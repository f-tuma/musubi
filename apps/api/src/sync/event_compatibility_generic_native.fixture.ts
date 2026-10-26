import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import { EventSchema, type Event } from "@musubi/types";
import { account, createCalendar, createEvent, db, eventOutbox, externalCalendars, externalEvents, getEventSnapshot, patchEventAndCalendarLinks, saveCaldavAccount, user, type EventOutboxIntent } from "@musubi/db";
import { googleAdapter } from "./adapters/google";
import { microsoftAdapter } from "./adapters/microsoft";
import { caldavAdapter } from "./adapters/caldav";
import { encryptSecret } from "./crypto";
import { deliverEventOutbox } from "./event_delivery";

/** Actual legacy generic composition, separate from the 26-case PG/stub gate.
 * No provider planner/parser/writer or delivery algorithm is reproduced here. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const encoder = config.api.syncOperationV1EncoderEnabled, originalFetch = globalThis.fetch;
  config.api.syncOperationV1EncoderEnabled = false;
  try {
    for (const provider of ["google", "microsoft", "caldav"] as const) for (const allDay of [false, true]) {
      const owner = `legacy-native-${provider}-${allDay}-${randomUUID()}`;
      let native: Record<string, any> | null = null, resource: string | null = null, resourcePath = "", version = 0, refreshes = 0;
      const mutations: { method: string; body: string; condition?: string }[] = [];
      const tag = () => provider === "microsoft" ? `W/"v${version}"` : `"v${version}"`;
      const server = createServer((request, response) => { void (async () => {
        const path = new URL(request.url!, "http://fixture.invalid").pathname;
        let body = ""; for await (const bytes of request) body += String(bytes);
        response.setHeader("content-type", "application/json");
        if (path.endsWith("/token")) { assert.equal(request.method, "POST"); assert(body.includes("grant_type=refresh_token")); assert(body.includes("fixture-refresh")); refreshes++; response.end(JSON.stringify({ access_token: `refreshed-${provider}`, token_type: "Bearer", expires_in: 3600 })); return; }
        assert.equal(request.headers.authorization, provider === "caldav" ? "Basic Zml4dHVyZTpmaXh0dXJl" : `Bearer refreshed-${provider}`);
        if (request.method === "PROPFIND") {
          response.setHeader("content-type", "application/xml"); response.writeHead(207);
          response.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${request.url}</d:href><d:propstat><d:prop><d:current-user-privilege-set>${["read", "write-content", "bind", "unbind"].map(value => `<d:privilege><d:${value}/></d:privilege>`).join("")}</d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`); return;
        }
        if (provider === "google" && path.includes("/users/me/calendarList/")) { response.end(JSON.stringify({ id: "remote", accessRole: "owner" })); return; }
        if (provider === "microsoft" && path === "/v1.0/me") { response.end(JSON.stringify({ id: "fixture-self", mail: "owner@example.test" })); return; }
        if (provider === "microsoft" && path === "/v1.0/me/calendars/remote") { response.end(JSON.stringify({ id: "remote", canEdit: true, owner: { address: "owner@example.test" } })); return; }
        if (request.method === "GET") {
          if (provider === "microsoft" && path === "/v1.0/me/calendars/remote/events") { response.end(JSON.stringify({ value: native ? [native] : [] })); return; }
          if (provider === "caldav") { if (resource === null || path !== resourcePath) { response.writeHead(404); response.end(); return; } response.setHeader("content-type", "text/calendar"); response.setHeader("etag", tag()); response.end(resource); return; }
          if (!native || !path.endsWith(`/${native.id}`)) { response.writeHead(404); response.end(); return; } response.end(JSON.stringify(native)); return;
        }
        const method = request.method!;
        mutations.push({ method, body, ...(request.headers["if-match"] ? { condition: String(request.headers["if-match"]) } : {}) });
        if (method === "DELETE") { assert.equal(request.headers["if-match"], tag()); native = null; resource = null; response.writeHead(204); response.end(); return; }
        if (provider === "caldav") {
          assert.equal(method, "PUT"); assert(body.includes("BEGIN:VCALENDAR\r\n"));
          if (resource === null) assert.equal(request.headers["if-none-match"], "*");
          else { assert.equal(request.headers["if-match"], tag()); assert(body.includes("X-PRIVATE:Preserve whole resource")); }
          resourcePath = path; resource = body; version++; response.setHeader("etag", tag()); response.writeHead(204); response.end(); return;
        }
        const payload = JSON.parse(body);
        if (method === "POST") {
          assert.equal(version, 0); version++;
          if (provider === "google") { assert.equal(typeof payload.extendedProperties.private.musubiOperationID, "string"); native = { ...payload, etag: tag(), status: "confirmed", organizer: { email: "owner@example.test", self: true }, attendees: [], nativePrivate: { keep: true } }; }
          else { assert.equal(typeof payload.transactionId, "string"); native = { ...payload, id: "native", "@odata.etag": tag(), iCalUId: "native-uid", type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, organizer: { emailAddress: { address: "owner@example.test" } }, nativePrivate: { keep: true } }; }
        } else {
          assert.equal(method, "PATCH"); assert.equal(request.headers["if-match"], tag());
          assert.deepEqual(payload, provider === "google" ? { summary: "Changed" } : { subject: "Changed" });
          version++; native = { ...native, ...payload, ...(provider === "google" ? { etag: tag() } : { "@odata.etag": tag() }) };
          assert.deepEqual(native.nativePrivate, { keep: true });
        }
        response.writeHead(method === "POST" ? 201 : 200); response.end(JSON.stringify(native));
      })().catch(error => { console.error(error); response.writeHead(500); response.end(); }); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      globalThis.fetch = (input, init) => { const url = new URL(String(input)); assert([origin, "https://www.googleapis.com", "https://graph.microsoft.com", "https://oauth2.googleapis.com", "https://login.microsoftonline.com"].includes(url.origin)); return originalFetch(`${origin}${url.pathname}${url.search}`, init); };
      await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
      try {
        let accountID = "fixture";
        if (provider === "caldav") accountID = (await saveCaldavAccount(owner, `${origin}/`, "fixture", encryptSecret("fixture"))).id;
        else await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: provider, accountId: accountID, scope: provider === "google" ? "https://www.googleapis.com/auth/calendar.events" : "Calendars.ReadWrite", accessToken: "expired", refreshToken: "fixture-refresh", accessTokenExpiresAt: new Date(0) });
        const calendar = await createCalendar({ creatorID: owner, name: "Legacy native", color: "red" }), externalCalendarID = provider === "caldav" ? `${origin}/dav/` : "remote";
        const [link] = await db.insert(externalCalendars).values({ provider, userID: owner, accountID, calendarID: calendar.id, externalCalendarID }).returning();
        const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, title: "Before", description: "Private notes", location: "Private room", color: "red", start: allDay ? "2026-10-26T00:00:00Z" : "2026-10-26T10:11:12.000Z", end: allDay ? "2026-10-26T00:00:00Z" : "2026-10-26T11:12:13.000Z", isAllDay: allDay, isCanceled: false, originCalendarID: calendar.id, calendars: [calendar.id] });
        const intent = (event: Event, action: EventOutboxIntent["action"], extra: Partial<EventOutboxIntent> = {}): EventOutboxIntent => ({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, eventID: event.id, calendarID: calendar.id, externalCalendarLinkID: link.id, provider, userID: owner, accountID, externalCalendarID, action, payload: { event, ...(action === "create" ? { createIdentityVersion: 1 } : {}) }, ...extra });
        const adapter = provider === "google" ? googleAdapter : provider === "microsoft" ? microsoftAdapter : caldavAdapter;
        const creation = intent(event, "create"); await createEvent(event, event.calendars, [creation]);
        assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.id, creation.id!)))[0]!.payload.operationEnvelope, undefined, "Explicit retained v0 admission reaches host compatibility");
        assert.equal((await deliverEventOutbox(creation.id!, () => adapter))?.status, "completed"); assert.equal(mutations.length, 1);
        assert.equal(refreshes, provider === "caldav" ? 0 : 1, "Actual OAuth refresh occurs once, then its token is reused");
        let [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id)); assert(mapping); assert.equal(mapping.etag, tag());
        const original = await getEventSnapshot(event.id); assert(original); assert.equal(original.title, "Before"); assert.equal(original.start.toISOString(), event.start.toISOString()); assert.equal(original.isAllDay, allDay);
        resource = (resource as string | null)?.replace("END:VEVENT", "X-PRIVATE:Preserve whole resource\r\nEND:VEVENT") ?? resource;
        const update = intent(original, "update", { externalEventID: mapping.externalEventID, expectedEtag: mapping.etag, icalUid: mapping.icalUid, payload: { event: original, patch: { title: "Changed" } } });
        await patchEventAndCalendarLinks(event.id, original.revision!, { title: "Changed" }, false, [update]);
        assert.equal((await deliverEventOutbox(update.id!, () => adapter))?.status, "completed"); assert.equal(mutations.length, 2);
        const changed = await getEventSnapshot(event.id); assert(changed); assert.equal(changed.title, "Changed"); assert.equal(changed.start.toISOString(), original.start.toISOString()); assert.equal(changed.description, original.description); assert.equal(changed.location, original.location);
        [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id)); assert.equal(mapping.etag, tag());
        const deletion = intent(changed, "delete", { externalEventID: mapping.externalEventID, expectedEtag: mapping.etag, icalUid: mapping.icalUid });
        await patchEventAndCalendarLinks(event.id, changed.revision!, { calendars: [] }, true, [deletion]);
        assert.equal((await deliverEventOutbox(deletion.id!, () => adapter))?.status, "completed"); assert.equal(mutations.length, 3);
        assert.deepEqual(await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id)), []); assert((await getEventSnapshot(event.id))?.deletedAt);
        assert.equal(native, null); assert.equal(resource, null);
        console.log(`Legacy native generic ${provider}/${allDay ? "all-day" : "timed"}: actual CREATE/UPDATE/DELETE, original validators, refresh, mapping, canonical preservation: PASS`);
      } finally { await db.delete(user).where(eq(user.id, owner)); globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  } finally { config.api.syncOperationV1EncoderEnabled = encoder; globalThis.fetch = originalFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
