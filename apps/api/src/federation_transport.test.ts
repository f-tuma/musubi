import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { type AddressInfo, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

// Real socket/TLS proof for the federation outbound transport (CP10 10.3,
// ID-06): the production factory with the production pinned leaf against own
// loopback listeners only. No public address, no system DNS, no system CA
// change: trust for the fixture CA lives in this process and is restored in
// `finally`. Missing openssl or an unsupported Node is an explicit failure.

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

const FIXTURE_HOST = "federation-fixture.invalid";
const OTHER_HOST = "federation-other.invalid";
const LOOPBACK = { address: "127.0.0.1", family: 4 as const };

if (typeof tls.setDefaultCACertificates !== "function" || typeof tls.getCACertificates !== "function")
  throw new Error(`HOLD: Node >= 22.19 with tls.setDefaultCACertificates is required (running ${process.version}).`);
const opensslVersion = execFileSync("openssl", ["version"], { encoding: "utf8" }).trim();
if (!/^OpenSSL 3\./.test(opensslVersion)) throw new Error(`HOLD: OpenSSL >= 3.0 is required (found "${opensslVersion}").`);

// ── Isolation: no system DNS, no unguarded ambient fetch ─────────────────────
let systemLookups = 0;
const dnsModule = dns as unknown as { lookup: unknown; promises: { lookup: unknown } };
const originalLookup = dnsModule.lookup, originalPromisesLookup = dnsModule.promises.lookup;
const refuseLookup = () => { systemLookups++; return new Error("system DNS lookup reached the transport test"); };
// Literal IPs never reach DNS (Node short-circuits them, and our own listeners
// bind to 127.0.0.1 through this path); every hostname is refused.
dnsModule.lookup = (...args: unknown[]) => {
  if (typeof args[0] === "string" && isIP(args[0])) return (originalLookup as (...rest: unknown[]) => unknown)(...args);
  const callback = args[args.length - 1];
  const error = refuseLookup();
  if (typeof callback === "function") queueMicrotask(() => callback(error));
  else throw error;
};
dnsModule.promises.lookup = async (...args: unknown[]) => {
  if (typeof args[0] === "string" && isIP(args[0])) return (originalPromisesLookup as (...rest: unknown[]) => unknown)(...args);
  throw refuseLookup();
};
syncBuiltinESMExports();

const ownPorts = new Set<number>();
let guardedLeafCalls = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  guardedLeafCalls++;
  const url = new URL(input instanceof Request ? input.url : String(input));
  const dispatcher = (init as { dispatcher?: { dispatch?: unknown } } | undefined)?.dispatcher;
  if (!(init && "dispatcher" in init && typeof dispatcher?.dispatch === "function")) throw new Error("pinned leaf called without dispatcher");
  if (![FIXTURE_HOST, OTHER_HOST, "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error(`leaf hostname ${url.hostname} is not a fixture host`);
  if (!ownPorts.has(Number(url.port))) throw new Error(`leaf port ${url.port} is not an own listener`);
  return nativeFetch(input, init);
}) as typeof fetch;

type Seen = { host: string | undefined; url: string | undefined; servername?: string };
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    ownPorts.add(port);
    resolve(port);
  }));
}
function closeServer(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
function openssl(cwd: string, args: string[]) {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "musubi-cp10-tls-"));
  const defaultCAs = tls.getCACertificates("default");
  const httpSeen: Seen[] = [], httpsSeen: Seen[] = [], secondSeen: Seen[] = [];
  let hangSeen = 0;
  const sseTimers = new Set<NodeJS.Timeout>();
  let secondPort = 0;

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    httpSeen.push({ host: req.headers.host, url: req.url });
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: `http://127.0.0.1:${secondPort}/landed` });
      return res.end();
    }
    if (req.url?.startsWith("/sse")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": ping\n\n");
      const timer = setInterval(() => res.write(": ping\n\n"), 20);
      sseTimers.add(timer);
      res.on("close", () => { clearInterval(timer); sseTimers.delete(timer); });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "fixture" }));
  });
  const hangServer = createHttpServer(() => { hangSeen++; });
  const secondServer = createHttpServer((req, res) => { secondSeen.push({ host: req.headers.host, url: req.url }); res.writeHead(200); res.end("landed"); });

  let httpsServer: Server | undefined;
  try {
    // D-E: CA + leaf (SAN = FIXTURE_HOST) generated at runtime into a temporary directory.
    openssl(temporary, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-sha256", "-days", "2",
      "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Musubi CP10 fixture CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    openssl(temporary, ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-sha256",
      "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${FIXTURE_HOST}`,
      "-addext", `subjectAltName=DNS:${FIXTURE_HOST}`, "-addext", "basicConstraints=CA:FALSE",
      "-addext", "keyUsage=digitalSignature,keyEncipherment", "-addext", "extendedKeyUsage=serverAuth"]);
    openssl(temporary, ["x509", "-req", "-sha256", "-days", "2", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-out", "leaf.crt", "-copy_extensions", "copy"]);
    const [caPem, leafPem, leafKey] = await Promise.all(["ca.crt", "leaf.crt", "leaf.key"].map((name) => readFile(join(temporary, name), "utf8")));
    // F-04: the listener presents only the leaf, never the CA chain.
    httpsServer = createHttpsServer({ cert: leafPem, key: leafKey }, (req, res) => {
      httpsSeen.push({ host: req.headers.host, url: req.url, servername: String((req.socket as tls.TLSSocket).servername) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const [httpPort, httpsPort, hangPort] = await Promise.all([listen(httpServer), listen(httpsServer), listen(hangServer)]);
    secondPort = await listen(secondServer);

    const { createFederationFetch } = await import("./federation_origin");
    const lookupImpl = async () => [{ ...LOOPBACK }];
    const federationFetch = createFederationFetch({ allowPrivate: true, lookupImpl });
    const cause = (error: unknown) => (error as { cause?: { code?: string } })?.cause?.code;

    // http 200, Host preserved, no system lookup.
    const plain = await federationFetch(`http://${FIXTURE_HOST}:${httpPort}/api/v1/server`, { headers: { accept: "application/json" }, redirect: "manual" });
    assert.equal(plain.status, 200);
    assert.deepEqual(await plain.json(), { ok: true, version: "fixture" });
    assert.deepEqual(httpSeen, [{ host: `${FIXTURE_HOST}:${httpPort}`, url: "/api/v1/server" }]);
    assert.equal(systemLookups, 0);

    // https without the fixture CA trusted: native verification refuses the leaf-only chain.
    await assert.rejects(federationFetch(`https://${FIXTURE_HOST}:${httpsPort}/`), (error: unknown) => {
      assert.equal(cause(error), "UNABLE_TO_VERIFY_LEAF_SIGNATURE", `unexpected cause ${String(cause(error))}: ${String((error as Error).message)}`);
      return true;
    });
    assert.equal(httpsSeen.length, 0);

    // https with the fixture CA trusted only in this process.
    tls.setDefaultCACertificates([...defaultCAs, caPem]);
    try {
      const secure = await federationFetch(`https://${FIXTURE_HOST}:${httpsPort}/api/v1/server`);
      assert.equal(secure.status, 200);
      await secure.json();
      assert.equal(httpsSeen.length, 1);
      assert.equal(httpsSeen[0]!.servername, FIXTURE_HOST, "SNI stays the original hostname");
      assert.equal(httpsSeen[0]!.host, `${FIXTURE_HOST}:${httpsPort}`);
      // Pinned to the same loopback but a different hostname: the certificate's SAN does not match.
      await assert.rejects(federationFetch(`https://${OTHER_HOST}:${httpsPort}/`), (error: unknown) => {
        assert.equal(cause(error), "ERR_TLS_CERT_ALTNAME_INVALID", `unexpected cause ${String(cause(error))}: ${String((error as Error).message)}`);
        return true;
      });
      assert.equal(httpsSeen.length, 1);
    } finally {
      tls.setDefaultCACertificates(defaultCAs);
    }

    // Timeout through the dispatcher against a listener that never answers.
    const startedAt = performance.now();
    await assert.rejects(federationFetch(`http://${FIXTURE_HOST}:${hangPort}/hang`, { signal: AbortSignal.timeout(100) }), (error: unknown) => {
      assert.equal((error as Error).name, "TimeoutError", `unexpected error ${String((error as Error).message)}`);
      return true;
    });
    assert.ok(performance.now() - startedAt <= 1000, "timeout observed within one second");
    assert.equal(hangSeen, 1);

    // 302 is returned, never followed: the second listener sees no request.
    const redirected = await federationFetch(`http://${FIXTURE_HOST}:${httpPort}/redirect`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), `http://127.0.0.1:${secondPort}/landed`);
    await redirected.body?.cancel();
    assert.equal(secondSeen.length, 0);

    // SSE-shaped body: reading works and abort rejects the reader.
    const streamAbort = new AbortController();
    const stream = await federationFetch(`http://${FIXTURE_HOST}:${httpPort}/sse`, { headers: { accept: "text/event-stream" }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(new TextDecoder().decode(first.value).includes(": ping"));
    streamAbort.abort();
    await assert.rejects(reader.read());

    // Policy denial with the real leaf: no listener request, no leaf call.
    const denying = createFederationFetch({ allowPrivate: false, lookupImpl });
    const httpBefore = httpSeen.length, leafBefore = guardedLeafCalls;
    await assert.rejects(denying(`http://${FIXTURE_HOST}:${httpPort}/denied`), /internal address/);
    assert.equal(httpSeen.length, httpBefore);
    assert.equal(guardedLeafCalls, leafBefore);
    assert.equal(systemLookups, 0, "no system DNS lookup in the whole test");

    // Static wiring: no bare fetch( in the six federation sources; the factory
    // module uses globalThis.fetch exactly once, inside the pinned leaf.
    const bareFetch = /(^|[^.\w])fetch\(/;
    for (const file of ["handlers/federation_proxy.ts", "handlers/federation.ts", "federation_peer.ts", "federation_connections.ts", "federation_stream.ts"]) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, bareFetch, `${file} must not call ambient fetch`);
      assert.doesNotMatch(source, /globalThis\.fetch/, `${file} must not call globalThis.fetch`);
      assert.match(source, /federationFetch\(/, `${file} goes through federationFetch`);
    }
    const factory = await readFile(new URL("./federation_origin.ts", import.meta.url), "utf8");
    assert.doesNotMatch(factory, bareFetch);
    assert.equal(factory.match(/globalThis\.fetch\(/g)?.length, 1);
    assert.match(factory, /createPinnedCaldavFetch\(\s*\(\s*\w+,\s*\w+\s*\)\s*=>\s*globalThis\.fetch\(/, "ambient fetch is used only as the leaf handed to createPinnedCaldavFetch");

    console.log(`federation transport socket/TLS self-check: OK (${process.version}, ${opensslVersion}, ${process.platform})`);
  } finally {
    for (const timer of sseTimers) clearInterval(timer);
    tls.setDefaultCACertificates(defaultCAs);
    await Promise.all([closeServer(httpServer), closeServer(hangServer), closeServer(secondServer), httpsServer ? closeServer(httpsServer) : Promise.resolve()]);
    await rm(temporary, { recursive: true, force: true });
    globalThis.fetch = nativeFetch;
    dnsModule.lookup = originalLookup;
    dnsModule.promises.lookup = originalPromisesLookup;
    syncBuiltinESMExports();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
