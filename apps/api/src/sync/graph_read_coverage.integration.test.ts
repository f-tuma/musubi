import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { expandRecurringEvents } from "@musubi/calendar";
import {
  account, calendarEvents, calendarMembers, createCalendar, db, events,
  externalCalendars, externalEvents, externalEventTombstones, eventOutbox,
  getUserExternalCalendars, importExternalCalendar, user,
} from "@musubi/db";
import { EventSchema } from "@musubi/types";
import { microsoftAdapter } from "./adapters/microsoft";
import { syncProvider } from "./engine";

const DAY = 86_400_000;
type Native = Record<string, any>;
type Fault = "none" | "expired" | "second-page" | "malformed" | "partial" | "hydration";

/** Only provider reads use the Graph interception. Explicit local fixture DELETE
 * controls the fake native state; it is never a delivered outbox operation. */
async function fixture(run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>, twoEvents = false) {
  const context = await createFixture(twoEvents);
  try { await run(context); } finally { await context.close(); }
}

async function createFixture(twoEvents: boolean) {
  const owner = `graph-coverage-${randomUUID()}`, viewer = `graph-coverage-viewer-${randomUUID()}`;
  const accountID = `account-${randomUUID()}`, nativeCalendarID = `calendar-${randomUUID()}`;
  const nativeEventID = `event-${randomUUID()}`, secondaryID = `second-${randomUUID()}`;
  const nativeUID = `uid-${randomUUID()}`, t0 = Date.now();
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  let now = t0, serial = 0, fault: Fault = "none", values: Native[] | null = null;
  let hydrationID: string | null = null;
  let nativePrivateRead = true;
  const nativeEvent = (id: string, title: string, start = t0 + DAY): Native => ({
    id, type: "singleInstance", "@odata.etag": `"${title}"`, iCalUId: id === nativeEventID ? nativeUID : `${nativeUID}-${id}`,
    sensitivity: "normal", isAllDay: false, subject: title,
    body: { content: "Synthetic notes", contentType: "text" }, location: { displayName: "Synthetic place" },
    start: { dateTime: new Date(start).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
    end: { dateTime: new Date(start + 3_600_000).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
  });
  const native = new Map<string, Native>([[nativeEventID, nativeEvent(nativeEventID, "Initial")]]);
  if (twoEvents) native.set(secondaryID, nativeEvent(secondaryID, "Second initial", t0 + 2 * DAY));
  const requests: { method: string; path: string; query: string; status: number }[] = [];
  const controls: { method: string; id: string }[] = [];
  const deltaPath = `/v1.0/me/calendars/${encodeURIComponent(nativeCalendarID)}/calendarView/delta`;
  const windows = new Map<string, { start: number; end: number }>();
  const continuation = (token: string, key = "$deltatoken") => `https://graph.microsoft.com${deltaPath}?${key}=${token}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.test");
    res.setHeader("content-type", "application/json");
    if (url.pathname.startsWith("/fixture/events/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.slice("/fixture/events/".length));
      assert.ok(native.delete(id)); controls.push({ method: "DELETE", id });
      res.statusCode = 204; return res.end();
    }
    const request = { method: req.method ?? "", path: url.pathname, query: url.search, status: 200 };
    requests.push(request);
    const json = (body: unknown, status = 200) => { request.status = status; res.statusCode = status; res.end(JSON.stringify(body)); };
    if (req.method !== "GET") return json({ error: { message: "Provider mutation forbidden" } }, 500);
    if (url.pathname === "/v1.0/me/calendars") return json({ value: [{ id: nativeCalendarID, name: "Synthetic source", canEdit: true, canViewPrivateItems: true }] });
    if (url.pathname === `/v1.0/me/calendars/${encodeURIComponent(nativeCalendarID)}`) {
      assert.equal(url.searchParams.get("$select"), "id,canViewPrivateItems");
      return json({ id: nativeCalendarID, canViewPrivateItems: nativePrivateRead });
    }
    const eventPrefix = `/v1.0/me/calendars/${encodeURIComponent(nativeCalendarID)}/events/`;
    if (url.pathname.startsWith(eventPrefix)) {
      const id = decodeURIComponent(url.pathname.slice(eventPrefix.length));
      if (id === hydrationID && fault === "hydration") return json({ error: { message: "Incomplete dependency" } }, 503);
      return native.has(id) ? json(native.get(id)) : json({ error: { code: "ErrorItemNotFound", message: "Synthetic missing item" } }, 404);
    }
    if (url.pathname === deltaPath) {
      if (url.searchParams.has("$skiptoken")) return json({ error: { message: "Second page failed" } }, 503);
      if (fault === "expired" && url.searchParams.has("$deltatoken")) {
        fault = "none"; return json({ error: { code: "SyncStateNotFound" } }, 410);
      }
      if (fault === "malformed") return json({});
      let window = windows.get(url.searchParams.get("$deltatoken") ?? "");
      if (!window) {
        window = { start: Date.parse(url.searchParams.get("startDateTime")!), end: Date.parse(url.searchParams.get("endDateTime")!) };
        assert.equal(window.start, now - 180 * DAY); assert.equal(window.end, now + 730 * DAY);
      }
      const token = `read-${++serial}`; windows.set(token, window);
      const observed = values ?? [...native.values()].filter(event => event.type !== "seriesMaster" && Date.parse(event.start.dateTime + "Z") >= window!.start && Date.parse(event.start.dateTime + "Z") < window!.end);
      if (fault === "second-page") return json({ value: observed, "@odata.nextLink": continuation("page-two", "$skiptoken") });
      if (fault === "partial") res.setHeader("content-range", "items 0-0/2");
      return json({ value: observed, "@odata.deltaLink": continuation(token) });
    }
    return json({ error: { message: "Unexpected fixture path" } }, 500);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.microsoft.com", "No live provider endpoints");
    return originalFetch(origin + url.pathname + url.search, init);
  };
  Date.now = () => now;
  const close = async () => {
    Date.now = originalNow; globalThis.fetch = originalFetch;
    try { await db.delete(user).where(inArray(user.id, [owner, viewer])); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    assert.ok(requests.every(request => request.method === "GET"), "The sync and its outbox never dispatched a provider mutation");
  };
  try {
  await db.insert(user).values([{ id: owner, name: "Synthetic owner", email: `${owner}@example.test` }, { id: viewer, name: "Synthetic viewer", email: `${viewer}@example.test` }]);
  await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "microsoft", accountId: accountID, scope: "Calendars.ReadWrite", accessToken: "fixture-only", refreshToken: "fixture-only", accessTokenExpiresAt: new Date(t0 + 2000 * DAY) });
  const sync = () => syncProvider(microsoftAdapter, owner, { id: accountID, label: "Synthetic Graph account" });
  await sync();
  const [source] = await getUserExternalCalendars("microsoft", owner, accountID);
  const [mapping] = await db.select().from(externalEvents).where(and(eq(externalEvents.calendarID, source.calendarID), eq(externalEvents.externalEventID, nativeEventID)));
  const eventID = mapping.eventID;
  await db.insert(calendarMembers).values({ userID: viewer, calendarID: source.calendarID, role: "viewer" });
  const destination = await importExternalCalendar("google", owner, `google-account-${randomUUID()}`, "Synthetic Google destination", { externalId: `google-calendar-${randomUUID()}`, name: "Synthetic destination", color: "red" });
  const [target] = await db.select().from(externalCalendars).where(eq(externalCalendars.calendarID, destination.id));
  await db.insert(calendarEvents).values({ eventID, calendarID: destination.id });
  await db.insert(externalEvents).values({ provider: "google", eventID, calendarID: destination.id, externalCalendarID: target.externalCalendarID, externalEventID: `google-event-${randomUUID()}`, etag: '"google-before"', icalUid: nativeUID });
  const snapshot = async () => {
    const rows = await db.select().from(events).where(eq(events.creatorID, owner)).orderBy(events.id);
    const ids = rows.map(row => row.id);
    const bindings = await db.select().from(externalEvents).where(inArray(externalEvents.eventID, ids)).orderBy(externalEvents.id);
    const links = await db.select().from(calendarEvents).where(inArray(calendarEvents.eventID, ids)).orderBy(calendarEvents.calendarID, calendarEvents.eventID);
    const members = await db.select().from(calendarMembers).where(eq(calendarMembers.calendarID, source.calendarID)).orderBy(calendarMembers.userID);
    const outbox = await db.select().from(eventOutbox).where(eq(eventOutbox.userID, owner)).orderBy(eventOutbox.id);
    const tombstones = await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, source.sourceID)).orderBy(externalEventTombstones.id);
    const [current] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.sourceID));
    const { updatedAt: _updatedAt, cursor, readCoverage, checkpointRevision, ...identity } = current;
    return { rows, bindings, links, members, outbox, tombstones, sourceIdentity: identity, checkpoint: { cursor, readCoverage, checkpointRevision } };
  };
  return {
    owner, eventID, nativeEventID, secondaryID, nativeCalendarID, source, target, destination, native, nativeEvent, t0,
    requests, controls, sync, snapshot, close,
    setNow(value: number) { now = value; }, setValues(value: Native[] | null) { values = value; },
    setFault(value: Fault) { fault = value; }, setHydrationID(value: string) { hydrationID = value; },
    setNativePrivateRead(value: boolean) { nativePrivateRead = value; },
    async deleteNative(id = nativeEventID) { const response = await originalFetch(`${origin}/fixture/events/${encodeURIComponent(id)}`, { method: "DELETE" }); assert.equal(response.status, 204); },
  };
  } catch (error) { await close(); throw error; }
}

function retained(snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof createFixture>>["snapshot"]>>) {
  const { checkpoint: _checkpoint, ...state } = snapshot;
  return state;
}

async function windowAndPendingWrites() {
  await fixture(async f => {
    const beforeIntent = await f.snapshot(), event = beforeIntent.rows.find(row => row.id === f.eventID)!;
    const accepted = EventSchema.parse({ ...event, calendars: [f.source.calendarID, f.destination.id] });
    await db.insert(eventOutbox).values([
      { id: randomUUID(), actorID: f.owner, mutationID: randomUUID(), position: 0, eventID: event.id, revision: event.revision, calendarID: f.source.calendarID, externalCalendarLinkID: f.source.sourceID, provider: "microsoft", userID: f.owner, accountID: beforeIntent.sourceIdentity.accountID, externalCalendarID: f.nativeCalendarID, externalEventID: f.nativeEventID, action: "update", payload: { event: accepted, patch: { title: "Accepted source intent" } }, status: "unconfirmed", attempts: 1, uncertain: true },
      { id: randomUUID(), actorID: f.owner, mutationID: randomUUID(), position: 0, eventID: event.id, revision: event.revision, calendarID: f.destination.id, externalCalendarLinkID: f.target.id, provider: "google", userID: f.owner, accountID: f.target.accountID, externalCalendarID: f.target.externalCalendarID, externalEventID: "accepted-destination-address", action: "update", payload: { event: accepted, patch: { title: "Accepted destination intent" } }, status: "pending" },
    ]);
    const before = await f.snapshot();
    f.setNow(f.t0 + 641 * DAY); await f.sync();
    const renewed = await f.snapshot();
    assert.deepEqual(retained(renewed), retained(before), "Renewed empty window retains home UUID/revision, mappings/native addresses, memberships, links and accepted writes byte for byte");
    assert.equal(renewed.checkpoint.checkpointRevision, before.checkpoint.checkpointRevision + 1);
    assert.notDeepEqual(renewed.checkpoint.readCoverage, before.checkpoint.readCoverage);
    assert.ok(f.native.has(f.nativeEventID), "The native event still exists outside the renewed window");
    assert.equal(JSON.parse(renewed.checkpoint.cursor!).version, 2);
    f.setFault("expired"); await f.sync();
    const restarted = await f.snapshot();
    assert.deepEqual(retained(restarted), retained(renewed), "A 410 and complete empty replacement window cannot manufacture a deletion or alter accepted intents");
    assert.equal(restarted.checkpoint.checkpointRevision, renewed.checkpoint.checkpointRevision + 1);
    assert.ok(f.requests.some(request => request.status === 410));
    const unknown = `unknown-${randomUUID()}`;
    f.setValues([{ id: unknown, "@removed": { reason: "deleted" } }]); await f.sync();
    const afterUnknown = await f.snapshot();
    assert.deepEqual(retained(afterUnknown), retained(restarted), "Unmapped @removed neither tombstones a host event nor poisons a future native binding");
    assert.equal(afterUnknown.tombstones.length, 0);
    assert.equal(f.requests.filter(request => request.path.endsWith(`/events/${unknown}`)).length, 0);
  });
}

async function removedButStillPresent() {
  await fixture(async f => {
    f.setNow(f.t0 + 641 * DAY); f.setValues([]); await f.sync();
    const before = await f.snapshot();
    const moved = { ...f.native.get(f.nativeEventID)!, subject: "Present outside coverage", "@odata.etag": '"outside-version"' };
    f.native.set(f.nativeEventID, moved);
    f.setValues([{ id: f.nativeEventID, "@removed": { reason: "deleted" } }]); await f.sync();
    const after = await f.snapshot(), current = after.rows.find(row => row.id === f.eventID)!;
    assert.equal(current.deletedAt, null); assert.equal(current.title, moved.subject);
    assert.equal(current.revision, before.rows.find(row => row.id === f.eventID)!.revision + 1);
    assert.deepEqual(after.bindings.map(row => ({ id: row.id, eventID: row.eventID, externalEventID: row.externalEventID })), before.bindings.map(row => ({ id: row.id, eventID: row.eventID, externalEventID: row.externalEventID })));
    assert.deepEqual(after.links, before.links); assert.deepEqual(after.members, before.members);
    assert.ok(after.outbox.every(row => row.action !== "delete"));
    assert.ok(f.requests.some(request => request.path.endsWith(`/events/${f.nativeEventID}`) && request.status === 200));
  });
}

async function provenDeletion(origin: boolean) {
  await fixture(async f => {
    let homeID = f.source.calendarID;
    if (!origin) {
      const home = await createCalendar({ creatorID: f.owner, name: "Authoritative local home", color: "red" }); homeID = home.id;
      await db.update(events).set({ originCalendarID: home.id }).where(eq(events.id, f.eventID));
      await db.insert(calendarEvents).values({ calendarID: home.id, eventID: f.eventID });
    }
    const before = await f.snapshot(), startRequest = f.requests.length;
    await f.deleteNative(); f.setValues([{ id: f.nativeEventID, "@removed": { reason: "deleted" } }]); await f.sync();
    const after = await f.snapshot(), row = after.rows.find(value => value.id === f.eventID)!;
    const proof = f.requests.slice(startRequest);
    assert.equal(proof.filter(request => request.path.endsWith(`/events/${f.nativeEventID}`) && request.status === 404).length, 2);
    assert.equal(proof.filter(request => request.path === `/v1.0/me/calendars/${f.nativeCalendarID}` && request.status === 200).length, 1);
    assert.equal(f.controls.length, 1, "The synthetic native DELETE precedes the read proof");
    assert.equal(row.originCalendarID, homeID); assert.equal(row.revision, before.rows.find(value => value.id === f.eventID)!.revision + 1);
    if (origin) {
      assert.ok(row.deletedAt, "The exact source-origin absence proof may tombstone its canonical home");
      assert.deepEqual(after.links, before.links); assert.deepEqual(after.bindings, before.bindings);
      assert.equal(after.outbox.length, 1); assert.equal(after.outbox[0].provider, "google"); assert.equal(after.outbox[0].action, "delete");
      assert.equal(after.outbox[0].attempts, 0); assert.equal(after.outbox[0].resultRef, null);
    } else {
      assert.equal(row.deletedAt, null, "Absence of a derived Graph copy cannot globally delete its authoritative home");
      assert.ok(after.links.some(link => link.calendarID === homeID));
      assert.ok(after.links.some(link => link.calendarID === f.destination.id));
      assert.ok(!after.links.some(link => link.calendarID === f.source.calendarID));
      assert.equal(after.outbox.length, 0, "Copy absence admits no foreign deletion");
    }
  });
}

async function nativeReadAuthorityLostAfterDiscovery() {
  await fixture(async f => {
    const before = await f.snapshot();
    await f.deleteNative(); f.setNativePrivateRead(false);
    f.setValues([{ id: f.nativeEventID, "@removed": { reason: "deleted" } }]);
    await assert.rejects(f.sync());
    assert.deepEqual(await f.snapshot(), before, "A fresh native private-read denial after granted discovery invalidates deletion proof, the whole read batch and its checkpoint");
    assert.equal(f.requests.filter(request => request.path.endsWith(`/events/${f.nativeEventID}`) && request.status === 404).length, 1, "The second absence read must not continue after native permission loss");
  });
}

async function movedExceptionKeepsOriginalSlot() {
  const rsvp = config.api.providerRsvpEditsEnabled;
  config.api.providerRsvpEditsEnabled = true;
  try {
    await fixture(async f => {
      const masterID = `master-${randomUUID()}`, exceptionID = `exception-${randomUUID()}`;
      const originalTime = f.t0 + 3 * DAY, originalStart = { kind: "instant", value: new Date(originalTime).toISOString() };
      const master: Native = {
        ...f.nativeEvent(masterID, "Synthetic recurring master", originalTime), type: "seriesMaster",
        recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", numberOfOccurrences: 3 } },
      };
      const exception = {
        ...f.nativeEvent(exceptionID, "Synthetic exception", originalTime), type: "exception", seriesMasterId: masterID,
        iCalUId: master.iCalUId, originalStart: originalStart.value,
      };
      f.native.set(masterID, master); f.native.set(exceptionID, exception);
      f.setValues([exception]); await f.sync();
      const before = await f.snapshot();
      const binding = before.bindings.find(row => row.externalEventID === exceptionID)!;
      assert.deepEqual(binding.originalStart, originalStart); assert.equal(binding.externalSeriesID, masterID);
      f.setNow(f.t0 + 641 * DAY); f.setValues([]); await f.sync();
      const renewed = await f.snapshot();
      assert.deepEqual(retained(renewed), retained(before), "Window renewal keeps the exception's original slot and existing canonical UUID");
      const movedTime = f.t0 + (641 + 731) * DAY;
      f.native.set(exceptionID, {
        ...exception, subject: "Moved exception outside window", "@odata.etag": '"moved-outside-version"',
        start: { dateTime: new Date(movedTime).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
        end: { dateTime: new Date(movedTime + 3_600_000).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
      });
      f.setValues([{ id: exceptionID, "@removed": { reason: "deleted" } }]); await f.sync();
      const after = await f.snapshot(), mapped = after.bindings.find(row => row.externalEventID === exceptionID)!;
      assert.equal(mapped.id, binding.id); assert.equal(mapped.eventID, binding.eventID);
      assert.equal(mapped.externalSeriesID, masterID); assert.deepEqual(mapped.originalStart, originalStart);
      const visible = after.rows.find(row => row.id === binding.eventID)!;
      assert.equal(visible.deletedAt, null); assert.equal(visible.start.getTime(), movedTime);
      assert.equal(after.rows.filter(row => row.id === binding.eventID).length, 1);
      const projected = after.rows.map(row => ({ ...row, calendars: [f.source.calendarID] }));
      assert.equal(expandRecurringEvents(projected, new Date(originalTime - 1), new Date(originalTime + DAY), { consumerTimeZone: "UTC" }).filter(row => row.id === binding.eventID).length, 0, "A moved exception does not reappear at its original slot");
      assert.equal(expandRecurringEvents(projected, new Date(movedTime - 1), new Date(movedTime + DAY), { consumerTimeZone: "UTC" }).filter(row => row.id === binding.eventID).length, 1);
      assert.ok(after.outbox.every(row => row.action !== "delete"));
    });
  } finally { config.api.providerRsvpEditsEnabled = rsvp; }
}

async function incompleteReadAndAtomicApply() {
  await fixture(async f => {
    const before = await f.snapshot();
    const firstUpdate = { ...f.native.get(f.nativeEventID)!, subject: "First update must roll back", "@odata.etag": '"changed-first"' };
    for (const fault of ["second-page", "malformed", "partial"] as const) {
      f.setValues([firstUpdate]); f.setFault(fault); await assert.rejects(f.sync());
      assert.deepEqual(await f.snapshot(), before, `${fault} leaves all canonical state and the checkpoint unchanged`);
    }
    const masterID = `dependency-${randomUUID()}`;
    f.setHydrationID(masterID); f.setFault("hydration");
    f.setValues([firstUpdate, { ...f.nativeEvent(`occurrence-${randomUUID()}`, "Incomplete occurrence"), type: "occurrence", seriesMasterId: masterID }]);
    await assert.rejects(f.sync()); assert.deepEqual(await f.snapshot(), before, "Failed master hydration cannot publish earlier observations or advance the cursor");
    f.setFault("none");
    const marker = `sql-reject-${randomUUID()}`, suffix = randomUUID().replace(/-/g, "");
    const functionName = `graph_coverage_fail_${suffix}`, triggerName = `graph_coverage_fail_${suffix}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = '${marker}' THEN RAISE EXCEPTION 'synthetic second-item apply failure'; END IF; RETURN NEW; END $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`));
      f.setValues([firstUpdate, { ...f.native.get(f.secondaryID)!, subject: marker, "@odata.etag": '"changed-second"' }]);
      await assert.rejects(f.sync());
      assert.deepEqual(await f.snapshot(), before, "A failure applying the second observation rolls back the first event, derived fanout, bindings and checkpoint atomically");
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON events`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
    }
  }, true);
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const timeEdits = config.api.eventTimeEditsEnabled, rsvp = config.api.providerRsvpEditsEnabled;
  config.api.eventTimeEditsEnabled = false; config.api.providerRsvpEditsEnabled = false;
  try {
    await windowAndPendingWrites(); await removedButStillPresent();
    await provenDeletion(true); await provenDeletion(false); await nativeReadAuthorityLostAfterDiscovery(); await movedExceptionKeepsOriginalSlot(); await incompleteReadAndAtomicApply();
    console.log("Graph read coverage: renewal/410 retention, immutable pending writes, ambiguous removals, origin/copy deletion authority, moved original slots, complete-read and atomic apply rollback: OK");
  } finally { config.api.eventTimeEditsEnabled = timeEdits; config.api.providerRsvpEditsEnabled = rsvp; }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$client.end());
