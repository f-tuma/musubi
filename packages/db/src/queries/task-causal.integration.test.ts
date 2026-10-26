import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { Pool } from "pg";
import { setTimeout as pause } from "node:timers/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";

/** Actual durable admission/claim/ACK and resolution helpers in a nonce DB.
 * Tampered persisted history is an explicit storage-boundary adversary. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test"); const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const name = `task_causal_db_${randomUUID().replace(/-/g, "")}`, url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`); process.env.DATABASE_URL = url.href;
  const pools = new Set<Pool>(), connectOriginal = Pool.prototype.connect;
  const connect = mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]): any { if (this !== admin) pools.add(this); return Reflect.apply(connectOriginal, this, args); });
  try {
    const { db, user, account, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      appendTaskOutbox, claimTaskOutbox, getTaskOutbox, finishTaskOutbox, acceptTaskOutboxDelivery, decodeTaskOutboxOperation,
      prepareTaskOutboxPredecessorResolution, assertTaskOutboxPredecessorResolution, setTaskOutboxCausalProjection,
      getTaskOutboxPredecessorEvidence, TaskOutboxPredecessorError } = await import("..");
    pools.add(db.$client); const { migrateDatabase } = await import("../migrate"); await migrateDatabase();
    const observer = new Pool({ connectionString: url.href, max: 3 }); pools.add(observer);
    async function lockWait() {
      for (let i = 0; i < 600; i++) {
        if ((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()")).rowCount) return;
        await pause(10);
      }
      throw new Error("Actual causal DB lock wait was not observed");
    }
    const baseline = { title: "Before", notes: "Keep", status: "needsAction", due: null }, target = { ...baseline, title: "Accepted successor" };
    const fixture = async (options: { action?: "update" | "delete"; legacy?: boolean; nullBaseline?: boolean; noTask?: boolean } = {}) => {
      const owner = `causal-db:${randomUUID()}`, otherUser = `causal-db-other:${randomUUID()}`, calendarID = randomUUID(), taskID = randomUUID(), accountID = randomUUID(), createID = randomUUID(), id = randomUUID();
      const ids = [createID, id];
      await db.insert(user).values([owner, otherUser].map(id => ({ id, name: "Causal DB", email: `${randomUUID()}@example.invalid` })));
      await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: accountID, scope: "https://www.googleapis.com/auth/tasks",
        accessToken: "causal.db.access", refreshToken: "causal.db.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      await db.insert(calendars).values({ id: calendarID, creatorID: owner, name: "Causal DB", color: "#112233" });
      await db.insert(calendarMembers).values({ calendarID, userID: owner, role: "owner" });
      const [source] = await db.insert(externalCalendars).values({ calendarID, provider: "google", userID: owner, accountID,
        externalCalendarID: "musubi-google-task-list:causal-db-list", supportsEvents: false, supportsTasks: true }).returning();
      const [stored] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID, originCalendarID: calendarID, title: "Before", description: "Keep", status: "in-process", priority: 2 }).returning();
      await db.insert(calendarTasks).values({ calendarID, taskID }); const task = TaskSchema.parse({ ...stored, calendarIDs: [calendarID] });
      const intent = (operation: "create" | "update" | "delete", operationID: string, value = task) => ({ id: operationID, actorID: owner, mutationID: randomUUID(), position: 0, taskID, calendarID,
        externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID, externalCalendarID: source.externalCalendarID, externalTaskID: null, expectedEtag: null,
        providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: operation, payload: { task: value, projectionBaseline: null } });
      await db.transaction(tx => appendTaskOutbox(tx, task, [intent("create", createID)]));
      const next = { ...task, title: "Accepted successor", revision: 2 }; await db.update(tasks).set({ title: next.title, revision: 2 }).where(eq(tasks.id, taskID));
      await db.transaction(tx => appendTaskOutbox(tx, next, [intent(options.action ?? "update", id, next)]));
      if (options.legacy) {
        const original = await getTaskOutbox(createID); assert(original);
        await db.update(taskOutbox).set({ payload: { task: original.payload.task, projectionBaseline: null } }).where(eq(taskOutbox.id, createID));
      }
      const created = await claimTaskOutbox(createID); assert(created?.leaseToken);
      const ref = { externalTaskId: "causal-db-native", etag: '"v1"', icalUid: null };
      if (options.noTask || options.nullBaseline) await finishTaskOutbox(createID, created.leaseToken, options.noTask ? "not-needed" : "completed", null,
        { uncertain: false, resultRef: options.noTask ? null : ref, remoteSnapshot: null });
      else assert.equal(await acceptTaskOutboxDelivery(created, created.leaseToken, { ref, projection: baseline }), true);
      let claim = await claimTaskOutbox(id); assert(claim?.leaseToken);
      let token = claim.leaseToken;
      return { owner, otherUser, calendarID, taskID, id, createID, source, ids, get claim() { return claim!; }, get token() { return token; }, ref,
        prepare: () => prepareTaskOutboxPredecessorResolution(claim, token),
        async reclaim() { await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, id)); claim = await claimTaskOutbox(id); assert(claim?.leaseToken); token = claim.leaseToken; },
        row: () => getTaskOutbox(id),
        async cleanup() { await db.delete(taskOutbox).where(inArray(taskOutbox.id, ids)); await db.delete(user).where(inArray(user.id, [owner, otherUser])); } };
    };
    const selected = process.argv[2] ?? "all", inventory: string[] = []; let passed = 0;
    async function run(id: string, body: () => Promise<void>) { inventory.push(id); if (selected !== "all" && selected !== id) return; await body(); passed++; console.log(`Task causal PostgreSQL: ${id}: PASS`); }
    for (const legacy of [false, true]) await run(legacy ? "mixed-legacy-profile" : "captured-resolution", async () => {
      const f = await fixture({ legacy }); try {
        const before = await f.row(), prepared = await f.prepare(); assert.equal(prepared.predecessorAddress.kind, "predecessor-task-reference");
        assert.equal(prepared.historyProfile, legacy ? "legacy-compatible" : "captured-v1"); assert.deepEqual(prepared.projectionBaseline, baseline);
        const after = await f.row(); assert(after); assert.equal(after.externalTaskID, null); assert.deepEqual(after.payload.operationEnvelope, before!.payload.operationEnvelope);
        assert(!Object.prototype.hasOwnProperty.call(after.payload.dispatchResolution, "attemptId"));
        assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), true);
      } finally { await f.cleanup(); }
    });
    const scopes = { taskID: () => randomUUID(), calendarID: () => randomUUID(), externalCalendarLinkID: () => randomUUID(), provider: () => "microsoft",
      userID: (f: Awaited<ReturnType<typeof fixture>>) => f.otherUser, accountID: () => "foreign-account", externalCalendarID: () => "foreign-list", providerAccessRevision: () => 1, retiredGeneration: () => 1 };
    for (const [field, value] of Object.entries(scopes)) await run(`scope-${field}`, async () => {
      const f = await fixture(); try {
        await db.update(taskOutbox).set({ [field]: value(f) }).where(eq(taskOutbox.id, f.createID));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError); await assert.rejects(() => getTaskOutboxPredecessorEvidence(f.claim), TaskOutboxPredecessorError);
        assert.equal((await f.row())!.payload.dispatchResolution, undefined);
      } finally { await f.cleanup(); }
    });
    for (const field of ["connectionId", "connectionGeneration"] as const) await run(`physical-${field}`, async () => {
      const f = await fixture(); try {
        const prior = await getTaskOutbox(f.createID); assert(prior);
        await db.update(taskOutbox).set({ payload: { ...prior.payload, operationCapture: { ...prior.payload.operationCapture as object,
          [field]: field === "connectionId" ? randomUUID() : 1 } } }).where(eq(taskOutbox.id, f.createID));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError);
      } finally { await f.cleanup(); }
    });
    for (const field of ["connectionId", "connectionGeneration", "malformed"] as const) await run(`legacy-present-capture-${field}`, async () => {
      const f = await fixture({ legacy: true }); try {
        const prior = await getTaskOutbox(f.createID); assert(prior);
        const capture = field === "malformed" ? { version: 1 } : { ...f.claim.payload.operationCapture as object,
          [field]: field === "connectionId" ? randomUUID() : 1 };
        await db.update(taskOutbox).set({ payload: { ...prior.payload, operationCapture: capture } }).where(eq(taskOutbox.id, f.createID));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError);
        await assert.rejects(() => getTaskOutboxPredecessorEvidence(f.claim), TaskOutboxPredecessorError);
        assert.equal((await f.row())!.payload.dispatchResolution, undefined);
      } finally { await f.cleanup(); }
    });
    await run("legacy-present-valid-capture", async () => {
      const f = await fixture({ legacy: true }); try {
        const prior = await getTaskOutbox(f.createID); assert(prior);
        await db.update(taskOutbox).set({ payload: { ...prior.payload, operationCapture: f.claim.payload.operationCapture } }).where(eq(taskOutbox.id, f.createID));
        assert.equal((await f.prepare()).historyProfile, "legacy-compatible", "Present capture does not invent a missing v1 envelope");
      } finally { await f.cleanup(); }
    });
    for (const mode of ["missing", "cycle", "pending", "foreign-behind-response"] as const) await run(`full-chain-${mode}`, async () => {
      const f = await fixture(); try {
        const prior = await getTaskOutbox(f.createID); assert(prior); const envelope = SyncOperationEnvelopeSchema.parse(prior.payload.operationEnvelope);
        if (mode === "pending") await db.update(taskOutbox).set({ status: "pending" }).where(eq(taskOutbox.id, f.createID));
        else {
          const next = mode === "cycle" ? f.createID : randomUUID();
          if (mode === "foreign-behind-response") { f.ids.push(next); await db.insert(taskOutbox).values({ ...prior, id: next, taskID: randomUUID(), mutationID: randomUUID(),
            predecessorID: null, payload: { task: prior.payload.task }, resultRef: null, remoteSnapshot: null, status: "not-needed" }); }
          await db.update(taskOutbox).set({ predecessorID: next, payload: { ...prior.payload, operationEnvelope: { ...envelope, predecessorOperationId: next } } }).where(eq(taskOutbox.id, f.createID));
        }
        await assert.rejects(f.prepare); assert.equal((await f.row())!.payload.dispatchResolution, undefined);
      } finally { await f.cleanup(); }
    });
    await run("saved-baseline-and-mask-tamper-before-resolution", async () => {
      const f = await fixture(); try {
        const row = await f.row(); assert(row); const fakeBaseline = { ...baseline, notes: "Other accepted notes" };
        await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: { version: 1, projection: target, baseline: fakeBaseline, patch: { title: target.title, notes: target.notes } } } }).where(eq(taskOutbox.id, f.id));
        assert.equal(decodeTaskOutboxOperation((await f.row())!).kind, "pinned-v1", "The forged mask is internally coherent but lacks historical authority");
        await assert.rejects(f.prepare, TaskOutboxPredecessorError);
      } finally { await f.cleanup(); }
    });
    await run("original-claim-drift-before-first-prepare", async () => {
      const f = await fixture(); try {
        await db.update(taskOutbox).set({ actorID: f.otherUser, position: 1 }).where(eq(taskOutbox.id, f.id));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError, "Fresh lookup cannot replace the immutable original claimed admission");
        assert.equal((await f.row())!.payload.dispatchResolution, undefined);
      } finally { await f.cleanup(); }
    });
    for (const part of ["mutation", "task", "list", "capture", "action"] as const) await run(`original-claim-${part}-before-first-prepare`, async () => {
      const f = await fixture({ action: "delete", noTask: true }); try {
        const row = await f.row(); assert(row); const envelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope);
        const payload = { ...row.payload }; let changes: Partial<typeof row> = {};
        if (part === "mutation") { const command = randomUUID(); changes = { mutationID: command }; payload.operationEnvelope = { ...envelope, commandId: command }; }
        if (part === "task") payload.task = { ...payload.task, title: "Changed before first prepare" };
        if (part === "list") { changes = { externalCalendarID: "musubi-google-task-list:substituted" }; payload.operationEnvelope = { ...envelope, locator: { ...envelope.locator, collectionId: changes.externalCalendarID! } }; }
        if (part === "capture") payload.operationCapture = { ...payload.operationCapture as object, connectionGeneration: 10 };
        if (part === "action") { changes = { action: "update" }; payload.operationEnvelope = { ...envelope, operation: { ...envelope.operation, action: "update" },
          nativePlan: { ...envelope.nativePlan, data: { planKind: "json-body", body: envelope.admittedProjection.data } } }; }
        await db.update(taskOutbox).set({ ...changes, payload }).where(eq(taskOutbox.id, f.id));
        if (part !== "capture") assert.equal(decodeTaskOutboxOperation((await f.row())!).kind, "pinned-v1", "Coherent replacement remains a decodable different admission");
        await assert.rejects(f.prepare, TaskOutboxPredecessorError); assert.equal((await f.row())!.payload.dispatchResolution, undefined);
      } finally { await f.cleanup(); }
    });
    await run("original-claim-null-history-saved-mask-before-first-prepare", async () => {
      const f = await fixture({ legacy: true, nullBaseline: true }); try {
        const row = await f.row(); assert(row);
        const saved = { version: 1 as const, projection: target, baseline, patch: { title: target.title } };
        await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: saved } }).where(eq(taskOutbox.id, f.id));
        await f.reclaim();
        const claimed = await f.row(); assert(claimed);
        await db.update(taskOutbox).set({ payload: { ...claimed.payload, dispatchProjection: { ...saved, baseline: target, patch: {} } } }).where(eq(taskOutbox.id, f.id));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError, "NULL history cannot bless a different preexisting retry mask");
      } finally { await f.cleanup(); }
    });
    await run("original-claim-resolution-removal-before-first-prepare", async () => {
      const f = await fixture(); try {
        const prepared = await f.prepare(); await setTaskOutboxCausalProjection(f.claim, f.token, prepared.predecessorAddress, { version: 1, projection: target, baseline, patch: { title: target.title } });
        await f.reclaim(); const row = await f.row(); assert(row);
        const { dispatchProjection: _projection, dispatchResolution: _resolution, dispatchProjectionWitness: _witness, ...payload } = row.payload;
        await db.update(taskOutbox).set({ payload }).where(eq(taskOutbox.id, f.id));
        await db.update(taskOutbox).set({ resultRef: { ...f.ref, externalTaskId: "substituted-native-task" } }).where(eq(taskOutbox.id, f.createID));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError, "Removing claimed sidecars cannot reset a retry's address authority");
      } finally { await f.cleanup(); }
    });
    for (const part of ["dispatchProjection", "dispatchResolution", "dispatchProjectionWitness"] as const) for (const change of ["remove", "replace", "add"] as const) await run(`original-claim-${part}-${change}-before-first-prepare`, async () => {
      const f = await fixture(); try {
        if (change !== "add") {
          const prepared = await f.prepare(); await setTaskOutboxCausalProjection(f.claim, f.token, prepared.predecessorAddress, { version: 1, projection: target, baseline, patch: { title: target.title } });
          await f.reclaim();
        }
        const row = await f.row(); assert(row); const payload = { ...row.payload };
        if (change === "remove") delete payload[part];
        else if (part === "dispatchProjection") payload.dispatchProjection = { version: 1, projection: target, baseline: change === "add" ? baseline : target, patch: change === "add" ? { title: target.title } : {} };
        else if (part === "dispatchResolution") payload.dispatchResolution = null;
        else payload.dispatchProjectionWitness = "changed-witness";
        await db.update(taskOutbox).set({ payload }).where(eq(taskOutbox.id, f.id));
        await assert.rejects(f.prepare, TaskOutboxPredecessorError);
      } finally { await f.cleanup(); }
    });
    await run("first-prepare-old-claim-does-not-refresh-progress", async () => {
      const f = await fixture(); try {
        await f.prepare(); await assert.rejects(f.prepare, TaskOutboxPredecessorError, "One preparation per original runtime claim; reuse its proof");
        await f.reclaim(); assert.equal((await f.prepare()).predecessorAddress.kind, "predecessor-task-reference");
      } finally { await f.cleanup(); }
    });
    for (const nullBaseline of [false, true]) await run(nullBaseline ? "null-baseline-bound-once" : "projection-bound-once", async () => {
      const f = await fixture({ legacy: nullBaseline, nullBaseline }); try {
        const prepared = await f.prepare(), saved = { version: 1 as const, projection: target, baseline, patch: { title: target.title } };
        assert.deepEqual(await setTaskOutboxCausalProjection(f.claim, f.token, prepared.predecessorAddress, saved), saved);
        assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), true);
        const row = await f.row(); assert(row);
        await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: { ...saved, baseline: { ...baseline, notes: "Tampered" }, patch: { title: target.title, notes: target.notes } } } }).where(eq(taskOutbox.id, f.id));
        assert.equal(decodeTaskOutboxOperation((await f.row())!).kind, "pinned-v1");
        assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), false);
      } finally { await f.cleanup(); }
    });
    for (const part of ["ref", "baseline", "attempt", "sidecar"] as const) await run(`resolved-${part}-tamper`, async () => {
      const f = await fixture(); try {
        const prepared = await f.prepare();
        if (part === "attempt") {
          assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, { ...prepared.predecessorAddress, attemptId: randomUUID() }), false);
        } else if (part === "sidecar") {
          const row = await f.row(); assert(row);
          await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchResolution: { ...row.payload.dispatchResolution as object, witness: "different" } } }).where(eq(taskOutbox.id, f.id));
          assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), false);
        } else {
          await db.update(taskOutbox).set(part === "ref" ? { resultRef: { ...f.ref, etag: '"different"' } } : { remoteSnapshot: { ...baseline, notes: "different" } }).where(eq(taskOutbox.id, f.createID));
          assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), false);
        }
      } finally { await f.cleanup(); }
    });
    for (const location of ["ancestor", "successor"] as const) for (const field of ["actorID", "mutationID", "position", "task"] as const) await run(`resolved-${location}-${field}-tamper`, async () => {
      const f = await fixture({ legacy: true }); try {
        const prepared = await f.prepare(), id = location === "ancestor" ? f.createID : f.id;
        const row = await getTaskOutbox(id); assert(row);
        // Keep an intentionally v0 ancestor v0; on the v1 successor mutate the
        // corresponding envelope field too so this exercises the full witness.
        const payload = { ...row.payload };
        const envelope = payload.operationEnvelope ? SyncOperationEnvelopeSchema.parse(payload.operationEnvelope) : undefined;
        if (field === "task") payload.task = { ...payload.task!, title: "Changed immutable snapshot" };
        const changes = field === "task" ? {} : { [field]: field === "position" ? row.position + 1 : field === "actorID" ? f.otherUser : randomUUID() };
        if (envelope && field === "mutationID") payload.operationEnvelope = { ...envelope, commandId: changes[field] as string };
        await db.update(taskOutbox).set({ ...changes, payload }).where(eq(taskOutbox.id, id));
        if (location === "successor") await assert.rejects(() => assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), TaskOutboxPredecessorError);
        else assert.equal(await assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), false);
      } finally { await f.cleanup(); }
    });
    await run("ack-revalidates-full-baseline", async () => {
      const f = await fixture(); try {
        const prepared = await f.prepare(); await setTaskOutboxCausalProjection(f.claim, f.token, prepared.predecessorAddress, { version: 1, projection: target, baseline, patch: { title: target.title } });
        await db.update(taskOutbox).set({ remoteSnapshot: { ...baseline, notes: "Changed after dispatch" } }).where(eq(taskOutbox.id, f.createID));
        assert.equal(await acceptTaskOutboxDelivery(f.claim, f.token, { ref: { ...f.ref, etag: '"v2"' }, projection: target }, undefined, undefined, f.ref, prepared.predecessorAddress), false);
        const [mapping] = await db.select().from(externalTasks).where(eq(externalTasks.taskID, f.taskID)); assert.equal(mapping.etag, '"v1"'); assert.equal((await f.row())!.status, "conflict");
      } finally { await f.cleanup(); }
    });
    await run("no-resource-ack", async () => {
      const f = await fixture({ action: "delete", noTask: true }); try {
        const prepared = await f.prepare(); assert.equal(prepared.predecessorAddress.kind, "predecessor-no-task");
        assert.equal(await acceptTaskOutboxDelivery(f.claim, f.token, null, undefined, undefined, null, prepared.predecessorAddress), true);
        const completed = await f.row(); assert.equal(completed!.status, "completed"); assert.equal(completed!.resultRef, null); assert.equal(completed!.remoteSnapshot, null);
      } finally { await f.cleanup(); }
    });
    for (const operation of ["prepare", "projection"] as const) for (const interruption of ["abort", "expiry"] as const) await run(`${operation}-wait-${interruption}-rollback`, async () => {
      const f = await fixture(), lock = await observer.connect(), controller = new AbortController();
      let pending: Promise<unknown> | undefined;
      try {
        const prepared = operation === "projection" ? await f.prepare() : undefined;
        const before = await f.row(); await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [f.taskID]);
        pending = operation === "prepare" ? prepareTaskOutboxPredecessorResolution(f.claim, f.token, controller.signal) :
          setTaskOutboxCausalProjection(f.claim, f.token, prepared!.predecessorAddress, { version: 1, projection: target, baseline, patch: { title: target.title } }, controller.signal);
        // Attach rejection handling before releasing the actual SQL wait.
        const rejected = assert.rejects(pending); await lockWait();
        if (interruption === "abort") controller.abort(); else await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, f.id));
        await lock.query("COMMIT"); await rejected;
        const after = await f.row(); assert.deepEqual(after!.payload, before!.payload, "No provisional sidecar/mask may survive a failed settlement");
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await pending?.catch(() => {}); await f.cleanup(); }
    });
    await run("projection-input-copied-before-wait", async () => {
      const f = await fixture(), lock = await observer.connect(); let pending: Promise<unknown> | undefined;
      try {
        const prepared = await f.prepare(), input = { version: 1 as const, projection: { ...target }, baseline: { ...baseline }, patch: { title: target.title } };
        await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [f.taskID]);
        pending = setTaskOutboxCausalProjection(f.claim, f.token, prepared.predecessorAddress, input); await lockWait();
        input.projection.title = "Caller changed"; input.baseline.title = "Caller changed"; input.patch.title = "Caller changed";
        await lock.query("COMMIT"); await pending; assert.deepEqual((await f.row())!.payload.dispatchProjection, { version: 1, projection: target, baseline, patch: { title: target.title } });
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await pending?.catch(() => {}); await f.cleanup(); }
    });
    for (const operation of ["prepare", "assert", "projection"] as const) for (const changed of ["caller", "stored"] as const) await run(`${operation}-original-claim-${changed}-changes-during-wait`, async () => {
      const f = await fixture(), lock = await observer.connect(); let pending: Promise<unknown> | undefined;
      try {
        const prepared = operation === "prepare" ? undefined : await f.prepare(), input = structuredClone(f.claim);
        await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [f.taskID]);
        pending = operation === "prepare" ? prepareTaskOutboxPredecessorResolution(input, f.token) : operation === "assert" ?
          assertTaskOutboxPredecessorResolution(input, f.token, prepared!.predecessorAddress) :
          setTaskOutboxCausalProjection(input, f.token, prepared!.predecessorAddress, { version: 1, projection: target, baseline, patch: { title: target.title } });
        const result = pending.then(value => ({ value }), error => ({ error })); await lockWait();
        if (changed === "caller") { input.actorID = f.otherUser; input.payload.task.title = "Caller changed during wait"; }
        else await db.update(taskOutbox).set({ actorID: f.otherUser }).where(eq(taskOutbox.id, f.id));
        await lock.query("COMMIT"); const settled = await result;
        if (changed === "stored") assert("error" in settled && settled.error instanceof TaskOutboxPredecessorError);
        else { assert(!("error" in settled)); if (operation === "assert") assert.equal(settled.value, true); }
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await pending?.catch(() => {}); await f.cleanup(); }
    });
    await run("prepare-claimed-sidecars-change-during-lock-wait", async () => {
      const f = await fixture({ legacy: true, nullBaseline: true }), lock = await observer.connect(); let pending: Promise<unknown> | undefined;
      try {
        const row = await f.row(); assert(row); const saved = { version: 1 as const, projection: target, baseline, patch: { title: target.title } };
        await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: saved } }).where(eq(taskOutbox.id, f.id)); await f.reclaim();
        await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [f.taskID]);
        pending = f.prepare(); const rejected = assert.rejects(pending, TaskOutboxPredecessorError); await lockWait();
        const current = await f.row(); assert(current);
        await db.update(taskOutbox).set({ payload: { ...current.payload, dispatchProjection: { ...saved, baseline: target, patch: {} } } }).where(eq(taskOutbox.id, f.id));
        await lock.query("COMMIT"); await rejected; assert.equal((await f.row())!.payload.dispatchResolution, undefined);
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await pending?.catch(() => {}); await f.cleanup(); }
    });
    await run("lease-takeover-rebinds-only-attempt", async () => {
      const f = await fixture(); try {
        const prepared = await f.prepare(), basis = (await f.row())!.payload.dispatchResolution;
        await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, f.id));
        const claim = await claimTaskOutbox(f.id); assert(claim?.leaseToken); assert.notEqual(claim.leaseToken, f.token);
        await assert.rejects(() => assertTaskOutboxPredecessorResolution(f.claim, f.token, prepared.predecessorAddress), TaskOutboxPredecessorError);
        const next = await prepareTaskOutboxPredecessorResolution(claim, claim.leaseToken);
        assert.equal(next.predecessorAddress.witness, prepared.predecessorAddress.witness); assert.deepEqual((await f.row())!.payload.dispatchResolution, basis);
        assert.equal(await assertTaskOutboxPredecessorResolution(claim, claim.leaseToken, prepared.predecessorAddress), false);
        assert.equal(await assertTaskOutboxPredecessorResolution(claim, claim.leaseToken, next.predecessorAddress), true);
      } finally { await f.cleanup(); }
    });
    await run("ack-post-mapping-wait-expiry-rollback", async () => {
      const f = await fixture(), lock = await observer.connect(); let pending: Promise<boolean> | undefined;
      try {
        const prepared = await f.prepare(); await setTaskOutboxCausalProjection(f.claim, f.token, prepared.predecessorAddress, { version: 1, projection: target, baseline, patch: { title: target.title } });
        await lock.query("BEGIN"); await lock.query("SELECT id FROM external_tasks WHERE task_id=$1 FOR UPDATE", [f.taskID]);
        await db.update(taskOutbox).set({ leaseUntil: sql`clock_timestamp() + interval '200 milliseconds'` }).where(eq(taskOutbox.id, f.id));
        pending = acceptTaskOutboxDelivery(f.claim, f.token, { ref: { ...f.ref, etag: '"v2"' }, projection: target }, undefined, undefined, f.ref, prepared.predecessorAddress);
        await lockWait(); await pause(250); await lock.query("COMMIT"); assert.equal(await pending, false);
        const row = await f.row(); assert.equal(row!.status, "attempting"); assert.equal(row!.resultRef, null);
        const [mapping] = await db.select().from(externalTasks).where(eq(externalTasks.taskID, f.taskID)); assert.equal(mapping.etag, '"v1"');
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await pending?.catch(() => {}); await f.cleanup(); }
    });
    await run("long-complete-chain-no-cap", async () => {
      const f = await fixture(); try {
        const current = await f.row(); assert(current); const envelope = SyncOperationEnvelopeSchema.parse(current.payload.operationEnvelope); let previous = f.createID;
        for (let index = 0; index < 130; index++) {
          const id = randomUUID(), command = randomUUID(); f.ids.push(id);
          await db.insert(taskOutbox).values({ ...current, id, mutationID: command, predecessorID: previous, status: "not-needed", uncertain: false, leaseToken: null, leaseUntil: null,
            resultRef: null, remoteSnapshot: null, payload: { ...current.payload, operationEnvelope: { ...envelope, operationId: id, commandId: command, predecessorOperationId: previous } } }); previous = id;
        }
        await db.update(taskOutbox).set({ predecessorID: previous, payload: { ...current.payload, operationEnvelope: { ...envelope, predecessorOperationId: previous } } }).where(eq(taskOutbox.id, f.id));
        await f.reclaim();
        const prepared = await f.prepare(); assert.equal(prepared.predecessorAddress.evidenceOperationId, f.createID); assert.equal(prepared.historyProfile, "captured-v1");
      } finally { await f.cleanup(); }
    });
    assert(selected === "all" || inventory.includes(selected), `Unknown causal DB case: ${selected}`); console.log(`Task causal PostgreSQL: ${passed} cases passed`);
  } finally {
    try { await Promise.all([...pools].map(pool => pool.end())); const sessions = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [name]);
      assert.equal(sessions.rows[0].count, 0); await admin.query(`DROP DATABASE "${name}"`); console.log(`Task causal DB cleanup: ${pools.size} owned pools closed, zero sessions, nonce DB dropped without FORCE: PASS`);
    } finally { connect.mock.restore(); await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
