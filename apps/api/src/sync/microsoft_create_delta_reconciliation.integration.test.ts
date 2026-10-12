import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import { account, db, events, eventOutbox, externalEvents, getUserExternalCalendars, setCursor, user } from "@musubi/db";
import { microsoftAdapter } from "./adapters/microsoft";
import { queueProviderOrganizer } from "./provider_organizer";
import { deliverEventOutbox } from "./event_delivery";
import { syncProvider } from "./engine";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const previousFetch = globalThis.fetch;
  const previousFlags = [config.api.providerOrganizerEditsEnabled, config.api.eventTimeEditsEnabled];
  config.api.providerOrganizerEditsEnabled = config.api.eventTimeEditsEnabled = true;
  let native: any, posts = 0, fullReads = 0, deltaReads = 0, removedProof = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com", "All provider traffic is intercepted");
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      assert.equal(url.pathname, "/v1.0/me/calendars/primary/events");
      posts++;
      native = { ...JSON.parse(String(init.body)), id: "native", iCalUId: "uid", "@odata.etag": 'W/"v1"', type: "singleInstance", originalStartTimeZone: "UTC", originalEndTimeZone: "UTC", isCancelled: false, isDraft: false, isOrganizer: true, recurrence: null, organizer: { emailAddress: { address: "owner@example.test" } }, onlineMeeting: null, onlineMeetingUrl: null, hasAttachments: false };
      return response({ id: "native" }, 201);
    }
    assert.ok(!init?.method || init.method === "GET");
    if (url.pathname === "/v1.0/me") return response({ id: "graph-object-id", mail: "owner@example.test", userPrincipalName: "owner@example.test" });
    const calendar = { id: "primary", name: "Primary", isDefaultCalendar: true, canEdit: true, canViewPrivateItems: true, owner: { address: "owner@example.test" } };
    if (url.pathname === "/v1.0/me/calendar") return response(calendar);
    if (url.pathname === "/v1.0/me/calendars/primary") return response(calendar);
    if (url.pathname === "/v1.0/me/calendars") return response({ value: [calendar] });
    if (url.pathname === "/v1.0/me/calendars/primary/events") return response({ value: native ? [native] : [] });
    if (url.pathname === "/v1.0/me/calendars/primary/events/native") return native ? response(native) : response({ error: { code: "ErrorItemNotFound" } }, 404);
    if (url.pathname.endsWith("/calendarView/delta")) {
      if (url.searchParams.has("$deltatoken")) deltaReads++; else fullReads++;
      // Missing incremental changes and empty window renewal are not native
      // deletion proof. An explicit candidate still requires scoped native GETs.
      return response({ value: removedProof ? [{ id: "native", "@removed": { reason: "deleted" } }] : url.searchParams.has("$deltatoken") ? [] : native ? [native] : [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendars/primary/calendarView/delta?$deltatoken=fixture" });
    }
    throw new Error(`Unexpected intercepted route: ${url.pathname}`);
  };
  try {
    for (const pending of [false, true]) {
      const actor = `graph-create-delta-${randomUUID()}`;
      native = undefined; posts = fullReads = deltaReads = 0; removedProof = false;
      await db.insert(user).values({ id: actor, name: "Fixture", email: `${actor}@example.test` });
      try {
        await db.insert(account).values({ id: randomUUID(), userId: actor, providerId: "microsoft", accountId: "fixture", scope: "Calendars.ReadWrite", accessToken: "fixture", refreshToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
        const sync = () => syncProvider(microsoftAdapter, actor, { id: "fixture", label: "Fixture" });
        const source = async () => (await getUserExternalCalendars("microsoft", actor, "fixture"))[0]!;
        await sync();
        const beforeCreate = await source();
        assert.ok(beforeCreate.cursor);
        const request = { provider: "microsoft", action: "create", notificationPolicy: "server-invite", operationID: randomUUID(), eventID: randomUUID(), calendarID: beforeCreate.calendarID, color: "red", content: { title: "Create then cancel between pulls", description: "Fixture", location: "Room" }, time: { kind: "zoned", timeZone: "UTC", startLocal: "2026-09-15T09:00:00", endLocal: "2026-09-15T10:00:00" }, guests: [{ email: "guest@example.test", optional: false }] };
        await queueProviderOrganizer(actor, request);
        await deliverEventOutbox(request.operationID, provider => provider === "microsoft" ? microsoftAdapter : null);
        const journal = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, request.operationID)))[0]!;
        const event = async () => (await db.select().from(events).where(eq(events.id, request.eventID)))[0]!;
        const mappings = () => db.select().from(externalEvents).where(eq(externalEvents.eventID, request.eventID));
        const accepted = await journal(), originalEvent = await event(), originalMappings = await mappings();
        assert.equal(accepted.status, "completed");
        assert.equal(originalMappings.length, 1);
        assert.equal(originalMappings[0]!.externalEventID, "native");
        assert.equal((await source()).cursor, beforeCreate.cursor, "Create ACK leaves the pre-create cursor in place");
        native = undefined; // Native cancellation; deliberately no incremental tombstone.
        await sync();
        assert.deepEqual(await event(), originalEvent, "Empty delta cannot authorize deletion");
        assert.deepEqual(await mappings(), originalMappings);
        assert.equal(deltaReads, 1);
        let pendingID: string | undefined;
        if (pending) {
          // Fixture-only pending write exercises the shared deletion fence; no worker runs it.
          pendingID = randomUUID();
          await db.insert(eventOutbox).values({ ...accepted, id: pendingID, mutationID: randomUUID(), predecessorID: accepted.id, action: "update", externalEventID: "native", expectedEtag: originalMappings[0]!.etag, payload: { event: accepted.payload.event }, status: "pending", attempts: 0, resultRef: null, remoteSnapshot: null, leaseToken: null, leaseUntil: null });
        }
        const pendingBefore = pendingID ? (await db.select().from(eventOutbox).where(eq(eventOutbox.id, pendingID)))[0]! : undefined;
        const link = await source();
        assert.notEqual(link.providerAccessRole, null);
        await setCursor(link.calendarID, null, { provider: "microsoft", linkID: link.sourceID, revision: link.providerAccessRevision, userID: actor, accountID: "fixture", externalCalendarID: link.externalCalendarID });
        await sync();
        assert.equal(fullReads, 2);
        assert.deepEqual(await mappings(), originalMappings, "Empty replacement coverage retains identity");
        assert.deepEqual(await journal(), accepted, "Completed creation journal stays intact");
        assert.ok((await source()).cursor);
        assert.deepEqual(await event(), originalEvent, "An empty replacement window cannot tombstone the canonical event");
        if (pendingID) assert.deepEqual((await db.select().from(eventOutbox).where(eq(eventOutbox.id, pendingID)))[0], pendingBefore, "Empty replacement coverage preserves the accepted pending operation byte for byte");
        removedProof = true;
        await sync();
        assert.deepEqual(await mappings(), originalMappings, "Proven deletion retains mapping identity for revival");
        assert.deepEqual(await journal(), accepted, "Native proof leaves the completed create receipt unchanged");
        if (pendingID) {
          assert.deepEqual(await event(), originalEvent, "Pending intent protects the canonical event from proven native absence");
          const [retained] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, pendingID));
          assert.equal(retained!.status, "conflict");
          assert.equal(retained!.errorCode, "provider-conflict");
          assert.equal(retained!.remoteSnapshot?.deleted, true);
          assert.deepEqual(retained!.payload, { event: accepted.payload.event });
        } else {
          const removed = await event();
          assert.ok(removed.deletedAt);
          assert.equal(removed.revision, originalEvent.revision + 1);
          assert.equal(removed.id, originalEvent.id);
        }
        assert.equal(posts, 1, "Reconciliation never replays the organizer POST");
      } finally { await db.delete(user).where(eq(user.id, actor)); }
    }
    console.log("Graph create ACK, missing delta, guarded reset and pending-write protection: OK");
  } finally {
    globalThis.fetch = previousFetch;
    [config.api.providerOrganizerEditsEnabled, config.api.eventTimeEditsEnabled] = previousFlags as [boolean, boolean];
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$client.end());
