import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, OutlookMoveRequestSchema, OutlookMoveResultSchema } from "@musubi/types";
import { resolveEventTimeEdit } from "@musubi/calendar";
import { account, db, user, events, externalEvents, eventOutbox, outlookMoves, externalCalendars,
  importExternalCalendar, upsertExternalEvent, readGraphFamilyContext, replaceGraphFamily, getEventSnapshot,
  readOutlookMove, startOutlookMove, outlookMoveResult, claimOutlookMove, latestOutlookMove,
  claimEventOutbox, markGraphOccurrenceContent, getOwnProviderEventObservation } from "@musubi/db";
import { graphSeriesFamilyEvidence } from "./adapters/microsoft_series_family";
import { graphFamilyObservation } from "./adapters/microsoft_series_delete";
import { microsoftAdapter, toNormalized } from "./adapters/microsoft";
import { outlookMoveChoices, previewOutlookMove, advanceOutlookMove } from "./outlook_moves";
import { observeProviderOrganizer } from "./provider_organizer";
import { deliverEventOutbox } from "./event_delivery";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const originalFetch = globalThis.fetch;
  config.api.providerOrganizerEditsEnabled = config.api.eventTimeEditsEnabled = true;
  try {
    for (const mode of ["personal", "meeting", "scrambled-order", "middle-lost-response", "middle-accepted-late-ack", "flat", "double-start", "concurrent-workers", "stale-native", "stale-local", "second-conflict", "lost-response", "restart-before", "accepted-recovery", "foreign-owner", "expired", "foreign-slot", "changed-slot", "cross-date", "duplicate-slot", "reused-id", "flag-off", "disconnect", "sibling-change", "late-cancellation", "legacy-client", "redacted-read", "access-revision", "second-batch"]) {
      const owner = `bulk-${randomUUID()}`, meeting = mode !== "personal";
      let writes = 0, providerCalls = 0;
      let hiddenAfterSecond: { base: any; instances: any[] } | undefined;
      const mutationIDs: string[] = [];
      const base: any = { id: "master", iCalUId: "master-uid", "@odata.etag": 'W/"master-0"', createdDateTime: "2026-09-01T10:00:00Z", type: "seriesMaster", subject: "Series", body: { contentType: "text", content: "Notes" }, location: { displayName: "Office" }, organizer: { emailAddress: { address: "owner@example.test" } }, isOrganizer: true, isCancelled: false, isDraft: false, isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, attendees: meeting ? [{ emailAddress: { address: "guest@example.test" }, type: "required", status: { response: "accepted" } }] : [], hasAttachments: false, isAllDay: false, originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", start: { dateTime: "2026-10-01T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-01T10:00:00", timeZone: "UTC" }, recurrence: { pattern: { type: "daily", interval: 3 }, range: { type: "numbered", numberOfOccurrences: 5, startDate: "2026-10-01", recurrenceTimeZone: "UTC" } }, cancelledOccurrences: ["cancelled-13"], exceptionOccurrences: [], isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: "busy", sensitivity: "normal", responseStatus: { response: "organizer" } };
      const instances: any[] = [1, 4, 7, 10].map(day => { const d = String(day).padStart(2, "0"); return { ...structuredClone(base), id: `occ-${d}`, iCalUId: `uid-${d}`, "@odata.etag": `W/"occ-${d}-0"`, type: day === 10 ? "exception" : "occurrence", subject: day === 10 ? "Independent title" : "Series", seriesMasterId: "master", originalStart: `2026-10-${d}T09:00:00Z`, recurrence: null, start: { dateTime: `2026-10-${d}T${day === 10 ? "12" : "09"}:00:00`, timeZone: "UTC" }, end: { dateTime: `2026-10-${d}T${day === 10 ? "13" : "10"}:00:00`, timeZone: "UTC" } }; });
      base.exceptionOccurrences = [instances[3]];
      const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      function apply(native: any, patch: any) {
        Object.assign(native, patch, { type: "exception", createdDateTime: "2026-09-23T12:00:00Z" });
        if (meeting) native.attendees[0].status = { response: "notResponded", time: "4501-01-01T00:00:00Z" };
        for (const n of [base, ...instances]) n["@odata.etag"] = `W/"${n.id}-${writes}"`;
        base.exceptionOccurrences = instances.filter(n => n.type === "exception");
      }
      globalThis.fetch = async (input, init) => {
        providerCalls++; const url = new URL(String(input)); assert.equal(url.origin, "https://graph.microsoft.com"); assert.equal(init?.redirect, "error");
        if (url.pathname === "/v1.0/me") return response({ id: "graph-user", mail: "owner@example.test", userPrincipalName: "owner@example.test" });
        if (url.pathname === "/v1.0/me/calendar") return response({ id: "native-calendar", isDefaultCalendar: true, canEdit: true, owner: { address: "owner@example.test" } });
        if (url.pathname === "/v1.0/me/calendars/native-calendar") return response({ id: "native-calendar" });
        if (url.pathname.endsWith("/instances")) return response({ value: hiddenAfterSecond?.instances ?? instances });
        const id = url.pathname.split("/").pop();
        const native = id === "master" ? base : instances.find(n => n.id === id);
        if (init?.method === "PATCH") {
          assert.notEqual(id, "master"); assert.notEqual(id, "occ-10");
          assert.equal(new Headers(init.headers).get("If-Match"), native["@odata.etag"]);
          writes++; mutationIDs.push(String(id));
          const [child] = await db.select().from(eventOutbox).where(eq(eventOutbox.actorID, owner)).then(rows => rows.filter(n => n.status === "attempting"));
          assert.ok(child!.payload.graphOccurrenceContent?.dispatch?.startedAt);
          const [parent] = await db.select().from(outlookMoves).where(eq(outlookMoves.id, child!.payload.graphOccurrenceContent!.bulkMove!.operationID));
          assert.equal(parent!.journal.items.find(n => n.nativeID === id)?.status, "queued");
          if (mode === "second-conflict" && id === "occ-04") return response({ error: { code: "ErrorPreconditionFailed" } }, 412);
          const patch = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(patch).sort(), ["end", "start"]);
          if (mode === "middle-accepted-late-ack" && id === "occ-04") hiddenAfterSecond = { base: structuredClone(base), instances: structuredClone(instances) };
          apply(native, patch);
          if (mode === "lost-response" || mode === "middle-lost-response" && id === "occ-04") throw new Error("Lost native response");
          return response(native);
        }
        const visible = hiddenAfterSecond ? id === "master" ? hiddenAfterSecond.base : hiddenAfterSecond.instances.find(n => n.id === id) : native;
        return visible ? response(visible) : response({}, 404);
      };
      await db.insert(user).values({ id: owner, name: "Fixture", email: `${owner}@example.test` });
      try {
        await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "microsoft", accountId: "fixture", scope: "Calendars.ReadWrite", refreshToken: "fixture", accessToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
        const calendar = await importExternalCalendar("microsoft", owner, "fixture", "Fixture", { externalId: "native-calendar", name: "Fixture", color: "red" });
        const time = resolveEventTimeEdit({ kind: "zoned", timeZone: "UTC", startLocal: "2026-10-01T09:00:00", endLocal: "2026-10-01T10:00:00" });
        const template = EventSchema.parse({ id: randomUUID(), creatorID: owner, title: "Series", organizer: "owner@example.test", color: "red", recurrence: "RRULE:FREQ=DAILY;INTERVAL=3;COUNT=5", isCanceled: false, calendars: [calendar.id], ...time });
        const observation = graphFamilyObservation(graphSeriesFamilyEvidence(base, instances, template, { externalEventId: "master", icalUid: "master-uid" }));
        if (mode !== "flat") {
          await upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", "master", { ...observation.master.values, color: "red" }, base["@odata.etag"], "master-uid", undefined, { timeModel: time.timeModel }, undefined, observation.master.providerState);
          const address = { userID: owner, accountID: "fixture", calendarID: calendar.id, externalMasterID: "master" };
          await replaceGraphFamily(await readGraphFamilyContext(address), observation);
        } else for (const item of instances) {
          const n = toNormalized(item);
          await upsertExternalEvent("microsoft", owner, calendar.id, "native-calendar", n.externalId, { title: n.title, start: n.start, end: n.end, isAllDay: n.isAllDay, description: n.description, location: n.location, organizer: n.organizer ?? "", recurrence: null, url: n.url, color: "red" }, n.etag, n.icalUid, undefined, undefined, { externalSeriesID: "master", originalStart: { kind: "instant", value: new Date(item.originalStart).toISOString() } }, n.providerState, undefined, "master");
        }
        const maps = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id));
        const eventID = maps.find(m => m.externalEventID === "occ-01")!.eventID;
        const choices = await outlookMoveChoices(owner, eventID, calendar.id);
        assert.equal(choices.occurrences.length, 3); assert.equal(choices.preserved.edited, 1); assert.equal(choices.preserved.cancelled, 1);
        const request = { operationID: randomUUID(), eventID, calendarID: calendar.id, expectedVersion: choices.version, eventIDs: choices.occurrences.map(n => n.eventID), offsetMinutes: 60 };
        if (mode === "legacy-client") {
          const state = await getOwnProviderEventObservation(owner, eventID);
          assert.equal((await observeProviderOrganizer(owner, eventID, state, "series-time")).outlookOccurrenceMove, undefined);
          assert.deepEqual((await observeProviderOrganizer(owner, eventID, state, "occurrence-move")).outlookOccurrenceMove, { calendarID: calendar.id }); continue;
        }
        if (mode === "scrambled-order") request.eventIDs.reverse();
        if (mode === "foreign-slot") request.eventIDs = [randomUUID()];
        if (mode === "changed-slot") request.eventIDs = [maps.find(m => m.externalEventID === "occ-10")!.eventID];
        if (mode === "cross-date") request.offsetMinutes = -720;
        if (mode === "duplicate-slot") request.eventIDs = [eventID, eventID];
        if (["foreign-slot", "changed-slot", "cross-date", "duplicate-slot"].includes(mode)) { await assert.rejects(previewOutlookMove(owner, request)); assert.equal(writes, 0); continue; }
        OutlookMoveRequestSchema.parse(request);
        const preview = await previewOutlookMove(owner, request);
        assert.equal(preview.status, "preview"); assert.equal(writes, 0);
        if (mode === "scrambled-order") {
          assert.deepEqual(preview.journal.request.eventIDs, request.eventIDs);
          assert.deepEqual(preview.journal.items.map(item => item.nativeID), ["occ-01", "occ-04", "occ-07"], "Admission sorts original slots, preserving the scrambled request separately");
        }
        assert.equal((await previewOutlookMove(owner, request)).id, preview.id);
        assert.equal((await latestOutlookMove(owner, eventID, calendar.id))!.id, preview.id);
        assert.ok(!JSON.stringify(outlookMoveResult(preview)).includes("owner@example.test"));
        if (mode === "reused-id") { await assert.rejects(previewOutlookMove(owner, { ...request, offsetMinutes: 30 })); continue; }
        if (mode === "foreign-owner") { await assert.rejects(readOutlookMove("someone-else", preview.id)); await assert.rejects(startOutlookMove("someone-else", preview.id)); continue; }
        if (mode === "expired") { await db.update(outlookMoves).set({ expiresAt: new Date(0) }).where(eq(outlookMoves.id, preview.id)); await assert.rejects(startOutlookMove(owner, preview.id)); continue; }
        if (mode === "stale-local") { await db.update(events).set({ revision: sql`${events.revision} + 1` }).where(eq(events.id, eventID)); await assert.rejects(startOutlookMove(owner, preview.id)); continue; }
        if (mode === "redacted-read") {
          await db.update(externalEvents).set({ readRedactionRevision: 1 }).where(eq(externalEvents.eventID, choices.occurrences[1]!.eventID));
          await assert.rejects(readOutlookMove(owner, preview.id));
          await assert.rejects(latestOutlookMove(owner, eventID, calendar.id));
          await assert.rejects(startOutlookMove(owner, preview.id)); continue;
        }
        if (mode === "access-revision") {
          await db.update(externalCalendars).set({ providerAccessRevision: sql`${externalCalendars.providerAccessRevision} + 1` }).where(eq(externalCalendars.calendarID, calendar.id));
          await assert.rejects(readOutlookMove(owner, preview.id));
          await assert.rejects(startOutlookMove(owner, preview.id)); continue;
        }
        const second = mode === "second-batch" ? await previewOutlookMove(owner, { ...request, operationID: randomUUID() }) : undefined;
        await startOutlookMove(owner, preview.id);
        if (second) { await assert.rejects(startOutlookMove(owner, second.id)); assert.equal((await latestOutlookMove(owner, eventID, calendar.id))!.id, preview.id); }
        if (mode === "double-start") await Promise.all([startOutlookMove(owner, preview.id), startOutlookMove(owner, preview.id)]);
        if (mode === "stale-native") instances[1].subject = "Concurrent edit";
        if (mode === "flag-off") config.api.eventTimeEditsEnabled = false;
        if (mode === "disconnect") await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.calendarID, calendar.id));
        if (mode === "restart-before") { assert.ok(await claimOutlookMove(preview.id)); await db.update(outlookMoves).set({ leaseUntil: new Date(0) }).where(eq(outlookMoves.id, preview.id)); }
        for (let iteration = 0; iteration < 8; iteration++) {
          await Promise.all(mode === "concurrent-workers" ? [advanceOutlookMove(preview.id), advanceOutlookMove(preview.id)] : [advanceOutlookMove(preview.id)]);
          const [row] = await db.select().from(outlookMoves).where(eq(outlookMoves.id, preview.id));
          if (row!.status !== "running") break;
          const item = row!.journal.items.find(n => n.status === "queued");
          if (item) {
            if (mode === "accepted-recovery" && writes === 0) {
              const leased = (await claimEventOutbox(item.operationID))!;
              await markGraphOccurrenceContent(leased); writes++;
              apply(instances[0], { start: { dateTime: "2026-10-01T10:00:00.000", timeZone: "UTC" }, end: { dateTime: "2026-10-01T11:00:00.000", timeZone: "UTC" } });
              await markGraphOccurrenceContent(leased, true);
              await db.update(eventOutbox).set({ leaseUntil: new Date(0) }).where(eq(eventOutbox.id, item.operationID));
            }
            await deliverEventOutbox(item.operationID, () => microsoftAdapter, { timeoutMs: 10_000 });
            if (writes === 1 && mode === "sibling-change") { instances[1].subject = "Concurrent edit"; }
            if (writes === 1 && mode === "late-cancellation") { instances.splice(1, 1); base.cancelledOccurrences.push("cancelled-04"); }
          }
        }
        const [row] = await db.select().from(outlookMoves).where(eq(outlookMoves.id, preview.id));
        const result = OutlookMoveResultSchema.parse(outlookMoveResult(row!));
        if (["stale-native", "flag-off", "disconnect"].includes(mode)) { assert.equal(result.status, "stopped"); assert.equal(writes, 0); assert.deepEqual(result.items.map(n => n.status), ["failed", "not-started", "not-started"]); }
        else if (["second-conflict", "sibling-change", "late-cancellation"].includes(mode)) { assert.equal(result.status, "stopped"); assert.equal(writes, mode === "second-conflict" ? 2 : 1); assert.deepEqual(result.items.map(n => n.status), ["completed", "failed", "not-started"]); }
        else if (mode === "middle-lost-response" || mode === "middle-accepted-late-ack") {
          assert.equal(result.status, "stopped"); assert.equal(writes, 2);
          assert.deepEqual(result.items.map(n => n.status), ["completed", "unconfirmed", "not-started"]);
          assert.deepEqual(mutationIDs, ["occ-01", "occ-04"], "A middle uncertain child preserves the first ACK and prevents a third send");
          const second = row!.journal.items[1]!;
          const [uncertain] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, second.operationID));
          assert.equal(uncertain!.status, "unconfirmed");
          assert.equal(!!uncertain!.payload.graphOccurrenceContent!.dispatch?.acceptedAt, mode === "middle-accepted-late-ack", "Native acceptance remains separate from an uncertain outcome");
          const pendingRows = await db.select().from(eventOutbox).where(eq(eventOutbox.actorID, owner));
          const stoppedCalls = providerCalls;
          await advanceOutlookMove(preview.id); await advanceOutlookMove(preview.id);
          assert.deepEqual(await db.select().from(eventOutbox).where(eq(eventOutbox.actorID, owner)), pendingRows);
          assert.equal(providerCalls, stoppedCalls, "A stopped coordinator cannot observe, admit or dispatch its remaining child");
          if (mode === "middle-accepted-late-ack") {
            hiddenAfterSecond = undefined;
            await db.update(eventOutbox).set({ leaseUntil: new Date(0), nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, second.operationID));
            assert.equal((await deliverEventOutbox(second.operationID, () => microsoftAdapter, { timeoutMs: 10_000 }))?.status, "completed", "The accepted child can recover after the parent stopped");
            const [late] = await db.select().from(outlookMoves).where(eq(outlookMoves.id, preview.id));
            assert.equal(late!.status, "stopped"); assert.deepEqual(late!.journal.items.map(n => n.status), ["completed", "completed", "not-started"]);
            const actual = graphFamilyObservation(graphSeriesFamilyEvidence(base, instances, template, { externalEventId: "master", icalUid: "master-uid" }));
            assert.deepEqual(late!.journal.expected, JSON.parse(JSON.stringify(actual)), "Late child ACK atomically saves the entire native family proof");
            const secondEvent = await getEventSnapshot(second.eventID);
            const [secondMapping] = await db.select().from(externalEvents).where(eq(externalEvents.eventID, second.eventID));
            assert.equal(secondEvent!.start.toISOString(), "2026-10-04T10:00:00.000Z");
            assert.deepEqual(secondEvent!.originalStart, { kind: "instant", value: "2026-10-04T09:00:00.000Z" });
            assert.equal(secondMapping!.etag, instances[1]["@odata.etag"]);
            const completedRows = await db.select().from(eventOutbox).where(eq(eventOutbox.actorID, owner));
            const recoveredCalls = providerCalls;
            await advanceOutlookMove(preview.id); await advanceOutlookMove(preview.id);
            assert.deepEqual(await db.select().from(eventOutbox).where(eq(eventOutbox.actorID, owner)), completedRows);
            assert.equal(providerCalls, recoveredCalls); assert.equal(writes, 2, "A late ACK never resumes the final child");
          }
        }
        else if (mode === "lost-response") { assert.equal(result.status, "stopped"); assert.equal(writes, 1); assert.deepEqual(result.items.map(n => n.status), ["unconfirmed", "not-started", "not-started"]); await advanceOutlookMove(preview.id); assert.equal(writes, 1); }
        else { assert.equal(result.status, "completed", mode); assert.equal(writes, 3); assert.ok(result.items.every(n => n.status === "completed")); }
        if (mode === "scrambled-order") assert.deepEqual(mutationIDs, ["occ-01", "occ-04", "occ-07"], "Native dispatch follows original slots rather than request order");
        assert.equal(base.start.dateTime, "2026-10-01T09:00:00");
        assert.equal(instances.find(n => n.id === "occ-10").subject, "Independent title");
        assert.ok(base.cancelledOccurrences.includes("cancelled-13"));
        if (result.items[0]!.status === "completed") assert.equal((await getEventSnapshot(eventID))!.start.toISOString(), "2026-10-01T10:00:00.000Z");
      } finally { config.api.eventTimeEditsEnabled = true; await db.delete(eventOutbox).where(eq(eventOutbox.actorID, owner)); await db.delete(user).where(eq(user.id, owner)); }
      console.log(`outlook bulk move: ${mode} passed`);
    }
  } finally { globalThis.fetch = originalFetch; }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
