import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use an owned disposable database");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname), "Refuse a non-local database");
  const { eq } = await import("drizzle-orm");
  const { config } = await import("@musubi/config");
  const { db, user, saveCaldavAccount, importExternalCalendar, getUserExternalCalendars, reconcileCaldavReadAccess, upsertExternalEvent, upsertExternalTask, getEventSnapshot, events, externalEvents, calendarEvents, eventOutbox, tasks, externalTasks, taskOutbox, externalCalendars, setCursor } = await import("@musubi/db");
  const { EventSchema, TaskSchema } = await import("@musubi/types");
  const { encryptSecret } = await import("./crypto");
  const { caldavAdapter } = await import("./adapters/caldav");
  const { syncProvider } = await import("./engine");
  let mode = "empty", fallbackListings = 0, multigets = 0, reports = 0;
  let fixtureFailure: unknown;
  const token = "urn:uuid:REPORT%2bToken+opaque?order=z&order=a&empty=";
  const discoveryToken = "urn:uuid:older-discovery-token";
  const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const document = (value: string) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="urn:wrong">${value}</d:multistatus>`;
  const row = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const calendarProps = '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Token fixture</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>';
  let origin = "";
  const collection = () => `${origin}/home/calendar/`;
  const fixture = createServer(async (req, res) => {
    try {
      assert.ok(["PROPFIND", "REPORT", "GET"].includes(req.method!), `Provider fixture only permits reads: ${req.method}`);
      assert.equal(req.headers.authorization, `Basic ${Buffer.from("fixture:fixture").toString("base64")}`);
      if (req.method === "GET") { assert.equal(req.url, "/.well-known/caldav"); res.writeHead(204); res.end(); return; }
      let body = ""; for await (const chunk of req) body += chunk;
      const href = origin + req.url;
      let xml: string;
      if (body.includes("sync-collection")) {
        reports++;
        if (mode === "redirected") { res.writeHead(307, { location: origin+"/unselected/" }); res.end(); return; }
        const rootToken = mode === "missing" ? "" : mode === "empty-token" ? "<d:sync-token/>" : mode === "wrong-token" ? `<x:sync-token>${xmlEscape(token)}</x:sync-token>` : `<d:sync-token>${xmlEscape(token)}</d:sync-token>`;
        xml = document(rootToken + (mode === "duplicate" ? rootToken : "") + (["changed", "hydration-failed"].includes(mode) ? row(collection()+"changed.ics", '<d:getetag>"v2"</d:getetag>') : mode === "deleted" ? `<d:response><d:href>${collection()}deleted.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>` : ""));
        if (mode === "partial") res.setHeader("content-range", "items 0-0/1");
        if (mode === "http-failed") { res.writeHead(503, { "content-type": "application/xml" }); res.end(xml); return; }
      } else if (body.includes("calendar-multiget")) {
        multigets++;
        if (mode === "hydration-failed") { res.writeHead(503, { "content-type": "application/xml" }); res.end(); return; }
        const data = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:changed", "SUMMARY:Changed task", "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
        xml = document(row(collection()+"changed.ics", `<d:getetag>"v2"</d:getetag><c:calendar-data>${xmlEscape(data)}</c:calendar-data>`));
      } else if (body.includes("current-user-principal")) xml = document(row(href, "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>"));
      else if (body.includes("calendar-home-set")) xml = document(row(href, "<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>"));
      else if (body.includes("current-user-privilege-set")) xml = document(row(href, "<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>"));
      else if (body.includes("supported-report-set")) xml = document(row(href, "<d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>"));
      else if (body.includes("resourcetype")) xml = document(row(href, "<d:resourcetype><d:collection/></d:resourcetype>") + (req.url === "/home/" ? row(collection(), `${calendarProps}<d:sync-token>${discoveryToken}</d:sync-token>`) : ""));
      else if (body.includes("getetag")) {
        fallbackListings++;
        if (mode !== "empty") { res.writeHead(503, { "content-type": "application/xml" }); res.end(); return; }
        xml = document(row(collection(), "<d:getetag>collection</d:getetag>"));
      } else throw new Error("Unexpected fixture request");
      res.writeHead(207, { "content-type": "application/xml" }); res.end(xml);
    } catch (error) { fixtureFailure = error; res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const owner = `caldav-token-${randomUUID()}`;
  const priorPrivate = config.security.federationAllowPrivateHosts;
  const priorTime = config.api.eventTimeEditsEnabled;
  config.security.federationAllowPrivateHosts = true;
  config.api.eventTimeEditsEnabled = false;
  await db.insert(user).values({ id: owner, name: "Token fixture", email: `${owner}@example.test` });
  try {
    const account = await saveCaldavAccount(owner, origin+"/", "fixture", encryptSecret("fixture"));
    const read = (cursor: string | null) => caldavAdapter.fetchChanges(owner, account.id, collection(), cursor);
    // This assertion is intentionally first: old source turns valid no-change
    // REPORT into a full listing/reset using the unrelated discovery token.
    const saved = await read("urn:uuid:prior-token");
    assert.equal(fallbackListings, 0, "A valid no-change saved-cursor REPORT must not trigger a full PROPFIND fallback");
    assert.deepEqual(saved, { changes: [], nextCursor: token, reset: false });
    assert.equal(multigets, 0);
    const initial = await read(null);
    assert.deepEqual(initial, { changes: [], nextCursor: token, reset: true });
    assert.equal(fallbackListings, 0); assert.equal(multigets, 0);
    mode = "changed";
    const changed = await read("urn:uuid:prior-token");
    assert.equal(changed.reset, false); assert.equal(changed.nextCursor, token);
    assert.equal(changed.changes.length, 1); assert.equal(changed.changes[0]!.kind, "task");
    assert.equal(multigets, 1); assert.equal(fallbackListings, 0);
    mode = "deleted";
    const deleted = await read("urn:uuid:prior-token");
    assert.equal(deleted.reset, false); assert.equal(deleted.nextCursor, token);
    assert.equal(deleted.changes.length, 2); assert.equal(multigets, 1); assert.equal(fallbackListings, 0);

    // Actual engine/DB acceptance uses the complete no-change incremental read,
    // retaining both families and pending/unconfirmed outbound intent.
    mode = "empty";
    const calendar = await importExternalCalendar("caldav", owner, account.id, "fixture", { externalId: collection(), name: "Token fixture", color: "#7A8BA3", supportsEvents: true, supportsTasks: true });
    await reconcileCaldavReadAccess(owner, account.id, calendar.id, { read: true, readFreeBusy: true }, false);
    await upsertExternalEvent("caldav", owner, calendar.id, collection(), collection()+"retained.ics", { title: "Retained", color: "#7A8BA3", start: new Date("2026-09-15T09:00:00Z"), end: new Date("2026-09-15T10:00:00Z"), isAllDay: false, description: "Private retained", location: null, organizer: "", recurrence: null, url: null }, '"event-v1"', "retained");
    await upsertExternalTask("caldav", owner, calendar.id, collection(), collection()+"retained-task.ics", { title: "Retained task", description: null, status: "needs-action", start: null, due: null, isAllDay: false, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null }, '"task-v1"', "retained-task");
    const [source] = await getUserExternalCalendars("caldav", owner, account.id);
    await setCursor(calendar.id, "urn:uuid:saved-engine-token");
    assert.equal((await getUserExternalCalendars("caldav", owner, account.id))[0]!.cursor, "urn:uuid:saved-engine-token");
    const [event] = await db.select().from(events).where(eq(events.creatorID, owner));
    const [task] = await db.select().from(tasks).where(eq(tasks.creatorID, owner));
    for (const status of ["pending", "unconfirmed"] as const) {
      await db.insert(eventOutbox).values({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, eventID: event!.id, revision: event!.revision, calendarID: calendar.id, externalCalendarLinkID: source.sourceID, provider: "caldav", userID: owner, accountID: account.id, externalCalendarID: collection(), externalEventID: collection()+"retained.ics", expectedEtag: '"event-v1"', action: "update", payload: { event: EventSchema.parse(await getEventSnapshot(event!.id)) }, status, uncertain: status === "unconfirmed" });
      await db.insert(taskOutbox).values({ id: randomUUID(), actorID: owner, mutationID: randomUUID(), position: 0, taskID: task!.id, revision: task!.revision, calendarID: calendar.id, externalCalendarLinkID: source.sourceID, provider: "caldav", userID: owner, accountID: account.id, externalCalendarID: collection(), externalTaskID: collection()+"retained-task.ics", expectedEtag: '"task-v1"', providerAccessRevision: source.providerAccessRevision, action: "update", payload: { task: TaskSchema.parse({ ...task, calendarIDs: [calendar.id] }) }, status, uncertain: status === "unconfirmed" });
    }
    const snapshot = async () => ({ events: await db.select().from(events).where(eq(events.creatorID, owner)), eventMaps: await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id)), links: await db.select().from(calendarEvents).where(eq(calendarEvents.calendarID, calendar.id)), eventOutbox: await db.select().from(eventOutbox).where(eq(eventOutbox.userID, owner)).orderBy(eventOutbox.id), tasks: await db.select().from(tasks).where(eq(tasks.creatorID, owner)), taskMaps: await db.select().from(externalTasks).where(eq(externalTasks.calendarID, calendar.id)), taskOutbox: await db.select().from(taskOutbox).where(eq(taskOutbox.userID, owner)).orderBy(taskOutbox.id) });
    const before = await snapshot();
    const [beforeSource] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.sourceID));
    await syncProvider(caldavAdapter, owner, { id: account.id, label: "fixture" });
    assert.deepEqual(await snapshot(), before, "No-change incremental read preserves canonical state, bindings and pending/unconfirmed intents");
    const [accepted] = await getUserExternalCalendars("caldav", owner, account.id);
    assert.equal(accepted!.sourceID, source.sourceID); assert.equal(accepted!.cursor, token);
    const [afterSource] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.sourceID));
    assert.equal(afterSource!.checkpointRevision, beforeSource!.checkpointRevision + 1);
    const stableSource = ({ cursor: _cursor, checkpointRevision: _revision, updatedAt: _updatedAt, ...stable }: typeof beforeSource) => stable;
    assert.deepEqual(stableSource(afterSource!), stableSource(beforeSource!), "No-change checkpoint keeps source incarnation, coverage and access metadata");
    assert.equal(fallbackListings, 0); assert.equal(multigets, 1);
    for (const bad of ["missing", "duplicate", "empty-token", "wrong-token", "partial", "http-failed", "hydration-failed", "redirected"]) {
      mode = bad;
      const [oldSource] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.sourceID));
      await assert.rejects(syncProvider(caldavAdapter, owner, { id: account.id, label: "fixture" }));
      assert.deepEqual(await snapshot(), before, `${bad}: invalid REPORT cannot sweep either family or rewrite intent`);
      const [unchanged] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.sourceID));
      assert.equal(unchanged!.cursor, oldSource!.cursor); assert.equal(unchanged!.checkpointRevision, oldSource!.checkpointRevision);
    }
    assert.equal(fixtureFailure, undefined); assert.ok(reports >= 10);
    console.log("CalDAV actual HTTP/client/adapter/engine/PostgreSQL token-only REPORT: no fallback/reset, exact cursor, both-family intent preservation and invalid-response refusal OK");
  } finally {
    config.security.federationAllowPrivateHosts = priorPrivate; config.api.eventTimeEditsEnabled = priorTime;
    await db.delete(user).where(eq(user.id, owner));
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
