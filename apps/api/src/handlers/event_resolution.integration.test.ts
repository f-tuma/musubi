import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  account,
  calendarMembers,
  CALENDAR_SCOPE,
  db,
  user,
  events,
  eventOutbox,
  externalCalendars,
  externalEvents,
  externalEventTombstones,
  createCalendar,
  saveCaldavAccount,
  createEvent,
  patchEventAndCalendarLinks,
  getEventSnapshot,
  replaceMemberToken,
  requestEventDeliveryRetry,
  commitEventDeliveryResolution,
  EventDeliveryResolutionError,
  deleteExternalEvent,
  type EventOutboxIntent,
} from "@musubi/db";
import {
  EventSchema,
  EventDeliveryConflictSchema,
  CLIENT_VERSION_HEADER,
  PRODUCT_VERSION,
  type EventDeliveryConflict,
} from "@musubi/types";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import {
  handlerGetEventDeliveryConflict,
  handlerResolveEventDelivery,
} from "./event_delivery";
import { prepareEventDeliveryResolution } from "../sync/event_resolution";
import { deliverEventOutbox } from "../sync/event_delivery";
import { getAdapter } from "../sync/engine";
import { googleEventCreateID } from "../sync/event_create_identity";
import { encryptSecret } from "../sync/crypto";
import { icalToNormalized } from "../sync/adapters/caldav";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `resolution-${randomUUID()}`;
  const stranger = `resolution-stranger-${randomUUID()}`;
  const token = issueMemberToken(),
    strangerToken = issueMemberToken();
  const remote = new Map<string, Record<string, any>>();
  const davRemote = new Map<string, { data: string; etag: string }>();
  const writes: {
    method: string;
    path: string;
    ifMatch: string | undefined;
    body: Record<string, any>;
  }[] = [];
  let providerReads = 0;
  let version = 0;
  let dropCreateReply = false;
  let releaseRefresh: (() => void) | undefined;
  let refreshGate: Promise<void> | undefined;
  let beforeWrite: (() => void) | undefined;
  let writable = true;
  const fixture = createServer(async (req, res) => {
    if (req.method === "GET" || req.method === "PROPFIND") providerReads++;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url!, "http://fixture.test").pathname;
    const reply = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/token") {
      await refreshGate;
      return reply({ access_token: "refreshed-fixture", expires_in: 3600 });
    }
    if (path.startsWith("/dav/")) {
      if (req.method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" });
        return res.end(
          `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        );
      }
      const resource = davRemote.get(path);
      if (req.method === "GET") {
        if (!resource) return reply({}, 404);
        res.writeHead(200, {
          "content-type": "text/calendar",
          etag: resource.etag,
        });
        return res.end(resource.data);
      }
      writes.push({
        method: req.method!,
        path,
        ifMatch: req.headers["if-match"] as string | undefined,
        body: {},
      });
      if (!resource || req.headers["if-match"] !== resource.etag)
        return reply({}, 412);
      davRemote.set(path, { data: raw, etag: `"dav-written-${++version}"` });
      res.writeHead(204, { etag: davRemote.get(path)!.etag });
      return res.end();
    }
    if (req.method === "GET" && path.includes("/calendarList/"))
      return reply({ id: decodeURIComponent(path.split("/").pop()!), accessRole: writable ? "owner" : "reader" });
    if (req.method === "GET")
      return remote.has(path) ? reply(remote.get(path)) : reply({}, 404);
    const body = raw ? JSON.parse(raw) : {};
    writes.push({
      method: req.method!,
      path,
      ifMatch: req.headers["if-match"] as string | undefined,
      body,
    });
    beforeWrite?.();
    beforeWrite = undefined;
    const current = remote.get(path);
    if (
      req.method !== "POST" &&
      (!current || req.headers["if-match"] !== current.etag)
    )
      return reply({}, 412);
    if (req.method === "DELETE") {
      remote.delete(path);
      res.writeHead(204);
      return res.end();
    }
    const id = req.method === "POST" ? body.id : current!.id;
    const address = req.method === "POST" ? `${path}/${id}` : path;
    if (req.method === "POST" && remote.has(address)) return reply({}, 409);
    const stored = {
      ...current,
      ...body,
      id,
      etag: `"written-${++version}"`,
      organizer: { self: true },
    };
    remote.set(address, stored);
    if (dropCreateReply && req.method === "POST") {
      req.socket.destroy();
      return;
    }
    return reply(stored);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express();
  app.use(express.json());
  app.get(
    "/events/:eventId/delivery/:operationId/conflict",
    requireAuth,
    handlerGetEventDeliveryConflict,
  );
  app.post(
    "/events/:eventId/delivery/:operationId/resolve",
    requireAuth,
    handlerResolveEventDelivery,
  );
  app.use(middlewareErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if ([origin, fixtureOrigin].includes(url.origin))
      return realFetch(input, init);
    assert.ok(
      ["https://www.googleapis.com", "https://oauth2.googleapis.com"].includes(
        url.origin,
      ),
      "No live network outside provider fixture",
    );
    return realFetch(fixtureOrigin + url.pathname + url.search, init).then(response => {
      // Loopback is an owned transport substitute for the requested provider
      // address. It is not a provider redirect or a change of scoped target.
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    });
  };
  await db.insert(user).values(
    [owner, stranger].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      isExternal: true,
    })),
  );
  try {
    await replaceMemberToken(owner, token.tokenHash);
    await replaceMemberToken(stranger, strangerToken.tokenHash);
    await db.insert(account).values({
      id: randomUUID(),
      userId: owner,
      providerId: "google",
      accountId: owner,
      scope: CALENDAR_SCOPE.google,
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const calendar = await createCalendar({
      creatorID: owner,
      name: "Resolution",
      color: "#112233",
    });
    const [link] = await db
      .insert(externalCalendars)
      .values({
        userID: owner,
        provider: "google",
        accountID: owner,
        calendarID: calendar.id,
        externalCalendarID: "resolution",
      })
      .returning();
    const seed = async (
      action: "create" | "update" | "delete" = "update",
      exists = true,
    ) => {
      const event = EventSchema.parse({
        id: randomUUID(),
        creatorID: owner,
        organizer: owner,
        title: "Saved draft",
        color: "#112233",
        calendars: [calendar.id],
        originCalendarID: calendar.id,
        start: "2026-09-07T10:00:00.123Z",
        end: "2026-09-07T11:00:00.123Z",
        isAllDay: false,
        isCanceled: false,
      });
      const id = randomUUID();
      const remoteID =
        action === "create"
          ? googleEventCreateID({ operationID: id })
          : `resource-${id}`;
      const path = `/calendar/v3/calendars/resolution/events/${remoteID}`;
      const intent: EventOutboxIntent = {
        id,
        actorID: owner,
        mutationID: randomUUID(),
        position: 0,
        eventID: event.id,
        calendarID: calendar.id,
        externalCalendarLinkID: link.id,
        userID: owner,
        provider: "google",
        accountID: owner,
        externalCalendarID: "resolution",
        externalEventID: action === "create" ? null : remoteID,
        expectedEtag: action === "create" ? null : '"accepted"',
        action,
        payload: {
          event,
          patch: { title: event.title },
          createIdentityVersion: 1,
        },
      };
      await createEvent(event, event.calendars, [intent]);
      await db
        .update(eventOutbox)
        .set({
          status: "conflict",
          uncertain: true,
          remoteSnapshot: {
            externalEventId: remoteID,
            etag: '"remote"',
            deleted: !exists,
            observedAt: new Date().toISOString(),
          },
        })
        .where(eq(eventOutbox.id, id));
      if (action !== "create")
        await db.insert(externalEvents).values({
          provider: "google",
          eventID: event.id,
          calendarID: calendar.id,
          externalCalendarID: "resolution",
          externalEventID: remoteID,
          etag: '"accepted"',
        });
      if (exists)
        remote.set(path, {
          id: remoteID,
          etag: '"remote"',
          summary: "Remote edit",
          start: { dateTime: event.start.toISOString() },
          end: { dateTime: event.end.toISOString() },
          organizer: { self: true },
          attendees: [{ email: "preserve@example.test", self: true, organizer: true }],
          extendedProperties: {
            private: { musubiOperationID: id, untouched: "keep" },
          },
        });
      return { event, id, remoteID, path, intent };
    };
    const call = async (
      item: Awaited<ReturnType<typeof seed>>,
      method = "GET",
      body?: unknown,
      bearer = token.raw,
    ) => {
      const response = await fetch(
        `${origin}/events/${item.event.id}/delivery/${item.id}/${method === "GET" ? "conflict" : "resolve"}`,
        {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    const confirmation = (preview: EventDeliveryConflict) => ({
      mutationId: randomUUID(),
      expectedLocalRevision: preview.localRevision,
      expectedLatestOperationId: preview.latestOperationId,
      expectedRemoteExists: preview.remote !== null,
      expectedRemoteEtag: preview.remoteEtag,
    });
    const rows = (eventID: string) =>
      db.select().from(eventOutbox).where(eq(eventOutbox.eventID, eventID));
    const settled = async (
      eventID: string,
      expected: "completed" | "conflict",
    ) => {
      for (let i = 0; i < 250; i++) {
        const replacement = (await rows(eventID)).find(
          (row) => row.payload.resolution,
        );
        if (replacement?.status === expected) return replacement;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(
        `resolution did not reach ${expected}: ${JSON.stringify((await rows(eventID)).map(({ status, errorCode, attempts }) => ({ status, errorCode, attempts })))}`,
      );
    };


    // Legacy personal conflict resolution must not bypass the explicit meeting
    // notification contract, including already-saved requests from older clients.
    for (const action of ["update", "delete"] as const) {
      const meeting = await seed(action);
      remote.get(meeting.path)!.attendees = [{ email: "guest@example.test" }];
      const beforeRows = await rows(meeting.event.id);
      const beforeWrites = writes.length;
      const observed = await call(meeting);
      assert.equal(observed.status, 200);
      const preview = EventDeliveryConflictSchema.parse(observed.body);
      assert.equal(preview.canResolve, false, "A generic saved request cannot authorize notifying external guests");
      assert.equal((await call(meeting, "POST", confirmation(preview))).status, 409);
      assert.equal(writes.length, beforeWrites, "Legacy meeting confirmation performs no native writes");
      assert.deepEqual(await rows(meeting.event.id), beforeRows, "Refusal preserves the original saved intent");
    }

    const readOnly = await seed();
    const priorPreview = await prepareEventDeliveryResolution(owner, readOnly.event.id, readOnly.id);
    const priorConfirmation = confirmation(priorPreview.preview);
    const beforeReadOnly = await rows(readOnly.event.id);
    await db.update(calendarMembers).set({ role: "viewer" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
    const readsBeforeDenial = providerReads;
    const deniedPreview = await call(readOnly);
    assert.equal(deniedPreview.status, 409, "A past receipt cannot authorize a private conflict preview after write access is lost");
    assert.equal(providerReads, readsBeforeDenial, "Refuse locally before fetching native details");
    assert.equal((await call(readOnly, "POST", priorConfirmation)).status, 409);
    assert.equal(providerReads, readsBeforeDenial);
    await assert.rejects(() => commitEventDeliveryResolution(owner, priorPreview.proof, priorConfirmation));
    assert.deepEqual(await rows(readOnly.event.id), beforeReadOnly);
    await db.update(calendarMembers).set({ role: "owner" }).where(and(eq(calendarMembers.calendarID, calendar.id), eq(calendarMembers.userID, owner)));
    assert.equal((await call(readOnly)).status, 200);
    const queued = await seed();
    const next = {
      ...queued.intent,
      id: randomUUID(),
      mutationID: randomUUID(),
      payload: { event: queued.event, patch: { title: "Latest saved draft" } },
    };
    await patchEventAndCalendarLinks(
      queued.event.id,
      1,
      { title: "Latest saved draft" },
      false,
      [next],
    );
    assert.equal(
      (await call(queued, "GET", undefined, strangerToken.raw)).status,
      404,
    );
    const preview = EventDeliveryConflictSchema.parse(
      (await call(queued)).body,
    );
    assert.equal(preview.local?.title, "Latest saved draft");
    assert.equal(preview.remote?.title, "Remote edit");
    assert.equal(preview.latestOperationId, next.id);
    assert.equal(preview.canResolve, true);
    const body = confirmation(preview),
      beforeLocal = await getEventSnapshot(queued.event.id);
    assert.equal(
      (await call(queued, "POST", body, strangerToken.raw)).status,
      404,
    );
    assert.equal(
      (await call(queued, "POST", { ...body, externalEventID: "forged" }))
        .status,
      400,
    );
    assert.equal((await call(queued, "POST", body)).status, 202);
    const replacement = await settled(queued.event.id, "completed");
    assert.equal(replacement.revision, 2);
    assert.equal(replacement.action, "update");
    assert.deepEqual(
      await getEventSnapshot(queued.event.id),
      beforeLocal,
      "resolution never edits or discards local saved content",
    );
    assert.equal(remote.get(queued.path)!.summary, "Latest saved draft");
    assert.deepEqual(remote.get(queued.path)!.attendees, [
      { email: "preserve@example.test", self: true, organizer: true },
    ]);
    assert.equal(
      remote.get(queued.path)!.extendedProperties.private.untouched,
      "keep",
    );
    assert.equal(
      writes.filter((write) => write.path === queued.path)[0].ifMatch,
      '"remote"',
    );
    assert.ok(
      (await rows(queued.event.id))
        .filter((row) => row.id !== replacement.id)
        .every((row) => row.status === "cancelled"),
    );
    const writeCount = writes.length;
    assert.equal((await call(queued, "POST", body)).status, 202);
    assert.equal(
      writes.length,
      writeCount,
      "same confirmation identity is idempotent after completion",
    );
    assert.equal(
      (
        await call(queued, "POST", {
          ...body,
          expectedRemoteEtag: '"different"',
        })
      ).status,
      409,
    );

    const staleRemote = await seed();
    const staleBody = confirmation(
      EventDeliveryConflictSchema.parse((await call(staleRemote)).body),
    );
    remote.get(staleRemote.path)!.etag = '"newer"';
    remote.get(staleRemote.path)!.summary = "Newer remote edit";
    assert.equal(
      (await call(staleRemote, "POST", staleBody)).body.code,
      "delivery-state-changed",
    );
    assert.equal((await rows(staleRemote.event.id)).length, 1);
    const staleLocal = await seed();
    const localBody = confirmation(
      EventDeliveryConflictSchema.parse((await call(staleLocal)).body),
    );
    await patchEventAndCalendarLinks(
      staleLocal.event.id,
      1,
      { title: "Another local save" },
      false,
    );
    assert.equal(
      (await call(staleLocal, "POST", localBody)).body.code,
      "delivery-state-changed",
    );
    assert.equal(
      (await getEventSnapshot(staleLocal.event.id))!.title,
      "Another local save",
    );

    const duringWrite = await seed();
    const writeBody = confirmation(
      EventDeliveryConflictSchema.parse((await call(duringWrite)).body),
    );
    beforeWrite = () => {
      remote.get(duringWrite.path)!.etag = '"raced"';
      remote.get(duringWrite.path)!.summary = "Keep racing edit";
    };
    assert.equal((await call(duringWrite, "POST", writeBody)).status, 202);
    await settled(duringWrite.event.id, "conflict");
    assert.equal(
      remote.get(duringWrite.path)!.summary,
      "Keep racing edit",
      "If-Match still protects a change after confirmation",
    );

    const knownCreate = await seed("create");
    const createBody = confirmation(
      EventDeliveryConflictSchema.parse((await call(knownCreate)).body),
    );
    const createsBefore = writes.filter(
      (write) => write.method === "POST",
    ).length;
    assert.equal((await call(knownCreate, "POST", createBody)).status, 202);
    assert.equal(
      (await settled(knownCreate.event.id, "completed")).action,
      "update",
    );
    assert.equal(
      writes.filter((write) => write.method === "POST").length,
      createsBefore,
      "existing create identity is conditionally updated, not duplicated",
    );

    const missing = await seed("update", false);
    const missingPreview = EventDeliveryConflictSchema.parse(
      (await call(missing)).body,
    );
    assert.equal(missingPreview.action, "create");
    assert.equal(missingPreview.canResolve, true);
    assert.equal(
      (await call(missing, "POST", confirmation(missingPreview))).status,
      202,
    );
    assert.equal(
      (await settled(missing.event.id, "completed")).action,
      "create",
    );
    const ambiguous = await seed("create", false);
    await db
      .update(eventOutbox)
      .set({ status: "unconfirmed", uncertain: false, remoteSnapshot: null })
      .where(eq(eventOutbox.id, ambiguous.id));
    assert.equal(
      EventDeliveryConflictSchema.parse((await call(ambiguous)).body)
        .canResolve,
      false,
      "legacy unconfirmed absence cannot authorize another create identity",
    );

    // Review regression: a safe absent-create proof becomes unsafe after retry.
    const racingCreate = await seed("create", false);
    await db
      .update(eventOutbox)
      .set({ status: "blocked", uncertain: false, remoteSnapshot: null })
      .where(eq(eventOutbox.id, racingCreate.id));
    const safe = await prepareEventDeliveryResolution(
      owner,
      racingCreate.event.id,
      racingCreate.id,
    );
    assert.equal(safe.preview.canResolve, true);
    await requestEventDeliveryRetry(
      owner,
      racingCreate.event.id,
      racingCreate.id,
    );
    dropCreateReply = true;
    assert.equal(
      (await deliverEventOutbox(racingCreate.id, getAdapter))?.status,
      "unconfirmed",
    );
    dropCreateReply = false;
    await assert.rejects(
      commitEventDeliveryResolution(
        owner,
        safe.proof,
        confirmation(safe.preview),
      ),
      (error: unknown) =>
        error instanceof EventDeliveryResolutionError &&
        error.code === "delivery-state-changed",
    );
    assert.equal((await rows(racingCreate.event.id)).length, 1);

    const deletedDuringRead = await seed("create");
    const fresh = await prepareEventDeliveryResolution(
      owner,
      deletedDuringRead.event.id,
      deletedDuringRead.id,
    );
    await deleteExternalEvent(
      "google",
      calendar.id,
      deletedDuringRead.remoteID,
    );
    await assert.rejects(
      commitEventDeliveryResolution(
        owner,
        fresh.proof,
        confirmation(fresh.preview),
      ),
      (error: unknown) =>
        error instanceof EventDeliveryResolutionError &&
        error.code === "delivery-state-changed",
    );
    assert.equal((await rows(deletedDuringRead.event.id)).length, 1);
    const [firstDeletion] = await db
      .select()
      .from(externalEventTombstones)
      .where(
        eq(externalEventTombstones.externalEventID, deletedDuringRead.remoteID),
      );
    await deleteExternalEvent(
      "google",
      calendar.id,
      deletedDuringRead.remoteID,
    );
    const [secondDeletion] = await db
      .select()
      .from(externalEventTombstones)
      .where(
        eq(externalEventTombstones.externalEventID, deletedDuringRead.remoteID),
      );
    assert.notEqual(
      firstDeletion.id,
      secondDeletion.id,
      "each repeated deletion observation needs its own CAS version",
    );

    const markerOnly = await seed();
    const changedMapping = await seed();
    const mappingProof = await prepareEventDeliveryResolution(
      owner,
      changedMapping.event.id,
      changedMapping.id,
    );
    await db
      .update(externalEvents)
      .set({ etag: '"new-mapping"' })
      .where(eq(externalEvents.eventID, changedMapping.event.id));
    await assert.rejects(
      commitEventDeliveryResolution(
        owner,
        mappingProof.proof,
        confirmation(mappingProof.preview),
      ),
      (error: unknown) =>
        error instanceof EventDeliveryResolutionError &&
        error.code === "delivery-state-changed",
    );
    assert.equal(
      (
        await db
          .select()
          .from(externalEvents)
          .where(eq(externalEvents.eventID, changedMapping.event.id))
      )[0].etag,
      '"new-mapping"',
    );
    const [marker] = await db
      .insert(externalEventTombstones)
      .values({
        externalCalendarLinkID: link.id,
        externalEventID: markerOnly.remoteID,
      })
      .returning();
    const markerProof = await prepareEventDeliveryResolution(
      owner,
      markerOnly.event.id,
      markerOnly.id,
    );
    // Same timestamp, different observation: timestamps alone are not a CAS.
    await db
      .update(externalEventTombstones)
      .set({ id: randomUUID() })
      .where(eq(externalEventTombstones.id, marker.id));
    await assert.rejects(
      commitEventDeliveryResolution(
        owner,
        markerProof.proof,
        confirmation(markerProof.preview),
      ),
      (error: unknown) =>
        error instanceof EventDeliveryResolutionError &&
        error.code === "delivery-state-changed",
    );
    const revivedPreview = EventDeliveryConflictSchema.parse(
      (await call(markerOnly)).body,
    );
    assert.equal(
      (await call(markerOnly, "POST", confirmation(revivedPreview))).status,
      202,
    );
    await settled(markerOnly.event.id, "completed");
    assert.equal(
      (
        await db
          .select()
          .from(externalEventTombstones)
          .where(
            eq(externalEventTombstones.externalEventID, markerOnly.remoteID),
          )
      ).length,
      0,
      "explicit fresh evidence can supersede an older deletion observation",
    );

    const alreadyMatches = await seed();
    remote.get(alreadyMatches.path)!.summary = alreadyMatches.event.title;
    writable = false;
    const matchingPreview = EventDeliveryConflictSchema.parse(
      (await call(alreadyMatches)).body,
    );
    assert.equal(
      matchingPreview.canResolve,
      true,
      "matching read evidence can resolve without write permission",
    );
    const beforeMatching = writes.length;
    assert.equal(
      (await call(alreadyMatches, "POST", confirmation(matchingPreview)))
        .status,
      202,
    );
    await settled(alreadyMatches.event.id, "completed");
    assert.equal(
      writes.length,
      beforeMatching,
      "verified matching content needs only a local acknowledgement",
    );
    writable = true;

    for (const exists of [true, false]) {
      const removed = await seed("delete", exists);
      await db.delete(events).where(eq(events.id, removed.event.id));
      const deletionPreview = EventDeliveryConflictSchema.parse(
        (await call(removed)).body,
      );
      assert.equal(deletionPreview.local, null);
      assert.equal(deletionPreview.localRevision, null);
      assert.equal(deletionPreview.action, "delete");
      assert.equal(deletionPreview.canResolve, true);
      assert.equal(
        (await call(removed, "POST", confirmation(deletionPreview))).status,
        202,
      );
      assert.equal(
        (await settled(removed.event.id, "completed")).action,
        "delete",
      );
      assert.equal(remote.has(removed.path), false);
    }

    // Actual CalDAV preserves unknown properties/components while projecting
    // sub-second local timestamps into iCalendar's supported second precision.
    const davCalendar = await createCalendar({
      creatorID: owner,
      name: "DAV resolution",
      color: "#112233",
    });
    const davAccount = await saveCaldavAccount(
      owner,
      `${fixtureOrigin}/dav/`,
      "owner",
      encryptSecret("fixture-password"),
    );
    const davURL = `${fixtureOrigin}/dav/calendar/`;
    const [davLink] = await db
      .insert(externalCalendars)
      .values({
        provider: "caldav",
        userID: owner,
        accountID: davAccount.id,
        calendarID: davCalendar.id,
        externalCalendarID: davURL,
      })
      .returning();
    const davPath = "/dav/calendar/retained.ics",
      resourceURL = fixtureOrigin + davPath;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Fixture//EN",
      "X-CALENDAR:keep",
      "BEGIN:VEVENT",
      "UID:retained@example.test",
      "DTSTAMP:20260907T090000Z",
      "DTSTART:20260907T100000Z",
      "DTEND:20260907T110000Z",
      "SUMMARY:Remote DAV",
      "RRULE:FREQ=WEEKLY",
      "X-PRIVATE-PROPERTY:keep",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "DESCRIPTION:Keep alarm",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const normalized = icalToNormalized({ url: resourceURL, data: ics })!;
    const davEvent = EventSchema.parse({
      ...normalized,
      id: randomUUID(),
      creatorID: owner,
      organizer: owner,
      color: "#112233",
      title: "Saved DAV draft",
      start: new Date(normalized.start.getTime() + 123),
      end: new Date(normalized.end.getTime() + 123),
      calendars: [davCalendar.id],
      originCalendarID: davCalendar.id,
      isCanceled: false,
    });
    const davID = randomUUID();
    const davIntent: EventOutboxIntent = {
      id: davID,
      actorID: owner,
      mutationID: randomUUID(),
      position: 0,
      eventID: davEvent.id,
      calendarID: davCalendar.id,
      externalCalendarLinkID: davLink.id,
      userID: owner,
      provider: "caldav",
      accountID: davAccount.id,
      externalCalendarID: davURL,
      externalEventID: resourceURL,
      expectedEtag: '"dav-old"',
      icalUid: "retained@example.test",
      action: "update",
      payload: { event: davEvent, patch: { title: davEvent.title } },
    };
    await createEvent(davEvent, davEvent.calendars, [davIntent]);
    await db.insert(externalEvents).values({
      provider: "caldav",
      eventID: davEvent.id,
      calendarID: davCalendar.id,
      externalCalendarID: davURL,
      externalEventID: resourceURL,
      etag: '"dav-old"',
      icalUid: "retained@example.test",
    });
    await db
      .update(eventOutbox)
      .set({ status: "conflict", uncertain: true })
      .where(eq(eventOutbox.id, davID));
    davRemote.set(davPath, { data: ics, etag: '"dav-current"' });
    const davCase = {
      event: davEvent,
      id: davID,
      remoteID: resourceURL,
      path: davPath,
      intent: davIntent,
    };
    const davPreview = EventDeliveryConflictSchema.parse(
      (await call(davCase)).body,
    );
    assert.equal(davPreview.canResolve, true);
    assert.equal(
      (await call(davCase, "POST", confirmation(davPreview))).status,
      202,
    );
    await settled(davEvent.id, "completed");
    const deliveredICS = davRemote.get(davPath)!.data;
    for (const preserved of [
      "X-CALENDAR:keep",
      "X-PRIVATE-PROPERTY:keep",
      "BEGIN:VALARM",
      "DESCRIPTION:Keep alarm",
      "RRULE:FREQ=WEEKLY",
      "UID:retained@example.test",
    ])
      assert.ok(
        deliveredICS.includes(preserved),
        `CalDAV preserving resolution lost ${preserved}`,
      );
    assert.ok(deliveredICS.includes("SUMMARY:Saved DAV draft"));
    assert.equal(
      writes.find((write) => write.path === davPath)!.ifMatch,
      '"dav-current"',
    );
    assert.equal(
      (await getEventSnapshot(davEvent.id))!.start.getMilliseconds(),
      123,
    );

    // A stuck OAuth refresh must not outlive the preview's response deadline.
    const timeout = await seed();
    refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await db
      .update(account)
      .set({ accessTokenExpiresAt: new Date(0) })
      .where(eq(account.userId, owner));
    const started = Date.now();
    const timedOut = await call(timeout);
    assert.equal(timedOut.status, 409);
    assert.equal(timedOut.body.code, "delivery-resolution-unavailable");
    assert.ok(
      Date.now() - started < 14_000,
      "OAuth refresh cannot hold the preview beyond the 12s deadline",
    );
    releaseRefresh!();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await rows(timeout.event.id)).length, 1);
    console.log(
      "K09 conflict resolution: actual Google HTTP conditional writes, stale proofs, archived queue, preserved draft, create recovery and OAuth deadline passed",
    );
  } finally {
    releaseRefresh?.();
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await db.delete(user).where(inArray(user.id, [owner, stranger]));
  }
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
