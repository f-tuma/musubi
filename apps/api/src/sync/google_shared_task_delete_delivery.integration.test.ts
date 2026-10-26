import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client, Pool } from "pg";
import { mock } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import type { CalendarAdapter } from "./adapter";
import type { DeliveryAttemptOptions } from "./delivery_policy";

/** Actual old/new native HTTP and host SQL. No live provider, copied executor,
 * production configuration or implicit network fallback is used here. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const databaseName = `google_task_delete_${randomUUID().replace(/-/g, "")}`, databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${databaseName}"`); process.env.DATABASE_URL = databaseUrl.href;
  // tsx may load the DB through both dynamic and static module identities.
  // Own every pool that actually connects before dropping the nonce database.
  const pools = new Set<Pool>(), originalConnect = Pool.prototype.connect;
  const connect = mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]): any {
    if (this !== admin) pools.add(this);
    return Reflect.apply(originalConnect, this, args);
  });
  let observer: Pool | undefined;
  const originalFetch = globalThis.fetch, scope = "https://www.googleapis.com/auth/tasks", nativeList = "native/list+id", nativeId = "native/task+id";
  type Native = { id: string; etag: string; title: string; notes: unknown; status: string; due: unknown; assignmentInfo?: unknown; deleted?: boolean };
  const before = (): Native => ({ id: nativeId, etag: '"v1"', title: "Before", notes: "Keep notes", status: "needsAction", due: "2026-10-26T00:00:00.000Z" });
  let remote: Native | null = before(), mode = "success", reads = 0, sessions = 0, refreshes = 0, factories = 0, lostOnce = false;
  let failures: unknown[] = [], requests: { method: string; path: string; body: string; ifMatch: string | null; contentType: string | null }[] = [];
  let afterRead: ((count: number) => Promise<void>) | undefined;
  let expire: (() => void) | undefined, lastSignal: AbortSignal | undefined;
  const deadlineMs = 123_467, originalTimer = globalThis.setTimeout;
  const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === deadlineMs) { expire = () => callback(...args); return originalTimer(callback, 30_000, ...args); }
    return originalTimer(callback, delay, ...args);
  });
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/token") { refreshes++; return json({ access_token: "c08.delete.refreshed", token_type: "Bearer", expires_in: 3600,
        scope: mode === "refresh-narrows" ? "https://www.googleapis.com/auth/calendar.events" : scope }); }
      const path = `/tasks/v1/lists/${encodeURIComponent(nativeList)}/tasks/${encodeURIComponent(nativeId)}`; assert.equal(req.url, path);
      requests.push({ method: req.method!, path, body: bytes, ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : null,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null });
      assert.match(String(req.headers.authorization), /^Bearer c08\.delete\.(?:access|refreshed)$/);
      if (req.method === "GET") {
        reads++; await afterRead?.(reads);
        if (mode === "initial-network-error" && reads === 1 || mode === "writer-network-error" && reads === 3) return res.destroy();
        if (mode === "initial429" || mode === "permission429" && reads === 2) { res.setHeader("retry-after", "90"); return json({}, 429); }
        if (["initial401", "refresh-narrows"].includes(mode) && reads === 1 || mode === "exhausted401" && reads <= 2 || mode === "writer401" && reads === 3) { res.setHeader("retry-after", "90"); return json({}, 401); }
        if (mode === "initial404") return json({}, 404);
        if (mode === "initial410") return json({}, 410);
        if (mode === "permission-absence-reappears" && reads === 2) return json({}, 404);
        if (["writer-absence", "cancel-writer-absence"].includes(mode) && reads === 3) { remote = null; return json({}, 410); }
        if (!remote) return json({}, 404);
        if (mode === "changed-writer" && reads === 3) remote.etag = '"v2"';
        const assigned = mode === "assigned-initial" && reads === 1 || mode === "assigned-permission" && reads === 2 || mode === "assigned-writer" && reads === 3;
        if (mode === "partial-read") res.setHeader("content-range", "bytes 0-99/999");
        return json({ ...remote, ...(assigned ? { assignmentInfo: { surfaceType: "DOCUMENT" } } : {}) }, mode === "any-ok-read" ? 208 : 200);
      }
      assert.equal(req.method, "DELETE"); assert.equal(req.headers["if-match"], '"v1"'); assert.equal(bytes, ""); assert.equal(req.headers["content-type"], undefined);
      const rejectedStatus = { reject412: 412, reject429: 429, reject408: 408, reject503: 503, delete401: 401 }[mode];
      if (rejectedStatus) { res.setHeader("retry-after", "90"); return json({}, rejectedStatus); }
      if (mode === "lost-unapplied" && !lostOnce) { lostOnce = true; return res.destroy(); }
      remote = null;
      if (mode === "lost-applied" && !lostOnce) { lostOnce = true; return res.destroy(); }
      const status = { response202: 202, response206: 206, response299: 299, response404: 404, response410: 410, response200: 200 }[mode] ?? 204;
      res.writeHead(status, { "content-type": "text/plain" }); res.end(status === 204 ? undefined : "unparsed response body");
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned DELETE fixture assertion failed"); }
  });
  try {
    const database = await import("@musubi/db");
    const { db, user, account, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      appendTaskOutbox, getTaskOutbox, unlinkTask, upsertExternalTask } = database;
    pools.add(db.$client); observer = new Pool({ connectionString: databaseUrl.href, max: 3 }); pools.add(observer);
    const { migrateDatabase } = await import("../../../../packages/db/src/migrate"); const { config } = await import("@musubi/config");
    const { deliverTaskOutbox } = await import("./task_delivery"); const { googleAdapter, toGoogleTask } = await import("./adapters/google");
    await migrateDatabase(); assert.equal(config.api.syncOperationV1EncoderEnabled, true);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert(["https://tasks.googleapis.com", "https://oauth2.googleapis.com"].includes(url.origin), "No live provider or network fallback");
      lastSignal = init?.signal ?? undefined;
      const response = await originalFetch(`${origin}${url.pathname}${url.search}`, init);
      if (mode === "cancel-writer-absence" && reads === 3 && response.status === 410) {
        // Abort exactly while the actual parser consumes final GET absence.
        // Both real writers still return normally before caller guard executes.
        Object.defineProperty(response, "status", { get() { expire!(); return 410; } });
      }
      return response;
    };
    const oldAdapter: CalendarAdapter = { ...googleAdapter, googleTaskDeleteV1: undefined };
    const newAdapter: CalendarAdapter = { ...googleAdapter, googleTaskDeleteV1(...args) {
      factories++; const bridge = googleAdapter.googleTaskDeleteV1!(...args);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { ...bridge.ports.accountSession,
        async open(target, signal) { sessions++; return bridge.ports.accountSession.open(target, signal); } } } };
    } };
    const reset = (next: string) => { remote = before(); mode = next; reads = sessions = refreshes = factories = 0; lostOnce = false; failures = []; requests = []; afterRead = undefined; expire = undefined; lastSignal = undefined; };
    let passed = 0;
    const seed = async (credentialScope = scope, enqueue = true, recurring = false) => {
      const owner = `task-delete:${randomUUID()}`, home = randomUUID(), secondary = randomUUID(), taskID = randomUUID(), id = randomUUID(), accountID = randomUUID();
      await db.insert(user).values({ id: owner, name: "Task DELETE fixture", email: `${randomUUID()}@example.invalid` });
      await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: accountID, scope: credentialScope,
        accessToken: "c08.delete.access", refreshToken: "c08.delete.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      await db.insert(calendars).values([home, secondary].map(calendarID => ({ id: calendarID, creatorID: owner, name: "Task DELETE", color: "#112233" })));
      await db.insert(calendarMembers).values([home, secondary].map(calendarID => ({ calendarID, userID: owner, role: "owner" as const })));
      const [source] = await db.insert(externalCalendars).values({ calendarID: secondary, provider: "google", userID: owner, accountID,
        externalCalendarID: `musubi-google-task-list:${nativeList}`, supportsEvents: false, supportsTasks: true }).returning();
      const [taskRow] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID: home, originCalendarID: home, title: "Home title", description: "Keep notes",
        status: "in-process", due: new Date("2026-10-26T14:45:00Z"), priority: 2, recurrence: recurring ? "FREQ=WEEKLY" : null }).returning();
      await db.insert(calendarTasks).values([home, secondary].map(calendarID => ({ calendarID, taskID })));
      const task = TaskSchema.parse({ ...taskRow, calendarIDs: [home, secondary] }), target = toGoogleTask(task), baseline = { ...target, title: "Before" };
      const [mapping] = await db.insert(externalTasks).values({ taskID, calendarID: secondary, provider: "google", externalCalendarID: source.externalCalendarID,
        externalTaskID: nativeId, etag: '"v1"', accountID, externalCalendarLinkID: source.id, projectionBaseline: baseline }).returning();
      if (enqueue) await db.transaction(tx => appendTaskOutbox(tx, task, [{ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID, calendarID: secondary,
        externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID, externalCalendarID: source.externalCalendarID,
        externalTaskID: nativeId, expectedEtag: '"v1"', providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0, action: "delete", payload: { task, projectionBaseline: baseline } }]));
      return { id, owner, home, secondary, taskID, accountID, source, mapping, target, baseline, task,
        run: (adapter: CalendarAdapter, options: DeliveryAttemptOptions = {}) => deliverTaskOutbox(id, () => adapter, options),
        due: () => db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id)),
        mapped: async () => (await db.select().from(externalTasks).where(eq(externalTasks.id, mapping.id)))[0],
        canonical: async () => (await db.select().from(tasks).where(eq(tasks.id, taskID)))[0]!,
        async cleanup() { await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner)); await db.delete(user).where(eq(user.id, owner)); } };
    };
    const modes = ["success", "initial404", "initial410", "writer-absence", "permission-absence-reappears", "response200", "response202", "response206", "response299", "response404", "response410",
      "lost-applied", "lost-unapplied", "reject412", "reject429", "reject408", "reject503", "initial429", "permission429", "initial401", "exhausted401", "writer401", "delete401", "refresh-narrows", "calendar-grant",
      "assigned-initial", "assigned-permission", "assigned-writer", "changed-writer", "initial-network-error", "writer-network-error", "any-ok-read", "partial-read", "cancel-writer-absence", "invalid-host-task", "legacy-recurring-secondary"];
    for (const paired of modes) {
      let oldWire: typeof requests = [], oldOutcome: unknown;
      for (const [label, adapter] of [["legacy", oldAdapter], ["shared", newAdapter]] as const) {
        reset(paired); const fixture = await seed(paired === "calendar-grant" ? "https://www.googleapis.com/auth/calendar.events" : scope, true, paired === "legacy-recurring-secondary");
        try {
          if (paired === "invalid-host-task") {
            const row = await getTaskOutbox(fixture.id); assert(row);
            await db.update(taskOutbox).set({ payload: { ...row.payload, task: { id: fixture.taskID } as any } }).where(eq(taskOutbox.id, fixture.id));
          }
          let result = await fixture.run(adapter, paired === "cancel-writer-absence" ? { timeoutMs: deadlineMs } : {}); assert(result);
          if (["lost-applied", "lost-unapplied"].includes(paired)) {
            assert.equal(result.status, "unconfirmed"); await fixture.due(); result = await fixture.run(adapter); assert.equal(result?.status, "completed");
            assert.equal(requests.filter(r => r.method === "DELETE").length, paired === "lost-applied" ? 1 : 2);
          }
          const mapping = await fixture.mapped(), canonical = await fixture.canonical();
          assert.equal(canonical.title, "Home title"); assert.equal(canonical.status, "in-process"); assert.equal(canonical.priority, 2); assert.equal(canonical.due?.toISOString(), "2026-10-26T14:45:00.000Z"); assert.equal(canonical.deletedAt, null);
          assert.equal(canonical.recurrence, paired === "legacy-recurring-secondary" ? "FREQ=WEEKLY" : null);
          assert.equal((await db.select().from(calendarTasks).where(and(eq(calendarTasks.taskID, fixture.taskID), eq(calendarTasks.calendarID, fixture.home)))).length, 1);
          const outcome = { status: result!.status, code: result!.errorCode, uncertain: result!.uncertain, resultRef: result!.resultRef,
            mapped: !!mapping, mappedTag: mapping?.etag ?? null, saved: result!.payload.dispatchProjection ?? null, refreshes };
          if (label === "legacy") { oldWire = structuredClone(requests); oldOutcome = outcome; }
          else {
            assert.deepEqual(requests, oldWire, `${paired}: exact path/method/body/If-Match parity`); assert.deepEqual(outcome, oldOutcome, `${paired}: durable settlement parity`);
            if (paired === "success") { assert.equal(sessions, 3); assert.deepEqual(requests.map(r => r.method), ["GET", "GET", "GET", "DELETE"]); }
            if (paired === "writer-absence") { assert.equal(requests.length, 3); assert.equal(requests.filter(r => r.method === "DELETE").length, 0); }
            if (paired === "cancel-writer-absence") { assert.equal(lastSignal?.aborted, true); assert.equal(requests.length, 3); }
            if (paired === "invalid-host-task") { assert.equal(factories, 0); assert.equal(requests.length, 0); }
            else if (paired === "legacy-recurring-secondary") { assert.equal(factories, 0); assert.equal(result!.status, "completed"); }
            else assert(factories >= 1);
            passed++; console.log(`Google task DELETE PG/HTTP parity: ${paired}: PASS`);
          }
          assert.deepEqual(failures, []);
        } finally { await fixture.cleanup(); }
      }
    }
    for (const deferredAddress of [true, false]) {
      reset("success"); const f = await seed();
      try {
        const row = await getTaskOutbox(f.id); assert(row); const envelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), predecessor = randomUUID(), command = randomUUID();
        await db.insert(taskOutbox).values({ ...row, id: predecessor, mutationID: command, status: "completed", predecessorID: null,
          createdAt: new Date(row.createdAt.getTime() - 1), resultRef: { externalTaskId: deferredAddress ? nativeId : "different-native-task", etag: '"v1"' }, remoteSnapshot: f.baseline,
          payload: { ...row.payload, operationEnvelope: { ...envelope, operationId: predecessor, commandId: command } } });
        await db.update(taskOutbox).set({ predecessorID: predecessor, ...(deferredAddress ? { externalTaskID: null, expectedEtag: null } : {}),
          payload: { ...row.payload, operationEnvelope: { ...envelope, predecessorOperationId: predecessor,
            locator: { ...envelope.locator, resourceId: deferredAddress ? null : nativeId } } } }).where(eq(taskOutbox.id, f.id));
        const result = await f.run(newAdapter); assert.equal(factories, deferredAddress ? 1 : 0);
        if (deferredAddress) { assert.equal(result?.status, "completed"); assert.deepEqual(requests.map(r => r.method), ["GET", "GET", "GET", "DELETE"]); }
        else { assert.equal(result?.status, "blocked"); assert.equal(result.errorCode, "task-projection-unavailable"); assert.equal(requests.length, 0); }
        assert.deepEqual(failures, []); passed++; console.log(`Google task DELETE PG/HTTP: ${deferredAddress ? "deferred address uses host-proven shared delivery" : "changed predecessor cannot readdress pinned DELETE"}: PASS`);
      } finally { await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed(scope, false);
      try {
        const unlinked = await unlinkTask(f.taskID, f.secondary, { actorID: f.owner, expectedRevision: 1, mutationID: randomUUID() }); assert(unlinked);
        const [operation] = await db.select().from(taskOutbox).where(eq(taskOutbox.taskID, f.taskID)); assert(operation?.payload.operationEnvelope);
        assert.equal(await f.mapped(), undefined, "Actual unlink removes only the secondary mapping before delivery");
        assert.equal((await deliverTaskOutbox(operation.id, () => newAdapter))?.status, "completed");
        assert.equal((await f.canonical()).title, "Home title"); assert.equal((await f.canonical()).deletedAt, null); assert.equal(await f.mapped(), undefined);
        assert.deepEqual(failures, []); passed++; console.log("Google task DELETE PG/HTTP: actual secondary unlink preserves home and never resurrects mapping: PASS");
      } finally { await f.cleanup(); }
    }
    for (const writerAbsent of [false, true]) {
      reset(writerAbsent ? "writer-absence" : "success"); const f = await seed(), lock = await observer.connect();
      let delivery: ReturnType<typeof f.run> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM external_tasks WHERE id=$1 FOR UPDATE", [f.mapping.id]);
        delivery = f.run(newAdapter, { timeoutMs: deadlineMs }); let waiting = false;
        for (let i = 0; i < 600; i++) {
          if ((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%external_tasks%' AND pid<>pg_backend_pid()")).rowCount) { waiting = true; break; }
          await pause(10);
        }
        assert(waiting); assert(expire); expire(); await lock.query("COMMIT");
        const result = await delivery; assert.equal(result?.status, "unconfirmed"); assert.equal(result?.uncertain, true); assert.equal((await f.mapped())?.etag, '"v1"');
        assert.equal(result?.resultRef?.etag, '"v1"'); await f.due(); assert.equal((await f.run(newAdapter))?.status, "completed");
        assert.equal(requests.filter(r => r.method === "DELETE").length, writerAbsent ? 0 : 1); assert.equal(await f.mapped(), undefined); assert.deepEqual(failures, []);
        passed++; console.log(`Google task DELETE PG/HTTP: actual ACK wait cancellation rolls back (${writerAbsent ? "writer absence" : "accepted DELETE"}): PASS`);
      } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); await delivery?.catch(() => {}); await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      afterRead = async count => { if (count !== 3) return; afterRead = undefined;
        await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id)); };
      try {
        const result = await f.run(newAdapter); assert.equal(result?.status, "blocked"); assert.equal(requests.filter(r => r.method === "DELETE").length, 0);
        assert.equal((await f.mapped())?.etag, '"v1"'); assert.deepEqual(failures, []); passed++; console.log("Google task DELETE PG/HTTP: source retirement before dispatch refuses DELETE: PASS");
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      let inbound: boolean | undefined;
      afterRead = async count => { if (count !== 3) return; afterRead = undefined;
        inbound = await upsertExternalTask("google", f.owner, f.secondary, f.source.externalCalendarID, nativeId, { title: "New inbound", description: "Keep notes", status: "needs-action", start: null,
          due: new Date("2026-10-26T00:00:00Z"), isAllDay: true, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null },
        '"v3"', null, undefined, { sourceID: f.source.id, accountID: f.accountID, providerAccessRevision: f.source.providerAccessRevision }, { ...f.baseline, title: "New inbound" }); };
      try {
        const result = await f.run(newAdapter); assert.equal(result?.status, "completed"); assert.equal(inbound, false); assert.equal(await f.mapped(), undefined);
        assert.equal((await f.canonical()).title, "Home title"); assert.equal(requests.filter(r => r.method === "DELETE").length, 1); assert.deepEqual(failures, []);
        passed++; console.log("Google task DELETE PG/HTTP: actual inbound defers pending DELETE without home resurrection: PASS");
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      afterRead = async count => { if (count !== 3) return; afterRead = undefined;
        // Deliberate local mapping race; actual inbound deferral is proved above.
        await db.update(externalTasks).set({ etag: '"v3"', projectionBaseline: { ...f.baseline, title: "New mapping" } }).where(eq(externalTasks.id, f.mapping.id)); };
      try {
        const result = await f.run(newAdapter); assert.equal(result?.status, "conflict"); assert.equal(result?.uncertain, true);
        assert.equal((await f.mapped())?.etag, '"v3"'); assert.equal(result?.resultRef?.etag, '"v1"'); assert.equal((await f.canonical()).title, "Home title");
        assert.deepEqual(failures, []); passed++; console.log("Google task DELETE PG/HTTP: injected mapping CAS race retains newer local mapping: PASS");
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      let committed!: () => void, release!: () => void; const didCommit = new Promise<void>(resolve => { committed = resolve; }), reply = new Promise<void>(resolve => { release = resolve; });
      const pending = new WeakSet<Client>(), originalQuery = Client.prototype.query;
      const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
        if (typeof text === "string" && /^delete from "external_tasks"/i.test(text) && Array.isArray(values) && values.includes(f.mapping.id)) pending.add(this);
        const actual = Reflect.apply(originalQuery, this, args);
        if (typeof text === "string" && text.trim().toLowerCase() === "commit" && pending.has(this)) { pending.delete(this); return Promise.resolve(actual).then(async value => { committed(); await reply; return value; }); }
        return actual;
      });
      let delivery: ReturnType<typeof f.run> | undefined;
      try {
        delivery = f.run(newAdapter, { timeoutMs: deadlineMs });
        await Promise.race([didCommit, pause(10_000, undefined, { ref: false }).then(() => { throw new Error("DELETE ACK actual COMMIT was not observed"); })]);
        assert.equal((await getTaskOutbox(f.id))?.status, "completed"); assert(expire); expire(); assert.equal((await delivery)?.status, "completed");
        release(); await pause(20); assert.equal((await getTaskOutbox(f.id))?.status, "completed"); assert.equal(await f.mapped(), undefined);
        assert.deepEqual(failures, []); passed++; console.log("Google task DELETE PG/HTTP: actual committed mapping retirement wins late cancellation: PASS");
      } finally { release(); query.mock.restore(); await delivery?.catch(() => {}); await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      try {
        const row = await getTaskOutbox(f.id); assert(row); const envelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope);
        await db.update(taskOutbox).set({ payload: { ...row.payload, operationEnvelope: { ...envelope, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: { title: "Injected" } } } } } }).where(eq(taskOutbox.id, f.id));
        factories = 0; assert.equal((await f.run(newAdapter))?.status, "blocked"); assert.equal(factories, 0); assert.equal(requests.length, 0);
        passed++; console.log("Google task DELETE PG: malformed present DELETE plan never falls back: PASS");
      } finally { await f.cleanup(); }
    }
    console.log(`Google task DELETE PostgreSQL/native HTTP: ${passed} cases passed`);
  } finally {
    timer.mock.restore(); globalThis.fetch = originalFetch; await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await Promise.all([...pools].map(pool => pool.end()));
      const sessions = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [databaseName]);
      assert.equal(sessions.rows[0].count, 0, "Every owned pool must close before nonce database removal");
      await admin.query(`DROP DATABASE "${databaseName}"`);
      console.log(`Google task DELETE cleanup: ${pools.size} owned pools closed, zero sessions, nonce DB dropped without FORCE: PASS`);
    } finally { connect.mock.restore(); await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
