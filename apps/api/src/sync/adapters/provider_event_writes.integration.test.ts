import { eventPatchRequest, type EventWriteRequest } from "@musubi/types";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { eq, sql } from "drizzle-orm";
import {
  account,
  CALENDAR_SCOPE,
  calendarEvents,
  createEvent,
  patchEventAndCalendarLinks,
  db,
  events,
  eventOutbox,
  externalEvents,
  getEvent,
  getExternalEvent,
  importExternalCalendar,
  importExternalEvent,
  memberTokens,
  saveCaldavAccount,
  setExternalEventSyncData,
  unlinkEventAndTombstoneIfOrphaned,
  user,
} from "@musubi/db";
import {
  CLIENT_VERSION_HEADER,
  EventSchema,
  PRODUCT_VERSION,
} from "@musubi/types";
import { googleAdapter } from "./google";
import { caldavAdapter, icalToNormalized } from "./caldav";
import { ProviderEventWriteError } from "../event_write";
import { EventDeliveryError, prepareEventWrites } from "../engine";
import { encryptSecret } from "../crypto";
import { issueMemberToken } from "../../federation_tokens";
import { requireAuth } from "../../middleware/require_auth";
import { middlewareErrorHandler } from "../../middleware/error_handler";
import { handlerImportCalendar } from "../../handlers/calendars";
import { handlerCreateEvent, handlerForkEvent, handlerLinkEvent, handlerUpdateEvent, handlerRemoveEvent } from "../../handlers/events";

// This fixture proves actual adapter/handler HTTP behavior, not provider-side
// enforcement. Google Calendar docs and RFC 4791/9110 supply that contract.
const richIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Unknown vendor//Calendar//EN",
  'X-CALENDAR-EXTRA;X-PARAM="urn:calendar":keep\\,all',
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Prague",
  "X-ZONE:opaque",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:rich@example.test",
  "SEQUENCE:42",
  "DTSTAMP:20260101T000000Z",
  'DTSTART;TZID=Europe/Prague;X-TIME="urn:time":20260101T100000',
  "DTEND;TZID=Europe/Prague:20260101T110000",
  "RRULE:FREQ=WEEKLY",
  'SUMMARY;LANGUAGE=cs;X-TITLE="urn:title":Before',
  'DESCRIPTION;ALTREP="cid:part1.0001@example.test":Text\\nwith folded',
  "\t continuation and \\, escaping",
  "X-ALT-DESC;FMTTYPE=text/html:<b>Rich</b>",
  'LOCATION;LANGUAGE=cs;X-COORD="geo:50,14":Room\\, 2',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="Room 2":geo:50,14',
  'ATTENDEE;CN="Guest: Person";ROLE=REQ-PARTICIPANT;X-UNKNOWN=YES:mailto:guest@example.test',
  'X-UNKNOWN;VALUE=TEXT;X-QUOTED="a:b;c":one\\,two',
  "X-FOLDED:preserve this long line exactly",
  " and its folding",
  "\tand tab",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Alarm text",
  'X-ALARM;X-ARG="urn:alarm":keep',
  "END:VALARM",
  "BEGIN:X-CUSTOM",
  "X-PROP;X-PARAM=opaque:unknown component",
  "END:X-CUSTOM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:rich@example.test",
  "RECURRENCE-ID;TZID=Europe/Prague:20260108T100000",
  "DTSTART;TZID=Europe/Prague:20260108T120000",
  "DTEND;TZID=Europe/Prague:20260108T130000",
  "SUMMARY:Detached",
  "X-EXCEPTION;X-KEEP=YES:keep all",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

