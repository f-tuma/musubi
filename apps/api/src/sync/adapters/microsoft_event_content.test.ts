import assert from "node:assert/strict";
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { microsoftEventVersion, microsoftPersonalContentPatch, updateMicrosoftPersonalContent } = await import("./microsoft_event_content");
  const { providerHttpMetricsRegistry, withProviderCallMetrics } = await import("../provider_http_metrics");
  const etag = 'W/"native-opaque-version"';
  assert.equal(microsoftEventVersion(etag), etag);
  for (const value of [undefined, null, '*', '"strong"', 'changeKey', ' W/"space"', 'W/"newline\n"']) assert.equal(microsoftEventVersion(value), null);
  assert.deepEqual(microsoftPersonalContentPatch({ title: "After" }), { subject: "After" });
  assert.deepEqual(microsoftPersonalContentPatch({ description: null, location: null }), { body: { contentType: "text", content: "" }, location: { displayName: "" } });
  assert.deepEqual(microsoftPersonalContentPatch({ color: "#ffffff" }), {});
  assert.throws(() => microsoftPersonalContentPatch(undefined), /event-diff-unavailable/);
  for (const field of ['start', 'end', 'isAllDay', 'recurrence', 'url', 'organizer', 'hasAttendees', 'isCanceled']) assert.throws(() => microsoftPersonalContentPatch({ [field]: null } as any), /Make other changes in Outlook/);
  const native = { id: "event/id", "@odata.etag": etag, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null };
  const session = { token: "fixture", calendarID: "calendar/id", eventID: "event/id", etag };
  let calls: Array<{ path: string; method: string; options: RequestInit }>;
  function transport({ calendar = {}, event = {}, status = 200, response = { id: native.id, "@odata.etag": 'W/"next-version"' }, race = false } = {}) {
    calls = [];
    return (async (url: RequestInfo | URL, options: RequestInit = {}) => {
      const path = String(url).replace('https://graph.microsoft.com/v1.0', '');
      const method = options.method ?? 'GET'; calls.push({ path, method, options });
      assert.equal(options.redirect, 'error');
      const json = (data: unknown, code = 200) => new Response(JSON.stringify(data), { status: code });
      if (path.startsWith('/me?$select=')) return json({ id: 'me', mail: 'owner@example.test', userPrincipalName: 'owner@example.test' });
      if (path.startsWith('/me/calendars/calendar%2Fid?$select=')) return json({ id: session.calendarID, canEdit: true, owner: { address: 'owner@example.test' }, ...calendar });
      assert.equal(path, '/me/calendars/calendar%2Fid/events/event%2Fid');
      if (method === 'GET') return json({ ...native, ...event });
      assert.equal(method, 'PATCH');
      assert.equal((options.headers as Record<string,string>)['If-Match'], etag);
      assert.deepEqual(JSON.parse(String(options.body)), { subject: 'After' });
      if (race) return json({}, 412);
      return json(response, status);
    }) as typeof fetch;
  }
  assert.deepEqual(await withProviderCallMetrics("microsoft", "event", () =>
    updateMicrosoftPersonalContent({ ...session, fetchImpl: transport() }, { title: 'After' }),
  ), { etag: 'W/"next-version"' });
  assert.equal(calls!.filter(c => c.method === 'PATCH').length, 1);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = transport();
    await withProviderCallMetrics("microsoft", "event", () => updateMicrosoftPersonalContent(session, { title: "After" }));
    assert.equal(calls!.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const expectedCounts = [
    { labels: { provider: "microsoft", family: "event", method: "GET", status: "200" }, value: 6 },
    { labels: { provider: "microsoft", family: "event", method: "PATCH", status: "200" }, value: 2 },
  ];
  const requests = providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!;
  assert.deepEqual((await requests.get()).values.map(({ labels, value }) => ({ labels, value })), expectedCounts,
    "each identity/calendar/event preflight and PATCH is counted exactly once for injected and default transports");
  for (const invalid of [ { attendees: [{}] }, { attendees: undefined }, { type: 'seriesMaster' }, { recurrence: {} }, { isOrganizer: false }, { isCancelled: true }, { isOnlineMeeting: true }, { isOnlineMeeting: undefined }, { 'attendees@odata.nextLink': 'next' }, { '@odata.etag': 'W/"stale"' }, { id: 'different-event' } ]) {
    await assert.rejects(() => updateMicrosoftPersonalContent({ ...session, fetchImpl: transport({ event: invalid as any }) }, { title: 'After' }));
    assert.equal(calls!.some(c => c.method === 'PATCH'), false);
  }
  for (const invalid of [{ canEdit: false }, { canEdit: undefined }, { id: 'different-calendar' }, { owner: { address: 'someone-else@example.test' } }]) {
    await assert.rejects(() => updateMicrosoftPersonalContent({ ...session, fetchImpl: transport({ calendar: invalid as any }) }, { title: 'After' }));
    assert.equal(calls!.some(c => c.method === 'PATCH'), false);
  }
  await assert.rejects(() => updateMicrosoftPersonalContent({ ...session, fetchImpl: transport({ race: true }) }, { title: 'After' }), /provider-conflict/);
  assert.equal(calls!.filter(c => c.method === 'PATCH').length, 1, 'stale write is never retried without condition');
  assert.deepEqual(await updateMicrosoftPersonalContent({ ...session, fetchImpl: transport({ response: { id: native.id } as any }) }, { title: 'After' }), { etag: null });
  await assert.rejects(() => updateMicrosoftPersonalContent({ ...session, fetchImpl: transport({ response: { id: 'wrong' } as any }) }, { title: 'After' }), (error: any) => error.outcome === 'unconfirmed');
  for (const status of [202, 301, 500]) await assert.rejects(() => updateMicrosoftPersonalContent({ ...session, fetchImpl: transport({ status }) }, { title: 'After' }));
  assert.deepEqual((await requests.get()).values.map(({ labels, value }) => ({ labels, value })), expectedCounts,
    "personal content requests outside delivery scope do not enter delivery metrics");
  console.log('Outlook personal content: exact native PATCH validator, preservation, ACL/identity/kind guards, conflict and ambiguous response checks passed.');
}
main().catch(error => { console.error(error); process.exit(1); });
