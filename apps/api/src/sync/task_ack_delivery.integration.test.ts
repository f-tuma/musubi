import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Client, Pool } from "pg";
import { TaskSchema } from "@musubi/types";
import type { CalendarAdapter, TaskReadEvidence } from "./adapter";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Task ACK delivery requires an explicit disposable database");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const databaseName = `task_ack_delivery_${randomUUID().replace(/-/g, "")}`;
  const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  process.env.DATABASE_URL = databaseUrl.href;
  const { db, user, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
    getTaskOutbox, upsertExternalTask } = await import("@musubi/db");
  const { migrateDatabase } = await import("../../../../packages/db/src/migrate");
  const { deliverTaskOutbox } = await import("./task_delivery");
  const { toGoogleTask } = await import("./adapters/google");
  const observer = new Pool({ connectionString: databaseUrl.href, max: 3 });
  const owner = `task-ack-delivery:${randomUUID()}`;
  const deadlineMs = 123_459;
  const realSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined, lastSignal: AbortSignal | undefined, passed = 0;
  const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === deadlineMs) { expire = () => callback(...args); return realSetTimeout(callback, 30_000, ...args); }
    return realSetTimeout(callback, delay, ...args);
  });
  async function fixture() {
    const calendarID = randomUUID(), taskID = randomUUID(), id = randomUUID(), nativeID = `native-${randomUUID()}`;
    await db.insert(calendars).values({ id: calendarID, creatorID: owner, name: "Task ACK delivery fixture", color: "#112233" });
    await db.insert(calendarMembers).values({ calendarID, userID: owner, role: "owner" });
    const [source] = await db.insert(externalCalendars).values({ calendarID, provider: "google", userID: owner,
      accountID: owner, externalCalendarID: `fixture-list:${calendarID}`, supportsEvents: false, supportsTasks: true }).returning();
    const [task] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID, originCalendarID: calendarID,
      title: "Accepted title", status: "in-process", due: new Date("2026-10-26T14:45:00Z"), priority: 2 }).returning();
    await db.insert(calendarTasks).values({ taskID, calendarID });
    const accepted = TaskSchema.parse({ ...task, calendarIDs: [calendarID] });
    const target = toGoogleTask(accepted), baseline = { ...target, title: "Previous title" };
    const [mapping] = await db.insert(externalTasks).values({ taskID, calendarID, provider: "google", externalCalendarID: source.externalCalendarID,
      externalTaskID: nativeID, etag: '"v1"', accountID: owner, externalCalendarLinkID: source.id, projectionBaseline: baseline }).returning();
    await db.insert(taskOutbox).values({ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID, revision: task.revision,
      calendarID, externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID: owner, externalCalendarID: source.externalCalendarID,
      externalTaskID: nativeID, expectedEtag: '"v1"', providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: "update",
      payload: { task: accepted, projectionBaseline: baseline } });
    let remote: TaskReadEvidence = { ref: { externalTaskId: nativeID, etag: '"v1"' }, projection: baseline };
    let writes = 0, reads = 0, afterWrite: (() => Promise<void>) | undefined;
    const adapter = {
      projectTask: toGoogleTask,
      async readTask(_u, _a, _c, _ref, signal) { reads++; lastSignal = signal; return remote; },
      async assertTaskWrite() {},
      async pushTaskUpdate(_u, _a, _c, resourceID, _task, ref, patch, signal) {
        assert(ref);
        assert.equal(resourceID, nativeID); assert.equal(ref.etag, '"v1"'); assert.deepEqual(patch, { title: "Accepted title" });
        await ref.beforeMutation?.(); writes++; lastSignal = signal;
        remote = { ref: { externalTaskId: nativeID, etag: '"v2"' }, projection: target };
        await afterWrite?.(); return remote.ref;
      },
      async pushTaskCreate() { assert.fail("Unexpected CREATE"); }, async pushTaskDelete() { assert.fail("Unexpected DELETE"); },
    } satisfies Partial<CalendarAdapter>;
    return { id, calendarID, taskID, mapping, source, nativeID, target, baseline,
      run: () => deliverTaskOutbox(id, () => adapter as unknown as CalendarAdapter, { timeoutMs: deadlineMs }),
      counters: () => ({ writes, reads }), afterWrite(fn: () => Promise<void>) { afterWrite = fn; } };
  }
  async function mappingFor(id: string) { return (await db.select().from(externalTasks).where(eq(externalTasks.id, id)))[0]!; }
  async function waitForAckLock() {
    for (let tries = 0; tries < 600; tries++) {
      const waiting = await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%external_tasks%' AND pid<>pg_backend_pid()");
      if (waiting.rowCount) return;
      await pause(10);
    }
    assert.fail("Task ACK did not reach its actual mapping lock");
  }
  try {
    await migrateDatabase();
    await db.insert(user).values({ id: owner, name: "Task ACK fixture", email: `${randomUUID()}@example.invalid` });
    {
      const f = await fixture(); assert.equal((await f.run())?.status, "completed");
      const mapping = await mappingFor(f.mapping.id); assert.equal(mapping.etag, '"v2"'); assert.deepEqual(mapping.projectionBaseline, f.target);
      const task = (await db.select().from(tasks).where(eq(tasks.id, f.taskID)))[0]!;
      assert.equal(task.status, "in-process"); assert.equal(task.due?.toISOString(), "2026-10-26T14:45:00.000Z"); assert.equal(task.priority, 2);
      assert.deepEqual(f.counters(), { reads: 2, writes: 1 }); passed++; console.log("Task ACK delivery PG: ordinary-update-keeps-richer-canonical-fields: PASS");
    }
    {
      const f = await fixture(), lock = await observer.connect(); let delivery: ReturnType<typeof f.run> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM external_tasks WHERE id=$1 FOR UPDATE", [f.mapping.id]);
        delivery = f.run(); await waitForAckLock(); assert(expire); expire();
        assert.equal(lastSignal?.aborted, true); await lock.query("COMMIT");
        const result = await delivery; assert.equal(result?.status, "unconfirmed"); assert.equal(result?.uncertain, true);
        assert.deepEqual(result?.resultRef, { externalTaskId: f.nativeID, etag: '"v2"' });
        assert.deepEqual(result?.remoteSnapshot, f.target, "Rejected local adoption retains the exact observed ref/projection pair");
        const mapping = await mappingFor(f.mapping.id); assert.equal(mapping.etag, '"v1"'); assert.deepEqual(mapping.projectionBaseline, f.baseline);
        await pause(20); assert.equal((await mappingFor(f.mapping.id)).etag, '"v1"'); assert.equal(f.counters().writes, 1);
        await db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, f.id));
        assert.equal((await f.run())?.status, "completed"); assert.equal(f.counters().writes, 1, "Recovery must observe the achieved patch without another write");
        passed++; console.log("Task ACK delivery PG: deadline-during-ACK-lock-rolls-back-and-recovers-read-only: PASS");
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await delivery?.catch(() => {}); }
    }
    {
      const f = await fixture();
      f.afterWrite(async () => {
        await upsertExternalTask("google", owner, f.calendarID, f.source.externalCalendarID, f.nativeID, {
          title: "New inbound content", description: null, status: "needs-action", start: null, due: new Date("2026-10-26T00:00:00Z"),
          isAllDay: true, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null,
        }, '"v3"', null, undefined, { sourceID: f.source.id, accountID: owner, providerAccessRevision: f.source.providerAccessRevision },
        { ...f.target, title: "New inbound content" });
      });
      const result = await f.run(); assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "task-provider-conflict");
      assert.equal(result?.uncertain, true); assert.deepEqual(result?.resultRef, { externalTaskId: f.nativeID, etag: '"v2"' });
      assert.deepEqual(result?.remoteSnapshot, f.target); assert.equal((await mappingFor(f.mapping.id)).etag, '"v3"');
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, f.taskID)))[0]!.title, "Accepted title");
      assert.equal(f.counters().writes, 1); passed++; console.log("Task ACK delivery PG: actual-inbound-mapping-wins-with-historical-response-retained: PASS");
    }
    {
      const f = await fixture();
      let committed!: () => void, release!: () => void;
      const didCommit = new Promise<void>(resolve => { committed = resolve; });
      const reply = new Promise<void>(resolve => { release = resolve; });
      const pending = new WeakSet<Client>();
      const original = Client.prototype.query;
      const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        const values = args[0]?.values ?? args[1];
        if (typeof text === "string" && /^update "external_tasks"/i.test(text) && Array.isArray(values) && values.includes(f.mapping.id)) pending.add(this);
        const result = Reflect.apply(original, this, args);
        if (typeof text === "string" && text.trim().toLowerCase() === "commit" && pending.has(this)) {
          pending.delete(this);
          // Forward the actual SQL unchanged; delay only the already committed
          // client's reply so the attempt timeout races with stored truth.
          return Promise.resolve(result).then(async value => { committed(); await reply; return value; });
        }
        return result;
      });
      let operation: ReturnType<typeof f.run> | undefined;
      try {
        operation = f.run();
        await Promise.race([didCommit, pause(10_000, undefined, { ref: false }).then(() => { throw new Error("ACK COMMIT was not observed"); })]);
        assert.equal((await getTaskOutbox(f.id))?.status, "completed"); assert(expire); expire();
        const result = await operation; assert.equal(result?.status, "completed"); assert.equal(result?.errorCode, null);
        release(); await pause(20); assert.equal((await getTaskOutbox(f.id))?.status, "completed");
        assert.equal((await mappingFor(f.mapping.id)).etag, '"v2"');
        passed++; console.log("Task ACK delivery PG: real-COMMIT-wins-timeout-before-client-reply: PASS");
      } finally { release(); query.mock.restore(); await operation?.catch(() => {}); }
    }
    console.log(`Task ACK delivery PostgreSQL: ${passed} cases passed`);
  } finally {
    timer.mock.restore(); await observer.end(); await db.$client.end();
    try { await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); } finally { await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
