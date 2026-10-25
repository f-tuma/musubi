import assert from "node:assert/strict";
import * as sharedProperties from "@musubi/provider-caldav/dav-properties";

process.env.DATABASE_URL ??= "postgres://fixture:fixture@localhost:5432/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { fetchCaldavPinned, createGuardedCaldavFetch } = await import("./caldav_client");
  const legacyProperties = await import("./caldav_properties");
  const { providerHttpMetricsRegistry, withProviderCallMetrics } = await import("./provider_http_metrics");
  assert.equal(legacyProperties.DavReadResponseError, sharedProperties.DavReadResponseError);
  assert.equal(legacyProperties.davMultistatus, sharedProperties.davMultistatus);
  const metric = providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!;
  const before = (await metric.get()).values.map(({ labels, value }) => ({ labels, value }));
  const original = globalThis.fetch;
  let calls = 0;
  try {
    // The wrappers were imported BEFORE this fixture replaces fetch. Production
    // and process-fixture callers must still reach the current explicit leaf.
    globalThis.fetch = (async (_url, init) => {
      calls++; assert.ok(init && "dispatcher" in init); return new Response(null, { status: 204 });
    }) as typeof fetch;
    await withProviderCallMetrics("caldav", "event", () => fetchCaldavPinned(new URL("https://dav.example.test/cal/event.ics"),
      { method: "DELETE" }, { address: "203.0.113.10", family: 4 }));
    assert.equal(calls, 1);
    assert.deepEqual((await metric.get()).values.map(({ labels, value }) => ({ labels, value })), before,
      "raw provider leaf is not observed a second time by the API wrapper");
    const legacy = createGuardedCaldavFetch({ allowPrivate: false, lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }] });
    await withProviderCallMetrics("caldav", "event", () => legacy("https://dav.example.test/cal/event.ics"));
    assert.equal(calls, 2);
    const after = (await metric.get()).values;
    assert.equal(after.find(item => item.labels.provider === "caldav" && item.labels.family === "event" && item.labels.method === "GET" && item.labels.status === "204")?.value, 1,
      "unchanged legacy leaf remains observed exactly once");
  } finally { globalThis.fetch = original; }
  console.log("CalDAV shared transport: parser/error identity, late fetch fixture and raw-versus-observed leaf metrics OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
