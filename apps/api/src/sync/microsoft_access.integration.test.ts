import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import { account, calendarEvents, createCalendar, db, eventOutbox, events, externalEvents, linkEventToCalendars, getEventSnapshot, queuePendingNotification, getDuePendingNotifications, getOwnProviderEventState, getUserExternalCalendars, reconcileMicrosoftCalendarAccess, user } from "@musubi/db";
import { EventSchema } from "@musubi/types";
import { microsoftAdapter } from "./adapters/microsoft";
import { syncProvider } from "./engine";
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const userID = `graph-private-${randomUUID()}`, accountID = "fixture";
  let absent = false;
  let privateAccess: boolean | undefined = true, canEdit = true, failure = false, discoveryFailure = false;
  let mode: "event" | "delete" | "empty" = "event", title = "Private original", serial = 0;
  let hold: { entered(): void; wait: Promise<void> } | undefined;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture.test"); assert.equal(req.method, "GET");
    res.setHeader("Content-Type", "application/json"); const json = (body: unknown) => res.end(JSON.stringify(body));
    if (url.pathname === "/v1.0/me/calendars") {
      assert.ok(url.searchParams.get("$select")?.includes("canViewPrivateItems"));
      if (discoveryFailure) { res.statusCode = 503; return json({ error: { message: "offline discovery" } }); }
      return json({ value: absent ? [] : [{ id: "calendar", name: "Private shared", canEdit, canViewPrivateItems: privateAccess }] });
    }
    if (url.pathname === "/v1.0/me/calendars/calendar") return json({ id: "calendar", canViewPrivateItems: privateAccess });
    if (url.pathname === "/v1.0/me/calendars/calendar/events/event") {
      assert.equal(mode, "delete"); res.statusCode = 404; return json({ error: { code: "ErrorItemNotFound" } });
    }
    if (url.pathname.endsWith("/calendarView/delta")) {
      paths.push(url.pathname); const cursor = ++serial;
      if (failure) { res.statusCode = 503; return json({ error: { message: "offline events" } }); }
      const value = mode === "empty" ? [] : mode === "delete" ? [{ id: "event", "@removed": { reason: "deleted" } }] : [{ id: "event", type: "singleInstance", "@odata.etag": '"same"', sensitivity: "private", subject: title, body: { content: title === "Busy" ? "" : "Secret notes" }, location: { displayName: title === "Busy" ? "" : "Secret room" }, start: { dateTime: "2026-09-15T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-09-15T10:00:00", timeZone: "UTC" } }];
      const pending = hold; hold = undefined; if (pending) { pending.entered(); await pending.wait; }
      return json({ value, "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/calendars/calendar/calendarView/delta?$deltatoken=${cursor}` });
    }
    res.statusCode = 500; json({ error: { message: "Unexpected fixture path" } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { const url = new URL(String(input)); assert.equal(url.hostname, "graph.microsoft.com", "No live providers"); return realFetch(origin + url.pathname + url.search, init); };
  await db.insert(user).values({ id: userID, name: "Privacy", email: `${userID}@example.test` });
  try {
    await db.insert(account).values({ id: randomUUID(), userId: userID, providerId: "microsoft", accountId: accountID, scope: "Calendars.ReadWrite", accessToken: "fixture", refreshToken: "fixture", accessTokenExpiresAt: new Date(Date.now() + 3600000) });
    const sync = () => syncProvider(microsoftAdapter, userID, { id: accountID, label: "Fixture" });
    const link = async () => (await getUserExternalCalendars("microsoft", userID, accountID))[0]!;
    const row = async () => (await db.select().from(events).where(eq(events.creatorID, userID)))[0]!;
    privateAccess = false; title = "Initially limited"; await sync();
    privateAccess = true; title = "Initial full read"; await sync();
    assert.equal((await row()).title, title, "Initial limited import restores same ETag");
    await sync(); const initial = await row(), calendarID = (await link()).calendarID;
    canEdit = false; failure = true; await assert.rejects(sync());
    assert.equal((await row()).title, initial.title, "Write loss alone is not private-read loss");
    privateAccess = false; await assert.rejects(sync());
    assert.equal((await row()).title, "Busy", "Redaction commits before failed native read");
    assert.equal((await row()).description, null); assert.equal((await row()).id, initial.id);
    assert.equal(await getOwnProviderEventState(userID, initial.id), null);
    const redacted = await row(); discoveryFailure = true; privateAccess = true; await assert.rejects(sync());
    assert.deepEqual(await row(), redacted, "Failed discovery cannot restore"); discoveryFailure = false;
    failure = false; privateAccess = undefined; title = "Unverified old secret"; await assert.rejects(sync());
    assert.deepEqual(await row(), redacted, "Unknown private-read proof cannot restore");
    privateAccess = false; title = "Public permitted title"; await sync();
    assert.equal((await row()).title, title, "Fresh limited read may return authorized details");
    await queuePendingNotification({ userID, subjectID: initial.id, kind: "event_changed", dueAt: new Date(0), payload: { kind: "cancelled", title: "Old notification title", start: initial.start.toISOString(), isAllDay: false } });
    const notification = async () => (await getDuePendingNotifications(new Date())).find(value => value.userID === userID && value.subjectID === initial.id)!;
    assert.equal((await notification()).eligible, false, "Limited read cannot expose retained notification content");
    const unrelatedLink = await createCalendar({ creatorID: userID, name: "Additional link", color: "red" });
    const beforeLink = (await row()).revision;
    await linkEventToCalendars(initial.id, [unrelatedLink.id]);
    assert.equal((await row()).revision, beforeLink + 1);
    privateAccess = true; title = "Private restored"; await sync();
    assert.equal((await row()).title, title, "Fresh same-ETag regain restores");
    assert.equal((await notification()).eligible, true, "Fresh full read and cursor restore notification eligibility after link revision");
    assert.equal((await db.select().from(externalEvents).where(eq(externalEvents.eventID, initial.id)))[0]!.readRedactionRevision, null);
    for (const staleMode of ["event", "delete", "empty"] as const) {
      mode = staleMode; title = "Late old secret";
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      hold = { entered, wait: new Promise<void>(resolve => { release = resolve; }) };
      const old = sync().then(() => null, error => error);
      try {
        await reached; const before = await link();
        await reconcileMicrosoftCalendarAccess(userID, accountID, calendarID, { canEdit, canViewPrivateItems: false });
        await reconcileMicrosoftCalendarAccess(userID, accountID, calendarID, { canEdit, canViewPrivateItems: true });
        assert.equal((await link()).providerAccessRevision, before.providerAccessRevision + 2);
        const accepted = await row(), acceptedLink = await link(); release(); assert.ok(await old, `${staleMode} must fail after ABA`);
        assert.deepEqual(await row(), accepted); assert.deepEqual(await link(), acceptedLink);
      } finally { release(); await old; }
      mode = "event"; title = "Fresh recovery"; await sync();
    }
    // A retained personal intent remains immutable and blocks Graph restoration;
    // the Google-only recovery path must not silently settle it.
    const beforeIntent = await row(), source = await link(), operationID = randomUUID();
    await db.insert(eventOutbox).values({ id: operationID, actorID: userID, mutationID: randomUUID(), position: 0, eventID: initial.id, revision: beforeIntent.revision, calendarID, externalCalendarLinkID: source.sourceID, provider: "microsoft", userID, accountID, externalCalendarID: "calendar", action: "update", payload: { event: EventSchema.parse({ ...beforeIntent, calendars: [calendarID] }) }, status: "pending" });
    const intent = (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    privateAccess = false; await sync();
    privateAccess = true; await sync();
    assert.equal((await row()).title, "Busy", "Graph cannot borrow personal Google recovery while an intent is pending");
    const retainedIntent = (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    assert.deepEqual(retainedIntent.payload, intent.payload);
    assert.equal(retainedIntent.status, "conflict");
    const shared = await createCalendar({ creatorID: userID, name: "Linked", color: "red" });
    await db.insert(calendarEvents).values({ calendarID: shared.id, eventID: initial.id });
    absent = true; await sync();
    const survivor = (await getEventSnapshot(initial.id))!;
    assert.equal(survivor.title, "Busy"); assert.equal(survivor.description, null);
    assert.equal(survivor.originCalendarID, null); assert.ok(survivor.deletedAt);
    assert.equal((await getUserExternalCalendars("microsoft", userID, accountID)).length, 0);
    const cancelled = (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    assert.deepEqual(cancelled.payload, intent.payload); assert.equal(cancelled.status, "cancelled");
    assert.ok(paths.filter(path => path.endsWith("/calendarView/delta")).length >= 5, "Access transitions force full read");
    console.log("Graph private-read discovery: failed/unknown reads, independent write loss, same-ETag limited/regain, stale upsert/delete/cursor ABA: OK");
  } finally { globalThis.fetch = realFetch; await db.delete(user).where(eq(user.id, userID)); await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
