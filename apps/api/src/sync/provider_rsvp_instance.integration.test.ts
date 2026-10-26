import express from "express";
import { account, replaceMemberToken } from "@musubi/db";
import { CLIENT_VERSION_HEADER, PRODUCT_VERSION, ProviderRsvpReceiptSchema } from "@musubi/types";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { handlerGetProviderEventState, handlerProviderRsvpEdit } from "../handlers/events";
import { prepareEventDeliveryResolution } from "./event_resolution";
import { commitEventDeliveryResolution, getEventDeliveryResolutionReplay } from "@musubi/db";
import { createServer } from "node:http";
import { config } from "@musubi/config";
import { googleAdapter } from "./adapters/google";
import { googleRsvpMethods } from "./adapters/google_rsvp_delivery";
import { deliverEventOutbox } from "./event_delivery";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, user, events, externalEvents, externalCalendars, calendarEvents, eventOutbox, createCalendar, upsertExternalEvent, getEventSnapshot, getOwnProviderEventObservation, prepareProviderRsvpEdit, commitProviderRsvpEdit, completeEventOutbox, hasProviderRsvpSource, calendarMembers } from "@musubi/db";
import { googleRsvpEvidence } from "./adapters/google_rsvp";
import { googleEventState } from "./adapters/provider_event_state";
import type { EventTimeModel } from "@musubi/types";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const savedFlag = config.api.providerRsvpEditsEnabled;
  config.api.providerRsvpEditsEnabled = true;
  let remote: any, mode = "normal", patches = 0, expectedPatchEtag = '"child"';
  let onRead: (() => Promise<void>) | undefined, onPatch: (() => Promise<void>) | undefined;
  const fixture = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer synthetic-instance-rsvp");
      res.setHeader("content-type", "application/json");
      if (req.url === "/calendar/v3/users/me/calendarList/primary") { res.end(JSON.stringify({ id: "guest@example.test", primary: true, accessRole: "owner" })); return; }
      assert.ok(req.url?.startsWith("/calendar/v3/calendars/guest%40example.test/events/instance"));
      if (req.method === "GET") {
        if (onRead) { const action = onRead; onRead = undefined; await action(); }
        res.end(JSON.stringify(remote)); return;
      }
      assert.equal(req.method, "PATCH");
      assert.equal(req.url, "/calendar/v3/calendars/guest%40example.test/events/instance?sendUpdates=all&conferenceDataVersion=1");
      assert.equal(req.headers["if-match"], expectedPatchEtag);
      let body = ""; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { attendeesOmitted: true, attendees: [{ email: "guest@example.test", responseStatus: "accepted" }] });
      patches++;
      if (remote.etag !== req.headers["if-match"]) { res.writeHead(412); res.end(); return; }
      remote.attendees[0].responseStatus = "accepted"; remote.etag = '\"child-next\"';
      if (onPatch) { const action = onPatch; onPatch = undefined; await action(); }
      if (mode === "lost") { req.socket.destroy(); return; }
      if (mode === "503") { res.writeHead(503); res.end(); return; }
      res.end(JSON.stringify(remote));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== "string");
  const realFetch = globalThis.fetch;
  const app = express(); app.use(express.json());
  app.get("/api/v1/events/:eventId/provider-state", requireAuth, handlerGetProviderEventState);
  app.post("/api/v1/events/:eventId/provider-rsvp", requireAuth, handlerProviderRsvpEdit);
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => api.once("listening", resolve));
  const apiAddress = api.address(); assert.ok(apiAddress && typeof apiAddress !== "string");
  const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
  globalThis.fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, "https://www.googleapis.com"); return realFetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init); };
  const adapter = { ...googleAdapter, ...googleRsvpMethods(async () => "synthetic-instance-rsvp") };
  try {
  for (const kind of ["zoned", "all-day"] as const) {
    for (const scenario of ["queue", "concurrent", "parent-revision", "parent-mapping", "parent-deleted", "parent-unlinked", "child-identity", "mapping-identity", "parent-pending", "parent-cancelled", "tamper", "deliver-normal", "deliver-lost", "deliver-503", "deliver-parent-before", "deliver-parent-after", "deliver-parent-map-before", "deliver-parent-map-after", "deliver-child-before", "deliver-grant-before", "deliver-grant-after", "deliver-lease-after", "deliver-pull-echo", "deliver-pull-state", "deliver-native-original-before", "deliver-native-original-after", "deliver-resolve-resend", "deliver-resolve-recover", "public-queue", "public-concurrent", "public-parent-race", "public-native-parent", "public-native-original"]) {
      mode = "normal"; patches = 0; expectedPatchEtag = '"child"'; onRead = undefined; onPatch = undefined;
      const owner = `rsvp-instance-${randomUUID()}`;
      await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test`, isExternal: true });
      try {
        // Durable before-write permission verifies the real connected grant,
        // including lower-level prepare/commit scenarios that stub token reads.
        await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: "fixture", scope: "https://www.googleapis.com/auth/calendar.events", accessToken: "synthetic-instance-rsvp", refreshToken: "synthetic-refresh", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
        const calendar = await createCalendar({ creatorID: owner, name: "Instance fixture", color: "red" });
        const [link] = await db.insert(externalCalendars).values({ provider: "google", userID: owner, accountID: "fixture", calendarID: calendar.id, externalCalendarID: "guest@example.test" }).returning();
        const allDay = kind === "all-day";
        const originalStart = allDay ? { kind: "date" as const, value: "2026-10-25" } : { kind: "instant" as const, value: "2026-10-25T00:30:00.000Z" };
        const model: EventTimeModel = allDay ? { kind: "all-day" } : { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-10-25T02:30:00.000", endLocal: "2026-10-25T03:30:00.000" };
        const native = { id: "instance", etag: '"child"', status: "confirmed", summary: "Moved meeting", start: allDay ? { date: "2026-10-26" } : { dateTime: "2026-10-25T02:30:00+01:00", timeZone: "Europe/Prague" }, end: allDay ? { date: "2026-10-27" } : { dateTime: "2026-10-25T03:30:00+01:00", timeZone: "Europe/Prague" }, recurringEventId: "series", originalStartTime: allDay ? { date: originalStart.value } : { dateTime: "2026-10-25T02:30:00+02:00", timeZone: "Europe/Prague" }, organizer: { email: "host@example.test" }, attendees: [{ email: "guest@example.test", self: true, responseStatus: "needsAction" }, { email: "other@example.test", responseStatus: "accepted" }] };
        remote = structuredClone(native);
        const state = googleEventState(native);
        const values = { title: native.summary, color: "red", start: new Date(allDay ? "2026-10-26T00:00:00Z" : "2026-10-25T01:30:00Z"), end: new Date(allDay ? "2026-10-26T00:00:00Z" : "2026-10-25T02:30:00Z"), isAllDay: allDay, description: null, location: null, organizer: "host@example.test", recurrence: null, url: null };
        const parentModel: EventTimeModel = allDay ? { kind: "all-day" } : { kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-10-24T02:30:00.000", endLocal: "2026-10-24T03:30:00.000" };
        await upsertExternalEvent("google", owner, calendar.id, "guest@example.test", "series", { ...values, title: "Series", start: new Date(allDay ? "2026-10-24T00:00:00Z" : "2026-10-24T00:30:00Z"), end: new Date(allDay ? "2026-10-24T00:00:00Z" : "2026-10-24T01:30:00Z"), recurrence: "RRULE:FREQ=DAILY;COUNT=4" }, '"parent"', null, undefined, { timeModel: parentModel }, undefined, state);
        await upsertExternalEvent("google", owner, calendar.id, "guest@example.test", "instance", values, native.etag, null, undefined, { timeModel: model, externalSeriesID: "series", originalStart }, undefined, state);
        const maps = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)).orderBy(externalEvents.id);
        const mapping = maps.find(item => item.externalEventID === "instance")!;
        const parentMapping = maps.find(item => item.externalEventID === "series")!;
        const child = (await getEventSnapshot(mapping.eventID))!;
        const parent = (await getEventSnapshot(parentMapping.eventID))!;
        const observation = await getOwnProviderEventObservation(owner, child.id, false, true);
        assert.deepEqual(observation.rsvpEdit, { provider: "google", expectedRevision: child.revision });
        const request = { provider: "google", operationID: randomUUID(), expectedRevision: child.revision, expectedStateVersion: observation.version, response: "accepted", sendUpdates: "all" };
        if (scenario.startsWith("public-")) {
          const credential = issueMemberToken(); await replaceMemberToken(owner, credential.tokenHash);
          const headers = { authorization: `Bearer ${credential.raw}`, [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, "Content-Type": "application/json" };
          const post = (body: unknown, id = child.id) => realFetch(`${apiOrigin}/api/v1/events/${id}/provider-rsvp`, { method: "POST", headers, body: JSON.stringify(body) });
          assert.equal((await realFetch(`${apiOrigin}/api/v1/events/${child.id}/provider-rsvp`, { method: "POST", headers: { "Content-Type": "application/json", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: JSON.stringify(request) })).status, 401);
          assert.equal((await post({ ...request, occurrence: { externalSeriesID: "forged" } })).status, 400);
          assert.equal((await post(request, parent.id)).status, 403, "Series master remains unsupported");
          config.api.providerRsvpEditsEnabled = false;
          const disabled = await realFetch(`${apiOrigin}/api/v1/events/${child.id}/provider-state`, { headers });
          assert.equal(disabled.status, 200); assert.equal((await disabled.json()).rsvpEdit, undefined);
          assert.equal((await post(request)).status, 403);
          config.api.providerRsvpEditsEnabled = true;
          const fresh = await realFetch(`${apiOrigin}/api/v1/events/${child.id}/provider-state`, { headers });
          assert.equal(fresh.headers.get("cache-control"), "private, no-store");
          assert.deepEqual((await fresh.json()).rsvpEdit, { provider: "google", expectedRevision: child.revision });
          if (scenario === "public-parent-race") onRead = async () => { await db.update(events).set({ revision: parent.revision + 1 }).where(eq(events.id, parent.id)); };
          if (scenario === "public-native-parent") remote.recurringEventId = "other";
          if (scenario === "public-native-original") remote.originalStartTime = allDay ? { date: "2026-10-26" } : { dateTime: "2026-10-25T02:30:00+01:00" };
          const replies = scenario === "public-concurrent" ? await Promise.all([post(request), post(request)]) : [await post(request)];
          assert.equal(patches, 0, "Public enqueue never PATCHes or notifies inline");
          if (["public-parent-race", "public-native-parent", "public-native-original"].includes(scenario)) {
            assert.equal(replies[0]!.status, scenario === "public-parent-race" ? 400 : 403);
            assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, child.id))).length, 0);
          } else {
            const receipts = await Promise.all(replies.map(async response => { assert.equal(response.status, 202); assert.equal(response.headers.get("cache-control"), "private, no-store"); return ProviderRsvpReceiptSchema.parse(await response.json()); }));
            assert.equal(new Set(receipts.map(item => item.operationID)).size, 1);
            assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, child.id))).length, 1);
            const receipt = receipts[0]!;
            const replay = ProviderRsvpReceiptSchema.parse(await (await post(request)).json());
            assert.equal(replay.replayed, true); assert.equal(replay.operationID, receipt.operationID);
            assert.deepEqual(await getEventSnapshot(child.id), child);
            assert.equal((await deliverEventOutbox(receipt.operationID, () => googleAdapter))?.status, "completed");
            assert.equal(patches, 1); assert.equal(remote.attendees[0].responseStatus, "accepted");
            assert.deepEqual(await getEventSnapshot(child.id), child);
          }
          continue;
        }
        const candidate = await prepareProviderRsvpEdit(owner, child.id, request);
        assert.equal(candidate.kind, "prepared"); if (candidate.kind !== "prepared") throw new Error("Expected context");
        const binding = candidate.context.instance!;
        assert.deepEqual(binding, { seriesID: parent.id, parentRevision: parent.revision, parentMappingID: parentMapping.id, externalSeriesID: "series", originalStart });
        const evidence = googleRsvpEvidence(native, { eventId: mapping.externalEventID, etag: mapping.etag!, authenticatedCopyEmail: "guest@example.test", occurrence: { externalSeriesID: binding.externalSeriesID, originalStart: binding.originalStart } }, "accepted");
        const commit = () => commitProviderRsvpEdit(candidate.context, evidence.baseline, model);
        if (scenario === "parent-revision") await db.update(events).set({ revision: parent.revision + 1 }).where(eq(events.id, parent.id));
        if (scenario === "parent-mapping") await db.update(externalEvents).set({ externalEventID: "different" }).where(eq(externalEvents.id, parentMapping.id));
        if (scenario === "parent-deleted") await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, parent.id));
        if (scenario === "parent-unlinked") await db.delete(calendarEvents).where(and(eq(calendarEvents.eventID, parent.id), eq(calendarEvents.calendarID, calendar.id)));
        if (scenario === "child-identity") await db.update(events).set({ originalStart: allDay ? { kind: "date", value: "2026-10-26" } : { kind: "instant", value: "2026-10-26T01:30:00.000Z" } }).where(eq(events.id, child.id));
        if (scenario === "mapping-identity") await db.update(externalEvents).set({ externalSeriesID: "other" }).where(eq(externalEvents.id, mapping.id));
        if (scenario.startsWith("parent-") && ["parent-pending", "parent-cancelled"].includes(scenario)) await db.insert(eventOutbox).values({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, eventID: parent.id, revision: parent.revision, calendarID: calendar.id, externalCalendarLinkID: link!.id, provider: "google", userID: owner, accountID: "fixture", externalCalendarID: "guest@example.test", externalEventID: "series", action: "update", status: scenario === "parent-cancelled" ? "cancelled" : "pending", payload: { event: parent } });
        if (scenario === "tamper") candidate.context.instance!.parentRevision++;
        if (!["queue", "concurrent"].includes(scenario) && !scenario.startsWith("deliver-")) {
          await assert.rejects(commit);
          assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, child.id))).length, 0);
        } else {
          const receipts = scenario === "concurrent" ? await Promise.all([commit(), commit()]) : [await commit()];
          assert.equal(new Set(receipts.map(item => item.operationID)).size, 1);
          const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, child.id));
          assert.equal(rows.length, 1); const row = rows[0]!;
          assert.deepEqual(row.payload.rsvp!.instance, binding);
          assert.deepEqual(row.payload.rsvp!.baseline, native);
          assert.equal(row.payload.rsvp!.desiredState.ownResponse, "accepted");
          assert.deepEqual(await getEventSnapshot(child.id), child);
          assert.deepEqual(await getEventSnapshot(parent.id), parent);
          assert.deepEqual(await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)).orderBy(externalEvents.id), maps);
          assert.equal((await commit()).replayed, true);
          if (scenario.startsWith("deliver-")) {
            const parentRevision = async () => { await db.update(events).set({ revision: parent.revision + 1 }).where(eq(events.id, parent.id)); };
            const parentIdentity = async () => { await db.update(externalEvents).set({ externalEventID: "other-parent" }).where(eq(externalEvents.id, parentMapping.id)); };
            const loseGrant = async () => { await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner))); };
            const nativeIdentity = async () => { remote.originalStartTime = allDay ? { date: "2026-10-26" } : { dateTime: "2026-10-25T02:30:00+01:00", timeZone: "Europe/Prague" }; };
            if (scenario === "deliver-parent-before") onRead = parentRevision;
            if (scenario === "deliver-parent-after") onPatch = parentRevision;
            if (scenario === "deliver-parent-map-before") onRead = parentIdentity;
            if (scenario === "deliver-parent-map-after") onPatch = parentIdentity;
            if (scenario === "deliver-child-before") onRead = async () => { await db.update(events).set({ revision: child.revision + 1 }).where(eq(events.id, child.id)); };
            if (scenario === "deliver-grant-before") onRead = loseGrant;
            if (scenario === "deliver-grant-after") onPatch = loseGrant;
            if (scenario === "deliver-lease-after") onPatch = async () => { await db.update(eventOutbox).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) }).where(eq(eventOutbox.id, row.id)); };
            if (scenario === "deliver-native-original-before") onRead = nativeIdentity;
            if (scenario === "deliver-native-original-after") onPatch = nativeIdentity;
            if (scenario.startsWith("deliver-pull-") || scenario.startsWith("deliver-resolve-")) onPatch = async () => {
              if (scenario === "deliver-pull-state" || scenario.startsWith("deliver-resolve-")) { remote.attendees[1].responseStatus = "declined"; remote.etag = '\"concurrent\"'; }
              await upsertExternalEvent("google", owner, calendar.id, "guest@example.test", "instance", values, remote.etag, null, undefined, { timeModel: model, externalSeriesID: "series", originalStart }, undefined, googleEventState(remote));
            };
            if (scenario === "deliver-lost") mode = "lost";
            if (scenario === "deliver-503") mode = "503";
            let result = await deliverEventOutbox(row.id, () => adapter);
            if (["deliver-lost", "deliver-503"].includes(scenario)) {
              assert.equal(result?.status, "unconfirmed", scenario); assert.equal(patches, 1);
              mode = "normal"; await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, row.id));
              result = await deliverEventOutbox(row.id, () => adapter);
            }
            const completed = ["deliver-normal", "deliver-lost", "deliver-503", "deliver-pull-echo"].includes(scenario);
            const [accepted] = await db.select().from(externalEvents).where(eq(externalEvents.id, mapping.id));
            if (completed) {
              assert.equal(result?.status, "completed", scenario);
              assert.equal(accepted!.etag, remote.etag); assert.equal(accepted!.providerState!.ownResponse, "accepted");
              assert.deepEqual(await getEventSnapshot(child.id), child);
              await upsertExternalEvent("google", owner, calendar.id, "guest@example.test", "instance", values, remote.etag, null, undefined, { timeModel: model, externalSeriesID: "series", originalStart }, undefined, googleEventState(remote));
              assert.deepEqual(await getEventSnapshot(child.id), child);
            } else {
              assert.notEqual(result?.status, "completed", scenario);
              assert.equal(accepted!.etag, native.etag, scenario);
              assert.equal(accepted!.providerState!.ownResponse, "needsAction", scenario);
            }
            if (scenario.startsWith("deliver-resolve-")) {
              const beforePreview = patches;
              if (scenario === "deliver-resolve-resend") { remote.attendees[0].responseStatus = "declined"; remote.etag = '\"own-changed\"'; }
              // A newer accepted parent revision may be adopted only by an
              // explicit new preview, while parent and original slot stay fixed.
              await db.update(events).set({ revision: parent.revision + 1 }).where(eq(events.id, parent.id));
              const first = await prepareEventDeliveryResolution(owner, child.id, row.id, () => adapter);
              assert.equal(first.preview.canResolve, true);
              assert.equal(first.proof.rsvp!.intent.instance!.parentRevision, parent.revision + 1);
              assert.equal(first.preview.rsvpResolution!.desired, "accepted");
              assert.equal(patches, beforePreview);
              const request = { mutationId: randomUUID(), expectedLocalRevision: child.revision, expectedLatestOperationId: row.id, expectedRemoteExists: true, expectedRemoteEtag: remote.etag, expectedRsvpBaselineVersion: first.preview.rsvpResolution!.baselineVersion };
              await db.update(events).set({ revision: parent.revision + 2 }).where(eq(events.id, parent.id));
              await assert.rejects(() => commitEventDeliveryResolution(owner, first.proof, request));
              const second = await prepareEventDeliveryResolution(owner, child.id, row.id, () => adapter);
              assert.notEqual(second.preview.rsvpResolution!.baselineVersion, request.expectedRsvpBaselineVersion, "Same native JSON with a changed parent invalidates the old preview");
              await assert.rejects(() => commitEventDeliveryResolution(owner, second.proof, request));
              remote.attendees[0].comment = "Current private comment";
              const fresh = await prepareEventDeliveryResolution(owner, child.id, row.id, () => adapter);
              assert.notEqual(fresh.preview.rsvpResolution!.baselineVersion, second.preview.rsvpResolution!.baselineVersion);
              assert.ok(!JSON.stringify(fresh.preview).includes("Current private comment"));
              const acceptedRequest = { ...request, expectedRsvpBaselineVersion: fresh.preview.rsvpResolution!.baselineVersion };
              const savedOriginal = remote.originalStartTime; await nativeIdentity();
              await assert.rejects(() => prepareEventDeliveryResolution(owner, child.id, row.id, () => adapter));
              remote.originalStartTime = savedOriginal;
              await db.update(externalEvents).set({ externalEventID: "other-parent" }).where(eq(externalEvents.id, parentMapping.id));
              await db.update(externalEvents).set({ externalSeriesID: "other-parent" }).where(eq(externalEvents.id, mapping.id));
              remote.recurringEventId = "other-parent";
              await assert.rejects(() => prepareEventDeliveryResolution(owner, child.id, row.id, () => adapter));
              await db.update(externalEvents).set({ externalEventID: "series" }).where(eq(externalEvents.id, parentMapping.id));
              await db.update(externalEvents).set({ externalSeriesID: "series" }).where(eq(externalEvents.id, mapping.id));
              remote.recurringEventId = "series";
              await loseGrant(); await assert.rejects(() => commitEventDeliveryResolution(owner, fresh.proof, acceptedRequest));
              await db.update(calendarMembers).set({ role: "owner" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
              const replacement = await commitEventDeliveryResolution(owner, fresh.proof, acceptedRequest);
              assert.equal(await getEventDeliveryResolutionReplay(owner, child.id, row.id, acceptedRequest), replacement);
              await assert.rejects(() => getEventDeliveryResolutionReplay(owner, child.id, row.id, request));
              const [replacementRow] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, replacement));
              assert.equal(replacementRow!.payload.rsvp!.instance!.parentRevision, parent.revision + 2);
              assert.equal(replacementRow!.payload.rsvp!.request.operationID, acceptedRequest.mutationId);
              expectedPatchEtag = remote.etag;
              const delivered = await deliverEventOutbox(replacement, () => adapter);
              assert.equal(delivered?.status, "completed", JSON.stringify({ scenario, status: delivered?.status, error: delivered?.errorCode, patches }));
              assert.equal(patches, beforePreview + (scenario === "deliver-resolve-resend" ? 1 : 0));
              assert.equal(remote.attendees[0].comment, "Current private comment");
              assert.equal(remote.attendees[1].responseStatus, "declined");
              assert.deepEqual(await getEventSnapshot(child.id), child);
              continue;
            }
            assert.equal(patches, scenario.endsWith("-before") ? 0 : 1, scenario);
            continue;
          }
          const token = randomUUID(); await db.update(eventOutbox).set({ status: "attempting", leaseToken: token, leaseUntil: new Date(Date.now() + 60000) }).where(eq(eventOutbox.id, row.id));
          const [claimed] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, row.id));
          assert.equal(await hasProviderRsvpSource(claimed!), true);
          assert.equal(await completeEventOutbox(row.id, token, { externalEventId: "instance", etag: '"new"' }, { externalEventId: "instance", etag: native.etag }, { isEcho: true, externalEventId: "instance", etag: '"new"', deleted: false, providerState: row.payload.rsvp!.desiredState, observedAt: new Date().toISOString() }), undefined);
        }
      } finally { await db.delete(user).where(eq(user.id, owner)); }
    }
  }
  } finally { config.api.providerRsvpEditsEnabled = savedFlag; globalThis.fetch = realFetch; await new Promise<void>(resolve => api.close(() => resolve())); await new Promise<void>(resolve => fixture.close(() => resolve())); }
  console.log("Private Google instance RSVP journal and delivery: bound family, concurrent replay, stale parent/identity refusal, conditional HTTP recovery, parent/permission/lease/pull fences: OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
