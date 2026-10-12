import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import { account, db, events, externalEvents, getUserExternalCalendars, setCursor, user } from "@musubi/db";
import { expandRecurringEvents } from "@musubi/calendar";
import { microsoftAdapter } from "./adapters/microsoft";
import { syncProvider } from "./engine";

async function main(rsvpOnly = false) {
  assert.equal(process.env.ENVIRONMENT, "test");
  const userID = `graph-occurrence-${randomUUID()}`;
  const master = { id: "series", type: "seriesMaster", "@odata.etag": '"MASTER"', subject: "Master", isAllDay: false, body: { content: "Master content" }, start: { dateTime: "2026-03-28T08:00:00", timeZone: "UTC" }, end: { dateTime: "2026-03-28T09:00:00", timeZone: "UTC" }, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", numberOfOccurrences: 4 } } };
  const occurrence = { id: "ordinary", type: "occurrence", seriesMasterId: "series", originalStart: "2026-03-28T08:00:00Z", start: master.start, end: master.end };
  const moved = { id: "moved", type: "exception", seriesMasterId: "series", "@odata.etag": '"MOVED"', originalStart: "2026-03-29T07:00:00.0000000Z", subject: "Own title", body: { content: "Own content" }, start: { dateTime: "2026-03-29T12:00:00", timeZone: "UTC" }, end: { dateTime: "2026-03-29T14:00:00", timeZone: "UTC" } };
  let items: any[] = [moved, occurrence, master];
  let failHydration = false;
  let omitOriginalStart = false;
  let expire = false;
  let alwaysExpire = false;
  let nativeRemoved = false;
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET");
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://fixture.test");
    const json = (body: unknown) => res.end(JSON.stringify(body));
    if (url.pathname === "/v1.0/me/calendars") return json({ value: [{ id: "calendar", name: "Fixture", canEdit: true, canViewPrivateItems: true }] });
    if (url.pathname === "/v1.0/me/calendars/calendar") return json({ id: "calendar", canViewPrivateItems: true });
    if (url.pathname.endsWith("/events/series")) return json(master);
    if (url.pathname.endsWith("/events/ordinary")) {
      assert.equal(url.searchParams.get("$select"), "*,originalStart");
      return json(omitOriginalStart ? { ...occurrence, originalStart: undefined } : occurrence);
    }
    if (url.pathname.endsWith("/events/moved")) {
      if (nativeRemoved) { res.statusCode = 404; return json({ error: { code: "ErrorItemNotFound" } }); }
      assert.equal(url.searchParams.get("$select"), "*,originalStart");
      if (failHydration) { res.statusCode = 503; return json({ error: { message: "fixture failure" } }); }
      return json(moved);
    }
    if (url.pathname.endsWith("/calendarView/delta")) {
      if (alwaysExpire || expire && url.searchParams.has("$deltatoken")) { expire = false; res.statusCode = 410; return json({ error: { message: "expired" } }); }
      return json({ value: items.map(item => item.id === "ordinary" ? { ...item, originalStart: undefined } : item), "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/calendar/calendarView/delta?$deltatoken=fixture" });
    }
    res.statusCode = 500; json({ error: { message: "Unexpected fixture route" } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fetch = globalThis.fetch;
  const enabled = config.api.eventTimeEditsEnabled;
  const rsvpEnabled = config.api.providerRsvpEditsEnabled;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.microsoft.com");
    return fetch(origin + url.pathname + url.search, init);
  };
  config.api.eventTimeEditsEnabled = true;
  await db.insert(user).values({ id: userID, name: "Fixture", email: `${userID}@example.test` });
  try {
    await db.insert(account).values({ id: randomUUID(), userId: userID, providerId: "microsoft", accountId: "account", scope: "Calendars.ReadWrite", refreshToken: "fixture", accessToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
    const sync = () => syncProvider(microsoftAdapter, userID, { id: "account", label: "Fixture" });
    const rows = () => db.select().from(events).where(eq(events.creatorID, userID)).orderBy(events.id);
    config.api.eventTimeEditsEnabled = false;
    config.api.providerRsvpEditsEnabled = false;
    await sync();
    const legacy = await rows();
    // RSVP must acquire a precise slot even with all time-writing disabled.
    config.api.eventTimeEditsEnabled = !rsvpOnly;
    config.api.providerRsvpEditsEnabled = rsvpOnly;
    await sync();
    const initial = await rows();
    assert.deepEqual(initial, legacy, "Identity adoption preserves local UUIDs and revisions");
    assert.equal(initial.length, 2);
    assert.ok(initial.every(event => !event.recurrence && !event.seriesID), "Provider-expanded instances are never expanded locally again");
    const [link] = await getUserExternalCalendars("microsoft", userID, "account");
    const mappings = () => db.select().from(externalEvents).where(eq(externalEvents.calendarID, link.calendarID)).orderBy(externalEvents.id);
    const mapped = await mappings();
    assert.ok(mapped.every(mapping => mapping.externalSeriesID === "series" && mapping.originalStart?.kind === "instant"));
    assert.equal(mapped.find(mapping => mapping.externalEventID === "ordinary")!.etag, null, "Master ETag must never authorize an instance");
    const expanded = expandRecurringEvents(initial.map(event => ({ ...event, calendars: [link.calendarID] })), new Date("2026-03-28T00:00Z"), new Date("2026-04-01T00:00Z"), { consumerTimeZone: "America/New_York" });
    assert.equal(expanded.length, 2);
    assert.equal(expanded.find(event => event.title === "Own title")!.description, "Own content");
    await sync();
    assert.deepEqual(await rows(), initial);
    await setCursor(link.calendarID, null);
    await sync();
    assert.deepEqual(await rows(), initial);
    expire = true;
    await sync();
    assert.deepEqual(await rows(), initial);
    assert.deepEqual((await mappings()).map(({ updatedAt: _updatedAt, providerStateObservedAt: _observedAt, ...mapping }) => mapping), mapped.map(({ updatedAt: _updatedAt, providerStateObservedAt: _observedAt, ...mapping }) => mapping), "Reset retains logical and original identity");
    const cursorBefore = await getUserExternalCalendars("microsoft", userID, "account");
    failHydration = true;
    await assert.rejects(sync(), /503/);
    failHydration = false;
    assert.deepEqual(await rows(), initial);
    assert.deepEqual(await getUserExternalCalendars("microsoft", userID, "account"), cursorBefore);
    omitOriginalStart = true;
    await assert.rejects(sync(), /exact millisecond/);
    omitOriginalStart = false;
    assert.deepEqual(await rows(), initial);
    assert.deepEqual(await getUserExternalCalendars("microsoft", userID, "account"), cursorBefore);
    const validOriginal = moved.originalStart;
    moved.originalStart = "2026-03-29T07:00:00.0000001Z";
    await assert.rejects(sync(), /exact millisecond/);
    moved.originalStart = "2026-03-30T07:00:00Z";
    await assert.rejects(sync(), /Graph read batch could not be persisted/);
    moved.originalStart = validOriginal;
    assert.deepEqual(await rows(), initial);
    assert.deepEqual(await getUserExternalCalendars("microsoft", userID, "account"), cursorBefore);
    alwaysExpire = true;
    await assert.rejects(sync(), /initial calendar window/);
    alwaysExpire = false;
    nativeRemoved = true;
    items = [{ id: "moved", "@removed": { reason: "deleted" } }];
    await sync();
    assert.ok((await rows()).find(event => event.title === "Own title")!.deletedAt);
    nativeRemoved = false;
    items = [occurrence, moved];
    await setCursor(link.calendarID, null);
    await sync();
    assert.deepEqual((await rows()).map(event => event.id), initial.map(event => event.id));
  } finally {
    globalThis.fetch = fetch;
    config.api.eventTimeEditsEnabled = enabled;
    config.api.providerRsvpEditsEnabled = rsvpEnabled;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(user).where(eq(user.id, userID));
  }
  console.log(`Graph expanded occurrence identity, hydration, validators and reset (${rsvpOnly ? "RSVP only" : "time edits"}): OK`);
}
main().then(() => main(true)).finally(() => db.$client.end());
