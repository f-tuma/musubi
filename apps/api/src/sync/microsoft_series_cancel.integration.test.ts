import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, ProviderEventStateResponseSchema } from "@musubi/types";
import { resolveEventTimeEdit, expandRecurringEvents } from "@musubi/calendar";
import { account, db, user, events, externalEvents, eventOutbox, calendarMembers, importExternalCalendar, upsertExternalEvent, readGraphFamilyContext, replaceGraphFamily, claimEventOutbox, getOwnProviderEventObservation, getEventSnapshot, markGraphMeetingCancellation, completeEventOutbox, requestEventDeliveryRetry } from "@musubi/db";
import { graphSeriesFamilyEvidence } from "./adapters/microsoft_series_family";
import { graphFamilyObservation } from "./adapters/microsoft_series_delete";
import { microsoftAdapter, toNormalized } from "./adapters/microsoft";
import { observeProviderOrganizer, queueProviderOrganizer } from "./provider_organizer";
import { deliverEventOutbox } from "./event_delivery";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const oldFetch = globalThis.fetch, oldFlag = config.api.providerOrganizerEditsEnabled;
  config.api.providerOrganizerEditsEnabled = true;
  try {
    for (const mode of ["occurrence", "series", "canonical", "canonical-series", "all-day", "moved", "stale-admission", "stale-delivery", "sibling-change", "lost-applied", "lost-retained", "restart", "accepted-recovery", "local-race", "denied", "identity", "partial", "survivor-changed", "private-denied-series", "masked-404-series", "calendar-denied-series", "calendar-partial-series", "calendar-malformed-series", "calendar-throttled-series"] as const) {
      const owner = `graph-series-cancel-${randomUUID()}`, allDay = mode === "all-day";
      let cancels = 0, removed = false, delivery = false;
      const base: any = { id: "master", iCalUId: "master-uid", "@odata.etag": 'W/"master-1"', type: "seriesMaster", subject: "Series", body: { contentType: "text", content: "Notes" }, location: { displayName: "Office" }, organizer: { emailAddress: { address: "owner@example.test" } }, isOrganizer: true, isCancelled: false, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, attendees: [{ emailAddress: { address: "guest@example.test" }, type: "required", status: { response: "accepted" } }], hasAttachments: false, isAllDay: allDay, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", start: { dateTime: `2026-09-25T${allDay ? "00" : "09"}:00:00`, timeZone: "UTC" }, end: { dateTime: allDay ? "2026-09-26T00:00:00" : "2026-09-25T10:00:00", timeZone: "UTC" }, recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", numberOfOccurrences: 3, startDate: "2026-09-25", recurrenceTimeZone: "UTC" } }, cancelledOccurrences: [], exceptionOccurrences: [], isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: "busy", sensitivity: "normal", responseStatus: { response: "organizer" } };
      let instances: any[] = [25, 26, 27].map(day => ({ ...structuredClone(base), id: `occ-${day}`, iCalUId: `uid-${day}`, "@odata.etag": `W/"occ-${day}"`, type: "occurrence", seriesMasterId: "master", originalStart: `2026-09-${day}T${allDay ? "00" : "09"}:00:00Z`, recurrence: null, start: { dateTime: `2026-09-${day}T${allDay ? "00" : "09"}:00:00`, timeZone: "UTC" }, end: { dateTime: allDay ? `2026-09-${day + 1}T00:00:00` : `2026-09-${day}T10:00:00`, timeZone: "UTC" } }));
      if (mode === "moved") { instances[1].type = "exception"; instances[1].subject = "Moved appointment"; instances[1].start.dateTime = "2027-01-10T12:00:00"; instances[1].end.dateTime = "2027-01-10T13:00:00"; base.exceptionOccurrences = [instances[1]]; }

      const originalInstances = structuredClone(instances);
      function applyCancellation(id: string) {
        if (id === "master") removed = true;
        else {
          instances = instances.filter(value => value.id !== id);
          base.exceptionOccurrences = base.exceptionOccurrences.filter((value: any) => value.id !== id);
          base.cancelledOccurrences.push("cancelled-slot"); base["@odata.etag"] = 'W/"master-2"';
        }
      }
      const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com"); assert.equal(init?.redirect, "error");
        if (url.pathname === "/v1.0/me") return response({ id: delivery && mode === "identity" ? "other-user" : "graph-user", mail: "owner@example.test", userPrincipalName: "owner@example.test" });
        if (url.pathname === "/v1.0/me/calendar") return response({ id: "native-calendar", isDefaultCalendar: true, canEdit: true, owner: { address: "owner@example.test" } });
        if (removed && url.pathname === "/v1.0/me/calendars/native-calendar" && url.searchParams.get("$select") === "id,canViewPrivateItems") {
          if (mode === "calendar-throttled-series") return new Response(JSON.stringify({ error: { code: "TooManyRequests" } }), { status: 429, headers: { "Retry-After": "60" } });
          if (mode === "calendar-denied-series") return response({ error: { code: "ErrorAccessDenied" } }, 403);
          if (mode === "calendar-partial-series") return response({ id: "native-calendar", canViewPrivateItems: true }, 206);
          if (mode === "calendar-malformed-series") return new Response("{", { status: 200 });
        }
        if (url.pathname === "/v1.0/me/calendars/native-calendar") return response({ id: "native-calendar", canViewPrivateItems: !(removed && mode === "private-denied-series") });
        if (url.pathname.endsWith("/instances")) return response({ value: mode === "partial" ? instances.slice(0, 1) : instances });
        if (url.pathname.endsWith("/cancel")) {
          assert.equal(init?.method, "POST"); assert.deepEqual(JSON.parse(String(init.body)), {});
          const id = url.pathname.split("/").slice(-2)[0]!; cancels++;
          const journal = (await db.select().from(eventOutbox).where(eq(eventOutbox.actorID, owner))).find(row => row.status === "attempting")!;
          assert.ok(journal.payload.graphMeetingCancellation?.dispatch?.startedAt, "Permanent marker precedes POST");
          if (mode !== "lost-retained") applyCancellation(id);
          if (mode.startsWith("lost-")) throw new Error("Lost response");
          if (mode === "survivor-changed") { instances[0].type = "exception"; instances[0].subject = "A concurrent edit"; base.exceptionOccurrences = [instances[0]]; }
          return new Response(null, { status: 202 });
        }
        const nativeID = url.pathname.split("/").pop();
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
        if (mode.startsWith("canonical")) {
          await upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", "master", { ...observation.master.values, color: "red" }, base["@odata.etag"], "master-uid", undefined, { timeModel: time.timeModel }, undefined, observation.master.providerState);
          const address = { userID: owner, accountID: "fixture", calendarID: calendar.id, externalMasterID: "master" };
          await replaceGraphFamily(await readGraphFamilyContext(address), observation);
        } else {
          for (const item of originalInstances) {
            const n = toNormalized(item);
            await upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", n.externalId, { title: n.title, start: n.start, end: n.end, isAllDay: n.isAllDay, description: n.description, location: n.location, organizer: n.organizer ?? "", recurrence: null, url: n.url, color: "red" }, n.etag, n.icalUid, undefined, undefined, { externalSeriesID: "master", originalStart: { kind: "instant", value: new Date(item.originalStart).toISOString() } }, n.providerState, undefined, "master");
          }
        }
        const mapping = (await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id))).find(m => m.externalEventID === "occ-26")!;
        const event = (await getEventSnapshot(mapping.eventID))!;
        const state = await getOwnProviderEventObservation(owner, event.id);
        assert.equal((await observeProviderOrganizer(owner, event.id, state, true)).outlookCancellation, undefined, "v1 clients never receive a new strict response field");
        const capability = await observeProviderOrganizer(owner, event.id, state, "series");
        if (mode === "partial") { assert.equal(capability.outlookCancellation, undefined); assert.equal(cancels, 0); continue; }
        ProviderEventStateResponseSchema.parse(capability);
        assert.ok(capability.outlookCancellation, `No capability: ${mode}`);
        const request = { provider: "microsoft", action: "delete", notificationPolicy: "server-invite", operationID: randomUUID(), eventID: event.id, calendarID: calendar.id, scope: mode.endsWith("series") ? "series" : "occurrence", expectedRevision: event.revision, expectedStateVersion: state.version, expectedSeriesVersion: capability.outlookCancellation.seriesVersion };
        if (mode === "stale-admission") { base["@odata.etag"] = 'W/"changed"'; await assert.rejects(() => queueProviderOrganizer(owner, request)); assert.equal(cancels, 0); continue; }
        await queueProviderOrganizer(owner, request);
        assert.equal((await queueProviderOrganizer(owner, request)).replayed, true);
        await assert.rejects(() => queueProviderOrganizer(owner, { ...request, scope: request.scope === "series" ? "occurrence" : "series" }));
        const n = observation.instances[0];
        await assert.rejects(() => upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", n.externalID, { ...n.values, color: "red" }, n.etag, n.icalUid), "Pending family cancellation fences ordinary pull");
        if (mode === "stale-delivery") base["@odata.etag"] = 'W/"changed"';
        if (mode === "sibling-change") { instances[0].type = "exception"; instances[0].subject = "Concurrent change"; base.exceptionOccurrences = [instances[0]]; }
        if (mode === "denied") await db.update(calendarMembers).set({ role: "viewer" }).where(eq(calendarMembers.calendarID, calendar.id));
        if (mode === "local-race") await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, event.id));
        if (mode === "restart" || mode === "accepted-recovery") {
          const claimed = await claimEventOutbox(request.operationID); assert.ok(claimed);
          assert.equal(await completeEventOutbox(claimed.id, claimed.leaseToken!, null, null), undefined, "Generic ACK rejects private cancellation");
          await markGraphMeetingCancellation(claimed);
          if (mode === "accepted-recovery") { applyCancellation("occ-26"); await markGraphMeetingCancellation(claimed, true); }
          await db.update(eventOutbox).set({ status: "unconfirmed", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, request.operationID));
        }
        delivery = true;
        const run = () => deliverEventOutbox(request.operationID, () => microsoftAdapter);
        const result = await run();
        const succeeds = ["occurrence", "series", "canonical", "canonical-series", "all-day", "moved", "accepted-recovery"].includes(mode);
        assert.equal(result?.status === "completed", succeeds, `${mode}: ${result?.status} ${result?.errorCode}`);
        assert.equal(cancels, ["occurrence", "series", "canonical", "canonical-series", "all-day", "moved", "lost-applied", "lost-retained", "survivor-changed", "private-denied-series", "masked-404-series", "calendar-denied-series", "calendar-partial-series", "calendar-malformed-series", "calendar-throttled-series"].includes(mode) ? 1 : 0);
        if (["private-denied-series", "masked-404-series", "calendar-denied-series", "calendar-partial-series", "calendar-malformed-series", "calendar-throttled-series"].includes(mode)) {
          assert.equal(result?.status, "unconfirmed", "Accepted cancel cannot ACK an absence hidden by permission loss or a masked 404");
          if (mode === "calendar-throttled-series") assert.ok(result!.nextAttemptAt.getTime() >= Date.now() + 55_000, "Negative proof preserves provider Retry-After lower bound");
          assert.equal(result?.uncertain, true); assert.equal(result?.resultRef, null);
          assert.ok(result?.payload.graphMeetingCancellation?.dispatch?.startedAt);
          const acceptedPayload = result!.payload.event;
          await requestEventDeliveryRetry(owner, event.id, request.operationID);
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, request.operationID));
          const recovered = await run();
          assert.equal(recovered?.status, "unconfirmed"); assert.equal(cancels, 1, "Failed native authority proof never repeats cancel POST");
          assert.deepEqual(recovered?.payload.event, acceptedPayload);
        }
        if (["lost-applied", "lost-retained", "restart", "survivor-changed"].includes(mode)) {
          const count = cancels;
          await requestEventDeliveryRetry(owner, event.id, request.operationID);
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, request.operationID));
          assert.notEqual((await run())?.status, "completed"); assert.equal(cancels, count, "Retries must never send another cancellation");
        }
        if (succeeds) {
          const rows = await db.select().from(events).where(eq(events.creatorID, owner));
          const visible = expandRecurringEvents(rows.filter(e => !e.deletedAt), new Date("2026-09-01Z"), new Date("2027-02-01Z"), { consumerTimeZone: "UTC" });
          assert.equal(visible.length, request.scope === "series" ? 0 : 2);
          const late = toNormalized(originalInstances[1]);
          assert.equal(await upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", late.externalId, { ...observation.instances[1].values, color: "red" }, late.etag, late.icalUid, undefined, undefined, { externalSeriesID: "master", originalStart: { kind: "instant", value: new Date(originalInstances[1].originalStart).toISOString() } }, late.providerState, undefined, "master"), false, "A stale active pull cannot resurrect a cancelled occurrence");
        }
        if (["occurrence", "canonical", "stale-delivery"].includes(mode)) {
          const maps = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id));
          const next = (await getEventSnapshot(maps.find(m => m.externalEventID === (mode === "stale-delivery" ? "occ-26" : "occ-25"))!.eventID))!;
          const nextState = await getOwnProviderEventObservation(owner, next.id);
          const refreshed = await observeProviderOrganizer(owner, next.id, nextState, "series");
          assert.ok(refreshed.outlookCancellation, "A stopped request or cancelled occurrence must not block a new series cancellation");
          const replace = { ...request, operationID: randomUUID(), eventID: next.id, scope: "series", expectedRevision: next.revision, expectedStateVersion: nextState.version, expectedSeriesVersion: refreshed.outlookCancellation.seriesVersion };
          await queueProviderOrganizer(owner, replace);
          assert.equal((await deliverEventOutbox(replace.operationID, () => microsoftAdapter))?.status, "completed");
        }
        console.log("Graph meeting series:", mode, result?.status);
      } finally { await db.delete(user).where(eq(user.id, owner)); }
    }
  } finally { globalThis.fetch = oldFetch; config.api.providerOrganizerEditsEnabled = oldFlag; }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
