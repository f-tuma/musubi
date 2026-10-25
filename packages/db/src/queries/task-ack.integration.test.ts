import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { TaskSchema } from "@musubi/types";
import type { TaskOutboxRow } from "./task-outbox";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Task ACK characterization requires a disposable test database");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl, "Explicit disposable PostgreSQL URL required");
  const databaseName = `task_ack_${randomUUID().replaceAll("-", "")}`, databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let created = false, closeDb: (() => Promise<void>) | undefined, observer: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    process.env.DATABASE_URL = databaseUrl.href;
    const { db, user, account, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      claimTaskOutbox, finishTaskOutbox, setTaskOutboxProjection, acceptTaskOutboxDelivery, upsertExternalTask,
      admitTaskOperationInTransaction, decodeTaskOutboxOperation, getTaskOutboxPredecessorEvidence } = await import("..");
    closeDb = () => db.$client.end();
    const { migrateDatabase } = await import("../migrate");
    const { config } = await import("@musubi/config");
    const pool = observer = new Pool({ connectionString: databaseUrl.href, max: 3 });
    const owner = `task-ack-owner:${randomUUID()}`;
    const baseline = { title: "Original native title", notes: null, status: "needsAction", due: "2026-10-26T00:00:00.000Z" };
    const selected = process.argv[2] ?? "all", inventory: string[] = [];
    let passed = 0;
    const json = (value: unknown) => JSON.parse(JSON.stringify(value));
    async function run(id: string, body: () => Promise<void>) {
      inventory.push(id); if (selected !== "all" && selected !== id) return;
      await body(); passed++; console.log(`Task ACK PostgreSQL: ${id}: PASS`);
    }
    async function fixture(options: { pinned?: boolean; legacyNull?: boolean; legacyNoBaseline?: boolean; caldav?: boolean; capturedUid?: string; mappingUid?: string } = {}) {
      const calendarID = randomUUID(), taskID = randomUUID(), id = randomUUID(), nativeID = `native-${randomUUID()}`;
      await db.insert(calendars).values({ id: calendarID, creatorID: owner, name: "Owned task home", color: "#112233" });
      await db.insert(calendarMembers).values({ calendarID, userID: owner, role: "owner" });
      const provider = options.caldav ? "caldav" : "google";
      const [source] = await db.insert(externalCalendars).values({ calendarID, provider, userID: owner, accountID: owner, externalCalendarID: options.caldav ? `https://fixture.example.test/${calendarID}/` : `musubi-google-task-list:${calendarID}`, supportsTasks: true, supportsEvents: false }).returning();
      const [task] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID, originCalendarID: calendarID, title: "Richer canonical title", status: "in-process", due: new Date("2026-10-26T14:45:00.000Z"), priority: 2 }).returning();
      await db.insert(calendarTasks).values({ taskID, calendarID });
      const [mapping] = await db.insert(externalTasks).values({ provider, taskID, calendarID, externalCalendarID: source.externalCalendarID, externalCalendarLinkID: source.id, accountID: owner, providerAccessRevision: source.providerAccessRevision, externalTaskID: nativeID, etag: '\"v1\"', icalUid: options.mappingUid ?? null, projectionBaseline: options.legacyNull ? null : baseline, acceptedRevision: 1 }).returning();
      const intent = { id, actorID: owner, mutationID: randomUUID(), position: 0, taskID, calendarID, externalCalendarLinkID: source.id, provider, userID: owner, accountID: owner, externalCalendarID: source.externalCalendarID, providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, externalTaskID: nativeID, expectedEtag: '\"v1\"', icalUid: options.capturedUid ?? null, action: "update" as const,
        payload: { task: TaskSchema.parse({ ...task, calendarIDs: [calendarID] }), ...(options.legacyNoBaseline ? {} : { projectionBaseline: options.legacyNull ? null : baseline }) } };
      const enabled = config.api.syncOperationV1EncoderEnabled;
      let payload = intent.payload as TaskOutboxRow["payload"];
      try {
        if (options.pinned) { config.api.syncOperationV1EncoderEnabled = true; payload = await db.transaction(tx => admitTaskOperationInTransaction(tx, intent.payload.task, intent, null)); }
      } finally { config.api.syncOperationV1EncoderEnabled = enabled; }
      await db.insert(taskOutbox).values({ ...intent, revision: 1, payload });
      const claim = await claimTaskOutbox(id); assert(claim?.leaseToken);
      const evidence = { ref: { externalTaskId: nativeID, etag: '\"v2\"', icalUid: options.mappingUid ?? null }, projection: { ...baseline, title: "Verified dispatched title" } as Record<string, unknown> };
      return { calendarID, taskID, source, mapping, claim, evidence };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const oldRef = (f: Fixture) => ({ externalTaskId: f.mapping.externalTaskID, etag: '\"v1\"', icalUid: null });
    const mapping = async (f: Fixture) => (await db.select().from(externalTasks).where(eq(externalTasks.id, f.mapping.id)))[0];
    const receipt = async (id: string) => (await db.select().from(taskOutbox).where(eq(taskOutbox.id, id)))[0]!;
    async function assertOriginal(f: Fixture) {
      assert.equal((await mapping(f))?.etag, '\"v1\"'); assert.deepEqual((await mapping(f))?.projectionBaseline, f.mapping.projectionBaseline);
      const row = await receipt(f.claim.id); assert.equal(row.status, "attempting"); assert.equal(row.resultRef, null);
    }
    async function waitForMappingLock() {
      for (let i = 0; i < 200; i++) {
        const result = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS waiting", ['%"external_tasks"%for update%']);
        if (result.rows[0].waiting) return; await pause(10);
      }
      assert.fail("Actual task ACK did not wait on its mapping row lock");
    }
    async function withMappingLock(f: Fixture, body: (release: () => Promise<void>) => Promise<void>) {
      const lock = await pool.connect();
      try { await lock.query("BEGIN"); await lock.query("SELECT id FROM external_tasks WHERE id=$1 FOR UPDATE", [f.mapping.id]); await body(async () => { await lock.query("COMMIT"); }); }
      finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
    }
    async function inbound(f: Fixture, etag: string, projection: Record<string, unknown>) {
      await upsertExternalTask("google", owner, f.calendarID, f.source.externalCalendarID, f.mapping.externalTaskID, { title: String(projection.title), description: null, status: "needs-action", start: null, due: new Date("2026-10-26T00:00:00.000Z"), isAllDay: true, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null }, etag, null, undefined, { sourceID: f.source.id, accountID: owner, providerAccessRevision: f.source.providerAccessRevision }, projection);
    }
    async function successor(f: Fixture, predecessorID: string, action: "update" | "delete", revision: number, payload = f.claim.payload) {
      const id = randomUUID();
      await db.insert(taskOutbox).values({ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID: f.taskID, revision, predecessorID, calendarID: f.calendarID, externalCalendarLinkID: f.source.id, provider: "google", userID: owner, accountID: owner, externalCalendarID: f.source.externalCalendarID, providerAccessRevision: f.source.providerAccessRevision, retiredGeneration: 0, externalTaskID: f.mapping.externalTaskID, expectedEtag: '\"v1\"', action, payload });
      return id;
    }
    await migrateDatabase();
    await db.insert(user).values({ id: owner, name: "Synthetic task ACK owner", email: `${owner}@example.test` });
    const [oauth] = await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: owner, scope: "https://www.googleapis.com/auth/tasks", syncStatus: "active", refreshToken: "fixture.no-http" }).returning();

    await run("inbound", async () => {
      const f = await fixture();
      await inbound(f, '\"v3\"', { ...baseline, title: "Newer inbound title" });
      const incoming = await mapping(f); assert.equal(incoming.etag, '\"v3\"');
      const [canonical] = await db.select().from(tasks).where(eq(tasks.id, f.taskID));
      assert.equal(canonical.title, "Richer canonical title"); assert.equal(canonical.status, "in-process"); assert.equal(canonical.due!.toISOString(), "2026-10-26T14:45:00.000Z"); assert.equal(canonical.priority, 2);
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), false);
      assert.equal((await mapping(f)).etag, '\"v3\"'); assert.deepEqual((await mapping(f)).projectionBaseline, incoming.projectionBaseline);
      const row = await receipt(f.claim.id); assert.equal(row.status, "conflict"); assert.equal(row.errorCode, "task-provider-conflict"); assert.equal(row.uncertain, true); assert.deepEqual(row.resultRef, f.evidence.ref); assert.deepEqual(row.remoteSnapshot, f.evidence.projection);
    });
    await run("lease", async () => {
      const f = await fixture(); await withMappingLock(f, async release => {
        await db.update(taskOutbox).set({ leaseUntil: sql`clock_timestamp()+interval '2 seconds'` }).where(eq(taskOutbox.id, f.claim.id));
        const acknowledgement = acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence); await waitForMappingLock();
        while (!(await pool.query("SELECT clock_timestamp()>lease_until AS expired FROM task_outbox WHERE id=$1", [f.claim.id])).rows[0].expired) await pause(10);
        await release(); assert.equal(await acknowledgement, false); await assertOriginal(f);
      });
    });
    await run("cancel", async () => {
      const f = await fixture(), controller = new AbortController(), reason = new Error("Synthetic ACK cancellation");
      await withMappingLock(f, async release => {
        const acknowledgement = acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence, undefined, controller.signal);
        const rejected = assert.rejects(acknowledgement, error => error === reason);
        await waitForMappingLock(); controller.abort(reason); await release(); await rejected; await assertOriginal(f);
      });
    });
    await run("snapshot", async () => {
      const f = await fixture(), other = await fixture(), row = structuredClone(f.claim), evidence = structuredClone(f.evidence), expected = oldRef(f);
      await withMappingLock(f, async release => {
        const acknowledgement = acceptTaskOutboxDelivery(row, row.leaseToken!, evidence, undefined, undefined, expected);
        await waitForMappingLock(); row.id = other.claim.id; row.taskID = other.taskID; row.calendarID = other.calendarID; row.accountID = "other-account";
        evidence.ref.externalTaskId = other.mapping.externalTaskID; evidence.ref.etag = '\"mutated\"'; evidence.projection.title = "Mutated evidence"; expected.etag = '\"mutated\"';
        await release(); assert.equal(await acknowledgement, true);
      });
      assert.equal((await mapping(f)).etag, '\"v2\"'); assert.equal((await mapping(f)).externalTaskID, f.mapping.externalTaskID); assert.deepEqual((await mapping(f)).projectionBaseline, f.evidence.projection); await assertOriginal(other);
    });
    await run("legacy-null-baseline", async () => {
      const f = await fixture({ legacyNull: true });
      assert.equal(await setTaskOutboxProjection(f.claim.id, f.claim.leaseToken!, { version: 1, projection: f.evidence.projection, patch: { title: f.evidence.projection.title }, baseline }), true);
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence, undefined, undefined, oldRef(f)), true);
      assert.deepEqual((await mapping(f)).projectionBaseline, f.evidence.projection);
    });
    await run("observed-json-echo", async () => {
      const f = await fixture(); f.evidence.projection.due = new Date("2026-10-26T00:00:00.000Z"); f.evidence.projection.omitted = undefined;
      await inbound(f, '\"v2\"', f.evidence.projection);
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), true);
      assert.deepEqual((await mapping(f)).projectionBaseline, json(f.evidence.projection)); assert.deepEqual((await receipt(f.claim.id)).remoteSnapshot, json(f.evidence.projection));
    });
    await run("legacy-caldav-uncaptured-uid", async () => {
      const f = await fixture({ caldav: true, mappingUid: "retained-resource-uid" });
      assert.equal(decodeTaskOutboxOperation(f.claim).kind, "legacy-v0");
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence, undefined, undefined, oldRef(f)), true);
      assert.equal((await mapping(f)).icalUid, "retained-resource-uid"); assert.equal((await mapping(f)).etag, '\"v2\"');
    });
    await run("caldav-captured-uid-conflict", async () => {
      const f = await fixture({ caldav: true, capturedUid: "captured-resource-uid", mappingUid: "captured-resource-uid" });
      f.evidence.ref.icalUid = "different-resource-uid";
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), false);
      assert.equal((await mapping(f)).icalUid, "captured-resource-uid"); assert.equal((await mapping(f)).etag, '\"v1\"'); assert.equal((await receipt(f.claim.id)).status, "conflict");
    });
    await run("predecessor-paired-baseline", async () => {
      const f = await fixture(), nextID = await successor(f, f.claim.id, "update", 2);
      await db.update(tasks).set({ revision: 2, title: "Newer canonical revision" }).where(eq(tasks.id, f.taskID));
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), true);
      assert.equal((await db.select().from(tasks).where(eq(tasks.id, f.taskID)))[0].title, "Newer canonical revision");
      const next = await claimTaskOutbox(nextID); assert(next?.leaseToken);
      assert.deepEqual(await getTaskOutboxPredecessorEvidence(next), { ref: f.evidence.ref, projectionBaseline: f.evidence.projection });
      const nextEvidence = { ref: { ...f.evidence.ref, etag: '\"v3\"' }, projection: { ...f.evidence.projection, title: "Second write" } };
      assert.equal(await acceptTaskOutboxDelivery(next, next.leaseToken, nextEvidence, undefined, undefined, f.evidence.ref), true);
      assert.equal((await mapping(f)).etag, '\"v3\"'); assert.equal((await mapping(f)).acceptedRevision, 2);
    });
    await run("predecessor-stale-caller-capture", async () => {
      const f = await fixture(), nextID = await successor(f, f.claim.id, "update", 2);
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), true);
      const next = await claimTaskOutbox(nextID); assert(next?.leaseToken);
      const nextEvidence = { ref: { ...f.evidence.ref, etag: '\"v3\"' }, projection: { ...f.evidence.projection, title: "Accepted second write" } };
      assert.equal(await acceptTaskOutboxDelivery(next, next.leaseToken, nextEvidence, undefined, undefined, oldRef(f)), false);
      assert.equal((await mapping(f)).etag, '\"v2\"'); assert.deepEqual((await receipt(nextID)).resultRef, nextEvidence.ref); assert.equal((await receipt(nextID)).status, "conflict");
    });
    for (const mode of ["deleted", "detached"] as const) await run(`historical-${mode}-lineage`, async () => {
      const f = await fixture({ legacyNoBaseline: true });
      await setTaskOutboxProjection(f.claim.id, f.claim.leaseToken!, { version: 1, projection: f.evidence.projection, patch: { title: f.evidence.projection.title }, baseline });
      const skippedID = await successor(f, f.claim.id, "update", 2), deleteID = await successor(f, skippedID, "delete", 3);
      if (mode === "deleted") await db.update(tasks).set({ revision: 3, deletedAt: new Date() }).where(eq(tasks.id, f.taskID));
      else await db.delete(calendarTasks).where(and(eq(calendarTasks.taskID, f.taskID), eq(calendarTasks.calendarID, f.calendarID)));
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), true);
      assert.equal((await mapping(f)).etag, '\"v1\"', "Historical ACK must not resurrect/advance a removed attachment");
      const skipped = await claimTaskOutbox(skippedID); assert(skipped?.leaseToken); assert.equal(await finishTaskOutbox(skippedID, skipped.leaseToken, "not-needed"), true);
      const deletion = await claimTaskOutbox(deleteID); assert(deletion?.leaseToken);
      assert.deepEqual((await getTaskOutboxPredecessorEvidence(deletion)).ref, f.evidence.ref);
      assert.equal(await acceptTaskOutboxDelivery(deletion, deletion.leaseToken, null, f.evidence.ref, undefined, f.evidence.ref), true);
      assert.equal(await mapping(f), undefined); assert.deepEqual((await receipt(f.claim.id)).remoteSnapshot, f.evidence.projection); assert.equal((await receipt(deleteID)).status, "completed");
    });
    await run("historical-lineage-rejects-newer-mapping", async () => {
      const f = await fixture(), deleteID = await successor(f, f.claim.id, "delete", 2);
      await db.delete(calendarTasks).where(and(eq(calendarTasks.taskID, f.taskID), eq(calendarTasks.calendarID, f.calendarID)));
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), true);
      await db.update(externalTasks).set({ etag: '\"v3\"', projectionBaseline: { ...baseline, title: "Newer scoped native version" } }).where(eq(externalTasks.id, f.mapping.id));
      const deletion = await claimTaskOutbox(deleteID); assert(deletion?.leaseToken);
      assert.equal(await acceptTaskOutboxDelivery(deletion, deletion.leaseToken, null, f.evidence.ref, undefined, f.evidence.ref), false);
      assert.equal((await mapping(f)).etag, '\"v3\"'); assert.equal((await receipt(deleteID)).status, "conflict");
    });
    await run("pinned-capture", async () => {
      const f = await fixture({ pinned: true }), decoded = decodeTaskOutboxOperation(f.claim); assert.equal(decoded.kind, "pinned-v1");
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence, undefined, undefined, oldRef(f)), true);
      assert.equal((await receipt(f.claim.id)).status, "completed");
    });
    await run("pinned-connection-aba", async () => {
      const f = await fixture({ pinned: true }); assert.equal(decodeTaskOutboxOperation(f.claim).kind, "pinned-v1");
      await db.update(account).set({ syncStatus: "disabled", syncReadGeneration: 1 }).where(eq(account.id, oauth.id));
      await db.update(account).set({ syncStatus: "active", syncReadGeneration: 2 }).where(eq(account.id, oauth.id));
      assert.equal(await acceptTaskOutboxDelivery(f.claim, f.claim.leaseToken!, f.evidence), false);
      assert.equal((await mapping(f)).etag, '\"v1\"'); const row = await receipt(f.claim.id); assert.equal(row.status, "blocked"); assert.equal(row.errorCode, "operation-source-changed"); assert.deepEqual(row.resultRef, f.evidence.ref); assert.deepEqual(row.remoteSnapshot, f.evidence.projection);
    });
    assert(selected === "all" || inventory.includes(selected), `Unknown task ACK fixture case: ${selected}`);
    console.log(`Task ACK PostgreSQL: ${passed} cases passed`);
  } finally {
    await observer?.end(); await closeDb?.();
    try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); } finally { await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
