import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  account,
  CALENDAR_SCOPE,
  calendarEvents,
  createCalendar,
  db,
  eventOutbox,
  externalCalendars,
  externalEvents,
  getEvent,
  memberTokens,
  saveCaldavAccount,
  user,
} from "@musubi/db";
import { CLIENT_VERSION_HEADER, EventSchema, PRODUCT_VERSION, eventCreateRequest } from "@musubi/types";
import { issueMemberToken } from "../federation_tokens";
import { requireAuth } from "../middleware/require_auth";
import { middlewareErrorHandler } from "../middleware/error_handler";
import { handlerCreateEvent, handlerRemoveEvent } from "./events";
import { encryptSecret } from "../sync/crypto";
import { deliverEventOutbox } from "../sync/event_delivery";
import { getAdapter, refreshNonOriginEventCopies } from "../sync/engine";

// Authenticated HTTP handlers, real adapters and disposable Postgres. Graph and
// CalDAV are an owned loopback fixture; no live provider is reachable. The
// fixture models a provider-side version change of an otherwise unchanged copy.
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const owner = `mirror-${randomUUID()}`;
  const token = issueMemberToken();
  type GraphEvent = Record<string, unknown> & { id: string; "@odata.etag": string; subject: string };
  const graph = new Map<string, GraphEvent>();
  const dav = new Map<string, { data: string; etag: string }>();
  const deletes: string[] = [];
  let version = 0;
  let stallGraphReads = false;
  const fixture = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url!, "http://fixture.test");
      const path = url.pathname, method = req.method!;
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path.startsWith("/v1.0/")) {
        if (path === "/v1.0/me") return json({ id: "me", mail: "owner@example.test" });
        if (path === "/v1.0/me/calendars/outlook") return json({ id: "outlook", canEdit: true, owner: { address: "owner@example.test" } });
        if (path === "/v1.0/me/calendars/outlook/events" && method === "POST") {
          const input = JSON.parse(body);
          const native: GraphEvent = {
            ...input, id: `graph-${randomUUID()}`, "@odata.etag": `W/"graph-${++version}"`, type: "singleInstance",
            isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, seriesMasterId: null, attendees: [],
            isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, sensitivity: "normal", showAs: "busy",
            isReminderOn: true, reminderMinutesBeforeStart: 15, responseStatus: { response: "organizer" },
            organizer: { emailAddress: { address: "owner@outlook.example", name: "Owner" } },
          };
          graph.set(native.id, native);
          return json(native, 201);
        }
        if (path === "/v1.0/me/calendars/outlook/events" && method === "GET")
          return json({ value: [...graph.values()] });
        const match = /^\/v1\.0\/me\/calendars\/outlook\/events\/([^/]+)$/.exec(path);
        if (match) {
          const id = decodeURIComponent(match[1]!), native = graph.get(id);
          if (method === "DELETE") { deletes.push(`graph:${id}`); graph.delete(id); res.writeHead(204); return res.end(); }
          if (stallGraphReads) return; // Never answers; only the shared deadline ends it.
          return native ? json(native) : json({ error: { code: "ErrorItemNotFound" } }, 404);
        }
      }
      if (path.startsWith("/dav/")) {
        if (method === "PROPFIND") {
          res.writeHead(207, { "content-type": "application/xml" });
          return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${path}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        }
        const item = dav.get(path);
        if (method === "PUT") {
          if (req.headers["if-none-match"] === "*" && item) { res.writeHead(412); return res.end(); }
          const etag = `"dav-${++version}"`;
          dav.set(path, { data: body, etag });
          res.writeHead(201, { etag });
          return res.end();
        }
        if (method === "GET") {
          if (!item) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { "content-type": "text/calendar", etag: item.etag });
          return res.end(item.data);
        }
        if (method === "DELETE") {
          if (!item) { res.writeHead(404); return res.end(); }
          if (req.headers["if-match"] !== item.etag) { res.writeHead(412); return res.end(); }
          deletes.push(`dav:${path}`); dav.delete(path); res.writeHead(204); return res.end();
        }
      }
      json({ error: `Unexpected fixture request ${method} ${path}` }, 500);
    });
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express();
  app.use(express.json());
  app.post("/events", requireAuth, handlerCreateEvent);
  app.delete("/events", requireAuth, handlerRemoveEvent);
  app.use(middlewareErrorHandler);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => api.once("listening", resolve));
  const apiOrigin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if ([fixtureOrigin, apiOrigin].includes(url.origin)) return realFetch(input, init);
    assert.equal(url.hostname, "graph.microsoft.com", `No live requests: ${url}`);
    return realFetch(`${fixtureOrigin}${url.pathname}${url.search}`, init).then(response => {
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    });
  };
  const call = (method: string, body: unknown) => fetch(`${apiOrigin}/events`, {
    method, body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token.raw}`, [CLIENT_VERSION_HEADER]: PRODUCT_VERSION },
  });
  const remove = async (id: string) => call("DELETE", { id, expectedRevision: (await getEvent(id)).revision });
  const mapping = async (eventID: string, calendarID: string) =>
    (await db.select().from(externalEvents).where(and(eq(externalEvents.eventID, eventID), eq(externalEvents.calendarID, calendarID))))[0];
  const settle = async (eventID: string) => {
    for (const row of await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, eventID)))
      if (!["completed", "not-needed", "cancelled"].includes(row.status)) await deliverEventOutbox(row.id, provider => getAdapter(provider)!);
    return db.select().from(eventOutbox).where(eq(eventOutbox.eventID, eventID));
  };

  await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test`, isExternal: true });
  try {
    await db.insert(memberTokens).values({ userID: owner, tokenHash: token.tokenHash });
    await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "microsoft", accountId: "primary", scope: CALENDAR_SCOPE.microsoft, accessToken: "fixture-access", refreshToken: "fixture-refresh", accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
    const davAccount = await saveCaldavAccount(owner, `${fixtureOrigin}/dav/`, "owner", encryptSecret("fixture-password"));
    const local = await createCalendar({ creatorID: owner, name: "Local", color: "#7A8BA3" });
    const { importExternalCalendar } = await import("@musubi/db");
    const outlook = await importExternalCalendar("microsoft", owner, "primary", "Outlook", { externalId: "outlook", name: "Outlook", color: "#7A8BA3" });
    const davCalendar = await importExternalCalendar("caldav", owner, davAccount.id, "DAV", { externalId: `${fixtureOrigin}/dav/cal/`, name: "DAV", color: "#7A8BA3" });
    // Completed discovery evidence: full private read on both sources.
    await db.update(externalCalendars).set({ providerAccessRole: "microsoft:private=yes;edit=yes", providerAccessRevision: 1 }).where(eq(externalCalendars.calendarID, outlook.id));
    await db.update(externalCalendars).set({ providerAccessRole: "caldav:read=yes;freebusy=yes", providerAccessRevision: 1 }).where(eq(externalCalendars.calendarID, davCalendar.id));

    const create = async (title: string) => {
      const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: `${owner}@example.test`, title, color: "#7A8BA3", start: "2026-11-30T21:00:00Z", end: "2026-11-30T21:05:00Z", isAllDay: false, isCanceled: false, calendars: [local.id, outlook.id, davCalendar.id], originCalendarID: local.id });
      const response = await call("POST", eventCreateRequest(event));
      assert.equal(response.status, 201, await response.text());
      const rows = await settle(event.id);
      assert.deepEqual(rows.map(row => [row.provider, row.action, row.status]).sort(), [["caldav", "create", "completed"], ["microsoft", "create", "completed"]]);
      const graphMap = (await mapping(event.id, outlook.id))!, davMap = (await mapping(event.id, davCalendar.id))!;
      return { id: event.id, graphID: graphMap.externalEventID, davPath: new URL(davMap.externalEventID).pathname, graphEtag: graphMap.etag!, davEtag: davMap.etag! };
    };
    const bumpVersions = (item: Awaited<ReturnType<typeof create>>, change: { title?: string } = {}) => {
      const native = graph.get(item.graphID)!;
      graph.set(item.graphID, { ...native, ...(change.title ? { subject: change.title } : {}), "@odata.etag": `W/"graph-${++version}"` });
      const resource = dav.get(item.davPath)!;
      dav.set(item.davPath, { ...resource, etag: `"dav-${++version}"` });
    };

    // 1. Provider-only version changes on both non-origin copies, no scheduled
    //    pull: the first DELETE stays a fail-closed 409 and re-observes ALL
    //    non-origin copies; one explicit retry then converges.
    const stale = await create("Mirror refresh");
    bumpVersions(stale);
    const before = await getEvent(stale.id);
    deletes.length = 0;
    const first = await remove(stale.id);
    assert.equal(first.status, 409);
    assert.equal((await first.json()).code, "provider-conflict");
    assert.equal(deletes.length, 0, "the refusal sends no provider DELETE");
    assert.deepEqual(await getEvent(stale.id), before, "the refresh changes no shared content, revision or timestamp");
    assert.equal((await mapping(stale.id, outlook.id))!.etag, graph.get(stale.graphID)!["@odata.etag"], "Graph copy validator refreshed");
    assert.equal((await mapping(stale.id, davCalendar.id))!.etag, dav.get(stale.davPath)!.etag, "CalDAV copy validator refreshed");
    assert.equal((await mapping(stale.id, davCalendar.id))!.providerState?.provider, "caldav", "CalDAV read carries provider state");
    const retry = await remove(stale.id);
    assert.equal(retry.status, 200, await retry.text());
    const deleted = await settle(stale.id);
    assert.deepEqual(deleted.filter(row => row.action === "delete").map(row => [row.provider, row.status]).sort(), [["caldav", "completed"], ["microsoft", "completed"]]);
    assert.deepEqual(deletes.sort(), [`dav:${stale.davPath}`, `graph:${stale.graphID}`].sort(), "exactly one provider DELETE per copy");

    // 2. A real external edit on a copy stays a conflict on every attempt.
    const edited = await create("Mirror edit");
    bumpVersions(edited, { title: "Edited in Outlook" });
    deletes.length = 0;
    assert.equal((await remove(edited.id)).status, 409);
    assert.equal((await mapping(edited.id, outlook.id))!.etag, edited.graphEtag, "edited content never becomes a write precondition");
    assert.equal((await remove(edited.id)).status, 409);
    assert.deepEqual(deletes.filter(entry => entry.startsWith("graph:")), [], "no Graph DELETE of an externally edited copy");

    // 3. A copy that is absent from the request-path read is skipped: no DB
    //    call, no unlink and no remote delete. (Graph 404 passes its own
    //    preflight; the stale CalDAV copy triggers the conflict.)
    const absent = await create("Mirror absent");
    graph.delete(absent.graphID);
    const resource = dav.get(absent.davPath)!;
    dav.set(absent.davPath, { ...resource, etag: `"dav-${++version}"` });
    const graphBefore = await mapping(absent.id, outlook.id);
    deletes.length = 0;
    assert.equal((await remove(absent.id)).status, 409);
    assert.deepEqual(await mapping(absent.id, outlook.id), graphBefore, "absent copy mapping untouched");
    assert.equal((await db.select().from(calendarEvents).where(and(eq(calendarEvents.eventID, absent.id), eq(calendarEvents.calendarID, outlook.id)))).length, 1, "absent copy stays linked");
    assert.equal(deletes.length, 0, "no provider DELETE");

    // 4. One shared deadline bounds the whole re-observation loop.
    const slow = await create("Mirror deadline");
    bumpVersions(slow);
    stallGraphReads = true;
    const started = Date.now();
    await refreshNonOriginEventCopies({ action: "delete", calendarIDs: [local.id, outlook.id, davCalendar.id], event: { ...(await getEvent(slow.id)), calendars: [local.id, outlook.id, davCalendar.id] } }, { timeoutMs: 300 });
    stallGraphReads = false;
    assert.ok(Date.now() - started < 5_000, "the stalled read ends at the shared deadline");
    assert.equal((await mapping(slow.id, davCalendar.id))!.etag, slow.davEtag, "no further target runs after the shared deadline");
    console.log("Non-origin mirror validator refresh API flow: all-target re-observation, explicit retry, edit conflict, absent-copy skip and shared deadline: OK");
  } finally {
    globalThis.fetch = realFetch;
    await db.delete(user).where(eq(user.id, owner));
    await new Promise(resolve => api.close(resolve));
    await new Promise(resolve => fixture.close(resolve));
    fixture.closeAllConnections?.();
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
