import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema } from "@musubi/types";
import { resolveEventTimeEdit, expandRecurringEvents } from "@musubi/calendar";
import { account, db, user, events, eventOutbox, calendarMembers, externalCalendars, importExternalCalendar, upsertExternalEvent, readGraphFamilyContext, replaceGraphFamily, applyLocalEventScope, claimEventOutbox } from "@musubi/db";
import { graphSeriesFamilyEvidence } from "./adapters/microsoft_series_family";
import { graphFamilyObservation } from "./adapters/microsoft_series_delete";
import { microsoftAdapter } from "./adapters/microsoft";
import { deliverEventOutbox } from "./event_delivery";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const oldFetch = globalThis.fetch, oldFlag = config.api.eventTimeEditsEnabled;
  config.api.eventTimeEditsEnabled = true;
  try {
    for (const mode of ["occurrence", "series", "all-day", "moved", "stale-admission", "stale-delivery", "sibling-change", "lost-applied", "lost-retained", "restart", "local-race", "denied", "private-denied-series", "masked-404-series", "calendar-denied-series", "calendar-partial-series", "calendar-malformed-series", "calendar-throttled-series"] as const) {
      const owner = `graph-delete-${randomUUID()}`, allDay = mode === "all-day";
      let deletes = 0, removed = false;
      const base: any = { id: "master", iCalUId: "master-uid", "@odata.etag": 'W/"master-1"', type: "seriesMaster", subject: "Series", body: { contentType: "text", content: "Notes" }, location: { displayName: "Office" }, organizer: { emailAddress: { address: "owner@example.test" } }, isOrganizer: true, isCancelled: false, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, attendees: [], isAllDay: allDay, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", start: { dateTime: `2026-09-25T${allDay ? "00" : "09"}:00:00`, timeZone: "UTC" }, end: { dateTime: allDay ? "2026-09-26T00:00:00" : "2026-09-25T10:00:00", timeZone: "UTC" }, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", numberOfOccurrences: 3, startDate: "2026-09-25", recurrenceTimeZone: "UTC" } }, cancelledOccurrences: [], exceptionOccurrences: [], isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: "busy", sensitivity: "normal", responseStatus: { response: "organizer" } };
      let instances: any[] = [25, 26, 27].map(day => ({ ...structuredClone(base), id: `occ-${day}`, iCalUId: `uid-${day}`, "@odata.etag": `W/"occ-${day}"`, type: "occurrence", seriesMasterId: "master", originalStart: `2026-09-${day}T${allDay ? "00" : "09"}:00:00Z`, recurrence: null, start: { dateTime: `2026-09-${day}T${allDay ? "00" : "09"}:00:00`, timeZone: "UTC" }, end: { dateTime: allDay ? `2026-09-${day + 1}T00:00:00` : `2026-09-${day}T10:00:00`, timeZone: "UTC" } }));
      if (mode === "moved") { instances[1].type = "exception"; instances[1].subject = "Moved appointment"; instances[1].start.dateTime = "2027-01-10T12:00:00"; instances[1].end.dateTime = "2027-01-10T13:00:00"; base.exceptionOccurrences = [instances[1]]; }
      const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com"); assert.equal(init?.redirect, "error");
        if (url.pathname === "/v1.0/me") return response({ id: "graph-user", mail: "owner@example.test", userPrincipalName: "owner@example.test" });
        if (removed && url.pathname === "/v1.0/me/calendars/native-calendar" && url.searchParams.get("$select") === "id,canViewPrivateItems") {
          if (mode === "calendar-throttled-series") return new Response(JSON.stringify({ error: { code: "TooManyRequests" } }), { status: 429, headers: { "Retry-After": "60" } });
          if (mode === "calendar-denied-series") return response({ error: { code: "ErrorAccessDenied" } }, 403);
          if (mode === "calendar-partial-series") return response({ id: "native-calendar", canViewPrivateItems: true }, 206);
          if (mode === "calendar-malformed-series") return new Response("{", { status: 200 });
        }
        if (url.pathname === "/v1.0/me/calendars/native-calendar") return response({ id: "native-calendar", canEdit: true, canViewPrivateItems: !(removed && mode === "private-denied-series"), owner: { address: "owner@example.test" } });
        if (url.pathname.endsWith("/instances")) return response({ value: instances });
        const nativeID = url.pathname.split("/").pop();
        if (init?.method === "DELETE") {
          deletes++;
          if (mode !== "lost-retained") {
            if (nativeID === "master") removed = true;
            else { instances = instances.filter(value => value.id !== nativeID); base.exceptionOccurrences = base.exceptionOccurrences.filter((value: any) => value.id !== nativeID); base.cancelledOccurrences.push("cancelled-native-slot"); base["@odata.etag"] = 'W/"master-2"'; }
          }
          if (mode.startsWith("lost-")) throw new Error("Lost response");
          return new Response(null, { status: 204 });
        }
        const native = removed ? undefined : nativeID === "master" ? base : instances.find(value => value.id === nativeID);
        return native ? response(native) : response({ error: { code: removed && mode === "masked-404-series" ? "ErrorAccessDenied" : "ErrorItemNotFound" } }, 404);
      };
      await db.insert(user).values({ id: owner, name: "Fixture", email: `${owner}@example.test` });
      try {
        await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "microsoft", accountId: "fixture", scope: "Calendars.ReadWrite", refreshToken: "fixture", accessToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
        const calendar = await importExternalCalendar("microsoft", owner, "fixture", "Fixture", { externalId: "native-calendar", name: "Fixture", color: "red" });
        const time = resolveEventTimeEdit(allDay ? { kind: "all-day", startDate: "2026-09-25", endDate: "2026-09-25" } : { kind: "zoned", timeZone: "UTC", startLocal: "2026-09-25T09:00:00", endLocal: "2026-09-25T10:00:00" });
        const template = EventSchema.parse({ id: randomUUID(), creatorID: owner, title: "Series", organizer: "owner@example.test", color: "red", recurrence: "RRULE:FREQ=DAILY;COUNT=3", isCanceled: false, calendars: [calendar.id], ...time });
        const observation = graphFamilyObservation(graphSeriesFamilyEvidence(base, instances, template, { externalEventId: "master", icalUid: "master-uid" }));
        await upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", "master", { ...observation.master.values, color: "red" }, base["@odata.etag"], "master-uid", undefined, { timeModel: time.timeModel }, undefined, observation.master.providerState);
        const address = { userID: owner, accountID: "fixture", calendarID: calendar.id, externalMasterID: "master" };
        await replaceGraphFamily(await readGraphFamilyContext(address), observation);
        const context = await readGraphFamilyContext(address), child = context.children.find(value => value.originalStart?.value.includes("2026-09-26"))!;
        const request = { action: "delete", operationID: randomUUID(), expectedRevision: context.root.revision, ...(mode.endsWith("series") ? { scope: "series" } : { scope: "occurrence", originalStart: child.originalStart, expectedOccurrenceRevision: child.revision }) };
        const required = await applyLocalEventScope(context.root.id, owner, request, { prepareProvider: true }); assert.equal(required.status, "graph_delete_required");
        if (mode === "stale-admission") { base["@odata.etag"] = 'W/"changed"'; await assert.rejects(() => microsoftAdapter.prepareGraphDeletion!(context, request)); assert.equal(deletes, 0); continue; }
        const proof = await microsoftAdapter.prepareGraphDeletion!(context, request);
        if (mode === "local-race") { await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, context.root.id)); const rejected = await applyLocalEventScope(context.root.id, owner, request, { graphDeletion: proof }); assert.equal(rejected.status, "conflict"); assert.equal(deletes, 0); continue; }
        const saved = await applyLocalEventScope(context.root.id, owner, request, { graphDeletion: proof }); assert.equal(saved.status, "saved");
        assert.equal((await applyLocalEventScope(context.root.id, owner, request, { prepareProvider: true })).status, "replayed");
        await assert.rejects(() => readGraphFamilyContext(address), "Pending delete fences family sync");
        if (mode === "stale-delivery") base["@odata.etag"] = 'W/"changed"';
        if (mode === "sibling-change") { instances[0].subject = "Concurrent change"; instances[0].type = "exception"; base.exceptionOccurrences = [instances[0]]; }
        if (mode === "denied") await db.update(calendarMembers).set({ role: "viewer" }).where(eq(calendarMembers.calendarID, calendar.id));
        if (mode === "restart") { await claimEventOutbox(request.operationID); await db.update(eventOutbox).set({ status: "unconfirmed", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, request.operationID)); }
        const run = () => deliverEventOutbox(request.operationID, () => microsoftAdapter);
        const result = await run();
        if (["stale-delivery", "sibling-change", "denied", "restart"].includes(mode)) { assert.equal(deletes, 0); assert.notEqual(result?.status, "completed"); }
        else if (["private-denied-series", "masked-404-series", "calendar-denied-series", "calendar-partial-series", "calendar-malformed-series", "calendar-throttled-series"].includes(mode)) {
          assert.equal(deletes, 1); assert.equal(result?.status, "unconfirmed");
          if (mode === "calendar-throttled-series") assert.ok(result!.nextAttemptAt.getTime() >= Date.now() + 55_000, "Negative proof preserves provider Retry-After lower bound");
          assert.equal(result?.uncertain, true); assert.equal(result?.resultRef, null);
          const acceptedPayload = result!.payload.event;
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, request.operationID));
          const recovered = await run();
          assert.equal(recovered?.status, "unconfirmed"); assert.equal(deletes, 1, "Permission loss or masked absence never authorizes another DELETE");
          assert.deepEqual(recovered?.payload.event, acceptedPayload);
        }
        else if (mode.startsWith("lost-")) {
          assert.equal(deletes, 1); assert.equal(result?.status, "unconfirmed");
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, request.operationID));
          assert.equal((await run())?.status, mode === "lost-applied" ? "completed" : "unconfirmed"); assert.equal(deletes, 1);
        } else { assert.equal(deletes, 1); assert.equal(result?.status, "completed", `${mode}: ${result?.errorCode}`); }
        if (["occurrence", "all-day", "moved", "series", "lost-applied"].includes(mode)) {
          const rows = await db.select().from(events).where(eq(events.creatorID, owner));
          const expanded = expandRecurringEvents(rows.filter(value => !value.deletedAt), new Date("2026-09-01Z"), new Date("2027-02-01Z"), { consumerTimeZone: "UTC" });
          assert.equal(expanded.length, mode === "series" ? 0 : 2);
          if (mode !== "series") assert.ok(rows.find(value => value.id === child.id)?.isCanceled);
        }
        console.log("Graph series delete:", mode, result?.status);
      } finally { await db.delete(user).where(eq(user.id, owner)); }
    }
  } finally { globalThis.fetch = oldFetch; config.api.eventTimeEditsEnabled = oldFlag; }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
