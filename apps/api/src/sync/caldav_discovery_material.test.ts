import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCaldavDiscoveryMaterialCache, type CaldavMaterialBinding } from "./caldav_discovery_material";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@localhost:1/unused";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { config } = await import("@musubi/config");
  const priorPrivate = config.security.federationAllowPrivateHosts;
  config.security.federationAllowPrivateHosts = true;
  const { createCaldavClient } = await import("./caldav_client");
  const { caldavEventPrivileges, caldavReadAccess } = await import("./caldav_privileges");
  let origin = "", homePath = "/home/", listingFailure = false, principalFailure = false, hasCalendar = true, readAllowed = true;
  let expectedPassword = "first-password", fixtureFailure: unknown;
  const calls: Array<{ method: string; path: string; kind: string }> = [];
  const document = (rows: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
  const row = (href: string, props: string, status = "HTTP/1.1 200 OK") => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
  const fixture = createServer(async (req, res) => {
    try {
      const method = req.method!, path = req.url!;
      assert.ok(["PROPFIND", "GET"].includes(method), "Fixture permits discovery reads only.");
      assert.equal(req.headers.authorization, `Basic ${Buffer.from(`fixture:${expectedPassword}`).toString("base64")}`);
      let body = ""; for await (const chunk of req) body += chunk;
      const kind = path === "/.well-known/caldav" ? "service" : body.includes("current-user-principal") ? "principal" : body.includes("calendar-home-set") ? "home" : body.includes("current-user-privilege-set") ? "acl" : body.includes("supported-report-set") ? "reports" : "listing";
      calls.push({ method, path, kind });
      if (method === "GET") { assert.equal(path, "/.well-known/caldav"); res.writeHead(204); res.end(); return; }
      let rows: string;
      if (kind === "principal") rows = row(origin + path, "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>", principalFailure ? "HTTP/1.1 403 Forbidden" : undefined);
      else if (kind === "home") rows = row(origin + path, `<c:calendar-home-set><d:href>${homePath}</d:href></c:calendar-home-set>`);
      else if (kind === "acl") rows = row(origin + path, `<d:current-user-privilege-set>${readAllowed ? "<d:privilege><d:read/></d:privilege>" : ""}</d:current-user-privilege-set>`);
      else if (kind === "reports") rows = row(origin + path, "<d:supported-report-set/>");
      else rows = row(origin + path, "<d:resourcetype><d:collection/></d:resourcetype>") + (path === homePath && hasCalendar
        ? row(origin + homePath + "calendar/", '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Fresh fixture</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>') : "");
      res.writeHead(kind === "listing" && listingFailure ? 503 : 207, { "content-type": "application/xml" });
      res.end(document(rows));
    } catch (error) { fixtureFailure = error; res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const binding: CaldavMaterialBinding = { userID: "fixture-owner", accountID: "fixture-physical-row", credentialRevision: "2026-10-26T12:00:00.000001", credentialFingerprint: "fixture-secret-digest-a", policyFingerprint: "fixture-private-policy-v1" };
  const cache = createCaldavDiscoveryMaterialCache();
  const make = (options: { refresh?: boolean; signal?: AbortSignal; binding?: CaldavMaterialBinding } = {}) => {
    const session = cache.begin(options.binding ?? binding, { refresh: options.refresh });
    return createCaldavClient(origin, "fixture", expectedPassword, options.signal, session);
  };
  const measure = async (run: () => Promise<unknown>) => {
    const before = calls.length; await run(); assert.equal(fixtureFailure, undefined);
    return calls.slice(before);
  };
  try {
    // Baseline uses the same actual client with material reuse disabled.
    const baseline: number[] = [];
    for (let index = 0; index < 2; index++) baseline.push((await measure(async () => {
      const client = await createCaldavClient(origin, "fixture", expectedPassword);
      assert.equal((await client.fetchCalendars()).length, 1);
    })).length);
    assert.deepEqual(baseline, [6, 6]);
    const cold = await measure(async () => { const client = await make(); assert.equal((await client.fetchCalendars()).length, 1); });
    const warm = await measure(async () => { const client = await make(); assert.equal((await client.fetchCalendars()).length, 1); });
    assert.equal(cold.length, 6);
    assert.deepEqual(warm.map(item => item.kind), ["listing", "reports"]);

    // Fresh collection membership and ACL remain network evidence on a hit.
    hasCalendar = false;
    const absent = await measure(async () => { const client = await make(); assert.deepEqual(await client.fetchCalendars(), []); });
    assert.deepEqual(absent.map(item => item.kind), ["listing"]);
    hasCalendar = true;
    readAllowed = false;
    const acl = await measure(async () => {
      const client = await make(); const [calendar] = await client.fetchCalendars();
      const privileges = await caldavEventPrivileges(calendar!.url, `Basic ${Buffer.from(`fixture:${expectedPassword}`).toString("base64")}`);
      assert.equal(caldavReadAccess(privileges).read, false);
    });
    assert.deepEqual(acl.map(item => item.kind), ["listing", "reports", "acl"]);
    readAllowed = true;

    // Failed/incomplete discovery invalidates only its own route ticket.
    listingFailure = true;
    await assert.rejects(async () => { const client = await make(); await client.fetchCalendars(); });
    listingFailure = false;
    const afterFailure = await measure(async () => { const client = await make(); await client.fetchCalendars(); });
    assert.equal(afterFailure.length, 6);

    const aborted = new AbortController(); aborted.abort(new Error("fixture-cancelled"));
    const beforeCancel = calls.length;
    await assert.rejects(async () => make({ signal: aborted.signal }), /fixture-cancelled/);
    assert.equal(calls.length, beforeCancel);
    const afterCancel = await measure(async () => { const client = await make(); await client.fetchCalendars(); });
    assert.equal(afterCancel.length, 2, "A new client has no earlier signal or sticky failure.");

    // Complete discovery, used for retirement, always refreshes endpoint routes.
    homePath = "/moved-home/";
    const refreshed = await measure(async () => { const client = await make({ refresh: true }); assert.equal((await client.fetchCalendars())[0]!.url, origin + homePath + "calendar/"); });
    assert.equal(refreshed.length, 6);
    const movedWarm = await measure(async () => { const client = await make(); assert.equal((await client.fetchCalendars())[0]!.url, origin + homePath + "calendar/"); });
    assert.deepEqual(movedWarm.map(item => item.path), ["/moved-home/", "/moved-home/calendar/"]);

    expectedPassword = "rotated-password";
    const rotated = { ...binding, credentialFingerprint: "fixture-secret-digest-b" };
    const credentials = await measure(async () => { const client = await make({ binding: rotated }); await client.fetchCalendars(); });
    assert.equal(credentials.length, 6, "The fresh credential incarnation cannot reuse old material.");

    // A cached private route still traverses current target/DNS policy.
    config.security.federationAllowPrivateHosts = false;
    const beforeDenied = calls.length;
    await assert.rejects(async () => { const client = await make({ binding: rotated }); await client.fetchCalendars(); }, /must use HTTPS/);
    assert.equal(calls.length, beforeDenied);
    config.security.federationAllowPrivateHosts = true;

    principalFailure = true;
    await assert.rejects(async () => make({ refresh: true }));
    principalFailure = false;
    const afterBadPrincipal = await measure(async () => { const client = await make(); await client.fetchCalendars(); });
    assert.equal(afterBadPrincipal.length, 6, "A failed discovery cannot provide a cached principal or home.");
    assert.equal(fixtureFailure, undefined);
    console.log(JSON.stringify({ boundary: "actual-loopback-http-guarded-client", baselineCalls: baseline, coldCalls: cold.length, warmCalls: warm.length, authoritativeRefreshCalls: refreshed.length, freshAclCalls: acl.filter(item => item.kind === "acl").length, realDatabase: false }));
  } finally {
    config.security.federationAllowPrivateHosts = priorPrivate;
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
