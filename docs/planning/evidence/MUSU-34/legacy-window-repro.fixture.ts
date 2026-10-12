/** Historical regression witness, pinned to be267b2. This test expects the unsafe
 * behavior so it must never be used as a current-engine passing test. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { account, calendarEvents, calendarMembers, db, events, externalCalendars, externalEvents, eventOutbox, getUserExternalCalendars, importExternalCalendar, user } from "@musubi/db";
import { microsoftAdapter } from "./adapters/microsoft";
import { syncProvider } from "./engine";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.equal(new URL(process.env.DATABASE_URL!).hostname, "127.0.0.1");
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/musubi_c03");
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(baseCommit, "be267b2a960c768c60bd0f91de1106f8878e7999");
  const owner = `graph-reset-owner-${randomUUID()}`, viewer = `graph-reset-viewer-${randomUUID()}`;
  const accountID = `graph-account-${randomUUID()}`, nativeCalendar = `graph-calendar-${randomUUID()}`;
  const nativeEvent = `graph-event-${randomUUID()}`, uid = `synthetic-uid-${randomUUID()}`;
  const realNow = Date.now, t0 = realNow(), day = 86_400_000;
  let clock = t0, round = 0;
  const requests: { method: string; path: string; query: string }[] = [];
  const native = { id: nativeEvent, type: "singleInstance", "@odata.etag": '"graph-version-1"', iCalUId: uid, sensitivity: "normal", subject: "Synthetic window witness", body: { content: "Synthetic test data" }, location: { displayName: "Fixture" }, start: { dateTime: new Date(t0 + day).toISOString().replace(/Z$/, ""), timeZone: "UTC" }, end: { dateTime: new Date(t0 + day + 3_600_000).toISOString().replace(/Z$/, ""), timeZone: "UTC" } };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.test");
    requests.push({ method: req.method!, path: url.pathname, query: url.search });
    res.setHeader("content-type", "application/json");
    const json = (body: unknown) => res.end(JSON.stringify(body));
    if (req.method !== "GET") { res.statusCode = 500; return json({ error: "Mutation forbidden in regression witness" }); }
    if (url.pathname === "/v1.0/me/calendars") return json({ value: [{ id: nativeCalendar, name: "Synthetic source", canEdit: true, canViewPrivateItems: true }] });
    if (url.pathname.endsWith("/calendarView/delta")) {
      const from = Date.parse(url.searchParams.get("startDateTime")!);
      const to = Date.parse(url.searchParams.get("endDateTime")!);
      assert.equal(from, clock - 180 * day);
      assert.equal(to, clock + 730 * day);
      const value = t0 + day >= from && t0 + day < to ? [native] : [];
      return json({ value, "@odata.deltaLink": `https://graph.microsoft.com/fixture-delta?round=${++round}` });
    }
    res.statusCode = 500; json({ error: { message: "Unexpected synthetic path" } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.microsoft.com", "Every provider request must remain on the local synthetic Graph server");
    return realFetch(origin + url.pathname + url.search, init);
  };
  Date.now = () => clock;
  let result: Record<string, unknown> | undefined;
  await db.insert(user).values([{ id: owner, name: "Synthetic owner", email: `${owner}@example.test` }, { id: viewer, name: "Synthetic viewer", email: `${viewer}@example.test` }]);
  try {
    await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "microsoft", accountId: accountID, scope: "Calendars.ReadWrite", accessToken: "fixture-only", refreshToken: "fixture-only", accessTokenExpiresAt: new Date(t0 + 2000 * day) });
    const run = () => syncProvider(microsoftAdapter, owner, { id: accountID, label: "Synthetic Graph account" });
    await run();
    const [source] = await getUserExternalCalendars("microsoft", owner, accountID);
    const [initial] = await db.select().from(events).where(eq(events.creatorID, owner));
    assert.ok(source && initial);
    assert.equal(initial.originCalendarID, source.calendarID);
    assert.equal(initial.deletedAt, null);
    await db.insert(calendarMembers).values({ calendarID: source.calendarID, userID: viewer, role: "viewer" });
    const destination = await importExternalCalendar("google", owner, `google-account-${randomUUID()}`, "Synthetic destination", { externalId: `google-calendar-${randomUUID()}`, name: "Synthetic Google destination", color: "red" });
    const [destinationSource] = await db.select().from(externalCalendars).where(eq(externalCalendars.calendarID, destination.id));
    await db.insert(calendarEvents).values({ eventID: initial.id, calendarID: destination.id });
    await db.insert(externalEvents).values({ provider: "google", eventID: initial.id, calendarID: destination.id, externalCalendarID: destinationSource.externalCalendarID, externalEventID: `google-event-${randomUUID()}`, etag: '"google-version-1"', icalUid: uid });
    const snapshot = async () => {
      const [event] = await db.select().from(events).where(eq(events.id, initial.id));
      const bindings = await db.select().from(externalEvents).where(eq(externalEvents.eventID, initial.id)).orderBy(externalEvents.provider);
      const links = await db.select().from(calendarEvents).where(eq(calendarEvents.eventID, initial.id));
      const members = await db.select({ userID: calendarMembers.userID, role: calendarMembers.role }).from(calendarMembers).where(eq(calendarMembers.calendarID, source.calendarID));
      const outbox = await db.select().from(eventOutbox).where(eq(eventOutbox.eventID, initial.id));
      const [sourceState] = await db.select().from(externalCalendars).where(eq(externalCalendars.id, source.sourceID));
      return { event, bindings, links, members, outbox, sourceState };
    };
    const before = await snapshot();
    assert.equal(before.outbox.length, 0);
    assert.equal(before.bindings.length, 2);
    assert.equal(before.links.length, 2);
    assert.equal(before.members.length, 2);
    // A realistic old window expires near its future edge. The native event is
    // still present in the fake provider, but lies before the renewed lower edge.
    clock = t0 + 641 * day;
    const oldCursor = JSON.parse(before.sourceState.cursor!);
    assert.equal(oldCursor.windowEnd - clock, 89 * day);
    assert.ok(t0 + day < clock - 180 * day);
    await run();
    const after = await snapshot();
    assert.ok(after.event.deletedAt, "Old engine converts out-of-window absence into a canonical tombstone");
    assert.equal(after.event.revision, before.event.revision + 1);
    assert.equal(after.event.originCalendarID, source.calendarID);
    assert.deepEqual(after.bindings, before.bindings, "Mapping identities remain while canonical event tombstones");
    assert.deepEqual(after.links, before.links);
    assert.deepEqual(after.members, before.members);
    assert.equal(after.outbox.length, 1);
    const intent = after.outbox[0];
    assert.equal(intent.provider, "google");
    assert.equal(intent.calendarID, destination.id);
    assert.equal(intent.action, "delete");
    assert.equal(intent.status, "pending");
    assert.equal(intent.attempts, 0);
    assert.equal(intent.uncertain, false);
    assert.equal(intent.resultRef, null);
    assert.ok(intent.payload.event.deletedAt);
    assert.equal(intent.revision, after.event.revision);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.method === "GET"));
    assert.equal(requests.filter(request => request.path.endsWith("/calendarView/delta")).length, 2);
    result = { schemaVersion: 1, recordRole: "historical-baseline-regression-witness", baseCommit, executionPath: "microsoftAdapter.listCalendars/fetchChanges -> syncProvider -> reconcileExternalChanges(reset=true) -> sweepExternalEvents -> deleteExternalEvent -> appendInboundEventFanout", t0: new Date(t0).toISOString(), t1: new Date(clock).toISOString(), nativeEventRemainsPresent: true, providerRequests: requests, foreignProviderMutationCount: 0, conclusion: "A renewed Graph window that excludes an existing source-origin event tombstones its canonical home event and admits a Google destination delete intent. No foreign DELETE was executed.", before, after };
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    await db.delete(user).where(inArray(user.id, [owner, viewer]));
    assert.equal((await db.select().from(user).where(inArray(user.id, [owner, viewer]))).length, 0);
    assert.equal((await db.select().from(events).where(eq(events.creatorID, owner))).length, 0);
    assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.userID, owner))).length, 0);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.ok(result);
  result.cleanup = { fixtureUsersDeleted: true, fixtureEventsDeleted: true, fixtureOutboxDeleted: true, disposableDatabaseRetainedForC03Upgrade: true };
  const evidence = process.env.REPRO_EVIDENCE_PATH ?? "/tmp/musubi-graph-baseline-reset-evidence.json";
  await writeFile(evidence, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ baseCommit, evidence, assertions: "passed", providerRequests: requests.length, foreignProviderMutationCount: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$client.end());
