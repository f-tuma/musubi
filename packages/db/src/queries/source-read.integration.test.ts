import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { setTimeout } from "node:timers/promises";
import { EventSchema, type SyncCoverage } from "@musubi/types";
import { account, beginGraphRead, applyGraphReadBatch, GraphReadSourceChanged, calendarEvents, db, deleteExternalEventInTransaction, disableExternalCalendar, eventOutbox, events, externalCalendars, externalEvents, externalEventTombstones, getEventSnapshot, getOAuthCredentials, getUserExternalCalendars, importExternalCalendar, importExternalEvent, linkEventToCalendars, markOAuthAccountActive, markOAuthAccountReconnectRequired, reconcileMicrosoftCalendarAccess, removeExternalAccountData, setCursor, setExternalCalendarCapabilities, updateOAuthTokens, upsertExternalEvent, upsertExternalEventInTransaction, user, type GraphReadAdmission } from "..";

const coverage: SyncCoverage = { kind: "window", fromInclusive: "2026-01-01T00:00:00.000Z", untilExclusive: "2028-01-01T00:00:00.000Z", complete: true };
const values = { title: "Retained event", color: "red", start: new Date("2026-09-15T09:00:00Z"), end: new Date("2026-09-15T10:00:00Z"), isAllDay: false, description: "Private notes", location: null, organizer: "", recurrence: null, url: null };
type Fixture = { userID: string; accountID: string; connectionID: string; calendarID: string; sourceID: string; externalCalendarID: string; eventID: string };
async function createFixture(): Promise<Fixture> {
  const userID = `source-read-${randomUUID()}`, accountID = randomUUID(), connectionID = randomUUID(), externalCalendarID = `native-${randomUUID()}`;
  await db.insert(user).values({ id: userID, name: "Read fixture", email: `${userID}@example.test` });
  await db.insert(account).values({ id: connectionID, userId: userID, providerId: "microsoft", accountId: accountID, scope: "Calendars.ReadWrite", refreshToken: "fixture-refresh", accessToken: "fixture-access", accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
  const calendar = await importExternalCalendar("microsoft", userID, accountID, "Fixture", { externalId: externalCalendarID, name: "Fixture", color: "red" });
  await reconcileMicrosoftCalendarAccess(userID, accountID, calendar.id, { canEdit: true, canViewPrivateItems: true });
  await upsertExternalEvent("microsoft", userID, calendar.id, externalCalendarID, "native-event", values, 'W/"one"', "fixture-uid");
  const [link] = await getUserExternalCalendars("microsoft", userID, accountID);
  const [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, calendar.id));
  return { userID, accountID, connectionID, calendarID: calendar.id, sourceID: link.sourceID, externalCalendarID, eventID: mapping.eventID };
}
async function withFixture(name: string, body: (fixture: Fixture) => Promise<void>) {
  const f = await createFixture();
  try { await body(f); console.log(`source read: ${name} OK`); }
  finally {
    // Purge this test owner's mapping/link union in bulk before FK cascades;
    // the large retention regression should measure apply, not N FK scans.
    await db.delete(externalEvents).where(sql`${externalEvents.eventID} in (select id from events where creator_id = ${f.userID})`);
    await db.delete(calendarEvents).where(sql`${calendarEvents.eventID} in (select id from events where creator_id = ${f.userID})`);
    await db.delete(events).where(eq(events.creatorID, f.userID));
    await db.delete(user).where(eq(user.id, f.userID));
  }
}
const begin = (f: Fixture, configurationFingerprint = "graph-window-retain-v1") => beginGraphRead({ userID: f.userID, accountID: f.accountID, calendarID: f.calendarID, sourceID: f.sourceID, configurationFingerprint });
const accept = <T>(admission: GraphReadAdmission, body: Parameters<typeof applyGraphReadBatch<T>>[2], nextCursor = "accepted-cursor") => applyGraphReadBatch(admission, { coverage, nextCursor, configurationFingerprint: admission.configurationFingerprint }, body);
async function snapshot(f: Fixture) {
  const rows = await db.select().from(events).where(eq(events.creatorID, f.userID)).orderBy(events.id);
  const ids = rows.map(row => row.id);
  return {
    source: await db.select().from(externalCalendars).where(eq(externalCalendars.userID, f.userID)).orderBy(externalCalendars.id),
    rows,
    links: ids.length ? await db.select().from(calendarEvents).where(inArray(calendarEvents.eventID, ids)).orderBy(calendarEvents.eventID, calendarEvents.calendarID) : [],
    mappings: ids.length ? await db.select().from(externalEvents).where(inArray(externalEvents.eventID, ids)).orderBy(externalEvents.id) : [],
    intents: await db.select().from(eventOutbox).where(eq(eventOutbox.userID, f.userID)).orderBy(eventOutbox.id),
    tombstones: await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, f.sourceID)).orderBy(externalEventTombstones.id),
  };
}
async function pending(f: Fixture) {
  const id = randomUUID();
  await db.insert(eventOutbox).values({ id, actorID: f.userID, mutationID: randomUUID(), position: 0, eventID: f.eventID, revision: (await getEventSnapshot(f.eventID))!.revision, calendarID: f.calendarID, externalCalendarLinkID: f.sourceID, provider: "microsoft", userID: f.userID, accountID: f.accountID, externalCalendarID: f.externalCalendarID, externalEventID: "native-event", expectedEtag: 'W/"one"', action: "update", payload: { event: EventSchema.parse(await getEventSnapshot(f.eventID)) } });
  return id;
}
async function rejected(admission: GraphReadAdmission) {
  let called = false;
  await assert.rejects(accept(admission, async () => { called = true; }), GraphReadSourceChanged);
  assert.equal(called, false, "Stale admission fails before any observation is applied");
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use a disposable migrated test database");
  await withFixture("empty coverage preserves canonical, mapping and pending intent", async f => {
    await pending(f);
    const admission = await begin(f), before = await snapshot(f);
    assert.equal(admission.readAuthorityVerified, true);
    assert.deepEqual(admission.knownEventIDs, ["native-event"]);
    const repeat = await begin(f);
    assert.deepEqual(repeat, admission, "Same profile is a no-op");
    assert.equal(await accept(admission, async () => 0), 0);
    const after = await snapshot(f);
    assert.deepEqual({ ...after, source: [] }, { ...before, source: [] });
    assert.equal(after.source[0].sourceGeneration, before.source[0].sourceGeneration);
    assert.equal(after.source[0].providerAccessRevision, before.source[0].providerAccessRevision);
    assert.equal(after.source[0].checkpointRevision, before.source[0].checkpointRevision + 1);
    assert.deepEqual(after.source[0].readCoverage, coverage);
    await rejected(admission);
    assert.deepEqual(await snapshot(f), after);
  });
  await withFixture("access ABA rejects old present/deletion/empty admissions", async f => {
    const old = await begin(f);
    assert.equal(await reconcileMicrosoftCalendarAccess(f.userID, f.accountID, f.calendarID, { canEdit: true, canViewPrivateItems: true }), false);
    await reconcileMicrosoftCalendarAccess(f.userID, f.accountID, f.calendarID, { canEdit: true, canViewPrivateItems: false });
    await reconcileMicrosoftCalendarAccess(f.userID, f.accountID, f.calendarID, { canEdit: true, canViewPrivateItems: true });
    const after = await snapshot(f);
    assert.equal(after.source[0].sourceGeneration, old.sourceGeneration + 2);
    await rejected(old);
    assert.deepEqual(await snapshot(f), after);
  });
  await withFixture("capability and configuration ABA do not retire pending write permission", async f => {
    await pending(f); const old = await begin(f), before = await snapshot(f);
    await setExternalCalendarCapabilities("microsoft", f.userID, f.accountID, f.externalCalendarID, { supportsEvents: false, supportsTasks: false });
    await setExternalCalendarCapabilities("microsoft", f.userID, f.accountID, f.externalCalendarID, { supportsEvents: true, supportsTasks: false });
    await rejected(old);
    const a = await begin(f, "profile-A"); await begin(f, "profile-B"); await begin(f, "profile-A");
    const after = await snapshot(f); await rejected(a);
    assert.deepEqual({ ...after, source: [] }, { ...before, source: [] });
    assert.equal(after.source[0].providerAccessRevision, before.source[0].providerAccessRevision);
    assert.deepEqual(await snapshot(f), after);
  });
  await withFixture("null cursor ABA and live profile mismatch cannot checkpoint", async f => {
    const old = await begin(f);
    await setCursor(f.calendarID, null); await setCursor(f.calendarID, null);
    const after = await snapshot(f);
    assert.equal(after.source[0].cursor, old.cursor);
    assert.equal(after.source[0].checkpointRevision, old.checkpointRevision + 2);
    await rejected(old); assert.deepEqual(await snapshot(f), after);
    const fresh = await begin(f);
    await assert.rejects(applyGraphReadBatch(fresh, { coverage, nextCursor: "bad", configurationFingerprint: "changed-live-profile" }, async () => {}), GraphReadSourceChanged);
    for (const invalid of [{ kind: "incremental" }, { kind: "partial", reason: "pagination" }, { kind: "collection-inventory-complete", snapshotId: "not-this-profile" }, { ...coverage, complete: false }] as SyncCoverage[]) {
      await assert.rejects(applyGraphReadBatch(fresh, { coverage: invalid, nextCursor: "bad", configurationFingerprint: fresh.configurationFingerprint }, async () => {}), GraphReadSourceChanged);
    }
  });
  await withFixture("real second observation failure rolls back the whole batch", async f => {
    await pending(f); const old = await begin(f), before = await snapshot(f);
    await assert.rejects(accept(old, async (tx, access) => {
      assert.equal(await upsertExternalEventInTransaction(tx, false, "microsoft", f.userID, f.calendarID, f.externalCalendarID, "new-first-item", { ...values, title: "Must roll back" }, 'W/"new"', "new-uid", undefined, undefined, undefined, undefined, undefined, undefined, access), true);
      // Adopting a precise occurrence identity over an unresolved source write
      // is a real host rejection after the preceding new row was inserted.
      await upsertExternalEventInTransaction(tx, false, "microsoft", f.userID, f.calendarID, f.externalCalendarID, "native-event", values, 'W/"newer"', "fixture-uid", undefined, undefined, { externalSeriesID: "series", originalStart: { kind: "instant", value: "2026-09-15T09:00:00.000Z" } }, undefined, undefined, undefined, access);
    }));
    assert.deepEqual(await snapshot(f), before);
  });
  await withFixture("OAuth retirement, scope ABA and routine token refresh", async f => {
    const old = await begin(f);
    const expected = (await getOAuthCredentials(f.userID, "microsoft", f.accountID))!;
    assert.equal(await updateOAuthTokens(f.userID, "microsoft", f.accountID, { accessToken: "rotated-access", refreshToken: "rotated-refresh", accessTokenExpiresAt: new Date(Date.now() + 7200_000) }, expected), true);
    assert.equal((await begin(f)).connectionGeneration, old.connectionGeneration, "Ordinary non-null token rotation is not grant retirement");
    assert.equal((await begin(f)).sourceGeneration, old.sourceGeneration);
    assert.equal(await markOAuthAccountReconnectRequired(f.userID, "microsoft", f.accountID, "invalid_grant"), true);
    await db.update(account).set({ refreshToken: "relinked", accessToken: "relinked" }).where(eq(account.id, f.connectionID));
    await markOAuthAccountActive(f.userID, "microsoft", f.accountID);
    const afterRelink = await snapshot(f); await rejected(old); assert.deepEqual(await snapshot(f), afterRelink);
    const scopeOld = await begin(f);
    // Better Auth-like direct SQL updates bypass helper lifecycle callbacks.
    await db.update(account).set({ scope: "Calendars.ReadWrite Tasks.ReadWrite" }).where(eq(account.id, f.connectionID));
    await db.update(account).set({ scope: "Calendars.ReadWrite" }).where(eq(account.id, f.connectionID));
    assert.equal((await begin(f)).connectionGeneration, scopeOld.connectionGeneration + 2);
    const afterScope = await snapshot(f); await rejected(scopeOld); assert.deepEqual(await snapshot(f), afterScope);
    const scopeAdmission = await begin(f), credentials = (await getOAuthCredentials(f.userID, "microsoft", f.accountID))!;
    await updateOAuthTokens(f.userID, "microsoft", f.accountID, { accessToken: "explicit-scope", accessTokenExpiresAt: new Date(Date.now() + 7200_000), scope: "Calendars.ReadWrite Tasks.ReadWrite" }, credentials);
    assert.equal((await begin(f)).sourceGeneration, scopeAdmission.sourceGeneration + 1);
    await rejected(scopeAdmission);
  });
  await withFixture("native address replacement and connection recreation", async f => {
    const old = await begin(f), [mapping] = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, f.calendarID));
    await db.delete(externalEvents).where(eq(externalEvents.id, mapping.id));
    await importExternalEvent("microsoft", f.eventID, f.calendarID, f.externalCalendarID, "native-event", 'W/"replacement"', "fixture-uid");
    const replacement = await snapshot(f); await rejected(old); assert.deepEqual(await snapshot(f), replacement);
    const captured = await begin(f);
    await removeExternalAccountData("microsoft", f.userID, f.accountID);
    await importExternalCalendar("microsoft", f.userID, f.accountID, "Recreated", { externalId: f.externalCalendarID, name: "Recreated", color: "red" });
    const after = await snapshot(f); await rejected(captured); assert.deepEqual(await snapshot(f), after);
  });
  await withFixture("disabled source rejects empty and nonempty apply", async f => {
    const old = await begin(f); await disableExternalCalendar(f.userID, f.calendarID);
    const after = await snapshot(f); await rejected(old); assert.deepEqual(await snapshot(f), after);
  });
  await withFixture("authority row locks hold through the checkpoint commit", async f => {
    const admission = await begin(f);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const applying = accept(admission, async () => { entered(); await gate; });
    const writer = await db.$client.connect();
    try {
      await reached;
      const { rows: [{ pid }] } = await writer.query<{ pid: number }>("select pg_backend_pid() as pid");
      let changed = false;
      const update = writer.query("update account set scope = 'Calendars.ReadWrite Tasks.ReadWrite' where id = $1", [f.connectionID]).then(() => { changed = true; });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await db.execute<{ wait_event_type: string | null }>(sql`select wait_event_type from pg_stat_activity where pid = ${pid}`);
        if (result.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
        await setTimeout(5);
      }
      assert.equal(blocked, true, "Direct grant update must really reach and wait on the shared authority row lock");
      assert.equal(changed, false);
      release(); await applying; await update;
      assert.equal(changed, true);
      assert.equal((await snapshot(f)).source[0].checkpointRevision, admission.checkpointRevision + 1);
      await rejected(admission);
    } finally { release(); await applying; writer.release(); }
  });
  await withFixture("shared-copy lock order and unlink receipts wait for commit", async f => {
    const second = await importExternalCalendar("microsoft", f.userID, f.accountID, "Second", { externalId: "second-native", name: "Second", color: "blue" });
    await reconcileMicrosoftCalendarAccess(f.userID, f.accountID, second.id, { canEdit: true, canViewPrivateItems: true });
    await upsertExternalEvent("microsoft", f.userID, f.calendarID, f.externalCalendarID, "native-two", { ...values, title: "Second" });
    const mapped = await db.select().from(externalEvents).where(eq(externalEvents.calendarID, f.calendarID)).orderBy(externalEvents.externalEventID);
    for (const row of mapped) { await linkEventToCalendars(row.eventID, [second.id]); await importExternalEvent("microsoft", row.eventID, second.id, "second-native", row.externalEventID); }
    const [secondSource] = await getUserExternalCalendars("microsoft", f.userID, f.accountID).then(rows => rows.filter(row => row.calendarID === second.id));
    const a = await begin(f), b = await beginGraphRead({ userID: f.userID, accountID: f.accountID, calendarID: second.id, sourceID: secondSource.sourceID, configurationFingerprint: "graph-window-retain-v1" });
    // Reverse provider item order while both transactions share the canonical
    // union. No failed fixture should be disguised by a transaction retry.
    await Promise.all([accept(a, async (tx, access) => { for (const row of mapped) await upsertExternalEventInTransaction(tx, false, "microsoft", f.userID, f.calendarID, f.externalCalendarID, row.externalEventID, values, null, null, undefined, undefined, undefined, undefined, undefined, undefined, access); }), accept(b, async (tx, access) => { for (const row of [...mapped].reverse()) await upsertExternalEventInTransaction(tx, false, "microsoft", f.userID, second.id, "second-native", row.externalEventID, values, null, null, undefined, undefined, undefined, undefined, undefined, undefined, access); })]);
    const fresh = await beginGraphRead({ userID: f.userID, accountID: f.accountID, calendarID: second.id, sourceID: secondSource.sourceID, configurationFingerprint: "graph-window-retain-v1" });
    const before = await snapshot(f); let receiptReturned = false;
    await assert.rejects(accept(fresh, async (tx, access) => { const result = await deleteExternalEventInTransaction(tx, "microsoft", second.id, "native-event", access); assert.ok(result.unlinked); throw new Error("Abort after real unlink"); }).then(() => { receiptReturned = true; }));
    assert.equal(receiptReturned, false); assert.deepEqual(await snapshot(f), before);
    const result = await accept(fresh, (tx, access) => deleteExternalEventInTransaction(tx, "microsoft", second.id, "native-event", access));
    assert.ok(result.unlinked); assert.equal(result.changed, true);
    assert.equal((await getEventSnapshot(f.eventID))!.deletedAt, null, "Derived-source removal cannot globally tombstone canonical event");
  });
  await withFixture("23,000 retained mappings use bounded parameter arrays", async f => {
    // Three expanded ID predicates would exceed PostgreSQL's 65,535 bind
    // limit. Generate a real populated collection and apply its entire closure.
    await db.execute(sql`with inserted as (
      insert into events (id, creator_id, origin_calendar_id, name, color, start_at, end_at, is_all_day, organizer)
      select gen_random_uuid(), ${f.userID}, ${f.calendarID}::uuid, 'Large retained fixture', 'red', '2026-09-15T09:00:00Z'::timestamp, '2026-09-15T10:00:00Z'::timestamp, false, ''
      from generate_series(1, 23000) returning id
    ) insert into external_events (provider, event_id, calendar_id, external_calendar_id, external_event_id)
      select 'microsoft', id, ${f.calendarID}::uuid, ${f.externalCalendarID}, id::text from inserted`);
    await db.execute(sql`insert into calendar_events (event_id, calendar_id)
      select event_id, ${f.calendarID}::uuid from external_events where calendar_id = ${f.calendarID}::uuid on conflict do nothing`);
    const admission = await begin(f);
    assert.equal(admission.knownEventIDs.length, 23001);
    await accept(admission, async () => 0);
    const count = await db.execute<{ count: string }>(sql`select count(*)::text as count from events where creator_id = ${f.userID} and deleted_at is null`);
    assert.equal(Number(count.rows[0].count), 23001, "No truncated coverage closure or fabricated deletion");
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$client.end());
