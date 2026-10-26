import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import { db, user, account, externalCalendars, externalEvents, eventOutbox, createCalendar, upsertExternalEvent, getEventSnapshot, getOwnProviderEventObservation } from "@musubi/db";
import { googleAdapter } from "./adapters/google";
import { googleEventState } from "./adapters/provider_event_state";
import { queueGoogleRsvp } from "./provider_rsvp";
import { deliverEventOutbox } from "./event_delivery";

/** Dedicated policy delta after event extraction: one possible dispatch is
 * permanent. Recovery observes only, including an unapplied original baseline.
 * Historical old/new parity belongs to the frozen pre-policy event checkpoint. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const flags = { rsvp: config.api.providerRsvpEditsEnabled, time: config.api.eventTimeEditsEnabled, reminders: config.api.providerReminderEditsEnabled };
  config.api.providerRsvpEditsEnabled = true; config.api.eventTimeEditsEnabled = false; config.api.providerReminderEditsEnabled = false;
  const originalFetch = globalThis.fetch;
  for (const mode of ["already-desired", "unapplied"] as const) {
    const owner = `event-rsvp-recovery-${randomUUID()}`;
    const remote = { id: "meeting", etag: '"before"', status: "confirmed", summary: "Private RSVP meeting",
      start: { dateTime: "2026-10-26T10:11:12.123Z", timeZone: "Europe/Prague" }, end: { dateTime: "2026-10-26T11:12:13.456Z", timeZone: "Europe/Prague" },
      organizer: { email: "host@example.test", self: false }, attendees: [{ email: "guest@example.test", self: true, responseStatus: "needsAction", comment: "Keep private comment" }, { email: "other@example.test", responseStatus: "accepted" }],
      reminders: { useDefault: true }, extendedProperties: { private: { retained: "Keep native bytes" } } };
    const baseline = structuredClone(remote); let patches = 0, reads = 0;
    const server = createServer((request, response) => { void (async () => {
      assert.equal(request.headers.authorization, "Bearer fixture-rsvp-recovery");
      response.setHeader("content-type", "application/json");
      if (request.url === "/calendar/v3/users/me/calendarList/primary") { response.end(JSON.stringify({ id: "guest@example.test", primary: true, accessRole: "owner" })); return; }
      const url = new URL(request.url!, "http://fixture.invalid");
      assert.equal(url.pathname, "/calendar/v3/calendars/guest%40example.test/events/meeting");
      if (request.method === "GET") { reads++; response.end(JSON.stringify(remote)); return; }
      assert.equal(request.method, "PATCH");
      assert.equal(url.searchParams.get("sendUpdates"), "all"); assert.equal(url.searchParams.get("conferenceDataVersion"), "1");
      assert.equal(request.headers["if-match"], '"before"', "A retry must keep the original strong validator");
      let body = ""; for await (const bytes of request) body += String(bytes);
      assert.deepEqual(JSON.parse(body), { attendeesOmitted: true, attendees: [{ email: "guest@example.test", responseStatus: "accepted" }] });
      patches++;
      if (mode === "unapplied" && patches === 1) { response.writeHead(503); response.end(); return; }
      remote.attendees[0]!.responseStatus = "accepted"; remote.etag = '"after"';
      if (patches === 1) response.writeHead(503);
      response.end(JSON.stringify(remote));
    })().catch(error => { console.error(error); response.writeHead(500); response.end(); }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, "https://www.googleapis.com", "No live provider fallback"); return originalFetch(`${origin}${url.pathname}${url.search}`, init); };
    await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.invalid` });
    try {
      await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: "fixture", scope: "https://www.googleapis.com/auth/calendar.events",
        accessToken: "fixture-rsvp-recovery", refreshToken: "fixture-rsvp-refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      const calendar = await createCalendar({ creatorID: owner, name: "Google RSVP recovery", color: "#112233" });
      await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google", userID: owner, accountID: "fixture", externalCalendarID: "guest@example.test" });
      await upsertExternalEvent("google", owner, calendar.id, "guest@example.test", remote.id, { title: remote.summary, color: "#112233", start: new Date(remote.start.dateTime), end: new Date(remote.end.dateTime),
        isAllDay: false, description: null, location: null, organizer: remote.organizer.email, recurrence: null, url: null }, remote.etag, null, undefined, undefined, undefined, googleEventState(remote));
      const [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)); assert(mapping);
      const original = await getEventSnapshot(mapping.eventID); assert(original);
      const observation = await getOwnProviderEventObservation(owner, original.id); assert(observation.version);
      const queued = await queueGoogleRsvp(owner, original.id, { operationID: randomUUID(), provider: "google", response: "accepted", sendUpdates: "all", expectedRevision: original.revision, expectedStateVersion: observation.version });
      const admitted = (await db.select().from(eventOutbox).where(eq(eventOutbox.id, queued.operationID)))[0]!; assert(admitted.payload.rsvp);
      let notification: string | undefined;
      const adapter = { ...googleAdapter, async writeRsvp(...args: Parameters<NonNullable<typeof googleAdapter.writeRsvp>>) {
        const result = await googleAdapter.writeRsvp!(...args); notification = result.notificationDelivery; return result;
      } };
      const first = await deliverEventOutbox(queued.operationID, () => adapter); assert.equal(first?.status, "unconfirmed"); assert.equal(patches, 1);
      assert.equal(first?.uncertain, true); assert.equal(first?.resultRef, null);
      assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.id, mapping.id)))[0]!.etag, '"before"');
      await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, queued.operationID));
      const beforeRecovery = reads;
      const recovered = await deliverEventOutbox(queued.operationID, () => adapter); assert.equal(recovered?.status, mode === "already-desired" ? "completed" : "unconfirmed");
      assert.equal(patches, 1, "A possible dispatch permanently consumes this operation's only RSVP mutation permission");
      assert(first?.payload.rsvp?.googleDelivery?.startedAt); assert.equal(recovered?.payload.rsvp?.googleDelivery?.startedAt, first.payload.rsvp.googleDelivery.startedAt);
      assert(reads > beforeRecovery, "Every recovery first reads the scoped native copy");
      assert.deepEqual(recovered?.payload.rsvp?.baseline, admitted.payload.rsvp.baseline); assert.deepEqual(recovered?.payload.operationEnvelope, admitted.payload.operationEnvelope);
      assert.deepEqual(await getEventSnapshot(original.id), original, "Provider RSVP must not overwrite richer canonical content or exact milliseconds");
      assert.equal(original.start.toISOString(), "2026-10-26T10:11:12.123Z"); assert.equal(original.end.toISOString(), "2026-10-26T11:12:13.456Z");
      const mapped = (await db.select().from(externalEvents).where(eq(externalEvents.id, mapping.id)))[0]!;
      assert.equal(mapped.etag, mode === "already-desired" ? '"after"' : '"before"'); assert.equal(mapped.providerState?.ownResponse, mode === "already-desired" ? "accepted" : "needsAction");
      const { etag: _beforeTag, attendees: beforeAttendees, ...beforeContent } = baseline, { etag: _afterTag, attendees: afterAttendees, ...afterContent } = remote;
      assert.deepEqual(afterContent, beforeContent); assert.deepEqual(afterAttendees[1], beforeAttendees[1]); assert.equal(afterAttendees[0]!.comment, beforeAttendees[0]!.comment);
      assert.equal(notification, mode === "already-desired" ? "unknown" : undefined, "An unobserved native result must not fabricate a writer receipt");
      console.log(`Google RSVP no-resend policy: ${mode}: original baseline/version, ${patches} conditional PATCH, GET-only recovery, unchanged canonical precision, notification not proven: PASS`);
    } finally { await db.delete(user).where(eq(user.id, owner)); globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  config.api.providerRsvpEditsEnabled = flags.rsvp; config.api.eventTimeEditsEnabled = flags.time; config.api.providerReminderEditsEnabled = flags.reminders;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
