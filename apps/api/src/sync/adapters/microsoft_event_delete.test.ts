import assert from "node:assert/strict";
import { deleteMicrosoftPersonalEvent } from "./microsoft_event_content";
import { providerHttpMetricsRegistry, withProviderCallMetrics } from "../provider_http_metrics";

async function main() {
  const etag = 'W/"accepted-version"';
  const session = { token: "fixture", calendarID: "calendar/id", eventID: "event/id", etag };
  const native = { id: session.eventID, "@odata.etag": etag, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null };
  let calls: { method: string; path: string }[] = [];
  function transport({ event = {}, owner = "owner@example.test", canEdit = true, missing = false, status = 204, lost = false, retained = false, verifyDenied = false, race = false } = {}) {
    calls = [];
    let exists = !missing, dispatched = false;
    return (async (input, init = {}) => {
      const url = new URL(String(input)), method = init.method ?? "GET";
      assert.equal(url.origin, "https://graph.microsoft.com");
      assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture");
      calls.push({ method, path: url.pathname });
      const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
      if (url.pathname === "/v1.0/me") return json({ id: "me", mail: "owner@example.test" });
      if (url.pathname === "/v1.0/me/calendars/calendar%2Fid") return json({ id: session.calendarID, canEdit, owner: { address: owner } });
      assert.equal(url.pathname, "/v1.0/me/calendars/calendar%2Fid/events/event%2Fid");
      if (method === "GET") {
        if (dispatched && verifyDenied) return json({}, 403);
        return exists ? json({ ...native, ...event }) : json({}, 404);
      }
      assert.equal(method, "DELETE");
      assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).get("if-match"), etag);
      dispatched = true;
      // Model the actual Graph limitation: a change after the last GET is not
      // protected by the header. This test must not claim otherwise.
      if (race) event = { ...event, "@odata.etag": 'W/"changed-after-check"' };
      if (status === 204 && !retained) exists = false;
      if (lost) throw new TypeError("Response lost");
      return status === 204 ? new Response(null, { status }) : json({}, status);
    }) as typeof fetch;
  }
  await withProviderCallMetrics("microsoft", "event", () => deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport() }));
  assert.equal(calls.length, 5);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = transport();
    await withProviderCallMetrics("microsoft", "event", () => deleteMicrosoftPersonalEvent(session));
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await withProviderCallMetrics("microsoft", "event", () => assert.rejects(
    deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport({ lost: true }) }),
    (e: any) => e.outcome === "unconfirmed",
  ));
  assert.equal(calls.length, 4, "a lost DELETE response is counted without retry or observation");
  const expectedCounts = [
    { labels: { provider: "microsoft", family: "event", method: "GET", status: "200" }, value: 9 },
    { labels: { provider: "microsoft", family: "event", method: "DELETE", status: "204" }, value: 2 },
    { labels: { provider: "microsoft", family: "event", method: "GET", status: "404" }, value: 2 },
    { labels: { provider: "microsoft", family: "event", method: "DELETE", status: "network-error" }, value: 1 },
  ];
  const requests = providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!;
  assert.deepEqual((await requests.get()).values.map(({ labels, value }) => ({ labels, value })), expectedCounts,
    "all personal DELETE preflights, mutations and absence observations are counted exactly once");
  for (const options of [{}, { missing: true }, { race: true }]) {
    await deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport(options) });
    assert.equal(calls.filter(c => c.method === "DELETE").length, options.missing ? 0 : 1);
    assert.equal(calls[calls.length - 1]?.method, "GET", "verify absence after deleting");
  }
  for (const event of [{ "@odata.etag": 'W/"new-version"' }, { id: "other" }, { attendees: [{}] }, { attendees: undefined }, { type: "occurrence" }, { type: "seriesMaster" }, { recurrence: {} }, { isOrganizer: false }, { isCancelled: true }, { isOnlineMeeting: true }, { isDraft: true }, { "@odata.nextLink": "next" }]) {
    await assert.rejects(() => deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport({ event }) }));
    assert.equal(calls.some(c => c.method === "DELETE"), false);
  }
  for (const options of [{ owner: "other@example.test" }, { canEdit: false }, { owner: "other@example.test", missing: true }]) {
    await assert.rejects(() => deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport(options) }));
    assert.equal(calls.some(c => c.method === "DELETE"), false);
  }
  for (const options of [{ lost: true }, { retained: true }, { verifyDenied: true }, { status: 202 }, { status: 408 }, { status: 503 }]) {
    await assert.rejects(() => deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport(options) }), (e: any) => e.outcome === "unconfirmed");
    assert.equal(calls.filter(c => c.method === "DELETE").length, 1, "no in-transport retries");
  }
  for (const status of [401, 403, 412, 429]) await assert.rejects(() => deleteMicrosoftPersonalEvent({ ...session, fetchImpl: transport({ status }) }), (e: any) => e.outcome === "not-written");
  await assert.rejects(() => deleteMicrosoftPersonalEvent({ ...session, etag: null, fetchImpl: transport() }), /provider-version-unavailable/);
  assert.equal(calls.length, 0);
  assert.deepEqual((await requests.get()).values.map(({ labels, value }) => ({ labels, value })), expectedCounts,
    "delete requests outside delivery scope do not enter delivery metrics");
  console.log("Outlook guarded delete: source/kind/version checks, absence confirmation, ambiguous outcomes and documented post-read race: OK");
}
main().catch(error => { console.error(error); process.exit(1); });
