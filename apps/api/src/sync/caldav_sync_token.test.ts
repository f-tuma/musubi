import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:7531";

async function main() {
  const { config } = await import("@musubi/config");
  const { StructuredLogger } = await import("@musubi/config");
  const { createCaldavClient } = await import("./caldav_client");
  const { assertDavReadResponse } = await import("./caldav_properties");
  const origin = "http://127.0.0.1:1", collection = origin + "/home/calendar/";
  const privateToken = "urn:uuid:PRIVATE-REPORT%2bopaque+token?order=z&order=a&empty=";
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const document = (value: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="urn:wrong">${value}</d:multistatus>`;
  const rootToken = (value: string) => `<d:sync-token>${escape(value)}</d:sync-token>`;
  const row = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const response = (xml: string, status = 207, headers: Record<string, string> = {}) => new Response(status === 204 ? null : xml, { status, headers: { "content-type": "application/xml", ...headers } });
  let report: (url: string, init: RequestInit) => Promise<Response> | Response = () => response(document(rootToken(privateToken)));
  let reportCalls = 0, unexpectedRedirectRequests = 0;
  const originalFetch = globalThis.fetch, originalPrivate = config.security.federationAllowPrivateHosts;
  config.security.federationAllowPrivateHosts = true;
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input)); assert.equal(target.origin, origin, "Synthetic responses only; no external network");
    const body = String(init?.body ?? "");
    assert.ok(init?.method === "PROPFIND" || init?.method === "REPORT", "No provider mutations");
    if (body.includes("sync-collection")) {
      reportCalls++;
      if (target.pathname === "/unselected/") unexpectedRedirectRequests++;
      assert.match(body, /<d:sync-level>1<\/d:sync-level>/);
      assert.equal(init?.redirect, "manual", "Guarded transport retains redirect control");
      return report(target.href, init!);
    }
    if (body.includes("current-user-principal")) return response(document(row(target.href, "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>")));
    if (body.includes("calendar-home-set")) return response(document(row(target.href, "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>")));
    assert.ok(body.includes("resourcetype"));
    return response(document(row(target.href, "<d:resourcetype><d:collection/></d:resourcetype>")));
  };
  let cases = 0;
  try {
    const client = await createCaldavClient(origin, "fixture", "fixture");
    const read = (url = collection, previous = "urn:uuid:prior") => client.syncCollectionWithToken({ url, props: { "d:getetag": {} }, syncLevel: 1, syncToken: previous });
    const accepted = await read();
    assert.equal(accepted.syncToken, privateToken, "Root token survives zero resource rows byte-for-byte, including opaque URI query encoding/order");
    assert.equal(accepted.responses.filter(value => value.href).length, 0);
    assert.equal(assertDavReadResponse(document(rootToken(privateToken)), collection, "sync"), privateToken);
    cases++;
    assert.equal((await read(collection, privateToken)).syncToken, privateToken, "A valid unchanged server token is permitted"); cases++;
    const nativeRows = [
      row(collection + "changed.ics", '<d:getetag>"v2"</d:getetag>'),
      `<d:response><d:href>${collection}deleted.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`,
    ];
    for (const rows of [nativeRows.slice(0, 1), nativeRows.slice(1), nativeRows]) {
      report = () => response(document(rows.join("") + rootToken(privateToken)));
      const result = await read();
      assert.equal(result.syncToken, privateToken); assert.equal(result.responses.length, rows.length);
      assert.ok(result.responses.every(value => value.href?.startsWith(collection)));
      cases++;
    }
    report = () => response(document(rootToken(privateToken) + row(collection + "property-token.ics", `<d:getetag>"v2"</d:getetag>${rootToken("urn:uuid:other-property-token")}`)));
    assert.equal((await read()).syncToken, privateToken, "Only the root sync-token supplies checkpoint authority"); cases++;
    const invalid = [
      document(""), document(rootToken(privateToken) + rootToken(privateToken)), document("<d:sync-token/>"),
      document(`<x:sync-token>${escape(privateToken)}</x:sync-token>`), document(`<d:sync-token><d:href>${escape(privateToken)}</d:href></d:sync-token>`),
      document(row(collection + "changed.ics", `<d:getetag>"v2"</d:getetag>${rootToken(privateToken)}`)),
      document("<d:sync-token>123</d:sync-token>"), document("<d:sync-token>true</d:sync-token>"),
      document(rootToken(privateToken) + row(collection + "changed.ics", '<d:getetag>"v2"</d:getetag>').replace("200 OK", "403 Forbidden")),
      `<!DOCTYPE d:multistatus [<!ENTITY p "${privateToken}">]>` + document("<d:sync-token>&p;</d:sync-token>"),
    ];
    const assertPrivateFailure = (error: unknown) => {
      assert.ok(error instanceof Error);
      const lines: string[] = [], originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
      try { new StructuredLogger("error").error("sync.failed", { error }); }
      finally { process.stderr.write = originalWrite; }
      for (const value of [privateToken, collection, "PRIVATE-status-text", "PRIVATE-body"]) assert.equal(lines.join("").includes(value), false);
      return true;
    };
    for (const xml of invalid) {
      report = () => response(xml);
      await assert.rejects(read(), assertPrivateFailure); cases++;
    }
    for (const [status, headers] of [[200, {}], [204, {}], [206, {}], [401, {}], [403, {}], [429, {}], [503, {}], [207, { "content-range": "items 0-0/1" }], [207, { "content-type": "text/plain" }]] as const) {
      report = () => new Response(status === 204 ? null : document(rootToken(privateToken)), { status, statusText: "PRIVATE-status-text", headers: { "content-type": "application/xml", ...headers } });
      await assert.rejects(read(), assertPrivateFailure); cases++;
    }
    report = () => new Response(null, { status: 307, headers: { location: origin + "/unselected/" } });
    await assert.rejects(read(), assertPrivateFailure);
    assert.equal(unexpectedRedirectRequests, 0, "A root-only token cannot authorize a redirected collection"); cases++;
    report = () => Object.defineProperty(response(document(rootToken(privateToken))), "url", { value: origin + "/unselected/" });
    await assert.rejects(read(), assertPrivateFailure); cases++;
    report = () => Object.defineProperty(response(document(rootToken(privateToken))), "redirected", { value: true });
    await assert.rejects(read(), assertPrivateFailure); cases++;
    await assert.rejects(client.syncCollectionWithToken({ url: "PRIVATE-body invalid URL", props: {}, syncLevel: 1 }), assertPrivateFailure); cases++;

    // Reverse completions on one client, including two calls for one collection.
    // Each result must carry only the token captured in its own response context.
    const pending = new Map<string, (value: Response) => void>();
    report = (_url, init) => new Promise(resolve => {
      const key = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(String(init.body))![1]!;
      pending.set(key, resolve);
    });
    const waitPending = async (count: number) => {
      const deadline = Date.now() + 2000;
      while (pending.size < count) { assert.ok(Date.now() < deadline, "Concurrent reads must reach the synthetic REPORT fixture"); await new Promise(resolve => setImmediate(resolve)); }
    };
    const a = read(collection, "prior-A"), b = read(origin + "/home/second/", "prior-B"), c = read(collection, "prior-C");
    await waitPending(3);
    pending.get("prior-B")!(response(document(rootToken("urn:uuid:token-B"))));
    assert.equal((await b).syncToken, "urn:uuid:token-B");
    pending.get("prior-C")!(response(document(rootToken("urn:uuid:token-C"))));
    assert.equal((await c).syncToken, "urn:uuid:token-C");
    pending.get("prior-A")!(response(document(rootToken("urn:uuid:token-A"))));
    assert.equal((await a).syncToken, "urn:uuid:token-A"); cases++;

    const good = read(collection, "prior-good"), bad = read(collection, "prior-bad");
    const badObserved = assert.rejects(bad, assertPrivateFailure);
    await waitPending(5);
    pending.get("prior-good")!(response(document(rootToken("urn:uuid:next-good"))));
    assert.equal((await good).syncToken, "urn:uuid:next-good");
    pending.get("prior-bad")!(response(document("")));
    await badObserved; cases++;
    report = () => response(document(""));
    await assert.rejects(read(), assertPrivateFailure); cases++;
    let overrideCalls = 0;
    await assert.rejects(client.syncCollectionWithToken({ url: collection, props: { "d:getetag": {} }, syncLevel: 1, fetch: async () => {
      overrideCalls++;
      await client.syncCollection({ url: collection, props: { "d:getetag": {} }, syncLevel: 1 });
      return response(document(rootToken(privateToken)));
    } }), assertPrivateFailure);
    assert.equal(overrideCalls, 0, "A fetch override cannot seed metadata through a nested guarded read and return unvalidated outer rows"); cases++;
    report = () => response(document(rootToken("urn:uuid:after-failure")));
    assert.equal((await read()).syncToken, "urn:uuid:after-failure"); cases++;
    assert.ok(reportCalls > cases);
    console.log(`CalDAV sync token actual guarded-client: ${cases} cases; zero-row metadata, exact opaque token, strict failures, scope binding and concurrent/stale isolation OK`);
  } finally { globalThis.fetch = originalFetch; config.security.federationAllowPrivateHosts = originalPrivate; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
