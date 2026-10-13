import {
  eventCreateRequest,
  eventPatchRequest,
  type EventWriteRequest,
} from "@musubi/types";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  account,
  CALENDAR_SCOPE,
  calendarEvents,
  calendarMembers,
  calendars,
  createCalendar,
  createEvent,
  db,
  events,
  externalEvents,
  getExternalEvent,
  getEvent,
  getOAuthCredentials,
  importExternalCalendar,
  importExternalEvent,
  linkEventToCalendars,
  memberTokens,
  saveCaldavAccount,
  setExternalEventSyncData,
  user,
} from "@musubi/db";
import {
  CLIENT_VERSION_HEADER,
  EventSchema,
  PRODUCT_VERSION,
} from "@musubi/types";
import {
  endSeriesBefore,
  excludeOccurrence,
  withSeriesEditIntent,
} from "@musubi/calendar";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import {
  handlerCreateEvent,
  handlerUpdateEvent,
  handlerRemoveEvent,
  handlerLinkEvent,
  handlerForkEvent,
} from "./events";
import { handlerImportCalendar } from "./calendars";
import { encryptSecret } from "../sync/crypto";
import { caldavAdapter, icalToNormalized } from "../sync/adapters/caldav";

// Actual authenticated HTTP handlers, real adapters/HTTP and disposable Postgres.
// No live destination is reachable: even unexpected OAuth URLs fail closed.
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.ok(process.env.DATABASE_URL);
  const owner = `k04-${randomUUID()}`;
  const viewer = `k04-viewer-${randomUUID()}`;
  const token = issueMemberToken();
  const viewerToken = issueMemberToken();
  const writes: {
    path: string;
    method: string;
    auth?: string;
    body: string;
  }[] = [];
  const reads: { path: string; auth?: string }[] = [];
  let role: string | undefined = "owner";
  let canEdit: boolean | undefined = true;
  let organizer: boolean | undefined = true;
  let googleGuestDefault = false;
  let returnedScope: string | undefined;
  let revokedRefresh = false;
  let refreshCalls = 0;
  let privileges: string[] | undefined = ["write"];
  let resourcePrivileges: string[] | undefined;
  let addresses: string[] | undefined = ["mailto:owner@example.test"];
  const importedPrivileges: string[] | undefined = ["bind"];
  let remoteCalendarCreates = 0;
  const davEtags = new Map<string, string>();
  const googleEtags = new Map<string, string>();
  const googleObjects = new Map<string, Record<string, unknown>>();
  const googleDeleted = new Set<string>();
  let version = 0;
  let davData = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:fixture",
    "DTSTART:20260101T100000Z",
    "DTEND:20260101T110000Z",
    "SUMMARY:Before",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const xmlEscape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const fixture = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url!, "http://fixture.test");
      const path = url.pathname;
      const method = req.method!;
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const xml = (href: string, props: string, status = "200 OK", homeHref?: string) => {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${homeHref && homeHref !== href ? `<d:response><d:href>${homeHref}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` : ""}<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response></d:multistatus>`,
        );
      };
      if (path.endsWith("/token")) {
        refreshCalls++;
        return revokedRefresh
          ? json({ error: "invalid_grant" }, 400)
          : json({
              access_token: "refreshed-access",
              expires_in: 3600,
              ...(returnedScope === undefined ? {} : { scope: returnedScope }),
            });
      }
      if (["POST", "PUT", "PATCH", "DELETE", "MKCALENDAR"].includes(method)) {
        if (path === "/v1.0/me/calendars" || method === "MKCALENDAR") {
          remoteCalendarCreates++;
          return json({ id: `imported-${remoteCalendarCreates}` }, 201);
        }
        writes.push({ path, method, auth: req.headers.authorization, body });
        if (method === "PUT" && path.startsWith("/dav/")) {
          davData = body;
          davEtags.set(path, `"dav-${++version}"`);
        }
        if (method === "DELETE") {
          davEtags.delete(path);
          if (path.startsWith("/calendar/v3/")) {
            const key = `${req.headers.authorization}:${path}`;
            googleObjects.delete(key); googleEtags.delete(key); googleDeleted.add(key);
          }
          res.writeHead(204);
          return res.end();
        }
        if (path.startsWith("/dav/")) {
          res.writeHead(201, { etag: davEtags.get(path)! });
          return res.end();
        }
        // Google PATCH returns the addressed native identity. POST may choose
        // a new identity; a sparse update must not fabricate a second object.
        const id = path.startsWith("/calendar/v3/")
          ? method === "POST" ? (JSON.parse(body).id ?? `created-${randomUUID()}`) : decodeURIComponent(path.split("/").pop()!)
          : `created-${randomUUID()}`;
        const eventPath = method === "POST" ? `${path}/${id}` : path;
        const etag = `"google-${++version}"`;
        googleEtags.set(`${req.headers.authorization}:${eventPath}`, etag);
        if (path.startsWith("/calendar/v3/")) {
          const key = `${req.headers.authorization}:${eventPath}`;
          googleObjects.set(key, { ...googleObjects.get(key), ...JSON.parse(body), id: decodeURIComponent(eventPath.split("/").pop()!) });
          googleDeleted.delete(key);
        }
        return json({ id, etag }, 201);
      }
      reads.push({ path, auth: req.headers.authorization });
      if (path === "/v1.0/me") return json({ mail: "owner@example.test" });
      if (path.includes("/calendarList/"))
        return json({ id: decodeURIComponent(path.split("/").pop()!), accessRole: path.endsWith("/denied") ? "reader" : role });
      if (path.startsWith("/v1.0/me/calendars/") && !path.includes("/events/"))
        return json({ canEdit });
      if (path.includes("/events/")) {
        const key = `${req.headers.authorization}:${path}`;
        if (googleDeleted.has(key)) return json({}, 404);
        return json(
          path.startsWith("/v1.0")
            ? { isOrganizer: organizer }
            : {
                id: decodeURIComponent(path.split("/").pop()!),
                summary: "Before", start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T11:00:00Z" },
                ...googleObjects.get(key),
                etag:
                  googleEtags.get(`${req.headers.authorization}:${path}`) ??
                  '"current"',
                organizer: googleGuestDefault
                  ? { email: "host@example.test", displayName: "Host" }
                  : { self: organizer },
              },
        );
      }
      if (
        method === "GET" &&
        path.startsWith("/dav/") &&
        path.endsWith(".ics")
      ) {
        res.writeHead(200, {
          "content-type": "text/calendar",
          etag: davEtags.get(path) ?? '"current"',
        });
        return res.end(davData);
      }
      if (method === "REPORT")
        return xml(
          "/dav/cal/event.ics",
          `<d:getetag>"current"</d:getetag><c:calendar-data>${xmlEscape(davData)}</c:calendar-data>`,
        );
      if (method === "PROPFIND") {
        if (body.includes("current-user-privilege-set")) {
          const grants = path.includes("musubi-")
            ? importedPrivileges
            : path.endsWith(".ics")
              ? (resourcePrivileges ?? privileges)
              : privileges;
          return grants
            ? xml(
                path,
                `<d:current-user-privilege-set>${grants.map((name) => `<d:privilege><d:${name}/></d:privilege>`).join("")}</d:current-user-privilege-set>`,
              )
            : xml(path, "<d:current-user-privilege-set/>", "404 Not Found");
        }
        if (body.includes("calendar-user-address-set"))
          return addresses
            ? xml(
                path,
                `<c:calendar-user-address-set>${addresses.map((address) => `<d:href>${address}</d:href>`).join("")}</c:calendar-user-address-set>`,
              )
            : xml(path, "", "404 Not Found");
        if (body.includes("supported-calendar-component-set"))
          return xml(
            "/dav/cal/",
            '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>DAV fixture</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
            "200 OK",
            path, // Complete Depth:1 discovery includes the requested home itself.
          );
        return xml(
          path,
          "<d:current-user-principal><d:href>/dav/principal/</d:href></d:current-user-principal><c:calendar-home-set><d:href>/dav/</d:href></c:calendar-home-set>",
        );
      }
      if (path === "/.well-known/caldav") {
        res.writeHead(404);
        return res.end();
      }
      return json(
        { error: `Unexpected fixture request ${method} ${path}` },
        500,
      );
    });
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express();
  app.use(express.json());
  app.post("/events", requireAuth, handlerCreateEvent);
  app.put("/events", requireAuth, handlerUpdateEvent);
  app.delete("/events", requireAuth, handlerRemoveEvent);
  app.post("/events/:eventId/link", requireAuth, handlerLinkEvent);
  app.post("/events/:eventId/fork", requireAuth, handlerForkEvent);
  app.post(
    "/import",
    express.text({ type: "text/calendar" }),
    requireAuth,
    handlerImportCalendar,
  );
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if ([fixtureOrigin, apiOrigin].includes(url.origin))
      return realFetch(input, init);
    assert.ok(
      [
        "www.googleapis.com",
        "graph.microsoft.com",
        "oauth2.googleapis.com",
        "login.microsoftonline.com",
      ].includes(url.hostname),
      `No live requests: ${url}`,
    );
    return realFetch(`${fixtureOrigin}${url.pathname}${url.search}`, init);
  };
  // Each capability scenario explicitly starts a fresh draft. Dedicated HTTP CAS
  // tests hold old revisions instead of rebasing these independent scenarios.
  const request = async (
    method: string,
    body: unknown,
    path = "/events",
    bearer = token.raw,
  ) => {
    const event = body as EventWriteRequest & {
      unlinkCalendarID?: string;
      scopeEditValidated?: boolean;
    };
    let wire: unknown = body;
    if (path === "/events" && method === "POST")
      wire = eventCreateRequest(event);
    if (path === "/events" && ["PUT", "DELETE"].includes(method)) {
      const revision = (await getEvent(event.id)).revision;
      wire =
        method === "DELETE"
          ? {
              id: event.id,
              expectedRevision: revision,
              ...(event.unlinkCalendarID
                ? { unlinkCalendarID: event.unlinkCalendarID }
                : {}),
            }
          : {
              ...eventPatchRequest({
                ...event,
                revision,
                ...(event.scopeEdit
                  ? {
                      scopeEdit: {
                        ...event.scopeEdit,
                        updates: event.scopeEdit.updates.map((update) => ({
                          ...update,
                          revision,
                        })),
                      },
                    }
                  : {}),
              }),
              ...(event.scopeEditValidated === undefined
                ? {}
                : { scopeEditValidated: event.scopeEditValidated }),
            };
    }
    if (path !== "/events") {
      const sourceID = path.split("/")[2];
      wire = {
        ...(body as object),
        expectedRevision: (await getEvent(sourceID)).revision,
      };
    }
    return fetch(`${apiOrigin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
      },
      body: JSON.stringify(wire),
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
  const refuses = async (
    run: () => Promise<Response>,
    reason: string,
    status = 403,
  ) => {
    const before = await snapshot();
    writes.length = 0;
    const response = await run();
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    if (status === 403) assert.equal(body.reason, reason, JSON.stringify(body));
    assert.equal(
      writes.length,
      0,
      "No first provider write, even with a later denied target",
    );
    assert.equal(
      await snapshot(),
      before,
      "No event/link/mapping mutation on refusal",
    );
    return body;
  };
  const eventIn = (calendarIDs: string[], recurrence: string | null = null) =>
    EventSchema.parse({
      id: randomUUID(),
      creatorID: owner,
      organizer: owner,
      title: "Before",
      color: "#7A8BA3",
      start: "2026-01-01T10:00:00Z",
      end: "2026-01-01T11:00:00Z",
      isAllDay: false,
      isCanceled: false,
      calendars: calendarIDs,
      originCalendarID: calendarIDs[0],
      recurrence,
    });
  await db.insert(user).values(
    [owner, viewer].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      isExternal: true,
    })),
  );
  try {
    await db.insert(memberTokens).values([
      { userID: owner, tokenHash: token.tokenHash },
      { userID: viewer, tokenHash: viewerToken.tokenHash },
    ]);
    await db.insert(account).values(
      ["google", "microsoft"].flatMap((providerId) =>
        ["primary", "sibling"].map((accountId) => ({
          id: randomUUID(),
          userId: owner,
          providerId,
          accountId,
          scope: CALENDAR_SCOPE[providerId],
          accessToken: `${accountId}-access`,
          refreshToken: "fixture-refresh",
          accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        })),
      ),
    );
    const local = await createCalendar({
      creatorID: owner,
      name: "Local",
      color: "#7A8BA3",
    });
    const mirror = (
      provider: string,
      externalId: string,
      accountID = "primary",
      role = "owner",
    ) =>
      importExternalCalendar(
        provider,
        owner,
        accountID,
        "Fixture",
        { externalId, name: externalId, color: "#7A8BA3" },
        role,
      );
    const google = await mirror("google", "allowed");
    const denied = await mirror("google", "denied");
    const outlook = await mirror("microsoft", "outlook");
    const sibling = await mirror("google", "allowed", "sibling");
    const taskOnly = await importExternalCalendar(
      "google",
      owner,
      "primary",
      "Tasks",
      {
        externalId: "tasks-only",
        name: "Tasks",
        color: "#7A8BA3",
        supportsEvents: false,
        supportsTasks: true,
      },
    );
    await refuses(
      () => request("POST", eventIn([google.id, taskOnly.id])),
      "unsupported",
    );
    await refuses(
      () => request("POST", eventIn([google.id, denied.id])),
      "denied",
    );
    role = undefined;
    await refuses(() => request("POST", eventIn([google.id])), "unknown");
    role = "owner";
    await refuses(
      () =>
        request("POST", eventIn([local.id, outlook.id], "RRULE:FREQ=WEEKLY")),
      "unsupported",
    );
    const event = eventIn([google.id]);
    assert.equal((await request("POST", event)).status, 201);
    assert.equal(writes[writes.length - 1]?.method, "POST");
    role = "reader"; // Permission changed AFTER the form's calendar role was loaded.
    await refuses(
      () => request("PUT", { ...event, title: "Changed" }),
      "denied",
    );
    role = "owner";
    for (organizer of [false, undefined])
      await refuses(
        () => request("PUT", { ...event, title: "Changed", organizer: owner }),
        organizer === false ? "denied" : "unknown",
      );
    await refuses(() => request("DELETE", event), "unknown");
    googleGuestDefault = true;
    await refuses(
      () => request("PUT", { ...event, title: "Guest cannot edit host" }),
      "denied",
    );
    const guestCopy = eventIn([google.id]);
    assert.equal((await request("POST", guestCopy)).status, 201);
    const guestMapping = await getExternalEvent(
      "google",
      guestCopy.id,
      "allowed",
      google.id,
    );
    assert.ok(guestMapping, "Guest copy must have a real provider mapping");
    const guestPath = `/calendar/v3/calendars/allowed/events/${guestMapping.externalEventId}`;
    reads.length = 0;
    writes.length = 0;
    assert.equal(
      (await request("DELETE", guestCopy)).status,
      200,
      "Documented Google self=false default allows personal copy removal",
    );
    assert.ok(
      reads.some((read) => read.path === guestPath),
      "Deletion must read guest organizer evidence",
    );
    assert.deepEqual(
      writes.map(({ method, path }) => [method, path]),
      [["DELETE", guestPath]],
    );
    googleGuestDefault = false;
    organizer = true;
    assert.equal(
      (await request("PUT", { ...event, title: "Allowed" })).status,
      200,
    );
    const mixed = eventIn([google.id, denied.id]);
    await createEvent(mixed, mixed.calendars);
    await importExternalEvent(
      "google",
      mixed.id,
      google.id,
      "allowed",
      "mixed",
      '"current"',
    );
    await importExternalEvent(
      "google",
      mixed.id,
      denied.id,
      "denied",
      "mixed",
      '"current"',
    );
    await refuses(
      () =>
        request("PUT", {
          ...mixed,
          calendars: [denied.id],
          title: "Must not delete first",
        }),
      "denied",
    );
    await refuses(() => request("DELETE", mixed), "denied");
    for (const action of ["link", "fork"])
      await refuses(
        () =>
          request(
            "POST",
            { calendarID: denied.id },
            `/events/${event.id}/${action}`,
          ),
        "denied",
      );
    await refuses(
      () => request("DELETE", { ...mixed, unlinkCalendarID: denied.id }),
      "denied",
    );
    const source = eventIn([local.id], "RRULE:FREQ=WEEKLY");
    await createEvent(source, source.calendars);
    for (const action of ["link", "fork"])
      await refuses(
        () =>
          request(
            "POST",
            { calendarID: outlook.id },
            `/events/${source.id}/${action}`,
          ),
        "unsupported",
      );
    const intent = withSeriesEditIntent({
      updates: [{ ...source, title: "First must not save" }],
      creates: [eventIn([outlook.id], source.recurrence)],
    });
    await refuses(() => request("PUT", intent.updates[0]), "unsupported");
    const deniedIntent = withSeriesEditIntent({
      updates: [{ ...source, title: "Must stay unchanged" }],
      creates: [eventIn([google.id, denied.id])],
    });
    await refuses(() => request("PUT", deniedIntent.updates[0]), "denied");
    await refuses(
      () => request("PUT", { ...intent.updates[0], title: "Mismatch" }),
      "",
      400,
    );
    await refuses(
      () =>
        request("PUT", { ...source, scopeEdit: { updates: [], creates: [] } }),
      "",
      400,
    );
    const recurringOutlook = eventIn([outlook.id], "RRULE:FREQ=WEEKLY");
    await createEvent(recurringOutlook, recurringOutlook.calendars);
    await importExternalEvent(
      "microsoft",
      recurringOutlook.id,
      outlook.id,
      "outlook",
      "master",
    );
    await refuses(
      () =>
        request("PUT", { ...recurringOutlook, recurrence: "RRULE:FREQ=DAILY" }),
      "unsupported",
    );
    await refuses(
      () =>
        request("PUT", { ...recurringOutlook, title: "Recurring content unsupported" }),
      "unsupported",
    );
    await refuses(() => request("DELETE", recurringOutlook), "unsupported");
    await refuses(
      () =>
        request(
          "PUT",
          withSeriesEditIntent({
            updates: [
              {
                ...recurringOutlook,
                title: "Update-only still requires protection",
              },
            ],
            creates: [],
          }).updates[0],
        ),
      "unsupported",
    );
    // A known Outlook mirror must stop the entire write set before any local
    // mutation, even if the home itself is not an Outlook calendar.
    await linkEventToCalendars(source.id, [outlook.id]);
    await importExternalEvent(
      "microsoft",
      source.id,
      outlook.id,
      "outlook",
      "mirror",
    );
    await refuses(
      () =>
        request("PUT", {
          ...source,
          calendars: [...source.calendars, outlook.id],
          title: "Mirror refuses",
        }),
      "unsupported",
    );
    // Existing local-only unlink has no remote resource/mutation and remains
    // available; this does not introduce a detach/override operation.
    const localOnlyLink = eventIn([local.id]);
    await createEvent(localOnlyLink, localOnlyLink.calendars);
    await linkEventToCalendars(localOnlyLink.id, [outlook.id]);
    const writesBeforeLocalUnlink = writes.length;
    const localUnlink = await request("DELETE", {
      ...localOnlyLink,
      calendars: [local.id, outlook.id],
      unlinkCalendarID: outlook.id,
    });
    assert.equal(localUnlink.status, 200);
    assert.equal(writes.length, writesBeforeLocalUnlink);
    canEdit = undefined;
    await refuses(() => request("POST", eventIn([outlook.id])), "unknown");
    canEdit = false;
    await refuses(() => request("POST", eventIn([outlook.id])), "denied");
    canEdit = true;
    // Same remote identity in two local mirrors: mapping reads/updates and writes stay isolated.
    const homeMapping = await getExternalEvent(
      "google",
      event.id,
      "allowed",
      google.id,
    );
    assert.ok(homeMapping);
    await importExternalEvent(
      "google",
      event.id,
      sibling.id,
      "allowed",
      homeMapping.externalEventId,
      '"sibling"',
    );
    assert.equal(
      (await getExternalEvent("google", event.id, "allowed", sibling.id))
        ?.externalEventId,
      homeMapping.externalEventId,
    );
    assert.equal(
      await getExternalEvent("google", event.id, "allowed", randomUUID()),
      null,
      "No remote-ID fallback for an explicit local scope",
    );
    await setExternalEventSyncData(
      "google",
      event.id,
      "allowed",
      { etag: '"home"', icalUid: null },
      google.id,
    );
    googleEtags.set(
      `Bearer primary-access:/calendar/v3/calendars/allowed/events/${homeMapping.externalEventId}`,
      '"home"',
    );
    assert.equal(
      (await getExternalEvent("google", event.id, "allowed", sibling.id))?.etag,
      '"sibling"',
    );
    writes.length = 0;
    assert.equal(
      (await request("PUT", { ...event, title: "Scoped identity" })).status,
      200,
    );
    assert.deepEqual(
      writes.map((write) => [write.auth, write.path]),
      [
        [
          "Bearer primary-access",
          `/calendar/v3/calendars/allowed/events/${homeMapping.externalEventId}`,
        ],
      ],
    );
    const davAccount = await saveCaldavAccount(
      owner,
      `${fixtureOrigin}/dav/`,
      "owner",
      encryptSecret("fixture-password"),
    );
    const dav = await mirror(
      "caldav",
      `${fixtureOrigin}/dav/cal/`,
      davAccount.id,
      "viewer",
    );
    const davEvent = eventIn([dav.id]);
    privileges = undefined;
    await refuses(() => request("POST", davEvent), "unknown");
    privileges = ["read"];
    await refuses(() => request("POST", davEvent), "denied");
    privileges = ["bind"];
    assert.equal(
      (await request("POST", davEvent)).status,
      201,
      "Projected viewer with fresh bind can create",
    );
    await db
      .update(externalEvents)
      .set({
        externalEventID: `${fixtureOrigin}/dav/cal/event.ics`,
        etag: '"current"',
        // Keep the UID returned by create when moving this fixture resource.
      })
      .where(eq(externalEvents.eventID, davEvent.id));
    await refuses(
      () => request("PUT", { ...davEvent, title: "No content right" }),
      "denied",
    );
    await refuses(() => request("DELETE", davEvent), "denied");
    privileges = ["write-content"];
    assert.equal(
      (await request("PUT", { ...davEvent, title: "Content right" })).status,
      200,
    );
    await refuses(() => request("POST", eventIn([dav.id])), "denied");
    privileges = ["unbind"];
    assert.equal((await request("DELETE", davEvent)).status, 200);
    // A legacy EXDATE/UNTIL PUT may precede a replacement POST. A known absent
    // bind must stop that first step, despite resource write-content permission.
    const legacySeries = eventIn([dav.id], "RRULE:FREQ=WEEKLY");
    await createEvent(legacySeries, legacySeries.calendars);
    const legacyResource = `${fixtureOrigin}/dav/cal/legacy.ics`;
    await importExternalEvent(
      "caldav",
      legacySeries.id,
      dav.id,
      `${fixtureOrigin}/dav/cal/`,
      legacyResource,
      '"current"',
      legacySeries.id,
    );
    davData = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${legacySeries.id}`,
      "DTSTART:20260101T100000Z",
      "DTEND:20260101T110000Z",
      "RRULE:FREQ=WEEKLY",
      "SUMMARY:Before",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const legacyOriginal = davData;
    resourcePrivileges = ["write-content"];
    for (const recurrence of [
      excludeOccurrence(
        legacySeries.recurrence!,
        new Date("2026-01-08T10:00:00Z"),
      ),
      endSeriesBefore(
        legacySeries.recurrence!,
        new Date("2026-01-08T10:00:00Z"),
      ),
    ]) {
      const update = { ...legacySeries, recurrence };
      for (privileges of [["read"], undefined]) {
        const reason = privileges ? "denied" : "unknown";
        const error = await refuses(
          () => request("PUT", { ...update, scopeEditValidated: true }),
          reason,
          400,
        );
        assert.match(error.error, /invalid data/);
        assert.equal(davData, legacyOriginal);
        const split = withSeriesEditIntent({
          updates: [update],
          creates: [eventIn([dav.id])],
        });
        await refuses(() => request("PUT", split.updates[0]), reason);
      }
      privileges = ["read"];
      const updateOnly = withSeriesEditIntent({
        updates: [update],
        creates: [],
      });
      await refuses(
        () =>
          request("PUT", {
            ...updateOnly.updates[0],
            title: "Mismatched update-only",
          }),
        "",
        400,
      );
      resourcePrivileges = ["read"];
      await refuses(() => request("PUT", updateOnly.updates[0]), "denied");
      resourcePrivileges = ["write-content"];
      writes.length = 0;
      assert.equal(
        (await request("PUT", updateOnly.updates[0])).status,
        200,
        "Explicit update-only recurrence changes need no bind",
      );
      assert.deepEqual(
        writes.map(({ method, path }) => [method, path]),
        [["PUT", "/dav/cal/legacy.ics"]],
      );
      assert.equal(
        icalToNormalized({ url: legacyResource, data: davData })?.recurrence,
        recurrence.startsWith("RRULE:") ? recurrence : `RRULE:${recurrence}`,
      );
      assert.ok(
        !(await snapshot()).includes("scopeEdit"),
        "Intent is never persisted",
      );
      assert.equal(
        (
          await request(
            "PUT",
            withSeriesEditIntent({ updates: [legacySeries], creates: [] })
              .updates[0],
          )
        ).status,
        200,
        "Update-only undo also needs no bind",
      );
      privileges = ["bind"];
      assert.equal(
        (await request("PUT", update)).status,
        200,
        "Legacy recurrence change still works with fresh bind",
      );
      assert.equal((await request("PUT", legacySeries)).status, 200);
      davData = legacyOriginal;
    }
    privileges = ["read"];
    assert.equal(
      (
        await request("PUT", {
          ...legacySeries,
          title: "Legacy preserving title",
          recurrence: "FREQ=WEEKLY",
        })
      ).status,
      200,
      "Semantically unchanged recurrence needs no bind",
    );
    resourcePrivileges = undefined;
    // Calendar owner is NOT organizer identity. No ORGANIZER remains a plain appointment.
    privileges = ["write"];
    davData = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:series",
      "DTSTART:20260101T100000Z",
      "DTEND:20260101T110000Z",
      "RRULE:FREQ=WEEKLY",
      "ORGANIZER:mailto:owner@example.test",
      "SUMMARY:Series",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series",
      "RECURRENCE-ID:20260108T100000Z",
      "DTSTART:20260108T120000Z",
      "DTEND:20260108T130000Z",
      "SUMMARY:Detached",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const normalized = icalToNormalized({ url: "unused", data: davData })!;
    const series = { ...eventIn([dav.id]), recurrence: normalized.recurrence };
    await createEvent(series, series.calendars);
    await importExternalEvent(
      "caldav",
      series.id,
      dav.id,
      `${fixtureOrigin}/dav/cal/`,
      `${fixtureOrigin}/dav/cal/event.ics`,
      '"current"',
      "series",
    );
    const originalResource = davData;
    await refuses(
      () => request("PUT", { ...series, recurrence: "RRULE:FREQ=DAILY" }),
      "unsupported",
    );
    await refuses(
      () =>
        request(
          "PUT",
          withSeriesEditIntent({
            updates: [{ ...series, recurrence: "RRULE:FREQ=DAILY" }],
            creates: [],
          }).updates[0],
        ),
      "unsupported",
    );
    assert.equal(davData, originalResource);
    addresses = ["mailto:someone-else@example.test"];
    await refuses(
      () => request("PUT", { ...series, title: "Not organizer" }),
      "denied",
    );
    await refuses(
      () =>
        request(
          "PUT",
          withSeriesEditIntent({
            updates: [{ ...series, title: "Not organizer" }],
            creates: [],
          }).updates[0],
        ),
      "denied",
    );
    await refuses(() => request("DELETE", series), "unknown"); // Shared organizer collection, different session principal: NOT a proven attendee copy.
    addresses = undefined;
    await refuses(
      () => request("PUT", { ...series, title: "Unknown organizer" }),
      "unknown",
    );
    addresses = ["mailto:owner@example.test"];
    assert.equal(
      (await request("PUT", { ...series, title: "Safe title" })).status,
      200,
    );
    assert.match(davData, /SUMMARY:Detached/);
    assert.match(davData, /RECURRENCE-ID/);
    await db
      .insert(calendarMembers)
      .values({ userID: viewer, calendarID: dav.id, role: "viewer" });
    reads.length = 0;
    await refuses(
      () => request("PUT", series, "/events", viewerToken.raw),
      "denied",
    );
    assert.equal(
      reads.length,
      0,
      "A collaborator's viewer ACL never opens provider reads",
    );
    await refuses(
      () =>
        request(
          "DELETE",
          { ...series, unlinkCalendarID: dav.id },
          "/events",
          viewerToken.raw,
        ),
      "denied",
    );
    const ownedCopy = await createCalendar({
      creatorID: viewer,
      name: "Own linked copy",
      color: "#7A8BA3",
    });
    await linkEventToCalendars(series.id, [ownedCopy.id]);
    await refuses(
      () =>
        request(
          "PUT",
          {
            ...series,
            calendars: [dav.id, ownedCopy.id],
            originCalendarID: ownedCopy.id,
          },
          "/events",
          viewerToken.raw,
        ),
      "denied",
    );
    const foreignAccount = await saveCaldavAccount(
      viewer,
      `${fixtureOrigin}/dav/`,
      "other",
      encryptSecret("fixture-password"),
    );
    const mismatched = await mirror(
      "caldav",
      `${fixtureOrigin}/dav/foreign/`,
      foreignAccount.id,
      "viewer",
    );
    reads.length = 0;
    await refuses(() => request("POST", eventIn([mismatched.id])), "denied");
    assert.equal(
      reads.length,
      0,
      "Projected role exception requires the actor's actual account",
    );
    // Discovery must not project unknown or read-only as owner.
    privileges = undefined;
    const discovery = await caldavAdapter.listCalendars(owner, davAccount.id);
    assert.equal(discovery.calendars[0]?.readOnly, true);
    for (const grant of ["read", "bind", "write-content", "unbind", "write"]) {
      privileges = [grant];
      assert.equal(
        (await caldavAdapter.listCalendars(owner, davAccount.id)).calendars[0]
          ?.readOnly,
        grant === "read",
      );
    }
    // New-calendar import has the explicitly approved empty-calendar boundary.
    const recurringIcs = originalResource;
    const importIcs = (provider: string, accountId: string, data: string) =>
      fetch(`${apiOrigin}/import?provider=${provider}&accountId=${accountId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.raw}`,
          "content-type": "text/calendar",
          [CLIENT_VERSION_HEADER]: PRODUCT_VERSION,
        },
        body: data,
      });
    const calendarCount = async () =>
      (await db.select().from(calendars).where(eq(calendars.creatorID, owner)))
        .length;
    let count = await calendarCount();
    const remoteCount = remoteCalendarCreates;
    await refuses(
      () => importIcs("microsoft", "primary", recurringIcs),
      "unsupported",
    );
    assert.equal(await calendarCount(), count);
    assert.equal(remoteCalendarCreates, remoteCount);
    // Graph new collection canEdit is only discoverable after CREATE.
    for (canEdit of [false, undefined]) {
      const error = await refuses(
        () =>
          importIcs(
            "microsoft",
            "primary",
            originalResource.replace(/RRULE:FREQ=WEEKLY\r\n/, ""),
          ),
        canEdit === false ? "denied" : "unknown",
      );
      assert.match(error.error, /calendar remains empty/);
      assert.equal(await calendarCount(), ++count);
    }
    canEdit = true;
    assert.equal(
      (
        await importIcs(
          "microsoft",
          "primary",
          originalResource.replace(/RRULE:FREQ=WEEKLY\r\n/, ""),
        )
      ).status,
      201,
    );
    // Owning a calendar is insufficient when the OAuth token cannot write.
    // Calendar-only grants work; Tasks are neither requested nor required.
    for (const [provider, target] of [
      ["google", google.id],
      ["microsoft", outlook.id],
    ]) {
      const scope = CALENDAR_SCOPE[provider];
      const readOnlyScope =
        provider === "google"
          ? "https://www.googleapis.com/auth/calendar.readonly"
          : "Calendars.Read";
      const setGrant = (values: Partial<typeof account.$inferInsert>) =>
        db
          .update(account)
          .set(values)
          .where(
            and(
              eq(account.userId, owner),
              eq(account.providerId, provider),
              eq(account.accountId, "primary"),
            ),
          );
      const plainIcs = originalResource.replace(/RRULE:FREQ=WEEKLY\r\n/, "");
      for (const grant of [null, "", readOnlyScope]) {
        await setGrant({
          scope: grant,
          accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        });
        await refuses(
          () => request("POST", eventIn([target])),
          grant === null ? "unknown" : "denied",
        );
        const beforeCalendars = await calendarCount();
        const beforeCreates = remoteCalendarCreates;
        await refuses(
          () => importIcs(provider, "primary", plainIcs),
          grant === null ? "unknown" : "denied",
        );
        assert.equal(await calendarCount(), beforeCalendars);
        assert.equal(
          remoteCalendarCreates,
          beforeCreates,
          "Known grant refusal precedes even calendar creation",
        );
      }
      for (const narrowed of [readOnlyScope, "", undefined]) {
        returnedScope = narrowed;
        await setGrant({
          scope: narrowed === undefined ? null : scope,
          accessTokenExpiresAt: new Date(0),
        });
        const beforeRefresh = refreshCalls;
        await refuses(
          () => request("POST", eventIn([target])),
          narrowed === undefined ? "unknown" : "denied",
        );
        assert.equal(refreshCalls, beforeRefresh + 1);
        assert.equal(
          (await getOAuthCredentials(owner, provider, "primary"))?.scope,
          narrowed ?? null,
        );
      }
      returnedScope = readOnlyScope;
      await setGrant({ scope, accessTokenExpiresAt: new Date(0) });
      const beforeCreates = remoteCalendarCreates;
      const beforeCalendars = await calendarCount();
      await refuses(() => importIcs(provider, "primary", plainIcs), "denied");
      assert.equal(
        remoteCalendarCreates,
        beforeCreates,
        "Refresh narrowing also precedes calendar creation",
      );
      assert.equal(await calendarCount(), beforeCalendars);
      returnedScope = undefined;
      await setGrant({ scope, accessTokenExpiresAt: new Date(0) });
      assert.equal(
        (await request("POST", eventIn([target]))).status,
        201,
        "Unchanged calendar-only grant stays writable after refresh",
      );
      revokedRefresh = true;
      await setGrant({ scope, accessTokenExpiresAt: new Date(0) });
      const error = await refuses(
        () => request("POST", eventIn([target])),
        "",
        500,
      );
      assert.equal(
        error.reason,
        undefined,
        "Revocation is not disguised as a capability denial",
      );
      const revoked = await getOAuthCredentials(owner, provider, "primary");
      assert.equal(revoked?.syncStatus, "reconnect_required");
      assert.equal(revoked?.syncErrorCode, "invalid_grant");
      revokedRefresh = false;
      await setGrant({
        scope,
        syncStatus: "active",
        syncErrorCode: null,
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      });
    }
    console.log(
      "K04 authenticated event capabilities + provider HTTP + DB: OK",
    );
  } finally {
    globalThis.fetch = realFetch;
    await db.delete(user).where(inArray(user.id, [owner, viewer]));
    await db.$client.end();
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
