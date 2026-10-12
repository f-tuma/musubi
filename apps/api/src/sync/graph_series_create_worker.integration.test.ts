import express from "express";
import { requireAuth } from "../middleware/require_auth";
import { handlerRetryEventDelivery } from "../handlers/event_delivery";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { issueMemberToken } from "../federation_tokens";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION } from "@musubi/types";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema } from "@musubi/types";
import { resolveEventTimeEdit, expandRecurringEvents } from "@musubi/calendar";
import { account, calendarMembers, db, events, externalEvents, eventOutbox, user, importExternalCalendar, queueGraphSeriesCreate, requestEventDeliveryRetry, replaceMemberToken, getEventDeliveryStatus } from "@musubi/db";
import { microsoftAdapter } from "./adapters/microsoft";
import { deliverEventOutbox } from "./event_delivery";
import { syncProvider } from "./engine";

async function run(scenario: string, until = false) {
  let failureTrigger: string | undefined;
  const actor = `graph-create-worker-${randomUUID()}`, allDay = scenario === "all-day", flag = config.api.eventTimeEditsEnabled;
  let mode = scenario === "prague-recovery" ? "partial" : scenario, present = false, posts = 0, operationID = "", eventID = "", calendarID = "", raced = false;
  const time = resolveEventTimeEdit(allDay ? { kind: "all-day", startDate: "2026-12-30", endDate: "2026-12-31" } : { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-27T09:00:00", endLocal: "2026-03-27T10:00:00" });
  const utc = (date: Date) => ({ dateTime: date.toISOString().slice(0, -1), timeZone: "UTC" });
  const native = () => ({ id: "series", transactionId: operationID, iCalUId: "master-uid", "@odata.etag": 'W/"master"', type: "seriesMaster", isAllDay: allDay, isCancelled: false, originalStartTimeZone: allDay ? "UTC" : "Europe/Prague", originalEndTimeZone: allDay ? "UTC" : "Europe/Prague", start: utc(time.start), end: utc(new Date(time.end.getTime() + (allDay ? 86400000 : 0))), recurrence: { pattern: { type: "daily", interval: 1 }, range: { ...(until ? { type: "endDate", endDate: allDay ? "2027-01-02" : "2026-03-30" } : { type: "numbered", numberOfOccurrences: 4 }), startDate: allDay ? "2026-12-30" : "2026-03-27", ...(allDay ? {} : { recurrenceTimeZone: scenario === "prague-recovery" ? "Central Europe Standard Time" : "Europe/Prague" }) } }, subject: mode === "changed-intent" && present ? "Changed elsewhere" : "Personal", body: { contentType: "text", content: "Notes" }, location: { displayName: "Office" }, attendees: [], isOrganizer: true, organizer: { emailAddress: { address: "owner@example.test" } }, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, cancelledOccurrences: [], exceptionOccurrences: [], isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: "busy", sensitivity: "normal", responseStatus: { response: "organizer" } });
  const instances = () => [27, 28, 29, 30].map(day => {
    const start = allDay ? new Date(time.start.getTime() + (day - 27) * 86400000) : new Date(`2026-03-${day}T0${day < 29 ? 8 : 7}:00:00Z`);
    const end = new Date(start.getTime() + (allDay ? 2 * 86400000 : 3600000));
    return { ...native(), id: `instance-${day}`, iCalUId: `uid-${day}`, "@odata.etag": `W/"${day}"`, type: "occurrence", seriesMasterId: "series", originalStart: start.toISOString(), start: utc(start), end: utc(end), recurrence: null };
  });
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.headers.authorization, "Bearer fixture");
    const url = new URL(req.url!, "http://fixture.test"), path = url.pathname;
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST") {
      assert.equal(path, "/v1.0/me/calendars/calendar/events");
      let raw = ""; for await (const part of req) raw += part;
      const body = JSON.parse(raw); assert.equal(body.transactionId, operationID); assert.deepEqual(body.attendees, []); assert.equal(body.organizer, undefined); assert.deepEqual(body.recurrence.range, { ...native().recurrence.range, ...(!allDay ? { recurrenceTimeZone: "Europe/Prague" } : {}) });
      assert.equal(body.start.timeZone, allDay ? "UTC" : "Europe/Prague");
      posts++; present = mode !== "absent";
      if (mode === "lost") { req.socket.destroy(); return; }
      if (mode === "absent") return json({}, 503);
      return json({ id: "series" }, 201);
    }
    assert.equal(req.method, "GET");
    if (path === "/v1.0/me/calendars") return json({ value: [{ id: "calendar", name: "Fixture", canEdit: true, canViewPrivateItems: true }] });
    if (path === "/v1.0/me/calendars/calendar") return mode === "initial-failure" ? json({}, 503) : json({ id: "calendar", canViewPrivateItems: true, canEdit: mode !== "native-denied" });
    if (path === "/v1.0/me/calendars/calendar/events") {
      if (!raced && ["local-race", "grant-race", "lease-race"].includes(mode)) {
        raced = true;
        if (mode === "local-race") await db.update(events).set({ revision: 2 }).where(eq(events.id, eventID));
        if (mode === "grant-race") await db.update(calendarMembers).set({ role: "viewer" }).where(eq(calendarMembers.calendarID, calendarID));
        if (mode === "lease-race") await db.update(eventOutbox).set({ leaseToken: randomUUID() }).where(eq(eventOutbox.id, operationID));
      }
      return json({ value: present && mode !== "unseen" ? [{ id: "series", transactionId: operationID }] : [] });
    }
    if (path === "/v1.0/me/calendars/calendar/events/series") return present ? json(native()) : json({ error: { code: "ErrorItemNotFound" } }, 404);
    if (path.endsWith("/events/series/instances")) {
      if (mode === "timeout") return;
      if (mode === "late-lease") await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, operationID));
      return json({ value: mode === "partial" ? instances().slice(0, 2) : instances() });
    }
    if (path.endsWith("/calendarView/delta")) return json({ value: instances(), "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/calendar/calendarView/delta?$deltatoken=fixture" });
    throw new Error(`Unexpected fixture route ${path}`);
  })().catch(error => { console.error(error); res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com"); return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init); };
  await db.insert(user).values({ id: actor, name: "Fixture", email: `${actor}@example.test`, isExternal: true });
  try {
    config.api.eventTimeEditsEnabled = true;
    await db.insert(account).values({ id: randomUUID(), userId: actor, providerId: "microsoft", accountId: "fixture", scope: "Calendars.ReadWrite", refreshToken: "fixture", accessToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
    const calendar = await importExternalCalendar("microsoft", actor, "fixture", "Fixture", { externalId: "calendar", name: "Fixture", color: "red" }); calendarID = calendar.id;
    const event = EventSchema.parse({ id: randomUUID(), revision: 1, creatorID: actor, organizer: actor, title: "Personal", color: "red", calendars: [calendar.id], originCalendarID: calendar.id, description: "Notes", location: "Office", isCanceled: false, recurrence: until ? (allDay ? "RRULE:FREQ=DAILY;UNTIL=20270102" : "RRULE:FREQ=DAILY;UNTIL=20260330T215959Z") : "RRULE:FREQ=DAILY;COUNT=4", ...time }); eventID = event.id;
    const queued = await queueGraphSeriesCreate(actor, randomUUID(), event); operationID = queued.operationID;
    const rows = () => db.select().from(events).where(eq(events.creatorID, actor)).orderBy(events.id);
    const maps = () => db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)).orderBy(externalEvents.id);
    const deliver = () => deliverEventOutbox(operationID, provider => provider === "microsoft" ? microsoftAdapter : null, { timeoutMs: mode === "timeout" ? 1000 : 10000 });
    if (scenario === "ack-db") {
      failureTrigger = `graph_worker_fail_${randomUUID().replace(/-/g, "")}`;
      await db.execute(sql.raw(`CREATE FUNCTION ${failureTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic transient storage failure'; END $$`));
      await db.execute(sql.raw(`CREATE TRIGGER ${failureTrigger} BEFORE INSERT ON external_events FOR EACH ROW WHEN (NEW.event_id = '${eventID}'::uuid) EXECUTE FUNCTION ${failureTrigger}()`));
    }
    if (scenario === "flag-off") config.api.eventTimeEditsEnabled = false;
    const transaction = db.transaction.bind(db); let transactionCalls = 0;
    if (scenario === "initial-db") (db as any).transaction = (...args: any[]) => ++transactionCalls === 2 ? Promise.reject(new Error("synthetic authority storage failure")) : (transaction as any)(...args);
    let result;
    try { result = scenario === "concurrent" ? (await Promise.all([deliver(), deliver()])).find(row => row?.status === "completed") : await deliver(); }
    finally { if (scenario === "initial-db") db.transaction = transaction; }

    if (["local-race", "grant-race", "lease-race", "changed-intent"].includes(scenario)) {
      assert.equal(posts, scenario === "changed-intent" ? 1 : 0); assert.equal((await maps()).length, 0);
      assert.equal(result!.status, scenario === "lease-race" ? "attempting" : "conflict");
      console.log(`Graph create worker ${until ? "UNTIL " : ""}${scenario}: fenced`); return;
    }
    if (["prague-recovery", "initial-failure", "initial-db", "ack-db", "unseen", "partial", "timeout", "late-lease", "flag-off", "native-denied", "absent"].includes(scenario)) {
      assert.equal(result!.status, ["initial-failure", "initial-db"].includes(scenario) ? "retry" : scenario === "late-lease" ? "attempting" : ["flag-off", "native-denied"].includes(scenario) ? "blocked" : "unconfirmed");
      assert.equal(result!.uncertain, !["initial-failure", "initial-db", "flag-off", "native-denied"].includes(scenario));
      assert.equal((await maps()).length, 0); assert.equal((await rows()).length, 1);
      assert.equal(result!.resultRef, null, "An incomplete family cannot leave a master-only ACK");
      if (failureTrigger) { await db.execute(sql.raw(`DROP TRIGGER ${failureTrigger} ON external_events`)); await db.execute(sql.raw(`DROP FUNCTION ${failureTrigger}()`)); failureTrigger = undefined; }
      const beforePosts = posts; mode = "normal"; config.api.eventTimeEditsEnabled = true;
      await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, operationID));
      if (scenario === "prague-recovery") {
        const [frozen] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)); assert.ok(frozen);
        await db.update(eventOutbox).set({ status: "conflict", uncertain: false }).where(eq(eventOutbox.id, operationID));
        await assert.rejects(() => requestEventDeliveryRetry(actor, eventID, operationID), { code: "delivery-conflict-unresolved" });
        assert.equal((await getEventDeliveryStatus(actor, eventID)).targets[0]!.graphCreateCheck, undefined);
        const { graphSeriesCreate: _create, ...ordinaryPayload } = frozen.payload;
        await db.update(eventOutbox).set({ uncertain: true, payload: ordinaryPayload }).where(eq(eventOutbox.id, operationID));
        await assert.rejects(() => requestEventDeliveryRetry(actor, eventID, operationID), { code: "delivery-conflict-unresolved" });
        assert.equal((await getEventDeliveryStatus(actor, eventID)).targets[0]!.graphCreateCheck, undefined);
        await db.update(eventOutbox).set({ payload: frozen.payload }).where(eq(eventOutbox.id, operationID));
        assert.equal((await getEventDeliveryStatus(actor, eventID)).targets[0]!.graphCreateCheck, true);
        const credential = issueMemberToken(); await replaceMemberToken(actor, credential.tokenHash);
        const app = express(); app.use(express.json()); app.post("/events/:eventId/delivery/:operationId/retry", requireAuth, handlerRetryEventDelivery); app.use(middlewareErrorHandler);
        const api = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => api.once("listening", resolve));
        try {
          const address = api.address(); assert.ok(address && typeof address !== "string");
          const response = await realFetch(`http://127.0.0.1:${address.port}/events/${eventID}/delivery/${operationID}/retry`, { method: "POST", headers: { authorization: `Bearer ${credential.raw}`, "content-type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: "{}" });
          assert.equal(response.status, 202);
          const [readmitted] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID));
          assert.deepEqual(readmitted!.payload, frozen.payload);
          assert.deepEqual(readmitted!.remoteSnapshot, frozen.remoteSnapshot);
          for (let i = 0; i < 300; i++) {
            [result] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID));
            if (result?.status === "completed") break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        } finally { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
      } else { await requestEventDeliveryRetry(actor, eventID, operationID); result = await deliver(); }
      if (scenario === "absent") {
        assert.equal(result!.status, "unconfirmed"); assert.equal(posts, 1, "Uncertain absence never repeats POST");
        console.log("Graph create worker uncertain absence: no repost"); return;
      }
      if (beforePosts) assert.equal(posts, beforePosts, "Recovery reuses the same native transaction");
    }
    assert.equal(result!.status, "completed"); assert.equal(result!.uncertain, false); assert.equal(posts, 1);
    assert.equal(result!.payload.event.recurrence, event.recurrence);
    assert.equal(result!.payload.graphSeriesCreate!.nativeEvent.recurrence, event.recurrence);
    const accepted = await rows(), acceptedMaps = await maps(); assert.equal(accepted.length, 5); assert.equal(acceptedMaps.length, 5);
    assert.equal(accepted.find(row => !row.seriesID)!.id, eventID); assert.equal(result!.resultRef!.externalEventId, "series");
    assert.equal(expandRecurringEvents(accepted, new Date(time.start.getTime() - 86400000), new Date(time.end.getTime() + 10 * 86400000), { consumerTimeZone: "UTC" }).length, 4);
    config.api.eventTimeEditsEnabled = false;
    await syncProvider(microsoftAdapter, actor, { id: "fixture", label: "Fixture" });
    assert.deepEqual(await rows(), accepted); assert.deepEqual(await maps(), acceptedMaps); assert.equal(posts, 1);
    console.log(`Graph create worker ${until ? "UNTIL " : ""}${scenario}: complete family, stable IDs and flag-off echo no-op`);
  } finally {
    if (failureTrigger) { await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failureTrigger} ON external_events`)); await db.execute(sql.raw(`DROP FUNCTION ${failureTrigger}()`)); }
    config.api.eventTimeEditsEnabled = flag; globalThis.fetch = realFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await db.delete(user).where(eq(user.id, actor)); }
}
async function main() { assert.equal(process.env.ENVIRONMENT, "test"); for (const scenario of ["prague-recovery", "normal", "concurrent", "all-day", "lost", "native-denied", "initial-db", "ack-db", "initial-failure", "unseen", "partial", "timeout", "late-lease", "flag-off", "absent", "local-race", "grant-race", "lease-race", "changed-intent"]) await run(scenario); for (const scenario of ["prague-recovery", "normal", "all-day", "lost", "partial", "absent", "changed-intent"]) await run(scenario, true); }
void main().catch(error => { console.error(error); process.exitCode = 1; });
