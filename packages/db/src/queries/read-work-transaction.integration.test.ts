import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const store = await import("..");
  const { withSyncReadTransaction, ackSyncDiscoveryWork } = await import("./read-work-transaction");
  const { eq } = await import("drizzle-orm");
  const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const actor = `read-guard-${randomUUID()}`, accountID = `opaque-${randomUUID()}`;
  await store.db.insert(store.user).values({ id: actor, name: "Before", email: `${actor}@example.test` });
  await store.db.insert(store.account).values({ id: randomUUID(), userId: actor, providerId: "google", accountId: accountID,
    scope: "https://www.googleapis.com/auth/calendar.events", refreshToken: "fixture-only" });
  const address = { userID: actor, provider: "google" as const, accountID, stream: "discovery" as const, configurationFingerprint: "guard-discovery-v1" };
  const claim = async (id: string) => {
    const result = await store.claimSyncReadWork(id);
    assert.equal(result.kind, "claimed");
    if (result.kind !== "claimed") throw new Error("Claim unavailable");
    return result.capture;
  };
  async function waitForLock() {
    for (let i = 0; i < 400; i++) {
      const result = await observer.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>pg_backend_pid()");
      if (result.rowCount) return;
      await pause(5);
    }
    throw new Error("Expected real PostgreSQL row-lock wait");
  }
  async function blockedAbort(lock: (connection: import("pg").PoolClient) => Promise<unknown>, run: (signal: AbortSignal) => Promise<unknown>) {
    const blocker = await observer.connect(), controller = new AbortController();
    await blocker.query("begin");
    try {
      await lock(blocker);
      const pending = run(controller.signal).then(() => null, error => error);
      await waitForLock();
      controller.abort(new Error("Controlled read cancellation"));
      await blocker.query("commit");
      assert.match(String(await pending), /Controlled read cancellation/);
    } finally { await blocker.query("rollback"); blocker.release(); }
  }
  try {
    const request = await store.requestSyncReadWork(address), captured = await claim(request.workID);
    await blockedAbort(connection => connection.query('select id from "user" where id=$1 for update', [actor]),
      signal => withSyncReadTransaction({ capture: captured, signal }, async tx => {
        await tx.update(store.user).set({ name: "Provisional" }).where(eq(store.user.id, actor));
      }));
    assert.equal((await store.db.select().from(store.user).where(eq(store.user.id, actor)))[0]!.name, "Before");
    await blockedAbort(connection => connection.query("select id from sync_read_work where id=$1 for update", [request.workID]),
      signal => ackSyncDiscoveryWork({ capture: captured, signal }));
    let status = (await store.getSyncReadWorkStatus(request.workID))!;
    assert.equal(status.completedGeneration, "0"); assert.equal(status.claimToken, captured.claimToken);
    await store.releaseSyncReadWork(captured);

    const calendar = await store.importExternalCalendar("google", actor, accountID, "Fixture", {
      externalId: "native-calendar", name: "Guard fixture", color: "#6699cc", supportsEvents: true,
    });
    const [source] = await store.db.select().from(store.externalCalendars).where(eq(store.externalCalendars.calendarID, calendar.id));
    assert.ok(source);
    const collectionRequest = await store.requestSyncReadWork({ ...address, stream: "events", sourceID: source.id, configurationFingerprint: "guard-events-v1" });
    const collectionCapture = await claim(collectionRequest.workID);
    await blockedAbort(connection => connection.query("select id from sync_read_work where id=$1 for update", [collectionRequest.workID]),
      signal => store.setCursor(calendar.id, "must-rollback", undefined, { capture: collectionCapture, signal }));
    const [after] = await store.db.select().from(store.externalCalendars).where(eq(store.externalCalendars.id, source.id));
    assert.equal(after!.cursor, source.cursor); assert.equal(after!.checkpointRevision, source.checkpointRevision);
    status = (await store.getSyncReadWorkStatus(collectionRequest.workID))!;
    assert.equal(status.completedGeneration, "0"); assert.equal(status.claimToken, collectionCapture.claimToken);

    // Successful final cursor CAS and exactly the captured dirty ACK commit together.
    await store.setCursor(calendar.id, "accepted-cursor", undefined, { capture: collectionCapture, signal: new AbortController().signal });
    assert.equal((await store.getSyncReadWorkStatus(collectionRequest.workID))!.completedGeneration, "1");
    assert.equal((await store.db.select().from(store.externalCalendars).where(eq(store.externalCalendars.id, source.id)))[0]!.cursor, "accepted-cursor");
    console.log("Queued read cancellation: provisional import, discovery ACK and cursor/dirty ACK rollback after real lock waits: PASS");
  } finally {
    await store.db.delete(store.user).where(eq(store.user.id, actor));
    await observer.end();
    await store.db.$client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
