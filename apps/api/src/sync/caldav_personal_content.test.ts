import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";
process.env.FEDERATION_ALLOW_PRIVATE_HOSTS = "true";

async function main() {
  const { isIcloudPersonalContentDestination, isCaldavPersonalContentOperation } = await import("./caldav_personal_content");
  const { caldavEventWritePermission, caldavAllows } = await import("./caldav_privileges");
  const { ProviderEventWriteError } = await import("./event_write");
  const account = "https://caldav.icloud.com/", collection = "https://p123-caldav.icloud.com/owner/calendars/personal/", resource = collection + "family.ics";
  assert.equal(isIcloudPersonalContentDestination(account, collection, resource), true);
  for (const [server, calendar, event] of [
    ["https://dav.example.test/", collection, resource],
    [account, "https://dav.example.test/personal/", "https://dav.example.test/personal/family.ics"],
    ["https://caldav.icloud.com.evil.test/", collection, resource],
    [account, collection, "https://p124-caldav.icloud.com/owner/calendars/personal/family.ics"],
    ["http://caldav.icloud.com/", collection, resource],
    [account, collection.replace("https:", "http:"), resource.replace("https:", "http:")],
    ["https://user:pass@caldav.icloud.com/", collection, resource],
    ["https://caldav.icloud.com:8443/", collection, resource],
    [account + "#fragment", collection, resource],
    [account, collection, resource + "#fragment"],
    ["garbage", collection, resource],
  ]) assert.equal(isIcloudPersonalContentDestination(server!, calendar!, event!), false, `${server} ${calendar} ${event}`);

  for (const patch of [{ title: "Renamed" }, { description: null }, { location: "Room" }, { title: "Renamed", description: "Notes", location: null }]) {
    assert.equal(isCaldavPersonalContentOperation({ patch }), true);
  }
  for (const operation of [null, {}, { patch: {} }, { patch: [] }, { patch: { recurrence: null } }, { patch: { title: "Renamed", recurrence: "FREQ=DAILY" } }, { patch: { start: new Date() } }, { patch: { color: "red" } },
    ...["targetEventID", "cancelTarget", "newDefinition", "time", "followingDelete"].flatMap(key => [null, false, "child"].map(value => ({ patch: { title: "Renamed" }, [key]: value }))),
  ]) assert.equal(isCaldavPersonalContentOperation(operation), false, JSON.stringify(operation));

  const originalFetch = globalThis.fetch;
  const url = "http://127.0.0.1:1/calendar/family.ics";
  let payload = "", status = 207, retryAfter: string | undefined;
  const row = (property: string, code = "404 Not Found", href = url) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${property}</d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat></d:response>`;
  const document = (body: string) => `<d:multistatus xmlns:d="DAV:" xmlns:x="urn:wrong">${body}</d:multistatus>`;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), url, "No live network");
    assert.equal(init?.method, "PROPFIND");
    assert.equal(new Headers(init?.headers).get("depth"), "0");
    return new Response(payload, { status, headers: { "content-type": "application/xml", ...(retryAfter ? { "retry-after": retryAfter } : {}) } });
  };
  try {
    payload = document(row("<d:current-user-privilege-set/>"));
    const missing = await caldavEventWritePermission(url, "Basic fixture");
    assert.equal(missing.missing, true); assert.equal(caldavAllows(missing.privileges, "update"), undefined);
    for (const body of [
      row("<d:current-user-privilege-set/>", "403 Forbidden"),
      row("<d:current-user-privilege-set/>", "200 OK"),
      row("<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>", "200 OK"),
      row("<x:current-user-privilege-set/>"),
      row("<d:current-user-privilege-set>junk</d:current-user-privilege-set>"),
      row("<d:current-user-privilege-set><d:privilege/></d:current-user-privilege-set>"),
      row("<d:current-user-privilege-set/>", "404 Not Found", url + ".other"),
      row("<d:current-user-privilege-set/>") + row("<d:current-user-privilege-set/>"),
      row("<d:displayname>Missing privilege property entirely</d:displayname>", "200 OK"),
      row("<d:current-user-privilege-set/>", "206 Partial Content"),
      `<d:response><d:href>${url}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`,
    ]) {
      payload = document(body);
      const result = await caldavEventWritePermission(url, "Basic fixture");
      assert.equal(result.missing, false, body);
      assert.notEqual(caldavAllows(result.privileges, "update"), true);
    }
    for (const code of [200, 403, 404]) {
      status = code; payload = document(row("<d:current-user-privilege-set/>"));
      const unknown = await caldavEventWritePermission(url, "Basic fixture");
      assert.equal(unknown.missing, false, `HTTP ${code} cannot prove the provider omits ACLs`);
      assert.equal(unknown.privileges, undefined, `HTTP ${code} cannot grant write access`);
    }
    retryAfter = "45";
    for (const code of [408, 429, 500, 503]) {
      status = code;
      await assert.rejects(() => caldavEventWritePermission(url, "Basic fixture"), error =>
        error instanceof ProviderEventWriteError && error.code === "provider-write-failed" && error.outcome === "not-written" && error.providerStatus === code && error.retryAfterMs === 45_000,
      `HTTP ${code} preserves the transient preflight failure and provider retry floor`);
    }
    retryAfter = undefined;
    status = 207; payload = "<broken";
    assert.equal((await caldavEventWritePermission(url, "Basic fixture")).missing, false);
    payload = document(row("<d:current-user-privilege-set><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set>", "200 OK"));
    const writable = await caldavEventWritePermission(url, "Basic fixture");
    assert.equal(writable.missing, false); assert.equal(caldavAllows(writable.privileges, "update"), true);
  } finally { globalThis.fetch = originalFetch; }
  console.log("iCloud personal content: destination/scope bounds; denied or malformed ACL remains unknown; transient preflight errors preserve Retry-After OK");
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