type Remote = {
  etag: string | null;
  data?: string;
  json?: Record<string, unknown>;
};

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.ok(process.env.DATABASE_URL);
  const owner = `k06-providers-${randomUUID()}`;
  const token = issueMemberToken();
  const requests: {
    method: string;
    path: string;
    auth: string;
    ifMatch?: string;
    body: string;
  }[] = [];
  const remote = new Map<string, Remote>();
  let nextVersion = 0;
  let writeStatus = 200;
  let omitWriteEtag = false;
  let weakWriteEtag = false;
  let readEtag: string | null | undefined;
  let transformAfterWrite = false;
  let disconnectWrite = false;
  let malformedWrite = false;
  let partialRead = false;
  let invalidUtf8Read = false;
  let beforeEventRead: (() => Promise<void>) | undefined;
  let beforeMutationResponse: (() => Promise<void>) | undefined;
  let eventCreatesUntilFailure: number | undefined;
  let deniedWriteAuth: string | undefined;
  const key = (auth: string, path: string) => `${auth}:${path}`;
  const fixture = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const path = new URL(req.url!, "http://fixture.test").pathname;
      const method = req.method!;
      const auth = req.headers.authorization ?? "";
      requests.push({
        method,
        path,
        auth,
        ifMatch: req.headers["if-match"] as string | undefined,
        body,
      });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const xml = (props: string) => {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${path}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        );
      };
      const stored = remote.get(key(auth, path));
      if (method === "GET" && path.includes("/calendarList/"))
        return json({ id: decodeURIComponent(path.split("/").pop()!), accessRole: "owner" });
      if (method === "GET" && path.endsWith("/events")) {
        return json({
          items: [...remote.entries()]
            .filter(([entry]) => entry.startsWith(`${auth}:${path}/`))
            .map(([, value]) => ({ ...value.json, etag: value.etag })),
          nextSyncToken: "cursor",
        });
      }
      if (method === "GET") {
        if (!stored) return json({}, 404);
        const etag = readEtag === undefined ? stored.etag : readEtag;
        if (stored.data !== undefined) {
          res.writeHead(partialRead ? 206 : 200, {
            "content-type": "text/calendar",
            ...(etag === null ? {} : { etag }),
          });
          return res.end(
            invalidUtf8Read
              ? Buffer.concat([Buffer.from(stored.data), Buffer.from([0xff])])
              : stored.data,
          );
        }
        const send = () =>
          json({ ...stored.json, etag, organizer: { self: true } });
        if (beforeEventRead) {
          const action = beforeEventRead;
          beforeEventRead = undefined;
          void action().then(send);
          return;
        }
        return send();
      }
      if (method === "PROPFIND")
        return xml(
          body.includes("current-user-privilege-set")
            ? "<d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>"
            : "<d:current-user-principal><d:href>/dav/principal/</d:href></d:current-user-principal><c:calendar-home-set><d:href>/dav/</d:href></c:calendar-home-set>",
        );
      if (method === "REPORT")
        return json(
          { error: "Preserving writes must GET, never projected REPORT" },
          409,
        );
      if (["PATCH", "PUT", "DELETE", "POST"].includes(method)) {
        if (disconnectWrite) {
          req.socket.destroy();
          return;
        }
        if (writeStatus === 303) {
          res.writeHead(303, { location: "/unexpected-redirect" });
          return res.end();
        }
        if (deniedWriteAuth === auth) return json({}, 412);
        if (writeStatus !== 200) {
          await beforeMutationResponse?.();
          return json({}, writeStatus);
        }
        if (method === "POST" && path.endsWith("/events") && eventCreatesUntilFailure !== undefined) {
          if (eventCreatesUntilFailure-- === 0) return json({}, 503);
        }
        if (method === "DELETE") {
          remote.delete(key(auth, path));
          res.writeHead(204);
          return res.end();
        }
        const etag = `"written-${++nextVersion}"`;
        const responseEtag = omitWriteEtag
          ? null
          : weakWriteEtag
            ? `W/${etag}`
            : etag;
        if (path.startsWith("/dav/")) {
          remote.set(key(auth, path), {
            etag,
            data: body + (transformAfterWrite ? "\r\n" : ""),
          });
          res.writeHead(
            204,
            responseEtag === null ? {} : { etag: responseEtag },
          );
          return res.end();
        }
        const id =
          method === "POST"
            ? (JSON.parse(body).id ?? `created-${nextVersion}`)
            : (stored?.json?.id ?? "same-remote-id");
        remote.set(key(auth, method === "POST" ? `${path}/${id}` : path), {
          etag,
          json: { ...stored?.json, ...JSON.parse(body), id },
        });
        if (malformedWrite) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("{");
        }
        if (path.endsWith("/events") || path.includes("/events/")) await beforeMutationResponse?.();
        return json({
          id,
          ...(responseEtag === null ? {} : { etag: responseEtag }),
        });
      }
      return json({ error: `Unexpected ${method} ${path}` }, 500);
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express();
  app.use(express.json());
  app.post("/events", requireAuth, handlerCreateEvent);
  app.post("/events/:eventId/fork", requireAuth, handlerForkEvent);
  app.post("/events/:eventId/link", requireAuth, handlerLinkEvent);
  app.patch("/events", requireAuth, handlerUpdateEvent);
  app.put("/events", requireAuth, handlerUpdateEvent);
  app.delete("/events", requireAuth, handlerRemoveEvent);
  app.post("/import", requireAuth, express.text({ type: "text/calendar" }), handlerImportCalendar);
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if ([origin, apiOrigin].includes(url.origin)) return realFetch(input, init);
    assert.equal(
      url.origin,
      "https://www.googleapis.com",
      `No live provider calls: ${url}`,
    );
    return realFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  const mutationRequests = () =>
    requests.filter(({ method }) =>
      ["POST", "PATCH", "PUT", "DELETE"].includes(method),
    );
  // Provider scenarios seed a fresh authoritative draft for each independent operation.
  // Stale/local-CAS races are exercised by event_revision.integration.test.ts.
  const request = async (method: string, event: EventWriteRequest) => {
    // These K06 cases intentionally reset provider state between independent
    // scenarios. Reset their durable attempts too; K07 ordering has its own cases.
    await db.delete(eventOutbox).where(eq(eventOutbox.eventID, event.id));
    return fetch(`${apiOrigin}/events`, {
      method,
      headers: {
        authorization: `Bearer ${token.raw}`,
        "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
      },
      body: JSON.stringify(
        method === "DELETE"
          ? {
              id: event.id,
              expectedRevision: (await getEvent(event.id)).revision,
            }
          : eventPatchRequest({
              ...event,
              revision: (await getEvent(event.id)).revision,
            }),
      ),
    });
  };
  const snapshot = async () =>
    JSON.stringify([
      await db.select().from(events).orderBy(events.id),
      await db
        .select()
        .from(calendarEvents)
        .orderBy(calendarEvents.eventID, calendarEvents.calendarID),
      await db.select().from(externalEvents).orderBy(externalEvents.id),
    ]);
  const noMutation = async (run: () => Promise<unknown>) => {
    const before = await snapshot();
    const count = mutationRequests().length;
    await run();
    assert.equal(
      mutationRequests().length,
      count,
      "No remote mutation on preflight refusal",
    );
    assert.equal(
      await snapshot(),
      before,
      "No local/link/mapping mutation on preflight refusal",
    );
  };
  const providerError = (code: string) => (error: unknown) =>
    error instanceof ProviderEventWriteError && error.code === code;
  const eventIn = (calendars: string[]) =>
    EventSchema.parse({
      id: randomUUID(),
      creatorID: owner,
      organizer: owner,
      title: "Before",
      color: "#7A8BA3",
      start: "2026-01-01T09:00:00Z",
      end: "2026-01-01T10:00:00Z",
      isAllDay: false,
      isCanceled: false,
      calendars,
      originCalendarID: calendars[0],
      description: "<b>Rich HTML</b>",
      location: "Room",
    });
  await db.insert(user).values({
    id: owner,
    name: owner,
    email: `${owner}@example.test`,
    isExternal: true,
  });
  try {
    await db
      .insert(memberTokens)
      .values({ userID: owner, tokenHash: token.tokenHash });
    await db.insert(account).values(
      ["primary", "sibling"].map((accountId) => ({
        id: randomUUID(),
        userId: owner,
        providerId: "google",
        accountId,
        scope: CALENDAR_SCOPE.google,
        accessToken: `${accountId}-access`,
        refreshToken: "fixture",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      })),
    );
    const mirrors = await Promise.all(
      ["primary", "sibling"].map((accountID) =>
        importExternalCalendar("google", owner, accountID, accountID, {
          externalId: "same-calendar",
          name: accountID,
          color: "#7A8BA3",
        }),
      ),
    );
    const googlePath =
      "/calendar/v3/calendars/same-calendar/events/same-remote-id";
    const googleEvent = eventIn([mirrors[0].id]);
    const opaque = '"G,opaque\\validator"';
    const googleJson = {
      id: "same-remote-id",
      summary: "Before",
      description: "<b>Rich HTML</b>",
      location: "Room",
      start: { dateTime: googleEvent.start.toISOString() },
      end: { dateTime: googleEvent.end.toISOString() },
      // This generic writer fixture is a personal event. Meetings with guests
      // use the separate organizer action and its explicit notification policy.
      attendees: [{ email: "owner@example.test", self: true, organizer: true, responseStatus: "accepted" }],
      eventType: "focusTime",
      focusTimeProperties: { autoDeclineMode: "declineNone", chatStatus: "doNotDisturb" },
      transparency: "opaque",
      visibility: "private",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 17 }] },
      conferenceData: { conferenceId: "native-kept", signature: "opaque-native-signature", entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/aaa-bbbb-ccc" }] },
      extendedProperties: { private: { unknown: "keep" } },
    };
    remote.set(key("Bearer primary-access", googlePath), {
      etag: opaque,
      json: googleJson,
    });
    remote.set(key("Bearer sibling-access", googlePath), {
      etag: '"sibling"',
      json: googleJson,
    });
    const pulled = await googleAdapter.fetchChanges(
      owner,
      "primary",
      "same-calendar",
      null,
    );
    assert.equal(pulled.changes[0].kind, "event");
    assert.equal(
      pulled.changes[0].data.etag,
      opaque,
      "Google EVENT read captures exact opaque ETag",
    );
    await createEvent(googleEvent, googleEvent.calendars);
    await importExternalEvent(
      "google",
      googleEvent.id,
      mirrors[0].id,
      "same-calendar",
      "same-remote-id",
      opaque,
    );
    // Same remote ID in another account/local calendar cannot contaminate this mapping.
    await importExternalEvent(
      "google",
      googleEvent.id,
      mirrors[1].id,
      "same-calendar",
      "same-remote-id",
      '"sibling"',
    );
    requests.length = 0;
    const googleTitle = { ...googleEvent, title: "Title only" };
    assert.equal((await request("PUT", googleTitle)).status, 200);
    assert.deepEqual(
      mutationRequests().map(({ method, ifMatch, body, auth }) => ({
        method,
        ifMatch,
        body: JSON.parse(body),
        auth,
      })),
      [
        {
          method: "PATCH",
          ifMatch: opaque,
          body: { summary: "Title only" },
          auth: "Bearer primary-access",
        },
      ],
    );
    const googleRef = (await getExternalEvent(
      "google",
      googleEvent.id,
      "same-calendar",
      mirrors[0].id,
    ))!;
    assert.equal(
      googleRef.etag,
      remote.get(key("Bearer primary-access", googlePath))!.etag,
    );
    assert.equal(
      (await getExternalEvent(
        "google",
        googleEvent.id,
        "same-calendar",
        mirrors[1].id,
      ))!.etag,
      '"sibling"',
    );
    assert.deepEqual(
      remote.get(key("Bearer primary-access", googlePath))!.json?.attendees,
      googleJson.attendees,
    );
    // The actual authenticated handler/worker PATCH above changed only title.
    // Inspect stored native bytes/fields and then read them through the adapter,
    // rather than inferring preservation from the outgoing request alone.
    assert.deepEqual(remote.get(key("Bearer primary-access", googlePath))!.json, { ...googleJson, summary: "Title only" });
    const readback = await googleAdapter.fetchChanges(owner, "primary", "same-calendar", pulled.nextCursor);
    const observed = readback.changes.find(change => change.kind === "event");
    assert.ok(observed?.kind === "event");
    assert.equal(observed.data.title, "Title only");
    assert.equal(observed.data.providerState?.eventType, "focusTime");
    assert.equal(observed.data.providerState?.availability, "opaque");
    assert.equal(observed.data.providerState?.privacy, "private");
    assert.deepEqual(observed.data.providerState?.reminders, { provider: "google", useDefault: false, overrides: [{ method: "popup", minutes: 17 }] });
    assert.deepEqual(observed.data.providerState?.conferenceURLs, ["https://meet.google.com/aaa-bbbb-ccc"]);
    assert.equal(observed.data.start.toISOString(), googleEvent.start.toISOString());
    assert.equal(observed.data.end.toISOString(), googleEvent.end.toISOString());
    await noMutation(async () => {
      await assert.rejects(
        () =>
          googleAdapter.pushUpdate(
            owner,
            "primary",
            "same-calendar",
            "same-remote-id",
            googleTitle,
            googleRef,
          ),
        providerError("event-diff-unavailable"),
      );
      await assert.rejects(
        () =>
          prepareEventWrites([
            {
              action: "update",
              event: googleTitle,
              calendarIDs: googleTitle.calendars,
            },
          ]),
        providerError("event-diff-unavailable"),
      );
    });
    for (const etag of [
      null,
      "",
      "*",
      "unquoted",
      'W/"weak"',
      ' "space"',
      '"bad\nline"',
    ]) {
      await noMutation(async () => {
        await assert.rejects(
          () =>
            googleAdapter.pushUpdate(
              owner,
              "primary",
              "same-calendar",
              "same-remote-id",
              googleTitle,
              { ...googleRef, etag },
              { title: googleTitle.title },
            ),
          providerError("provider-version-unavailable"),
        );
        await assert.rejects(
          () =>
            googleAdapter.pushDelete(
              owner,
              "primary",
              "same-calendar",
              "same-remote-id",
              { ...googleRef, etag },
            ),
          providerError("provider-version-unavailable"),
        );
      });
    }
    for (const fresh of ['"unseen"', null, 'W/"weak"']) {
      readEtag = fresh;
      await noMutation(async () =>
        assert.equal(
          (await request("PUT", { ...googleTitle, title: "Refused" })).status,
          409,
        ),
      );
    }
    readEtag = undefined;
    await noMutation(async () => {
      await googleAdapter.pushUpdate(
        owner,
        "primary",
        "same-calendar",
        "same-remote-id",
        googleTitle,
        googleRef,
        {},
      );
    });
    const cleared = await googleAdapter.pushUpdate(
      owner,
      "primary",
      "same-calendar",
      "same-remote-id",
      { ...googleTitle, description: null },
      googleRef,
      { description: null },
    );
    assert.deepEqual(
      JSON.parse(mutationRequests()[mutationRequests().length - 1].body),
      { description: null },
    );
    assert.ok(cleared?.etag);
    await setExternalEventSyncData(
      "google",
      googleEvent.id,
      "same-calendar",
      { etag: cleared.etag, icalUid: null },
      mirrors[0].id,
    );

    // Provider 412 is visible, never retried or swallowed. Current legacy handler
    // commits locally first for update, but cannot yet expose a K06 UI receipt.
    writeStatus = 412;
    requests.length = 0;
    assert.equal(
      (
        await request("PUT", {
          ...googleTitle,
          title: "Locally committed conflict",
        })
      ).status,
      409,
    );
    assert.equal(
      (await getEvent(googleEvent.id)).title,
      "Locally committed conflict",
    );
    assert.equal(mutationRequests().length, 1);
    assert.equal(mutationRequests()[0].ifMatch, cleared.etag);
    assert.equal(
      (await getExternalEvent(
        "google",
        googleEvent.id,
        "same-calendar",
        mirrors[0].id,
      ))!.etag,
      cleared.etag,
    );
    const deleteEvent = { ...googleEvent, id: randomUUID() };
    remote.set(key("Bearer primary-access", "/calendar/v3/calendars/same-calendar/events/delete-conflict"), {
      etag: cleared.etag, json: { ...googleJson, id: "delete-conflict" },
    });
    await createEvent(deleteEvent, deleteEvent.calendars);
    await importExternalEvent(
      "google",
      deleteEvent.id,
      mirrors[0].id,
      "same-calendar",
      "delete-conflict",
      cleared.etag,
    );
    const deletedConflict = await request("DELETE", deleteEvent);
    assert.equal(deletedConflict.status, 409);
    const deletionReceipt = await deletedConflict.json();
    assert.equal(deletionReceipt.localCommitted, true);
    assert.equal(deletionReceipt.currentRevision, 2);
    assert.ok((await getEvent(deleteEvent.id)).deletedAt);
    writeStatus = 202;
    await assert.rejects(
      () =>
        googleAdapter.pushDelete(
          owner,
          "primary",
          "same-calendar",
          "same-remote-id",
          { ...googleRef, etag: cleared.etag },
        ),
      (error: unknown) =>
        error instanceof ProviderEventWriteError &&
        error.outcome === "unconfirmed",
    );
    writeStatus = 303;
    const redirectsBefore = requests.length;
    await assert.rejects(() =>
      googleAdapter.pushDelete(
        owner,
        "primary",
        "same-calendar",
        "same-remote-id",
        { ...googleRef, etag: cleared.etag },
      ),
    );
    assert.equal(
      requests.length,
      redirectsBefore + 1,
      "Google conditional writes never follow redirects to GET",
    );
    writeStatus = 200;

    // Prepared refs and receipts remain scoped and survive local mapping removal.
    const deletes = await prepareEventWrites([
      {
        action: "delete",
        event: googleTitle,
        calendarIDs: [mirrors[0].id, mirrors[1].id],
      },
    ]);
    await unlinkEventAndTombstoneIfOrphaned(googleEvent.id, [
      mirrors[0].id,
      mirrors[1].id,
    ]);
    requests.length = 0;
    const deleted = await deletes();
    assert.deepEqual(
      deleted.map(({ status }) => status),
      ["completed", "completed"],
    );
    assert.deepEqual(
      mutationRequests().map(({ ifMatch, auth }) => ({ ifMatch, auth })),
      [
        { ifMatch: cleared.etag, auth: "Bearer primary-access" },
        { ifMatch: '"sibling"', auth: "Bearer sibling-access" },
      ],
    );
    await deletes();
    assert.equal(
      mutationRequests().length,
      2,
      "Prepared closure cannot re-send completed writes",
    );

    // Successful writes never invent or carry forward validators; create and
    // update return null when absent/weak instead of accepting an unseen GET.
    for (const weak of [false, true]) {
      omitWriteEtag = !weak;
      weakWriteEtag = weak;
      const created = await googleAdapter.pushCreate(
        owner,
        "primary",
        "same-calendar",
        googleEvent,
      );
      assert.equal(created.etag, null);
    }
    omitWriteEtag = false;
    weakWriteEtag = false;
    malformedWrite = true;
    await assert.rejects(
      () =>
        googleAdapter.pushCreate(
          owner,
          "primary",
          "same-calendar",
          googleEvent,
        ),
      (error: unknown) =>
        error instanceof ProviderEventWriteError &&
        error.outcome === "unconfirmed",
    );
    malformedWrite = false;

    const davAccount = await saveCaldavAccount(
      owner,
      `${origin}/dav/`,
      "owner",
      encryptSecret("fixture-password"),
    );
    const davAuth = `Basic ${Buffer.from("owner:fixture-password").toString("base64")}`;
    const davCalendar = `${origin}/dav/cal/`;
    const davPath = "/dav/cal/rich.ics";
    const davUrl = `${origin}${davPath}`;
    const dav = await importExternalCalendar(
      "caldav",
      owner,
      davAccount.id,
      "DAV",
      { externalId: davCalendar, name: "DAV", color: "#7A8BA3" },
    );
    const normalized = icalToNormalized({ url: davUrl, data: richIcs })!;
    assert.ok(normalized);
    const davEvent = {
      ...eventIn([dav.id]),
      ...normalized,
      id: randomUUID(),
      organizer: owner,
    };
    const davRef = {
      externalEventId: davUrl,
      etag: '"DAV,opaque\\tag"',
      icalUid: "rich@example.test",
    };
    remote.set(key(davAuth, davPath), { etag: davRef.etag, data: richIcs });
    await createEvent(davEvent, davEvent.calendars);
    await importExternalEvent(
      "caldav",
      davEvent.id,
      dav.id,
      davCalendar,
      davUrl,
      davRef.etag,
      davRef.icalUid,
    );
    requests.length = 0;
    const davTitle = { ...davEvent, title: "Changed" };
    assert.equal((await request("PUT", davTitle)).status, 200);
    const preserved = richIcs.replace(":Before\r\n", ":Changed\r\n");
    assert.equal(
      remote.get(key(davAuth, davPath))!.data,
      preserved,
      "COMPLETE byte equality except selected SUMMARY: folded properties, parameters, nested components, UID and detached exceptions",
    );
    assert.deepEqual(
      mutationRequests().map(({ method, ifMatch, body }) => ({
        method,
        ifMatch,
        body,
      })),
      [{ method: "PUT", ifMatch: davRef.etag, body: preserved }],
    );
    assert.equal(
      requests.filter(({ method }) => method === "REPORT").length,
      0,
    );
    const currentDavRef = (await getExternalEvent(
      "caldav",
      davEvent.id,
      davCalendar,
      dav.id,
    ))!;
    assert.equal(currentDavRef.etag, remote.get(key(davAuth, davPath))!.etag);
    for (const etag of [
      null,
      "",
      "*",
      "unquoted",
      'W/"weak"',
      ' "space"',
      '"bad\nline"',
    ]) {
      await noMutation(async () => {
        await assert.rejects(
          () =>
            caldavAdapter.pushUpdate(
              owner,
              davAccount.id,
              davCalendar,
              davUrl,
              davTitle,
              { ...currentDavRef, etag },
              { title: "Changed" },
            ),
          providerError("provider-version-unavailable"),
        );
        await assert.rejects(
          () =>
            caldavAdapter.pushDelete(
              owner,
              davAccount.id,
              davCalendar,
              davUrl,
              { ...currentDavRef, etag },
            ),
          providerError("provider-version-unavailable"),
        );
      });
    }
    for (const fresh of ['"unseen"', null, 'W/"weak"']) {
      readEtag = fresh;
      await noMutation(async () => {
        await assert.rejects(
          () =>
            caldavAdapter.pushUpdate(
              owner,
              davAccount.id,
              davCalendar,
              davUrl,
              davTitle,
              currentDavRef,
              { title: "Changed" },
            ),
          providerError(
            fresh === '"unseen"'
              ? "provider-conflict"
              : "provider-version-unavailable",
          ),
        );
        assert.equal(
          (await request("PUT", { ...davTitle, title: "Refused" })).status,
          409,
        );
        assert.equal((await request("DELETE", davTitle)).status, 409);
      });
    }
    readEtag = undefined;
    await noMutation(async () => {
      await assert.rejects(
        () =>
          caldavAdapter.pushUpdate(
            owner,
            davAccount.id,
            davCalendar,
            davUrl,
            davTitle,
            currentDavRef,
          ),
        providerError("event-diff-unavailable"),
      );
      await assert.rejects(
        () =>
          caldavAdapter.pushUpdate(
            owner,
            davAccount.id,
            davCalendar,
            davUrl,
            { ...davTitle, recurrence: "RRULE:FREQ=DAILY" },
            currentDavRef,
            { recurrence: "RRULE:FREQ=DAILY" },
          ),
        /detached exceptions/,
      );
    });
    for (const invalid of ["partial", "utf8"]) {
      partialRead = invalid === "partial";
      invalidUtf8Read = invalid === "utf8";
      await noMutation(async () =>
        assert.notEqual(
          (await request("PUT", { ...davTitle, title: "Incomplete read" }))
            .status,
          200,
        ),
      );
    }
    partialRead = false;
    invalidUtf8Read = false;
    // Ambiguous/malformed masters never get guessed or PUT.
    for (const invalid of [
      preserved.replace(
        "END:VCALENDAR",
        "BEGIN:VEVENT\r\nUID:rich@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR",
      ),
      preserved.replace("UID:rich@example.test", "UID:other"),
      preserved.replace("END:X-CUSTOM", "END:VALARM"),
    ]) {
      remote.set(key(davAuth, davPath), {
        etag: currentDavRef.etag!,
        data: invalid,
      });
      await noMutation(async () =>
        assert.notEqual(
          (await request("PUT", { ...davTitle, title: "No guessing" })).status,
          200,
        ),
      );
    }
    remote.set(key(davAuth, davPath), {
      etag: currentDavRef.etag!,
      data: preserved,
    });

    // A fresh GET after preflight is allowed only at the previously accepted
    // version. Changed read version rejects without accepting/rebasing it.
    const changedAfterPreflight = await prepareEventWrites([
      {
        action: "update",
        event: { ...davTitle, title: "Later" },
        previous: davTitle,
        calendarIDs: [dav.id],
      },
    ]);
    remote.get(key(davAuth, davPath))!.etag = '"concurrent"';
    const countBefore = mutationRequests().length;
    await assert.rejects(
      changedAfterPreflight,
      (error: unknown) =>
        error instanceof EventDeliveryError &&
        error.receipts[0].status === "conflict" &&
        providerError("provider-conflict")(error.failure),
    );
    assert.equal(mutationRequests().length, countBefore);
    assert.equal(
      (await getExternalEvent("caldav", davEvent.id, davCalendar, dav.id))!
        .etag,
      currentDavRef.etag,
    );
    remote.get(key(davAuth, davPath))!.etag = currentDavRef.etag!;

    // Mixed target delivery reports completed + conflict; later targets remain
    // not-attempted and a failing closure never becomes an unconditional retry.
    const createForPartial = eventIn([mirrors[0].id]);
    await createEvent(createForPartial, createForPartial.calendars);
    const partial = await prepareEventWrites([
      {
        action: "create",
        event: createForPartial,
        calendarIDs: [mirrors[0].id],
      },
      {
        action: "update",
        event: { ...davTitle, title: "Conflict" },
        previous: davTitle,
        calendarIDs: [dav.id],
      },
      { action: "delete", event: davTitle, calendarIDs: [dav.id] },
    ]);
    await partial("create");
    writeStatus = 412;
    requests.length = 0;
    await assert.rejects(
      () => partial("update"),
      (error: unknown) =>
        error instanceof EventDeliveryError &&
        error.receipts.map(({ status }) => status).join(",") ===
          "completed,conflict,not-attempted" &&
        error.failure instanceof ProviderEventWriteError &&
        error.failure.providerStatus === 412,
    );
    assert.equal(mutationRequests().length, 1);
    assert.equal(mutationRequests()[0].ifMatch, currentDavRef.etag);
    await assert.rejects(() => partial("delete"), EventDeliveryError);
    assert.equal(
      mutationRequests().length,
      1,
      "Failure is latched: no retry or later destructive delivery",
    );
    await assert.rejects(
      () =>
        caldavAdapter.pushDelete(
          owner,
          davAccount.id,
          davCalendar,
          davUrl,
          currentDavRef,
        ),
      providerError("provider-conflict"),
    );
    assert.equal(mutationRequests()[1].method, "DELETE");
    assert.equal(mutationRequests()[1].ifMatch, currentDavRef.etag);
    writeStatus = 303;
    const davRedirectsBefore = requests.length;
    await assert.rejects(
      () =>
        caldavAdapter.pushDelete(
          owner,
          davAccount.id,
          davCalendar,
          davUrl,
          currentDavRef,
        ),
      /conditional mutation cannot redirect to GET/,
    );
    assert.equal(requests.length, davRedirectsBefore + 1);
    writeStatus = 202;
    await assert.rejects(
      () =>
        caldavAdapter.pushDelete(
          owner,
          davAccount.id,
          davCalendar,
          davUrl,
          currentDavRef,
        ),
      (error: unknown) =>
        error instanceof ProviderEventWriteError &&
        error.outcome === "unconfirmed" &&
        error.providerStatus === 202,
    );
    writeStatus = 200;
    assert.equal(remote.get(key(davAuth, davPath))!.data, preserved);

    // Ordinary (nonrecurring) resource: changed nullable property only, then
    // start-only editing materializes the intended DTEND instead of sliding it
    // through DURATION. Unrelated alarm/extension lines remain literal bytes.
    const ordinaryPath = "/dav/cal/ordinary.ics";
    const ordinaryUrl = `${origin}${ordinaryPath}`;
    const ordinaryData = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ordinary",
      "DTSTART:20260101T100000Z",
      "DURATION:PT1H",
      "SUMMARY:Ordinary",
      "LOCATION;X-KEEP=YES:Room",
      "X-UNKNOWN:keep",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT5M",
      "DESCRIPTION:keep alarm",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    remote.set(key(davAuth, ordinaryPath), {
      etag: '"ordinary"',
      data: ordinaryData,
    });
    const ordinary = {
      ...eventIn([dav.id]),
      ...icalToNormalized({ url: ordinaryUrl, data: ordinaryData })!,
      id: randomUUID(),
      organizer: owner,
    };
    let ordinaryRef = {
      externalEventId: ordinaryUrl,
      etag: '"ordinary"',
      icalUid: "ordinary",
    };
    const ordinaryCleared = await caldavAdapter.pushUpdate(
      owner,
      davAccount.id,
      davCalendar,
      ordinaryUrl,
      { ...ordinary, location: null },
      ordinaryRef,
      { location: null },
    );
    assert.ok(ordinaryCleared?.etag);
    assert.equal(
      remote.get(key(davAuth, ordinaryPath))!.data,
      ordinaryData.replace("LOCATION;X-KEEP=YES:Room\r\n", ""),
    );
    ordinaryRef = { ...ordinaryRef, etag: ordinaryCleared.etag };
    await caldavAdapter.pushUpdate(
      owner,
      davAccount.id,
      davCalendar,
      ordinaryUrl,
      { ...ordinary, start: new Date("2026-01-01T10:30:00Z") },
      ordinaryRef,
      { start: new Date("2026-01-01T10:30:00Z") },
    );
    const movedData = remote.get(key(davAuth, ordinaryPath))!.data!;
    assert.equal(
      icalToNormalized({
        url: ordinaryUrl,
        data: movedData,
      })?.end.toISOString(),
      "2026-01-01T11:00:00.000Z",
    );
    assert.doesNotMatch(movedData, /DURATION/);
    assert.match(movedData, /X-UNKNOWN:keep\r\nBEGIN:VALARM/);

    // Engine persists a missing Google response validator as NULL, not the old
    // tag, and a subsequent handler write is refused before local mutation.
    omitWriteEtag = true;
    assert.equal(
      (
        await request("PUT", {
          ...createForPartial,
          title: "No response validator",
        })
      ).status,
      200,
    );
    assert.equal(
      (await getExternalEvent(
        "google",
        createForPartial.id,
        "same-calendar",
        mirrors[0].id,
      ))!.etag,
      null,
    );
    await noMutation(async () =>
      assert.equal(
        (await request("PUT", { ...createForPartial, title: "Must refresh" }))
          .status,
        409,
      ),
    );
    omitWriteEtag = false;

    // Missing/transformed write responses clear mapping ETag; no follow-up GET
    // may silently bless provider transformations or concurrent user changes.
    const acceptedDavEtag = currentDavRef.etag;
    for (const weak of [false, true]) {
      // Restore isolated fixture/accepted mapping before each independent case.
      remote.set(key(davAuth, davPath), {
        etag: acceptedDavEtag!,
        data: preserved,
      });
      await setExternalEventSyncData(
        "caldav",
        davEvent.id,
        davCalendar,
        { etag: acceptedDavEtag, icalUid: davRef.icalUid },
        dav.id,
      );
      omitWriteEtag = !weak;
      weakWriteEtag = weak;
      transformAfterWrite = true;
      const deliverMissing = await prepareEventWrites([
        {
          action: "update",
          event: { ...davTitle, title: `Missing-${weak}` },
          previous: davTitle,
          calendarIDs: [dav.id],
        },
      ]);
      requests.length = 0;
      await deliverMissing();
      assert.equal(
        (await getExternalEvent("caldav", davEvent.id, davCalendar, dav.id))!
          .etag,
        null,
      );
      assert.equal(
        requests.filter(({ method }) => method === "GET").length,
        1,
        "Only the same-version pre-write GET",
      );
      await noMutation(async () =>
        assert.equal(
          (await request("PUT", { ...davTitle, title: "Must refresh" })).status,
          409,
        ),
      );
      const created = await caldavAdapter.pushCreate(
        owner,
        davAccount.id,
        davCalendar,
        eventIn([dav.id]),
      );
      assert.equal(
        created.etag,
        null,
        "CalDAV create also refuses to invent a validator",
      );
    }
    omitWriteEtag = false;
    weakWriteEtag = false;
    transformAfterWrite = false;
    const davCreated = await caldavAdapter.pushCreate(
      owner,
      davAccount.id,
      davCalendar,
      eventIn([dav.id]),
    );
    assert.ok(davCreated.etag);
    assert.equal(
      davCreated.etag,
      remote.get(key(davAuth, new URL(davCreated.externalEventId).pathname))!
        .etag,
    );
    // Whole-resource (whole-series) deletion uses the accepted version even
    // after local unlink removes its mapping, never DELETE an occurrence URL.
    remote.set(key(davAuth, davPath), {
      etag: acceptedDavEtag!,
      data: preserved,
    });
    await setExternalEventSyncData(
      "caldav",
      davEvent.id,
      davCalendar,
      { etag: acceptedDavEtag, icalUid: davRef.icalUid },
      dav.id,
    );
    const deleteDav = await prepareEventWrites([
      { action: "delete", event: davTitle, calendarIDs: [dav.id] },
    ]);
    await unlinkEventAndTombstoneIfOrphaned(davEvent.id, [dav.id]);
    requests.length = 0;
    await deleteDav();
    assert.deepEqual(
      mutationRequests().map(({ method, ifMatch, path }) => ({
        method,
        ifMatch,
        path,
      })),
      [{ method: "DELETE", ifMatch: acceptedDavEtag, path: davPath }],
    );
    assert.equal(remote.has(key(davAuth, davPath)), false);
    disconnectWrite = true;
    const networkFailure = await prepareEventWrites([
      {
        action: "create",
        event: createForPartial,
        calendarIDs: [mirrors[0].id],
      },
    ]);
    await assert.rejects(
      networkFailure,
      (error: unknown) =>
        error instanceof EventDeliveryError &&
        error.receipts[0].status === "unconfirmed",
    );
    disconnectWrite = false;

    // Real authenticated PATCH: a local writer wins AFTER provider preflight
    // starts. The losing CAS must make zero remote mutations.
    const race = eventIn([mirrors[0].id]);
    await createEvent(race, race.calendars);
    const racePath = "/calendar/v3/calendars/same-calendar/events/local-race";
    remote.set(key("Bearer primary-access", racePath), {
      etag: '"race-v1"',
      json: { id: "local-race", summary: race.title },
    });
    await importExternalEvent(
      "google",
      race.id,
      mirrors[0].id,
      "same-calendar",
      "local-race",
      '"race-v1"',
    );
    const rawPatch = (
      eventID: string,
      revision: number,
      patch: Record<string, unknown>,
    ) =>
      fetch(`${apiOrigin}/events`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token.raw}`,
          "content-type": "application/json",
          [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
        },
        body: JSON.stringify({
          id: eventID,
          expectedRevision: revision,
          patch,
        }),
      });
    requests.length = 0;
    beforeEventRead = async () => {
      await patchEventAndCalendarLinks(race.id, 1, {
        start: new Date("2026-01-01T08:00:00Z"),
      });
    };
    const lost = await rawPatch(race.id, 1, { title: "Stale title" });
    assert.equal(lost.status, 409);
    assert.equal((await lost.json()).localCommitted, false);
    assert.equal(mutationRequests().length, 0);
    assert.equal((await getEvent(race.id)).title, race.title);
    assert.equal((await getEvent(race.id)).revision, 2);

    // Known multi-target delivery: first conditional PATCH succeeds, second
    // returns412. Public receipt reveals partial success, no account/resource IDs.
    const partialEvent = eventIn(mirrors.map((mirror) => mirror.id));
    await createEvent(partialEvent, partialEvent.calendars);
    const partialPath =
      "/calendar/v3/calendars/same-calendar/events/http-partial";
    for (const [index, auth] of [
      "Bearer primary-access",
      "Bearer sibling-access",
    ].entries()) {
      remote.set(key(auth, partialPath), {
        etag: '"partial-v1"',
        json: { id: "http-partial", summary: partialEvent.title,
          start: { dateTime: partialEvent.start.toISOString() }, end: { dateTime: partialEvent.end.toISOString() } },
      });
      await importExternalEvent(
        "google",
        partialEvent.id,
        mirrors[index].id,
        "same-calendar",
        "http-partial",
        '"partial-v1"',
      );
    }
    deniedWriteAuth = "Bearer sibling-access";
    requests.length = 0;
    const partialResponse = await rawPatch(partialEvent.id, 1, {
      title: "Locally saved partial",
    });
    const receipt = await partialResponse.json();
    assert.equal(partialResponse.status, 409);
    assert.equal(receipt.localCommitted, true);
    assert.equal(receipt.currentRevision, 2);
    assert.deepEqual(receipt.delivery, { completed: true, status: "conflict" });
    assert.equal(receipt.current.title, "Locally saved partial");
    assert.equal(mutationRequests().length, 2);
    assert.ok(!JSON.stringify(receipt).includes("sibling-access"));
    assert.ok(!JSON.stringify(receipt).includes("http-partial"));
    deniedWriteAuth = undefined;
    // Provider failure, followed by a failed latest read or a concurrent purge.
    for (const mode of ["read-failure", "purge"] as const) {
      const faultEvent = eventIn([mirrors[0].id]);
      await createEvent(faultEvent, faultEvent.calendars);
      const resource = `fault-${mode}`;
      remote.set(key("Bearer primary-access", `/calendar/v3/calendars/same-calendar/events/${resource}`), {
        etag: '"fault-v1"', json: { id: resource, summary: faultEvent.title,
          start: { dateTime: faultEvent.start.toISOString() }, end: { dateTime: faultEvent.end.toISOString() } },
      });
      await importExternalEvent("google", faultEvent.id, mirrors[0].id, "same-calendar", resource, '"fault-v1"');
      const query = db.$client.query.bind(db.$client);
      beforeMutationResponse = async () => {
        if (mode === "purge") await db.delete(events).where(eq(events.id, faultEvent.id));
        else (db.$client as any).query = async (config: any, ...args: any[]) => {
          if ((typeof config === "string" ? config : config.text).includes('from "events"')) throw new Error("post-provider read unavailable");
          return (query as any)(config, ...args);
        };
      };
      writeStatus = 412;
      try {
        const response = await rawPatch(faultEvent.id, 1, { title: "Committed despite provider failure" });
        const result = await response.json();
        assert.equal(response.status, 409);
        assert.equal(result.localCommitted, true);
        assert.equal(result.current, undefined);
        assert.equal(result.committed[0].revision, 2);
        assert.equal(result.committed[0].title, "Committed despite provider failure");
        assert.deepEqual(result.delivery, { completed: false, status: "conflict" });
      } finally { db.$client.query = query; beforeMutationResponse = undefined; writeStatus = 200; }
    }
    const ics = (count: number) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...Array.from({ length: count }, (_, n) => [
      "BEGIN:VEVENT", `UID:import-${n}@fixture.test`, `SUMMARY:Import ${n}`,
      "DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", "END:VEVENT",
    ]).flat(), "END:VCALENDAR", ""].join("\r\n");
    const importRequest = (count: number) => fetch(`${apiOrigin}/import?provider=google&accountId=primary`, {
      method: "POST", headers: { authorization: `Bearer ${token.raw}`, "content-type": "text/calendar", [CLIENT_VERSION_HEADER]: PRODUCT_VERSION }, body: ics(count),
    });
    eventCreatesUntilFailure = 1;
    const importPartial = await importRequest(3);
    const importReceipt = await importPartial.json();
    assert.equal(importPartial.status, 502);
    assert.equal(importReceipt.localCommitted, true);
    assert.equal(importReceipt.imported, 3);
    assert.equal(importReceipt.committed.length, 3);
    assert.deepEqual(importReceipt.delivery, { completed: true, status: "unconfirmed" });
    assert.ok(!JSON.stringify(importReceipt).includes("primary-access"));
    eventCreatesUntilFailure = undefined;
    // Actual provider create acknowledgement is held while local state changes.
    for (const change of ["update", "unlink"] as const) {
      let changedID = "";
      beforeMutationResponse = async () => {
        const [imported] = await db.select().from(events).where(eq(events.title, "Import 0")).orderBy(events.createdAt);
        // Select newest import rather than earlier partial-import identities.
        const rows = await db.select().from(events).where(eq(events.title, "Import 0"));
        const latest = rows.reduce((a, b) => a.createdAt > b.createdAt ? a : b, imported);
        changedID = latest.id;
        const result = await patchEventAndCalendarLinks(latest.id, 1,
          change === "update" ? { title: "Newer local state" } : { calendars: [] }, change === "unlink");
        assert.equal(result.status, "saved");
      };
      const response = await importRequest(1);
      const result = await response.json();
      beforeMutationResponse = undefined;
      assert.equal(response.status, 502);
      assert.equal(result.localCommitted, true);
      assert.equal(result.committed[0].revision, 1);
      assert.equal((await getEvent(changedID)).revision, 2);
      assert.deepEqual(await db.select().from(externalEvents).where(eq(externalEvents.eventID, changedID)), [], "delayed create ACK cannot resurrect mapping or bless newer revision");
      assert.deepEqual(result.delivery, { completed: false, status: "unconfirmed" });
    }
    // A response validator cannot overwrite an intervening accepted mapping or
    // acknowledge an event revision that no longer equals its local commit.
    assert.equal(
      await setExternalEventSyncData(
        "google",
        partialEvent.id,
        "same-calendar",
        { etag: '"late"', icalUid: null },
        mirrors[0].id,
        { revision: 1, etag: '"partial-v1"', externalEventID: "http-partial" },
      ),
      false,
    );

    // K07: actual authenticated HTTP -> transaction -> durable claim -> provider HTTP.
    const durableEvent = eventIn([mirrors[0].id]);
    // PostgreSQL canonicalizes UUIDs; valid uppercase input must still enqueue.
    durableEvent.id = durableEvent.id.toUpperCase();
    durableEvent.calendars = [mirrors[0].id.toUpperCase(), mirrors[0].id];
    durableEvent.originCalendarID = mirrors[0].id.toUpperCase();
    const sendDurable = (path: string, body: unknown, mutationID = randomUUID(), method = "POST") =>
      fetch(`${apiOrigin}${path}`, { method, headers: {
        authorization: `Bearer ${token.raw}`, "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: PRODUCT_VERSION, "Idempotency-Key": mutationID,
      }, body: JSON.stringify(body) });
    const jobsFor = (id: string) => db.select().from(eventOutbox).where(eq(eventOutbox.eventID, id));
    beforeMutationResponse = async () => {
      const jobs = await jobsFor(durableEvent.id);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, "attempting", "durable claim precedes provider side effect");
      assert.equal(jobs[0].revision, 1);
      assert.equal(jobs[0].payload.event.revision, 1);
      assert.equal(jobs[0].payload.createIdentityVersion, 1);
      assert.equal(JSON.parse(mutationRequests()[mutationRequests().length - 1].body).id, `musubi${jobs[0].id.replace(/-/g, "")}`);
      assert.equal((await getEvent(durableEvent.id)).revision, 1, "local commit precedes HTTP");
    };
    const durableCreated = await sendDurable("/events", durableEvent);
    beforeMutationResponse = undefined;
    assert.equal(durableCreated.status, 201, JSON.stringify(await durableCreated.json()));
    assert.equal((await jobsFor(durableEvent.id))[0].status, "completed");
    assert.equal((await jobsFor(durableEvent.id))[0].attempts, 1);

    const beforeCaseOnlyPatch = await getExternalEvent("google", durableEvent.id, "same-calendar", mirrors[0].id);
    const beforeCaseOnlyRequests = mutationRequests().length;
    const caseOnlyPatch = await sendDurable("/events", {
      id: durableEvent.id, expectedRevision: 1,
      patch: { calendars: [mirrors[0].id.toUpperCase()] },
    }, randomUUID(), "PATCH");
    assert.equal(caseOnlyPatch.status, 200);
    assert.equal((await getEvent(durableEvent.id)).revision, 1, "case-only calendar patch is a no-op");
    assert.deepEqual(await getExternalEvent("google", durableEvent.id, "same-calendar", mirrors[0].id), beforeCaseOnlyPatch);
    assert.equal((await jobsFor(durableEvent.id)).length, 1);
    assert.equal(mutationRequests().length, beforeCaseOnlyRequests);

    const caseOnlyLink = await sendDurable(`/events/${durableEvent.id}/link`, {
      calendarID: mirrors[0].id.toUpperCase(), expectedRevision: 1,
    });
    assert.equal(caseOnlyLink.status, 200);
    assert.equal((await getEvent(durableEvent.id)).revision, 1);
    assert.equal((await jobsFor(durableEvent.id)).length, 1);
    assert.equal(mutationRequests().length, beforeCaseOnlyRequests);
    const sameCalendarFork = await sendDurable(`/events/${durableEvent.id}/fork`, {
      calendarID: mirrors[0].id.toUpperCase(), expectedRevision: 1,
    });
    assert.equal(sameCalendarFork.status, 400);
    assert.equal(mutationRequests().length, beforeCaseOnlyRequests);

    // Exercise the durable delivery guards directly, without API canonicalization.
    const directUppercase = eventIn([mirrors[0].id.toUpperCase()]);
    directUppercase.id = directUppercase.id.toUpperCase();
    const directDelivery = await prepareEventWrites([{
      event: directUppercase, calendarIDs: directUppercase.calendars, action: "create",
    }], { actorID: owner, mutationID: randomUUID().toUpperCase() });
    const directSaved = await createEvent(directUppercase, directUppercase.calendars, directDelivery.outbox);
    await directDelivery(undefined, directSaved.revision);
    assert.equal((await jobsFor(directUppercase.id))[0].status, "completed");

    const forkKey = randomUUID();
    const forkBody = { calendarID: mirrors[1].id, expectedRevision: 1 };
    const firstFork = await sendDurable(`/events/${durableEvent.id}/fork`, forkBody, forkKey);
    assert.equal(firstFork.status, 201);
    const forkedEvent = await firstFork.json();
    const beforeRetry = mutationRequests().length;
    const secondFork = await sendDurable(`/events/${durableEvent.id}/fork`, forkBody, forkKey);
    assert.equal(secondFork.status, 409);
    assert.equal((await secondFork.json()).code, "event-mutation-duplicate");
    assert.equal(mutationRequests().length, beforeRetry, "duplicate fork never reaches provider");
    const forkJobs = await db.select().from(eventOutbox).where(eq(eventOutbox.mutationID, forkKey));
    assert.equal(forkJobs.length, 1);
    assert.equal(forkJobs[0].eventID, forkedEvent.id);

    const linkResponse = await sendDurable(`/events/${durableEvent.id}/link`, {
      calendarID: mirrors[1].id.toUpperCase(), expectedRevision: 1,
    });
    assert.equal(linkResponse.status, 200);
    const beforeUnlink = await getExternalEvent("google", durableEvent.id, "same-calendar", mirrors[1].id);
    assert.ok(beforeUnlink);
    const unlinkResponse = await sendDurable("/events", {
      id: durableEvent.id, expectedRevision: 2, unlinkCalendarID: mirrors[1].id.toUpperCase(),
    }, randomUUID(), "DELETE");
    assert.equal(unlinkResponse.status, 200);
    assert.equal(await getExternalEvent("google", durableEvent.id, "same-calendar", mirrors[1].id), null);
    const deleteJob = (await jobsFor(durableEvent.id)).find((job) => job.action === "delete")!;
    assert.equal(deleteJob.externalEventID, beforeUnlink.externalEventId);
    assert.equal(deleteJob.expectedEtag, beforeUnlink.etag);
    assert.equal(deleteJob.status, "completed");

    // Remote create commits but its response is unreadable. Later HTTP mutations
    // must retain intent despite the missing mapping, with no blind second send.
    const ambiguousEvent = eventIn([mirrors[0].id]);
    malformedWrite = true;
    const ambiguousCreate = await sendDurable("/events", ambiguousEvent);
    malformedWrite = false;
    assert.equal(ambiguousCreate.status, 502);
    assert.equal((await ambiguousCreate.json()).localCommitted, true);
    assert.equal((await jobsFor(ambiguousEvent.id))[0].status, "unconfirmed");
    const attemptsAfterCreate = mutationRequests().length;
    const queuedUpdate = await sendDurable("/events", {
      id: ambiguousEvent.id, expectedRevision: 1, patch: { title: "Pending edit" },
    }, randomUUID(), "PATCH");
    assert.equal(queuedUpdate.status, 502);
    assert.equal((await queuedUpdate.json()).localCommitted, true);
    const queuedDelete = await sendDurable("/events", {
      id: ambiguousEvent.id, expectedRevision: 2,
    }, randomUUID(), "DELETE");
    assert.equal(queuedDelete.status, 502);
    assert.equal((await queuedDelete.json()).localCommitted, true);
    assert.equal(mutationRequests().length, attemptsAfterCreate);
    const queued = (await jobsFor(ambiguousEvent.id)).sort((a, b) => a.revision - b.revision);
    assert.deepEqual(queued.map((job) => [job.action, job.status, job.attempts]), [
      ["create", "unconfirmed", 1], ["update", "pending", 0], ["delete", "pending", 0],
    ]);
    assert.equal(queued[1].predecessorID, queued[0].id);
    assert.equal(queued[2].predecessorID, queued[1].id);
    assert.equal(queued[2].externalEventID, null);

    // Fail the real outbox INSERT after the event INSERT: neither may commit.
    const rollbackEvent = eventIn([mirrors[0].id]);
    await db.execute(sql.raw(`create function k07_reject_outbox() returns trigger language plpgsql as $$
      begin if NEW.event_id = '${rollbackEvent.id}'::uuid then raise exception 'fixture failure'; end if; return NEW; end $$`));
    await db.execute(sql.raw("create trigger k07_reject_outbox before insert on event_outbox for each row execute function k07_reject_outbox()"));
    try {
      const before = mutationRequests().length;
      const rejected = await sendDurable("/events", rollbackEvent);
      assert.equal(rejected.status, 500);
      assert.equal(mutationRequests().length, before);
      assert.deepEqual(await db.select().from(events).where(eq(events.id, rollbackEvent.id)), []);
      assert.deepEqual(await jobsFor(rollbackEvent.id), []);
    } finally {
      await db.execute(sql.raw("drop trigger k07_reject_outbox on event_outbox"));
      await db.execute(sql.raw("drop function k07_reject_outbox()"));
    }
    console.log("K07 actual HTTP atomic enqueue/claim, duplicate fork and retained unlink destination: OK");
    console.log(
      "K06 authenticated provider race/partial412/localCommitted and scoped metadata acceptance guards: OK",
    );
    console.log(
      "K06 Google/CalDAV actual adapter + authenticated handler + scoped prepared delivery: OK",
    );
  } finally {
    globalThis.fetch = realFetch;
    await db.delete(user).where(eq(user.id, owner));
    await Promise.all([
      new Promise<void>((resolve) => api.close(() => resolve())),
      new Promise<void>((resolve) => fixture.close(() => resolve())),
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
