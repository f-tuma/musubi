import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client, Pool } from "pg";
import { mock } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { eq, inArray } from "drizzle-orm";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import type { CalendarAdapter } from "./adapter";
import type { DeliveryAttemptOptions } from "./delivery_policy";

/** Actual task executor/ACK, PostgreSQL and closed owned HTTP. Invalid persisted
 * lineage is a storage-boundary fixture, not a public API exploit claim. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const name = `task_causal_${randomUUID().replace(/-/g, "")}`, url = new URL(adminUrl); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  process.env.DATABASE_URL = url.href;
  const pools = new Set<Pool>(), originalConnect = Pool.prototype.connect;
  const connect = mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]): any {
    if (this !== admin) pools.add(this); return Reflect.apply(originalConnect, this, args);
  });
  const originalFetch = globalThis.fetch, list = "causal/list", grant = "https://www.googleapis.com/auth/tasks";
  let nativeId = "causal/task", loseMutationReply = false, infiniteMetadata = false;
  let onRequest: ((method: string, path: string) => Promise<void>) | undefined;
  let remote: Record<string, unknown> | null = null, requests: string[] = [], failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      requests.push(req.method!);
      await onRequest?.(req.method!, req.url!);
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === `/tasks/v1/users/@me/lists/${encodeURIComponent(list)}`) { assert.equal(req.method, "GET"); return json({ id: list }); }
      if (req.url === `/tasks/v1/lists/${encodeURIComponent(list)}/tasks`) {
        assert.equal(req.method, "POST"); remote = { id: nativeId, ...JSON.parse(raw), etag: '"v1"' }; return json({ id: nativeId, etag: '"v1"' }, 201);
      }
      assert.equal(req.url, `/tasks/v1/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(nativeId)}`);
      if (req.method === "GET") {
        if (remote && infiniteMetadata) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(remote).replace(/}$/, ',"ignoredOverflow":1e400}')); }
        return remote ? json(remote) : json({}, 404);
      }
      assert.equal(req.headers["if-match"], '"v1"');
      if (req.method === "DELETE") { remote = null; if (loseMutationReply) { req.socket.destroy(); return; } res.writeHead(204); return res.end(); }
      assert.equal(req.method, "PATCH"); assert(remote); Object.assign(remote, JSON.parse(raw), { etag: '"v2"' });
      if (loseMutationReply) { req.socket.destroy(); return; }
      return json({ etag: '"v2"' });
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned causal fixture assertion failed"); }
  });
  try {
    const database = await import("@musubi/db");
    const { db, user, account, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      appendTaskOutbox, getTaskOutbox } = database;
    pools.add(db.$client);
    const { migrateDatabase } = await import("../../../../packages/db/src/migrate");
    const { deliverTaskOutbox } = await import("./task_delivery"), { googleAdapter, toGoogleTask } = await import("./adapters/google");
    const { deliverSharedGoogleTaskUpdate } = await import("./google_shared_task_update_delivery"), { deliverSharedGoogleTaskDelete } = await import("./google_shared_task_delete_delivery");
    await migrateDatabase(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    globalThis.fetch = (input, init) => {
      const native = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert.equal(native.origin, "https://tasks.googleapis.com", "No live/native/OAuth fallback");
      return originalFetch(origin + native.pathname + native.search, init);
    };
    const legacy: CalendarAdapter = { ...googleAdapter, googleTaskCreateV1: undefined, googleTaskUpdateV1: undefined, googleTaskDeleteV1: undefined };
    let factories = 0;
    const shared: CalendarAdapter = { ...googleAdapter,
      googleTaskUpdateV1(...args) { factories++; return googleAdapter.googleTaskUpdateV1!(...args); },
      googleTaskDeleteV1(...args) { factories++; return googleAdapter.googleTaskDeleteV1!(...args); } };
    const seed = async (action: "update" | "delete", noResource = false) => {
      nativeId = "causal/task"; loseMutationReply = infiniteMetadata = false; onRequest = undefined;
      remote = { id: nativeId, title: "Before", notes: "Keep", status: "needsAction", due: null, etag: '"v1"' }; requests = []; failures = []; factories = 0;
      const owner = `causal:${randomUUID()}`, home = randomUUID(), taskID = randomUUID(), accountID = randomUUID(), createID = randomUUID(), id = randomUUID();
      await db.insert(user).values({ id: owner, name: "Causal fixture", email: `${randomUUID()}@example.invalid` });
      await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: accountID, scope: grant,
        accessToken: "causal.fixture.access", refreshToken: "causal.fixture.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      await db.insert(calendars).values({ id: home, creatorID: owner, name: "Causal", color: "#112233" });
      await db.insert(calendarMembers).values({ calendarID: home, userID: owner, role: "owner" });
      const [source] = await db.insert(externalCalendars).values({ calendarID: home, provider: "google", userID: owner, accountID,
        externalCalendarID: `musubi-google-task-list:${list}`, supportsEvents: false, supportsTasks: true }).returning();
      const [row] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID: home, originCalendarID: home,
        title: "Before", description: "Keep", status: "in-process", priority: 2 }).returning();
      await db.insert(calendarTasks).values({ calendarID: home, taskID });
      const task = TaskSchema.parse({ ...row, calendarIDs: [home] });
      const intent = (operationID: string, operation: "create" | "update" | "delete", value = task) => ({ id: operationID, actorID: owner,
        mutationID: randomUUID(), position: 0, taskID, calendarID: home, externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID,
        externalCalendarID: source.externalCalendarID, externalTaskID: null, expectedEtag: null,
        providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: operation, payload: { task: value, projectionBaseline: null } });
      await db.transaction(tx => appendTaskOutbox(tx, task, [intent(createID, "create")]));
      const next = { ...task, title: action === "update" ? "Accepted successor" : task.title, revision: 2 };
      await db.update(tasks).set({ title: next.title, revision: 2, ...(noResource ? { deletedAt: new Date() } : {}) }).where(eq(tasks.id, taskID));
      await db.transaction(tx => appendTaskOutbox(tx, next, [intent(id, action, next)]));
      assert((await getTaskOutbox(id))?.payload.operationEnvelope, "Actual queued successor admission must remain pinned and unaddressed");
      const ids = [id, createID];
      return { id, createID, owner, taskID, home, source, accountID, ids, target: toGoogleTask(next),
        run: (adapter = legacy, options: DeliveryAttemptOptions = {}) => deliverTaskOutbox(id, () => adapter, options),
        async cleanup() { onRequest = undefined; await db.delete(taskOutbox).where(inArray(taskOutbox.id, ids)); await db.delete(user).where(eq(user.id, owner)); } };
    };
    const selected = process.argv[2] ?? "all", inventory: string[] = []; let passed = 0;
    async function run(id: string, body: () => Promise<void>) { inventory.push(id); if (selected !== "all" && selected !== id) return; await body(); passed++; console.log(`Task causal API PG/HTTP: ${id}: PASS`); }
    for (const action of ["update", "delete"] as const) await run(`foreign-task-${action}`, async () => {
      const f = await seed(action);
      try {
        const original = await getTaskOutbox(f.createID); assert(original);
        const foreign = randomUUID(), command = randomUUID();
        f.ids.push(foreign);
        await db.insert(taskOutbox).values({ ...original, id: foreign, taskID: randomUUID(), mutationID: command, status: "completed", uncertain: false,
          resultRef: { externalTaskId: nativeId, etag: '"v1"', icalUid: null }, remoteSnapshot: { title: "Before", notes: "Keep", status: "needsAction", due: null },
          payload: { task: original.payload.task, projectionBaseline: null } });
        const successor = await getTaskOutbox(f.id); assert(successor); const envelope = SyncOperationEnvelopeSchema.parse(successor.payload.operationEnvelope);
        await db.update(taskOutbox).set({ predecessorID: foreign, payload: { ...successor.payload,
          operationEnvelope: { ...envelope, predecessorOperationId: foreign } } }).where(eq(taskOutbox.id, f.id));
        const result = await f.run();
        console.log(JSON.stringify({ characterization: `foreign-task-${action}`, methods: requests, remoteTitle: remote?.title ?? null, status: result?.status }));
        assert.deepEqual(failures, []); assert.deepEqual(requests, [], "Invalid full-scope lineage must be refused before every native request");
        assert.notEqual(result?.status, "completed");
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) await run(`actual-create-${action}-parity`, async () => {
      let oldWire: string[] = [];
      for (const [label, adapter] of [["legacy", legacy], ["shared", shared]] as const) {
        const f = await seed(action);
        try {
          remote = null; assert.equal((await deliverTaskOutbox(f.createID, () => googleAdapter))?.status, "completed");
          const admitted = await getTaskOutbox(f.id); assert(admitted); const capturedEnvelope = JSON.stringify(admitted.payload.operationEnvelope);
          requests = []; const result = await f.run(adapter); assert.equal(result?.status, "completed");
          assert.equal(result.externalTaskID, null); assert.equal(JSON.stringify(result.payload.operationEnvelope), capturedEnvelope);
          if (label === "legacy") oldWire = [...requests]; else {
            assert.deepEqual(requests, oldWire); assert.equal(factories, 1);
            assert(result.payload.dispatchResolution); assert(result.payload.dispatchProjectionWitness);
          }
          const [canonical] = await db.select().from(tasks).where(eq(tasks.id, f.taskID)); assert.equal(canonical.status, "in-process"); assert.equal(canonical.priority, 2);
          const [mapping] = await db.select().from(externalTasks).where(eq(externalTasks.taskID, f.taskID));
          if (action === "delete") assert.equal(mapping, undefined); else { assert.equal(mapping.externalTaskID, nativeId); assert.equal(mapping.etag, '"v2"'); }
          assert.deepEqual(failures, []);
        } finally { await f.cleanup(); }
      }
    });
    for (const action of ["update", "delete"] as const) for (const mode of ["cycle", "missing", "foreign-account", "foreign-physical", "legacy-present-physical", "legacy-malformed-capture", "baseline-and-mask"] as const) await run(`shared-${action}-invalid-${mode}-zero-http`, async () => {
      const f = await seed(action); try {
        remote = null; assert.equal((await deliverTaskOutbox(f.createID, () => googleAdapter))?.status, "completed"); requests = [];
        const prior = await getTaskOutbox(f.createID), row = await getTaskOutbox(f.id); assert(prior && row);
        if (mode === "foreign-account") await db.update(taskOutbox).set({ accountID: "foreign-account" }).where(eq(taskOutbox.id, f.createID));
        else if (mode === "baseline-and-mask") {
          const baseline = { ...f.target, title: "Before", notes: "Changed historical authority" };
          const target = action === "delete" ? { ...f.target, title: "Before" } : f.target;
          await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: { version: 1, baseline, projection: target,
            patch: { ...(action === "update" ? { title: target.title } : {}), notes: target.notes } } } }).where(eq(taskOutbox.id, f.id));
        } else if (mode === "foreign-physical" || mode.startsWith("legacy-")) {
          const capture = mode === "legacy-malformed-capture" ? { version: 1 } : { ...prior.payload.operationCapture as object, connectionId: randomUUID() };
          const payload = { ...prior.payload, operationCapture: capture };
          if (mode.startsWith("legacy-")) delete payload.operationEnvelope;
          await db.update(taskOutbox).set({ payload }).where(eq(taskOutbox.id, f.createID));
        } else {
          const envelope = SyncOperationEnvelopeSchema.parse(prior.payload.operationEnvelope), predecessorID = mode === "cycle" ? prior.id : randomUUID();
          await db.update(taskOutbox).set({ predecessorID, payload: { ...prior.payload, operationEnvelope: { ...envelope, predecessorOperationId: predecessorID } } }).where(eq(taskOutbox.id, prior.id));
        }
        const result = await f.run(shared); assert.notEqual(result?.status, "completed"); assert.equal(result?.status, "blocked");
        assert.deepEqual(requests, []); assert.equal(factories, 0, "Invalid persisted lineage is rejected before lazy credentials/native construction");
        assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) for (const part of ["actor", "mutation", "task", "list", "capture", "action"] as const) await run(`shared-${action}-original-claim-${part}-before-first-prepare-zero-http`, async () => {
      const f = await seed(action); try {
        remote = null; assert.equal((await deliverTaskOutbox(f.createID, () => googleAdapter))?.status, "completed"); requests = [];
        const claimed = await database.claimTaskOutbox(f.id); assert(claimed?.leaseToken);
        const envelope = SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), payload = { ...claimed.payload };
        let changes: Partial<typeof claimed> = {};
        if (part === "actor") changes = { position: 1 };
        if (part === "mutation") { const command = randomUUID(); changes = { mutationID: command }; payload.operationEnvelope = { ...envelope, commandId: command }; }
        if (part === "task") payload.task = { ...payload.task, title: "Changed after original claim" };
        if (part === "capture") payload.operationCapture = { ...payload.operationCapture as object, connectionGeneration: 10 };
        if (part === "action") { const changedAction = action === "delete" ? "update" : "delete"; changes = { action: changedAction };
          payload.operationEnvelope = { ...envelope, operation: { ...envelope.operation, action: changedAction }, nativePlan: { ...envelope.nativePlan,
            data: { planKind: "json-body", body: changedAction === "delete" ? null : envelope.admittedProjection.data } } }; }
        if (part === "list") {
          const calendarID = randomUUID();
          await db.insert(calendars).values({ id: calendarID, creatorID: f.owner, name: "Other source", color: "#112233" });
          await db.insert(calendarMembers).values({ calendarID, userID: f.owner, role: "owner" });
          const [source] = await db.insert(externalCalendars).values({ calendarID, provider: "google", userID: f.owner, accountID: f.accountID,
            externalCalendarID: "musubi-google-task-list:other-list", supportsEvents: false, supportsTasks: true }).returning();
          changes = { calendarID, externalCalendarLinkID: source.id, externalCalendarID: source.externalCalendarID };
          const rewrite = (original: typeof envelope) => ({ ...original, locator: { ...original.locator, collectionId: source.externalCalendarID },
            sourceEpoch: { ...original.sourceEpoch, sourceId: source.id, generation: source.providerAccessRevision } });
          const capture = { ...claimed.payload.operationCapture as object, sourceId: source.id, writeGeneration: source.providerAccessRevision };
          payload.operationEnvelope = rewrite(envelope); payload.operationCapture = capture;
          const prior = await getTaskOutbox(f.createID); assert(prior);
          await db.update(taskOutbox).set({ ...changes, resultRef: { externalTaskId: "other-list-native-task", etag: '"v1"', icalUid: null },
            payload: { ...prior.payload, operationCapture: capture, operationEnvelope: rewrite(SyncOperationEnvelopeSchema.parse(prior.payload.operationEnvelope)) } }).where(eq(taskOutbox.id, f.createID));
        }
        await db.update(taskOutbox).set({ ...changes, payload }).where(eq(taskOutbox.id, f.id));
        if (part !== "capture") assert.equal(database.decodeTaskOutboxOperation((await getTaskOutbox(f.id))!).kind, "pinned-v1");
        const result = action === "update" ? await deliverSharedGoogleTaskUpdate(claimed, envelope, shared.googleTaskUpdateV1!) :
          await deliverSharedGoogleTaskDelete(claimed, envelope, shared.googleTaskDeleteV1!);
        assert.equal(result?.status, "blocked"); assert.equal(result.errorCode, "task-projection-unavailable"); assert.deepEqual(requests, []); assert.equal(factories, 0);
        assert.equal(result.payload.dispatchResolution, undefined); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    await run("shared-original-no-task-delete-cannot-ack-replaced-update", async () => {
      const f = await seed("delete", true); try {
        assert.equal((await deliverTaskOutbox(f.createID, () => legacy))?.status, "not-needed");
        const claimed = await database.claimTaskOutbox(f.id); assert(claimed?.leaseToken); const envelope = SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope);
        await db.update(taskOutbox).set({ action: "update", payload: { ...claimed.payload, operationEnvelope: { ...envelope,
          operation: { ...envelope.operation, action: "update" }, nativePlan: { ...envelope.nativePlan, data: { planKind: "json-body", body: envelope.admittedProjection.data } } } } }).where(eq(taskOutbox.id, f.id));
        assert.equal(database.decodeTaskOutboxOperation((await getTaskOutbox(f.id))!).kind, "pinned-v1");
        const result = await deliverSharedGoogleTaskDelete(claimed, envelope, shared.googleTaskDeleteV1!);
        assert.equal(result?.status, "blocked"); assert.equal(result.errorCode, "task-projection-unavailable"); assert.deepEqual(requests, []); assert.equal(factories, 0);
        assert.equal(result.payload.dispatchResolution, undefined);
      } finally { await f.cleanup(); }
    });
    await run("shared-original-null-history-saved-mask-cannot-false-ack", async () => {
      const f = await seed("update"); try {
        remote = null; await deliverTaskOutbox(f.createID, () => googleAdapter); requests = [];
        const prior = await getTaskOutbox(f.createID), row = await getTaskOutbox(f.id); assert(prior && row && remote);
        await db.update(taskOutbox).set({ remoteSnapshot: null, payload: { task: prior.payload.task, projectionBaseline: null } }).where(eq(taskOutbox.id, prior.id));
        await db.update(externalTasks).set({ projectionBaseline: null }).where(eq(externalTasks.taskID, f.taskID));
        const saved = { version: 1 as const, projection: f.target, baseline: { ...f.target, title: "Before" }, patch: { title: f.target.title } };
        await db.update(taskOutbox).set({ status: "retry", uncertain: true, payload: { ...row.payload, dispatchProjection: saved } }).where(eq(taskOutbox.id, f.id));
        const claimed = await database.claimTaskOutbox(f.id); assert(claimed?.leaseToken && claimed.reconciling);
        await db.update(taskOutbox).set({ payload: { ...claimed.payload, dispatchProjection: { ...saved, baseline: f.target, patch: {} } } }).where(eq(taskOutbox.id, f.id));
        const result = await deliverSharedGoogleTaskUpdate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), shared.googleTaskUpdateV1!);
        console.log(JSON.stringify({ characterization: "claimed-null-history-mask", status: result?.status, nativeTitle: (remote as Record<string, unknown> | null)?.title, methods: requests, factories }));
        assert.notEqual(result?.status, "completed", "Changed empty retry mask cannot acknowledge the unchanged native title");
        assert.deepEqual(requests, []); assert.equal(factories, 0); assert.equal(result?.payload.dispatchResolution, undefined); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    await run("shared-original-resolution-removal-cannot-readdress-retry", async () => {
      const f = await seed("update"); try {
        remote = null; await deliverTaskOutbox(f.createID, () => googleAdapter); requests = [];
        let claimed = await database.claimTaskOutbox(f.id); assert(claimed?.leaseToken);
        const prepared = await database.prepareTaskOutboxPredecessorResolution(claimed, claimed.leaseToken);
        await database.setTaskOutboxCausalProjection(claimed, claimed.leaseToken, prepared.predecessorAddress, { version: 1, projection: f.target,
          baseline: { ...f.target, title: "Before" }, patch: { title: f.target.title } });
        await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, f.id));
        claimed = await database.claimTaskOutbox(f.id); assert(claimed?.leaseToken && claimed.reconciling);
        const { dispatchProjection: _projection, dispatchResolution: _resolution, dispatchProjectionWitness: _witness, ...payload } = claimed.payload;
        await db.update(taskOutbox).set({ payload }).where(eq(taskOutbox.id, f.id));
        await db.update(taskOutbox).set({ resultRef: { externalTaskId: "replacement-native-task", etag: '"v1"', icalUid: null } }).where(eq(taskOutbox.id, f.createID));
        const result = await deliverSharedGoogleTaskUpdate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), shared.googleTaskUpdateV1!);
        assert.notEqual(result?.status, "completed"); assert.deepEqual(requests, []); assert.equal(factories, 0); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) await run(`legacy-${action}-cycle-zero-http`, async () => {
      const f = await seed(action); try {
        remote = null; await deliverTaskOutbox(f.createID, () => googleAdapter); requests = [];
        const prior = await getTaskOutbox(f.createID); assert(prior); const envelope = SyncOperationEnvelopeSchema.parse(prior.payload.operationEnvelope);
        await db.update(taskOutbox).set({ predecessorID: prior.id, payload: { ...prior.payload, operationEnvelope: { ...envelope, predecessorOperationId: prior.id } } }).where(eq(taskOutbox.id, prior.id));
        const result = await f.run(); assert.equal(result?.status, "conflict"); assert.equal(result.errorCode, "task-provider-conflict"); assert.deepEqual(requests, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) for (const mode of ["metadata-array257", "metadata-fields129", "metadata-depth20", "metadata-infinity", "native-id2050", "lost-reply-recovery", "native-version-conflict", "mixed-v0-null-baseline"] as const) await run(`deferred-${action}-${mode}-parity`, async () => {
      let old: unknown;
      for (const [label, adapter] of [["legacy", legacy], ["shared", shared]] as const) {
        const f = await seed(action); try {
          if (mode === "native-id2050") nativeId = "n".repeat(2050);
          remote = null; assert.equal((await deliverTaskOutbox(f.createID, () => googleAdapter))?.status, "completed"); requests = [];
          if (mode === "metadata-array257") remote!.ignored = Array.from({ length: 257 }, (_, i) => i);
          if (mode === "metadata-fields129") remote!.ignored = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key${i}`, i]));
          if (mode === "metadata-depth20") { let value: unknown = 1; for (let i = 0; i < 20; i++) value = { nested: value }; remote!.ignored = value; }
          if (mode === "metadata-infinity") infiniteMetadata = true;
          if (mode === "native-version-conflict") remote!.etag = '"other-version"';
          if (mode === "mixed-v0-null-baseline") {
            const prior = await getTaskOutbox(f.createID); assert(prior);
            await db.update(taskOutbox).set({ remoteSnapshot: null, payload: { task: prior.payload.task, projectionBaseline: null } }).where(eq(taskOutbox.id, prior.id));
            await db.update(externalTasks).set({ projectionBaseline: null }).where(eq(externalTasks.taskID, f.taskID));
          }
          loseMutationReply = mode === "lost-reply-recovery";
          let result = await f.run(adapter);
          if (loseMutationReply) {
            assert.equal(result?.status, "unconfirmed"); assert(result.uncertain); loseMutationReply = false;
            const firstMutations = requests.filter(method => method === "PATCH" || method === "DELETE").length;
            assert.equal(firstMutations, 1); requests = [];
            await db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, f.id));
            result = await f.run(adapter); assert.equal(requests.some(method => method === "PATCH" || method === "DELETE"), false, "Uncertain retry is GET-only");
          }
          const receipt = { status: result?.status, errorCode: result?.errorCode, uncertain: result?.uncertain, wire: [...requests] };
          if (label === "legacy") old = receipt; else assert.deepEqual(receipt, old);
          assert.equal(result?.status, mode === "native-version-conflict" ? "conflict" : "completed");
          assert.equal(result.externalTaskID, null); assert.deepEqual(failures, []);
        } finally { await f.cleanup(); }
      }
    });
    for (const action of ["update", "delete"] as const) for (const change of ["baseline", "ref", "mask", "token", "source", "privacy"] as const) await run(`shared-${action}-${change}-changes-before-dispatch`, async () => {
      const f = await seed(action); try {
        remote = null; assert.equal((await deliverTaskOutbox(f.createID, () => googleAdapter))?.status, "completed"); requests = [];
        let reads = 0;
        onRequest = async method => {
          if (method !== "GET" || ++reads !== 3) return;
          if (change === "baseline") await db.update(taskOutbox).set({ remoteSnapshot: { ...f.target, notes: "Changed after preparation" } }).where(eq(taskOutbox.id, f.createID));
          if (change === "ref") await db.update(taskOutbox).set({ resultRef: { externalTaskId: nativeId, etag: '"changed"', icalUid: null } }).where(eq(taskOutbox.id, f.createID));
          if (change === "token") await db.update(taskOutbox).set({ leaseToken: randomUUID() }).where(eq(taskOutbox.id, f.id));
          if (change === "source") await db.update(externalCalendars).set({ providerAccessRevision: f.source.providerAccessRevision + 1 }).where(eq(externalCalendars.id, f.source.id));
          if (change === "privacy") await db.update(tasks).set({ providerReadRetiredGeneration: 1 }).where(eq(tasks.id, f.taskID));
          if (change === "mask") {
            const row = await getTaskOutbox(f.id); assert(row?.payload.dispatchProjection);
            const saved = row.payload.dispatchProjection;
            await db.update(taskOutbox).set({ payload: { ...row.payload, dispatchProjection: { ...saved,
              baseline: { ...saved.baseline, notes: "Changed together" }, patch: { ...saved.patch, notes: saved.projection.notes } } } }).where(eq(taskOutbox.id, f.id));
          }
        };
        const result = await f.run(shared); assert.notEqual(result?.status, "completed");
        assert.equal(requests.some(method => method === "PATCH" || method === "DELETE"), false); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) await run(`shared-${action}-lineage-changes-before-ack`, async () => {
      const f = await seed(action); try {
        remote = null; await deliverTaskOutbox(f.createID, () => googleAdapter); requests = [];
        onRequest = async method => {
          if (method === "PATCH" || method === "DELETE") await db.update(taskOutbox).set({ remoteSnapshot: { ...f.target, notes: "Changed after send" } }).where(eq(taskOutbox.id, f.createID));
        };
        const result = await f.run(shared); assert.equal(result?.status, "conflict");
        const [mapping] = await db.select().from(externalTasks).where(eq(externalTasks.taskID, f.taskID)); assert.equal(mapping.etag, '"v1"');
        assert.equal(requests.filter(method => method === "PATCH" || method === "DELETE").length, 1); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) for (const changed of ["mapping", "newer-canonical-secondary"] as const) await run(`deferred-${action}-${changed}-authority-parity`, async () => {
      let oldWire: string[] = [];
      for (const [label, adapter] of [["legacy", legacy], ["shared", shared]] as const) {
        const f = await seed(action); try {
          remote = null; await deliverTaskOutbox(f.createID, () => googleAdapter); requests = [];
          if (changed === "mapping") await db.update(externalTasks).set({ externalTaskID: "replacement-mapping", etag: '"replacement"' }).where(eq(externalTasks.taskID, f.taskID));
          else {
            const newHome = randomUUID();
            await db.insert(calendars).values({ id: newHome, creatorID: f.owner, name: "New canonical home", color: "#112233" });
            await db.insert(calendarMembers).values({ calendarID: newHome, userID: f.owner, role: "owner" });
            await db.insert(calendarTasks).values({ calendarID: newHome, taskID: f.taskID });
            await db.update(tasks).set({ title: "Newer canonical title", revision: 3, calendarID: newHome, originCalendarID: newHome }).where(eq(tasks.id, f.taskID));
          }
          const result = await f.run(adapter); assert.equal(result?.status, changed === "mapping" ? "conflict" : "completed");
          if (label === "legacy") oldWire = [...requests]; else assert.deepEqual(requests, oldWire);
          const [canonical] = await db.select().from(tasks).where(eq(tasks.id, f.taskID));
          assert.equal(canonical.status, "in-process"); assert.equal(canonical.priority, 2);
          if (changed === "newer-canonical-secondary") { assert.equal(canonical.title, "Newer canonical title"); assert.equal(canonical.revision, 3); }
          const [mapping] = await db.select().from(externalTasks).where(eq(externalTasks.taskID, f.taskID));
          if (changed === "mapping") assert.equal(mapping.externalTaskID, "replacement-mapping", "Current mapping never readdresses the captured successor");
          assert.deepEqual(failures, []);
        } finally { await f.cleanup(); }
      }
    });
    for (const tag of [null, 'W/"weak"']) await run(`deferred-delete-${tag === null ? "null" : "weak"}-tag-native-absence-parity`, async () => {
      let oldWire: string[] = [];
      for (const [label, adapter] of [["legacy", legacy], ["shared", shared]] as const) {
        const f = await seed("delete"); try {
          remote = null; await deliverTaskOutbox(f.createID, () => googleAdapter); requests = []; remote = null;
          await db.update(taskOutbox).set({ resultRef: { externalTaskId: nativeId, etag: tag, icalUid: null } }).where(eq(taskOutbox.id, f.createID));
          await db.update(externalTasks).set({ etag: tag }).where(eq(externalTasks.taskID, f.taskID));
          assert.equal((await f.run(adapter))?.status, "completed"); assert.deepEqual(requests, ["GET"]);
          if (label === "legacy") oldWire = [...requests]; else assert.deepEqual(requests, oldWire);
          assert.deepEqual(failures, []);
        } finally { await f.cleanup(); }
      }
    });
    await run("not-needed-create-delete-zero-http", async () => {
      const f = await seed("delete", true);
      try {
        assert.equal((await deliverTaskOutbox(f.createID, () => legacy))?.status, "not-needed");
        const created = await getTaskOutbox(f.createID); assert.equal(created?.uncertain, false); assert.equal(created.resultRef, null); assert.equal(created.remoteSnapshot, null);
        assert.equal((await f.run())?.status, "completed"); assert.deepEqual(requests, []); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete"] as const) await run(`shared-not-needed-create-${action}-zero-http`, async () => {
      const f = await seed(action, true); try {
        assert.equal((await deliverTaskOutbox(f.createID, () => legacy))?.status, "not-needed");
        if (action === "update") await db.update(tasks).set({ deletedAt: null }).where(eq(tasks.id, f.taskID));
        const result = await f.run(shared); assert.equal(result?.status, action === "delete" ? "completed" : "retry");
        if (action === "update") assert.equal(result?.errorCode, "task-version-unavailable");
        assert.deepEqual(requests, []); assert.equal(factories, 0); assert(result?.payload.dispatchResolution);
        assert.equal(result?.resultRef, null); assert.equal(result?.remoteSnapshot, null); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const ambiguity of ["none", "uncertainty", "snapshot", "address", "etag", "uid"] as const) await run(`shared-no-resource-intermediate-${ambiguity}-zero-http`, async () => {
      const f = await seed("delete", true); try {
        assert.equal((await deliverTaskOutbox(f.createID, () => legacy))?.status, "not-needed");
        assert.equal((await f.run())?.status, "completed", "The intermediate DELETE actually completed without a native destination");
        const prior = await getTaskOutbox(f.id); assert(prior);
        const task = TaskSchema.parse({ ...prior.payload.task, revision: 3 }), id = randomUUID(); f.ids.push(id);
        await db.update(tasks).set({ revision: 3 }).where(eq(tasks.id, f.taskID));
        await db.transaction(tx => appendTaskOutbox(tx, task, [{ id, actorID: f.owner, mutationID: randomUUID(), position: 0,
          taskID: f.taskID, calendarID: f.home, externalCalendarLinkID: f.source.id, provider: "google", userID: f.owner, accountID: f.accountID,
          externalCalendarID: f.source.externalCalendarID, externalTaskID: null, expectedEtag: null, icalUid: null,
          providerAccessRevision: f.source.providerAccessRevision, retiredGeneration: 0, action: "delete", payload: { task, projectionBaseline: null } }]));
        if (ambiguity === "uncertainty") await db.update(taskOutbox).set({ uncertain: true }).where(eq(taskOutbox.id, prior.id));
        if (ambiguity === "snapshot") await db.update(taskOutbox).set({ remoteSnapshot: f.target }).where(eq(taskOutbox.id, prior.id));
        if (ambiguity === "etag") await db.update(taskOutbox).set({ expectedEtag: '"unpaired"' }).where(eq(taskOutbox.id, prior.id));
        if (ambiguity === "uid") await db.update(taskOutbox).set({ icalUid: "unpaired-uid" }).where(eq(taskOutbox.id, prior.id));
        if (ambiguity === "address") {
          const envelope = SyncOperationEnvelopeSchema.parse(prior.payload.operationEnvelope);
          await db.update(taskOutbox).set({ externalTaskID: nativeId, payload: { ...prior.payload, operationEnvelope: { ...envelope,
            locator: { ...envelope.locator, resourceId: nativeId } } } }).where(eq(taskOutbox.id, prior.id));
        }
        const result = await deliverTaskOutbox(id, () => shared);
        assert.equal(result?.status, ambiguity === "none" ? "completed" : "blocked"); assert.deepEqual(requests, []); assert.equal(factories, 0);
        assert.equal(result?.resultRef, null); assert.equal(result?.remoteSnapshot, null); assert.deepEqual(failures, []);
      } finally { await f.cleanup(); }
    });
    for (const action of ["update", "delete", "no-resource"] as const) await run(`shared-${action}-real-commit-wins-late-timeout`, async () => {
      const f = await seed(action === "update" ? "update" : "delete", action === "no-resource");
      let delivery: ReturnType<typeof f.run> | undefined, expire: (() => void) | undefined, committed!: () => void, release!: () => void;
      const deadlineMs = 123_467, didCommit = new Promise<void>(resolve => { committed = resolve; }), reply = new Promise<void>(resolve => { release = resolve; });
      const originalTimer = globalThis.setTimeout;
      const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (delay === deadlineMs) { expire = () => callback(...args); return originalTimer(callback, 30_000, ...args); }
        return originalTimer(callback, delay, ...args);
      });
      const pending = new WeakSet<Client>(), originalQuery = Client.prototype.query;
      const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
        if (typeof text === "string" && /^update "task_outbox" set "status"/i.test(text) && Array.isArray(values) && values.includes(f.id) && values.includes("completed")) pending.add(this);
        const actual = Reflect.apply(originalQuery, this, args);
        if (typeof text === "string" && text.trim().toLowerCase() === "commit" && pending.has(this)) {
          pending.delete(this); return Promise.resolve(actual).then(async value => { committed(); await reply; return value; });
        }
        return actual;
      });
      try {
        remote = null; assert.equal((await deliverTaskOutbox(f.createID, () => googleAdapter))?.status, action === "no-resource" ? "not-needed" : "completed"); requests = [];
        delivery = f.run(shared, { timeoutMs: deadlineMs });
        await Promise.race([didCommit, pause(10_000, undefined, { ref: false }).then(() => { throw new Error("Actual causal ACK COMMIT was not observed"); })]);
        assert.equal((await getTaskOutbox(f.id))?.status, "completed"); assert(expire); expire();
        assert.equal((await delivery)?.status, "completed"); release(); await pause(20);
        assert.equal((await getTaskOutbox(f.id))?.status, "completed");
        assert.equal(requests.filter(method => method === "PATCH" || method === "DELETE").length, action === "no-resource" ? 0 : 1);
        assert.deepEqual(failures, []);
      } finally { release(); query.mock.restore(); timer.mock.restore(); await delivery?.catch(() => {}); await f.cleanup(); }
    });
    assert(selected === "all" || inventory.includes(selected), `Unknown causal case: ${selected}`);
    console.log(`Task causal API PostgreSQL/native HTTP: ${passed} cases passed`);
  } finally {
    globalThis.fetch = originalFetch; await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await Promise.all([...pools].map(pool => pool.end()));
      const sessions = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [name]); assert.equal(sessions.rows[0].count, 0);
      await admin.query(`DROP DATABASE "${name}"`); console.log(`Task causal API cleanup: ${pools.size} owned pools closed, zero sessions, nonce DB dropped without FORCE: PASS`);
    } finally { connect.mock.restore(); await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
