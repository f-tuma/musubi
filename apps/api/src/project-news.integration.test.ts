import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response as ApiResponse } from "express";
import {
  createProjectNewsHandler, createProjectNewsReader, ProjectNewsUnavailable,
  PROJECT_NEWS_MAX_BYTES, PROJECT_NEWS_TTL_MS, PROJECT_NEWS_URL,
} from "./project-news";

const item = { id: "2026-10-27", title: "HTTP boundary update", body: "Synthetic public news for every server." };
const feed = JSON.stringify({ schemaVersion: 1, items: [item] });
const wireItems = [{ ...item, minVersion: null }];
const etag = '"project-news-http-v1"';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}.`)), 5_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function sourceHashes() {
  const files = {
    reader: new URL("./project-news.ts", import.meta.url),
    feedSchema: new URL("../../../packages/types/src/project-news.ts", import.meta.url),
    integration: new URL("./project-news.integration.test.ts", import.meta.url),
  };
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, path]) =>
    [name, createHash("sha256").update(await readFile(path)).digest("hex")])));
}

async function main() {
  const hashes = await sourceHashes(), nativeFetch = globalThis.fetch;
  const requests = { cache: 0, redirect: 0, trap: 0, hang: 0, oversize: 0 };
  const cacheEtags: (string | null)[] = [];
  const firstCacheRequest = deferred(), releaseCacheResponse = deferred();
  const hungBodyClosed = deferred(), oversizeBodyClosed = deferred();
  let hangCancellations = 0, oversizeCancellations = 0, initializations = 0, fetchPortCalls = 0;
  let serverFailure: unknown, origin = "", listening = false;

  function validateRequest(req: IncomingMessage) {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.accept, "application/json");
    assert.equal(req.headers["user-agent"], "Musubi-project-news");
  }
  function sendFeed(res: ServerResponse) {
    res.writeHead(200, { "content-type": "application/json", etag });
    res.end(feed);
  }
  async function respond(req: IncomingMessage, res: ServerResponse) {
    validateRequest(req);
    switch (req.url) {
      case "/cache":
        requests.cache++; cacheEtags.push(req.headers["if-none-match"]?.toString() ?? null);
        if (requests.cache === 1) {
          firstCacheRequest.resolve(); await releaseCacheResponse.promise; sendFeed(res);
        } else {
          assert.equal(req.headers["if-none-match"], etag);
          res.writeHead(304, { etag }); res.end();
        }
        break;
      case "/redirect":
        requests.redirect++;
        res.writeHead(302, { location: `${origin}/trap` }); res.end();
        break;
      case "/trap": requests.trap++; sendFeed(res); break;
      case "/hang":
        requests.hang++;
        res.on("close", () => {
          if (!res.writableEnded) { hangCancellations++; hungBodyClosed.resolve(); }
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"schemaVersion":1,"items":['); res.flushHeaders();
        // Real response headers arrive, but its unfinished body must be
        // interrupted by the production AbortSignal rather than a fake fetch.
        break;
      case "/oversize":
        requests.oversize++;
        if (requests.oversize === 1) { sendFeed(res); break; }
        assert.equal(req.headers["if-none-match"], etag);
        res.on("close", () => {
          if (!res.writableEnded) { oversizeCancellations++; oversizeBodyClosed.resolve(); }
        });
        // No Content-Length: exercise the reader's streamed-byte limit. Leave
        // the body open so socket closure proves cancellation before cleanup.
        res.writeHead(200, { "content-type": "application/json" });
        res.write(Buffer.alloc(PROJECT_NEWS_MAX_BYTES + 1, 120)); res.flushHeaders();
        break;
      default: throw new Error("Unexpected loopback request.");
    }
  }
  const server = createServer((req, res) => {
    void respond(req, res).catch(error => { serverFailure ??= error; res.destroy(); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    listening = true;
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The production URL and request policy remain fixed. Only the existing
    // fetch dependency port maps that exact request to this owned HTTP server.
    const transport = (path: string): typeof globalThis.fetch => async (input, init) => {
      fetchPortCalls++;
      assert.equal(input, PROJECT_NEWS_URL);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("accept"), "application/json");
      return nativeFetch(`${origin}${path}`, init);
    };

    let cacheNow = 0;
    const cachedReader = createProjectNewsReader({ fetch: transport("/cache"), now: () => cacheNow, timeoutMs: 2_000 });
    const simultaneous = [cachedReader(), cachedReader(), cachedReader()];
    await bounded(firstCacheRequest.promise, "the first cache request");
    assert.equal(requests.cache, 1, "concurrent reads issue one actual HTTP request");
    releaseCacheResponse.resolve();
    const cold = await bounded(Promise.all(simultaneous), "the shared cache response");
    for (const result of cold) assert.deepEqual(result, wireItems);
    assert.deepEqual(await cachedReader(), wireItems);
    assert.equal(requests.cache, 1, "a fresh cache does not contact the server");
    cacheNow += PROJECT_NEWS_TTL_MS;
    assert.deepEqual(await cachedReader(), wireItems);
    assert.equal(requests.cache, 2);
    assert.deepEqual(cacheEtags, [null, etag]);
    cacheNow += PROJECT_NEWS_TTL_MS - 1;
    assert.deepEqual(await cachedReader(), wireItems);
    assert.equal(requests.cache, 2, "304 grants the ordinary cache lifetime");

    const redirectReader = createProjectNewsReader({ fetch: transport("/redirect"), timeoutMs: 1_000 });
    await assert.rejects(redirectReader(), ProjectNewsUnavailable);
    assert.equal(requests.redirect, 1);
    assert.equal(requests.trap, 0, "the actual fetch must not follow a redirect");

    const stalledReader = createProjectNewsReader({ fetch: transport("/hang"), timeoutMs: 250 });
    const handler = createProjectNewsHandler({ read: stalledReader, getSettings: async () => ({}), initialize: async (_userId, marker) => {
      initializations++; return { initialized: true, settings: { lastSeenProjectNews: marker } };
    } });
    let status = 0, body: unknown;
    const response = { status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } };
    await bounded(handler({ user: { id: "http-news-reader" } } as Request, response as unknown as ApiResponse), "the stalled body timeout");
    await bounded(hungBodyClosed.promise, "the timeout socket cancellation");
    assert.equal(status, 503);
    assert.deepEqual(body, { error: "NewsUnavailable", message: "News and updates are temporarily unavailable." });
    assert.equal(initializations, 0, "a failed cold body must not establish a baseline");
    assert.equal(hangCancellations, 1);

    let oversizeNow = 0;
    const boundedReader = createProjectNewsReader({ fetch: transport("/oversize"), now: () => oversizeNow, timeoutMs: 2_000 });
    assert.deepEqual(await boundedReader(), wireItems);
    oversizeNow += PROJECT_NEWS_TTL_MS;
    assert.deepEqual(await bounded(boundedReader(), "the streamed size rejection"), wireItems);
    await bounded(oversizeBodyClosed.promise, "the oversized body cancellation");
    assert.equal(oversizeCancellations, 1);
    assert.deepEqual(await boundedReader(), wireItems);
    assert.equal(requests.oversize, 2, "a failed warm refresh backs off without immediate replay");
    assert.equal(fetchPortCalls, 6);
    assert.deepEqual(requests, { cache: 2, redirect: 1, trap: 0, hang: 1, oversize: 2 });
    if (serverFailure) throw serverFailure;
    assert.deepEqual(await sourceHashes(), hashes, "the tested sources must stay stable throughout the HTTP proof");
    console.log(JSON.stringify({ schemaVersion: 1, suite: "project-news-http", sourceHashes: hashes,
      proof: { requests, fetchPortCalls, etagRequests: cacheEtags, concurrentColdReaders: simultaneous.length,
        redirectTrapRequests: requests.trap, timedOutBodyCancellations: hangCancellations,
        oversizedBodyCancellations: oversizeCancellations, oversizedBytesSent: PROJECT_NEWS_MAX_BYTES + 1,
        coldFailureStatus: status, coldFailureInitializations: initializations, warmFallbackRetained: true,
        stableSources: true } }));
  } finally {
    releaseCacheResponse.resolve();
    if (listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

void main().catch(error => { console.error("Project news HTTP integration failed.", error); process.exitCode = 1; });
