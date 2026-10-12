import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { expandRecurringEvents, resolveEventTimeEdit } from "@musubi/calendar";
import { account, db, reconcileMicrosoftCalendarAccess, deleteExternalEvent, events, externalEvents, sweepExternalEvents, getUserExternalCalendars, importExternalCalendar, setCursor, upsertExternalEvent, user } from "@musubi/db";
import { microsoftAdapter } from "./adapters/microsoft";
import { microsoftEventState } from "./adapters/provider_event_state";
import { syncProvider } from "./engine";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const userID = `graph-family-sync-${randomUUID()}`;
  const values = { title: "Series", description: "Notes", location: "Office", organizer: "owner@example.test", recurrence: "RRULE:FREQ=DAILY;COUNT=4", url: null, ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-27T09:00:00", endLocal: "2026-03-27T10:00:00" }) };
  const native: any = { id: "series", iCalUId: "master-uid", "@odata.etag": 'W/"master"', type: "seriesMaster", isAllDay: false, isCancelled: false, originalStartTimeZone: "Europe/Prague", originalEndTimeZone: "Europe/Prague", start: { dateTime: "2026-03-27T08:00:00", timeZone: "UTC" }, end: { dateTime: "2026-03-27T09:00:00", timeZone: "UTC" }, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", startDate: "2026-03-27", numberOfOccurrences: 4, recurrenceTimeZone: "Europe/Prague" } }, subject: "Series", body: { contentType: "text", content: "Notes" }, location: { displayName: "Office" }, attendees: [], isOrganizer: true, organizer: { emailAddress: { address: "owner@example.test" } }, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, cancelledOccurrences: [], exceptionOccurrences: [], isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: "busy", sensitivity: "normal", responseStatus: { response: "organizer" } };
  const occurrence = (day: number, hour: number): any => ({ ...native, id: `occ-${day}`, iCalUId: `uid-${day}`, "@odata.etag": `W/"${day}"`, type: "occurrence", seriesMasterId: "series", originalStart: `2026-03-${day}T0${hour}:00:00Z`, recurrence: null, start: { dateTime: `2026-03-${day}T0${hour}:00:00`, timeZone: "UTC" }, end: { dateTime: `2026-03-${day}T0${hour + 1}:00:00`, timeZone: "UTC" } });
  const ordinary = [occurrence(27, 8), occurrence(28, 8), occurrence(29, 7), occurrence(30, 7)];
  const oneOff = { ...ordinary[0], id: "standalone", type: "singleInstance", seriesMasterId: null, subject: "Untracked event", originalStart: null };
  let privateRead: boolean | undefined = true;
  let master = structuredClone(native), instances = structuredClone(ordinary), mode = "normal", reads: string[] = [], localChange: (() => Promise<void>) | undefined;
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, "Bearer fixture");
    const url = new URL(req.url!, "http://fixture.test"); reads.push(url.pathname);
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/v1.0/me/calendars") return json({ value: [{ id: "calendar", name: "Fixture", canEdit: true, canViewPrivateItems: privateRead }] });
    if (url.pathname === "/v1.0/me/calendars/calendar") return json({ id: "calendar", canViewPrivateItems: mode === "removed-private-denied" ? false : privateRead }, mode === "removed-denied" ? 403 : 200);
    if (url.pathname === "/v1.0/me/calendars/calendar/events/series") {
      if (mode !== "late-root") assert.equal(url.searchParams.get("$expand"), "exceptionOccurrences", "Tracked series use the full reader, never calendarView hydration");
      if (mode === "master-failure") return json({}, 503);
      if (mode.startsWith("removed")) return json({ error: { code: "ErrorItemNotFound" } }, 404);
      if (mode === "missing-master") return json({}, 404);
      return json(master);
    }
    if (url.pathname.endsWith("/events/series/instances")) {
      assert.equal(url.searchParams.get("startDateTime"), "2026-03-27T08:00:00.000Z");
      assert.equal(url.searchParams.get("endDateTime"), "2026-03-30T08:00:00.000Z");
      if (mode === "incomplete") return json({ value: instances.slice(0, 1) });
      return json({ value: instances });
    }
    if (url.pathname.endsWith("/calendarView/delta")) {
      if (localChange) { const change = localChange; localChange = undefined; await change(); }
      if (mode === "view-failure") return json({}, 503);
      // The full family is authoritative even when the bounded view is empty,
      // or contains stale IDs absent from both current maps and native slots.
      return json({ value: mode === "late-root" ? [...ordinary, oneOff] : mode === "empty-view" ? [oneOff] : [...ordinary, { id: "retired-unmapped", seriesMasterId: "series", type: "exception" }, { id: "occ-28", "@removed": { reason: "deleted" } }, oneOff], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/calendar/calendarView/delta?$deltatoken=fixture" });
    }
    return json({ error: "Unexpected hydration route" }, 500);
  })().catch(error => { console.error(error); res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch, enabled = config.api.eventTimeEditsEnabled;
  globalThis.fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com"); return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init); };
  await db.insert(user).values({ id: userID, name: "Fixture", email: `${userID}@example.test` });
  try {
    await db.insert(account).values({ id: randomUUID(), userId: userID, providerId: "microsoft", accountId: "account", scope: "Calendars.ReadWrite", refreshToken: "fixture", accessToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
    const calendar = await importExternalCalendar("microsoft", userID, "account", "Fixture", { externalId: "calendar", name: "Fixture", color: "red" });
    const acceptRoot = async () => {
      await upsertExternalEvent("microsoft", userID, calendar.id, "calendar", "series", { ...values, color: "red" }, 'W/"master"', "master-uid", undefined, { timeModel: values.timeModel }, undefined, microsoftEventState(native));
    };
    const rows = () => db.select().from(events).where(eq(events.creatorID, userID)).orderBy(events.id);
    const maps = () => db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)).orderBy(externalEvents.id);
    const sync = () => syncProvider(microsoftAdapter, userID, { id: "account", label: "Fixture" });
    const snapshot = async () => ({ rows: await rows(), maps: await maps(), links: await getUserExternalCalendars("microsoft", userID, "account") });
    config.api.eventTimeEditsEnabled = false;
    mode = "late-root"; localChange = acceptRoot;
    await sync();
    assert.equal((await rows()).length, 2, "A newly accepted master fences unmapped instance echoes after fetch exclusions were captured");
    assert.equal((await maps()).length, 2);
    mode = "normal"; reads = [];
    assert.deepEqual(await sync(), [calendar.id]);
    const initial = await rows(), initialMaps = await maps(), root = initial.find(value => value.recurrence)!;
    assert.equal(initial.length, 6); assert.equal(initialMaps.length, 6);
    assert.equal(initial.filter(value => value.seriesID === root.id).length, 4);
    assert.ok(!initialMaps.some(value => value.externalEventID === "retired-unmapped"));
    assert.equal(expandRecurringEvents(initial, new Date("2026-03-01Z"), new Date("2026-04-01Z"), { consumerTimeZone: "UTC" }).length, 5);
    assert.equal(reads.filter(value => value.endsWith("/events/series")).length, 2);
    assert.deepEqual(await sync(), []); assert.deepEqual(await rows(), initial);
    for (const flag of [true, false]) {
      config.api.eventTimeEditsEnabled = flag; mode = "empty-view"; reads = [];
      const cursor = JSON.parse((await getUserExternalCalendars("microsoft", userID, "account"))[0]!.cursor!);
      await setCursor(calendar.id, JSON.stringify({ ...cursor, windowEnd: Date.now() + 86400000 }));
      assert.deepEqual(await sync(), []); assert.deepEqual(await rows(), initial, "Window renewal cannot sweep tracked masters/instances");
      assert.equal((await maps()).length, 6); assert.ok(reads.some(value => value.endsWith("/calendarView/delta")));
    }
    mode = "normal";
    const staleSeen = initialMaps.map(value => value.externalEventID);
    instances[0]!.id = "occ-27-replaced";
    await Promise.all([sync(), sweepExternalEvents("microsoft", calendar.id, staleSeen)]);
    const acceptedReplacement = await rows(), replacementMaps = await maps();
    assert.equal(replacementMaps.find(value => value.externalEventID === "occ-27-replaced")!.eventID, initialMaps.find(value => value.externalEventID === "occ-27")!.eventID);
    assert.equal(await sweepExternalEvents("microsoft", calendar.id, staleSeen), 0, "Stale reset cannot delete a newly accepted native ID");
    assert.equal(await deleteExternalEvent("microsoft", calendar.id, "occ-27-replaced"), false, "Ordinary delete cannot bypass complete-family evidence");
    assert.equal(await deleteExternalEvent("microsoft", calendar.id, "series"), false);
    assert.equal(await upsertExternalEvent("microsoft", userID, calendar.id, "calendar", "occ-27-replaced", { ...values, recurrence: null, title: "Stale component", color: "red" }, 'W/"stale"', "uid-27"), false);
    assert.deepEqual(await rows(), acceptedReplacement); assert.deepEqual(await maps(), replacementMaps);
    master.exceptionOccurrences = [{ ...ordinary[2], type: "exception", subject: "Moved far away", start: { dateTime: "2027-05-01T12:00:00", timeZone: "UTC" }, end: { dateTime: "2027-05-01T13:00:00", timeZone: "UTC" } }];
    master.cancelledOccurrences = ["opaque-cancelled"];
    instances = [ordinary[0], ordinary[3]];
    assert.deepEqual(await sync(), [calendar.id]);
    const changed = await rows(), child = (id: string) => changed.find(value => value.id === initialMaps.find(map => map.externalEventID === id)!.eventID)!;
    assert.equal(changed.length, 6); assert.equal(child("occ-28").isCanceled, true);
    assert.equal(child("occ-29").title, "Moved far away"); assert.deepEqual(child("occ-29").timeModel, { kind: "legacy-unknown" });
    mode = "empty-view"; await setCursor(calendar.id, null); await sync(); assert.deepEqual(await rows(), changed);
    for (const scenario of ["incomplete", "master-failure", "missing-master", "view-failure"]) {
      mode = scenario; const before = await snapshot(); await assert.rejects(sync); assert.deepEqual(await snapshot(), before, "Failed full proof or view does not partially persist/advance cursor");
    }
    mode = "normal"; master = structuredClone(native); instances = structuredClone(ordinary);
    const oldCursor = (await getUserExternalCalendars("microsoft", userID, "account"))[0]!.cursor;
    localChange = async () => { await db.update(events).set({ title: "Concurrent local", revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id)); };
    await assert.rejects(sync); assert.equal((await rows()).find(value => value.id === root.id)!.title, "Concurrent local");
    assert.equal((await getUserExternalCalendars("microsoft", userID, "account"))[0]!.cursor, oldCursor);
    assert.equal((await rows()).find(value => value.id === child("occ-28").id)!.isCanceled, true, "Stale context cannot partially revive children");
    await sync(); assert.equal((await rows()).length, 6); assert.equal((await rows()).filter(value => value.isCanceled).length, 0);
    for (const denial of ["removed-denied", "removed-private-denied"]) {
      mode = denial;
      const beforeDenied = await snapshot(); await assert.rejects(sync); assert.deepEqual(await snapshot(), beforeDenied, "Failed native read authority cannot remove a complete family or advance its checkpoint");
    }
    mode = "removed";
    localChange = async () => { await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, root.id)); };
    await assert.rejects(sync); assert.ok((await rows()).every(value => !value.deletedAt), "Stale context cannot remove the family");
    const beforeRemoved = await rows(), beforeRemovedMaps = await maps();
    await setCursor(calendar.id, null);
    assert.deepEqual(await sync(), [calendar.id]);
    const removed = await rows();
    assert.equal(removed.filter(value => value.deletedAt).length, 5);
    assert.deepEqual(removed.find(value => !value.seriesID && !value.recurrence), beforeRemoved.find(value => !value.seriesID && !value.recurrence), "Unrelated one-off survives");
    assert.deepEqual(await maps(), beforeRemovedMaps, "Retain source addresses for full-proof revival");
    assert.deepEqual(await sync(), []); assert.deepEqual(await rows(), removed, "Repeated negative proof is a no-op despite stale ordinary delta");
    await setCursor(calendar.id, null); await sync(); assert.deepEqual(await rows(), removed, "Reset cannot revive removed family from stale components");
    mode = "normal"; master.cancelledOccurrences = ["opaque-cancelled"]; instances = [ordinary[0], ordinary[2], ordinary[3]];
    assert.deepEqual(await sync(), [calendar.id]);
    const restored = await rows();
    assert.deepEqual(restored.map(value => value.id), beforeRemoved.map(value => value.id));
    assert.ok(restored.every(value => !value.deletedAt));
    assert.equal(restored.find(value => value.id === child("occ-28").id)!.isCanceled, true, "Revival retains native cancellation");
    assert.deepEqual(await sync(), []); assert.deepEqual(await rows(), restored);
    const beforeUnmapped = await snapshot();
    for (const flag of [true, false]) {
      config.api.eventTimeEditsEnabled = flag;
      assert.equal(await upsertExternalEvent("microsoft", userID, calendar.id, "calendar", "unmapped-late", { ...values, recurrence: null, title: "Stale echo", color: "red" }, null, "late-uid", undefined, undefined, undefined, undefined, undefined, "series"), false);
    }
    assert.deepEqual(await snapshot(), beforeUnmapped, "Source parent guard never promotes a bounded instance or changes mappings");
    for (const accessMode of ["normal", "removed"]) {
      mode = accessMode;
      localChange = async () => {
        await reconcileMicrosoftCalendarAccess(userID, "account", calendar.id, { canEdit: true, canViewPrivateItems: false });
        await reconcileMicrosoftCalendarAccess(userID, "account", calendar.id, { canEdit: true, canViewPrivateItems: true });
      };
      await assert.rejects(sync, Error, "Held family proof cannot replace/delete after access ABA");
      assert.ok((await rows()).every(value => value.title === "Busy"), "Redaction includes unmapped cancelled children");
      assert.ok((await rows()).every(value => !value.deletedAt));
      mode = "normal"; await sync();
      assert.equal((await rows()).find(value => value.id === root.id)!.title, native.subject);
    }
    // Remove the native mapping as for a never-observed cancelled slot, then
    // prove this test exercises event-level evidence rather than a map marker.
    const cancelledChild = (await rows()).find(value => value.seriesID === root.id && value.isCanceled)!;
    assert.ok(cancelledChild.providerReadRetiredRevision);
    await db.delete(externalEvents).where(eq(externalEvents.eventID, cancelledChild.id));
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.eventID, cancelledChild.id))).length, 0);
    // The cancelled child has no mapping after the root's authorized recovery.
    privateRead = undefined; master = structuredClone(native); instances = structuredClone(ordinary);
    await assert.rejects(sync, Error, "Unknown proof cannot revive an unmapped retired child after root recovery");
    privateRead = true; await sync();
    // A genuinely new cancelled identity must not inherit its restored root's history.
    const newSlot = (await rows()).find(value => value.seriesID === root.id && !value.isCanceled)!;
    await db.delete(events).where(eq(events.id, newSlot.id));
    const slotDay = newSlot.originalStart!.value.slice(8, 10);
    master.cancelledOccurrences = ["new-cancelled-slot"];
    instances = ordinary.filter(value => value.originalStart.slice(8, 10) !== slotDay);
    await sync();
    const createdCancelled = (await rows()).find(value => value.seriesID === root.id && value.isCanceled)!;
    assert.notEqual(createdCancelled.id, newSlot.id); assert.equal(createdCancelled.providerReadRetiredRevision, null);
    privateRead = undefined; await sync();
    console.log("Tracked Graph family sync: actual scoped native reads, flag-off preservation, calendarView/stale-ID suppression before hydration, reset/window renewal, moved/cancelled/revived UUIDs, complete-read failures and local-race cursor preservation: OK");
  } finally { config.api.eventTimeEditsEnabled = enabled; globalThis.fetch = realFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.delete(user).where(eq(user.id, userID)); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
