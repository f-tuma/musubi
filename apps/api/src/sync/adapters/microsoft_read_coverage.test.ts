import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  const { fetchMicrosoftChanges, parseCursor } = await import("./microsoft");
  const base = "https://graph.microsoft.com/v1.0";
  const calendar = "work/team";
  const view = `${base}/me/calendars/work%2Fteam/calendarView/delta`;
  const eventPath = `${base}/me/calendars/work%2Fteam/events/`;
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const day = 86_400_000;
  const cursor = JSON.stringify({ version: 2, calendarId: calendar, windowStart: now - 180 * day,
    windowEnd: now + 730 * day, link: `${view}?token=previous` });
  const item = (id = "native", extra: Record<string, unknown> = {}) => ({
    id, type: "singleInstance", subject: "Present", isAllDay: false,
    start: { dateTime: "2026-11-01T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-01T10:00:00.0000000", timeZone: "UTC" },
    ...extra,
  });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const page = (value: unknown[] = [], token = "next") => json({ value, "@odata.deltaLink": `${view}?token=${token}` });
  const removed = (id = "native") => ({ id, "@removed": { reason: "deleted" } });
  const missing = () => json({ error: { code: "ErrorItemNotFound", message: "Item missing" } }, 404);
  const read = (fetchImpl: typeof fetch, previous = cursor, extra: Record<string, unknown> = {}) =>
    fetchMicrosoftChanges("fixture", calendar, previous, { now, fetchImpl, ...extra });

  // Exact start and end survive each delta round; old/unknown cursors renew
  // without interpreting missing entries as complete collection inventory.
  const incremental = await read(async () => page([item()]));
  assert.deepEqual(incremental.coverage, { kind: "window", fromInclusive: new Date(now - 180 * day).toISOString(),
    untilExclusive: new Date(now + 730 * day).toISOString(), complete: true });
  assert.equal(incremental.reset, false);
  assert.equal(incremental.cursorRestarted, false);
  assert.equal(parseCursor(incremental.nextCursor)?.windowStart, now - 180 * day);
  const zeroDuration = item("zero");
  zeroDuration.end = { ...zeroDuration.start };
  const equalEndpoints = await read(async () => page([zeroDuration]));
  assert.equal(equalEndpoints.changes[0]?.kind, "event", "Existing zero-duration timed events remain readable");
  await assert.rejects(read(async () => page([{ ...zeroDuration, isAllDay: true }])),
    "An exclusive all-day interval must still have positive length");
  for (const previous of [null, "https://old/delta", JSON.stringify({ link: `${view}?token=old`, windowEnd: now + 730 * day }),
    JSON.stringify({ ...JSON.parse(cursor), version: 3 }),
    JSON.stringify({ ...JSON.parse(cursor), calendarId: "different" }),
    JSON.stringify({ ...JSON.parse(cursor), windowEnd: now + 80 * day }),
    JSON.stringify({ ...JSON.parse(cursor), link: "https://foreign.example/steal" })]) {
    const urls: string[] = [];
    const snapshot = await read(async input => { urls.push(String(input)); return page(); }, previous as string);
    assert.equal(snapshot.reset, false);
    assert.equal(snapshot.cursorRestarted, true);
    assert.equal(snapshot.coverage?.kind, "window");
    assert.deepEqual(snapshot.changes, []);
    const requested = new URL(urls[0]!);
    assert.equal(requested.pathname, new URL(view).pathname);
    assert.equal(requested.searchParams.get("startDateTime"), new Date(now - 180 * day).toISOString());
    assert.equal(requested.searchParams.get("endDateTime"), new Date(now + 730 * day).toISOString());
  }

  // An expired token on page 2 discards page 1. The new bounded snapshot
  // reports coverage only, never the obsolete window's missing inventory.
  const expiredRequests: string[] = [];
  const restarted = await read(async input => {
    const url = String(input); expiredRequests.push(url);
    if (url.includes("startDateTime")) return page([item("fresh")]);
    if (url.includes("page=2")) return json({ error: { code: "SyncStateNotFound" } }, 410);
    return json({ value: [item("obsolete")], "@odata.nextLink": `${view}?page=2` });
  });
  assert.equal(expiredRequests.length, 3);
  assert.equal(restarted.reset, false);
  assert.equal(restarted.cursorRestarted, true);
  assert.deepEqual(restarted.changes.map(change => change.kind === "event" && change.data.externalId), ["fresh"]);
  assert.equal(restarted.coverage?.kind, "window");

  // No plausible-looking partial or wrong-scope page can certify a checkpoint.
  const malformed = [
    json({}), json({ "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [], "@odata.nextLink": `${view}?page=2`, "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [] }), json({ value: [], "@odata.deltaLink": null }),
    json({ value: [item("")], "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [item("native", { start: { dateTime: "2026-02-30T09:00:00", timeZone: "UTC" } })], "@odata.deltaLink": `${view}?token=next` }),
    json({ value: [], "@odata.deltaLink": "https://foreign.example/steal" }),
    json({ value: [], "@odata.deltaLink": `${base}/me/calendars/another/calendarView/delta?token=next` }),
    json({ value: [], "@odata.deltaLink": `${view}?token=next#fragment` }),
    json({ value: [], "@odata.deltaLink": `${view}?token=next` }, 206),
    json({ value: [], "@odata.deltaLink": `${view}?token=next` }, 200, { "content-range": "items 0-1/10" }),
  ];
  for (const response of malformed) await assert.rejects(read(async () => response));
  await assert.rejects(read(async () => json({ value: [], "@odata.nextLink": `${view}?token=previous` })), /cyclic/);
  let excessivePages = 0;
  await assert.rejects(read(async () => json({ value: [], "@odata.nextLink": `${view}?page=${++excessivePages}` })), /excessive/);
  assert.equal(excessivePages, 1000);
  let pages = 0;
  await assert.rejects(read(async () => ++pages === 1
    ? json({ value: [item()], "@odata.nextLink": `${view}?page=2` })
    : json({ error: { code: "ServiceUnavailable" } }, 503)));
  assert.equal(pages, 2);

  // A native change outside the delta window is returned as @removed by Graph.
  // Its full scoped GET wins; no tombstone is manufactured from the delta.
  const moved = item("native", { start: { dateTime: "2030-11-01T09:00:00", timeZone: "UTC" },
    end: { dateTime: "2030-11-01T10:00:00", timeZone: "UTC" }, subject: "Moved outside window" });
  const movedRequests: string[] = [];
  const outside = await read(async (input, init) => {
    const url = String(input); movedRequests.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, undefined);
    return url.startsWith(eventPath) ? json(moved) : page([removed()]);
  }, cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true });
  assert.equal(movedRequests.length, 2);
  assert.equal(outside.changes[0]?.kind, "event");
  if (outside.changes[0]?.kind === "event") {
    assert.equal(outside.changes[0].data.status, "active");
    assert.equal(outside.changes[0].data.title, "Moved outside window");
  }
  const definition = await read(async input => String(input).startsWith(eventPath)
    ? json(item("native", { type: "seriesMaster", recurrence: { pattern: { type: "daily" } } })) : page([removed()]),
  cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true });
  assert.deepEqual(definition.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal" }],
    "A full master definition cannot be flattened into one imported instance");

  // Unknown addresses and uncertain/private-redacted authority remain plain
  // absence observations. They cannot poison future create recovery tombstones.
  for (const options of [{ knownEventIDs: [] , microsoftReadAuthorityVerified: true },
    { knownEventIDs: ["native"], microsoftReadAuthorityVerified: false }]) {
    let count = 0;
    const unknown = await read(async () => { count++; return page([removed()]); }, cursor, options);
    assert.equal(count, 1);
    assert.deepEqual(unknown.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal" }]);
  }

  // A real deletion in the fake provider produces two exact native 404 reads
  // bracketing the readable calendar. Delta alone is still insufficient.
  let nativePresent = true;
  const proofRequests: string[] = [];
  const fakeProvider: typeof fetch = async (input, init) => {
    const url = String(input); proofRequests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "DELETE") { nativePresent = false; return new Response(null, { status: 204 }); }
    if (url === `${eventPath}native`) return nativePresent ? json(item()) : missing();
    if (url.includes("?$select=id,canViewPrivateItems")) return json({ id: calendar, canViewPrivateItems: true });
    return page([removed()]);
  };
  await fakeProvider(`${eventPath}native`, { method: "DELETE" });
  const deleted = await read(fakeProvider, cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true });
  assert.deepEqual(deleted.changes, [{ kind: "event-absence", externalId: "native", reason: "window-removal",
    deletionEvidence: { kind: "scoped-native-absence", responseStatus: 404, readAuthorityVerified: true,
      nativeReadProfile: "graph-event-double-404-calendar-v1" } }]);
  assert.deepEqual(proofRequests.slice(2), [`GET ${eventPath}native`,
    `GET ${base}/me/calendars/work%2Fteam?$select=id,canViewPrivateItems`, `GET ${eventPath}native`]);

  for (const bad of [json({ error: { code: "ErrorAccessDenied" } }, 403),
    json({ error: { code: "TooManyRequests" } }, 429), json({ error: { code: "ServiceUnavailable" } }, 503),
    json({ error: { code: "ErrorItemNotFound" } }, 410), json({ error: { code: "ErrorAccessDenied" } }, 404),
    json({}, 404), json({ error: { code: "ErrorItemNotFound" } }, 404, { "content-range": "bytes 0-5/100" }),
    json({ ...item(), id: "wrong" }), json({ id: "native" })]) {
    await assert.rejects(read(async input => String(input).startsWith(eventPath) ? bad : page([removed()]),
      cursor, { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));
  }
  // Captured DB authority can become stale while provider reads are in flight.
  // Native private-item access must still be explicit at the bracketing read.
  for (const badCalendar of [json({ id: "wrong", canViewPrivateItems: true }),
    json({ error: { code: "ErrorAccessDenied" } }, 403),
    json({ id: calendar, canViewPrivateItems: true, "@odata.nextLink": `${view}?page=2` }),
    json({ id: calendar, canViewPrivateItems: false }), json({ id: calendar }),
    json({ id: calendar, canViewPrivateItems: null })]) {
    await assert.rejects(read(async input => String(input).startsWith(eventPath) ? missing()
      : String(input).includes("?$select=id,canViewPrivateItems") ? badCalendar : page([removed()]), cursor,
    { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));
  }
  let nativeReads = 0;
  await assert.rejects(read(async input => String(input).startsWith(eventPath)
    ? (++nativeReads === 1 ? missing() : json(item()))
    : String(input).includes("?$select=id,canViewPrivateItems") ? json({ id: calendar, canViewPrivateItems: true }) : page([removed()]), cursor,
  { knownEventIDs: ["native"], microsoftReadAuthorityVerified: true }));

  // A moved exception retains its original slot, which differs from its current
  // start. Master hydration never substitutes the master's conditional version.
  const exception = item("exception", { ...moved, id: "exception", type: "exception", seriesMasterId: "master",
    originalStart: "2026-11-01T09:00:00.0000000Z" });
  const hydrated = await read(async input => {
    const url = String(input);
    if (url.includes(`${eventPath}master`)) return json(item("master", { type: "seriesMaster", "@odata.etag": 'W/"master"' }));
    if (url.includes(`${eventPath}exception`)) return json(exception);
    return page([removed("exception")]);
  }, cursor, { knownEventIDs: ["exception"], microsoftReadAuthorityVerified: true });
  assert.equal(hydrated.changes[0]?.kind, "event");
  if (hydrated.changes[0]?.kind === "event") {
    assert.deepEqual(hydrated.changes[0].data.providerOccurrence, { externalSeriesID: "master",
      originalStart: { kind: "instant", value: "2026-11-01T09:00:00.000Z" } });
    assert.equal(hydrated.changes[0].data.start.toISOString(), "2030-11-01T09:00:00.000Z");
    assert.equal(hydrated.changes[0].data.etag, null);
  }
  await assert.rejects(read(async input => {
    const url = String(input);
    if (url.includes(`${eventPath}master`)) return json(item("master", { type: "seriesMaster" }));
    if (url.includes(`${eventPath}exception`)) return json({ ...exception, originalStart: "2026-02-30T09:00:00Z" });
    return page([removed("exception")]);
  }, cursor, { knownEventIDs: ["exception"], microsoftReadAuthorityVerified: true }),
  "Invalid calendar dates must never roll into a fabricated original slot");

  // Full-family exclusions happen before ambiguous removal/dependency reads.
  let exclusionCalls = 0;
  const excluded = await read(async () => { exclusionCalls++; return page([removed("tracked"),
    item("tracked-slot", { seriesMasterId: "tracked-master" })]); }, cursor,
  { knownEventIDs: ["tracked"], microsoftReadAuthorityVerified: true,
    excludedEventIDs: ["tracked"], excludedSeriesIDs: ["tracked-master"] });
  assert.deepEqual(excluded.changes, []);
  assert.equal(exclusionCalls, 1);
  console.log("microsoft read coverage self-check: OK");
}

main().catch(error => { console.error(error); process.exit(1); });
