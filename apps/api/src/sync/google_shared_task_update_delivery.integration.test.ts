import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client, Pool } from "pg";
import { dropOwnedTestDatabase } from "./owned_database_fixture_cleanup";
import { mock } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import type { CalendarAdapter } from "./adapter";
import type { DeliveryAttemptOptions } from "./delivery_policy";

/** Actual old/new host, native HTTP, OAuth and PostgreSQL boundary. No real
 * provider URL is reachable through this fixture's closed transport. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const databaseName = `google_task_update_${randomUUID().replace(/-/g, "")}`;
  const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  process.env.DATABASE_URL = databaseUrl.href;
  // Own pools from every loader identity before removing this fixture's DB.
  const pools = new Set<Pool>(), originalConnect = Pool.prototype.connect;
  const connect = mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]): any {
    if (this !== admin) pools.add(this);
    return Reflect.apply(originalConnect, this, args);
  });
  let observer: Pool | undefined;
  const originalFetch = globalThis.fetch;
  const nativeList = "native/list+id", nativeId = "native/task+id", scope = "https://www.googleapis.com/auth/tasks";
  type Native = { id: string; etag: string; title: string; notes: unknown; status: string; due: unknown; assignmentInfo?: unknown };
  const before = (): Native => ({ id: nativeId, etag: '"v1"', title: "Before", notes: "Keep notes", status: "needsAction", due: "2026-10-26T00:00:00.000Z" });
  let remote = before(), mode = "success", applied = false, reads = 0, refreshes = 0, sessions = 0, factoryCalls = 0;
  let requests: { method: string; path: string; body: unknown; ifMatch: string | null }[] = [], failures: unknown[] = [];
  let afterApplied: (() => Promise<void>) | undefined;
  let afterRead: ((read: number) => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/token") {
        refreshes++; assert.equal(req.method, "POST");
        return json({ access_token: "c08.task.refreshed", token_type: "Bearer", expires_in: 3600,
          scope: mode === "refresh-narrows" ? "https://www.googleapis.com/auth/calendar.events" : scope });
      }
      const path = `/tasks/v1/lists/${encodeURIComponent(nativeList)}/tasks/${encodeURIComponent(nativeId)}`;
      assert.equal(req.url, path);
      requests.push({ method: req.method!, path, body: bytes ? JSON.parse(bytes) : null,
        ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : null });
      assert.match(String(req.headers.authorization), /^Bearer c08\.task\.(?:access|refreshed)$/);
      if (req.method === "GET") {
        reads++;
        await afterRead?.(reads);
        if (applied) await afterApplied?.();
        if (mode === "initial-network-error" && reads === 1 || mode === "writer-network-error" && reads === 3) return res.destroy();
        if (mode === "absent") return json({}, 410);
        if (mode === "initial429" || mode === "final429" && applied) { res.setHeader("retry-after", "90"); return json({}, 429); }
        if (["initial401", "refresh-narrows"].includes(mode) && reads === 1 || mode === "exhausted401" && reads <= 2 || mode === "writer401" && reads === 3) {
          res.setHeader("retry-after", "90"); return json({}, 401);
        }
        return json(remote);
      }
      assert.equal(req.method, "PATCH"); assert.equal(req.headers["if-match"], '"v1"');
      if (mode === "412") return json({}, 412);
      if (mode === "patch401") return json({}, 401);
      Object.assign(remote, JSON.parse(bytes), { etag: '"v2"' }); applied = true;
      if (mode === "untouched") remote.notes = { legacy: true };
      if (mode === "lost") return res.destroy();
      if (mode === "malformed") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{"); }
      if (mode === "missing-tag") return json({});
      // The existing successful PATCH parser only requires a strong body tag.
      return json({ etag: '"v2"' });
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned fixture assertion failed"); }
  });
  try {
    const database = await import("@musubi/db");
    const { db, user, account, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      appendTaskOutbox, getTaskOutbox, upsertExternalTask } = database;
    pools.add(db.$client);
    observer = new Pool({ connectionString: databaseUrl.href, max: 3 }); pools.add(observer);
    const { config } = await import("@musubi/config");
    const { migrateDatabase } = await import("../../../../packages/db/src/migrate");
    const { deliverTaskOutbox } = await import("./task_delivery");
    const { googleAdapter, toGoogleTask } = await import("./adapters/google");
    await migrateDatabase(); assert.equal(config.api.syncOperationV1EncoderEnabled, true);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert(["https://tasks.googleapis.com", "https://oauth2.googleapis.com"].includes(url.origin), "No external network fallback");
      return originalFetch(`${origin}${url.pathname}${url.search}`, init);
    };
    const oldAdapter = { ...googleAdapter, googleTaskUpdateV1: undefined };
    const newAdapter: CalendarAdapter = { ...googleAdapter,
      googleTaskUpdateV1(...args) {
        factoryCalls++; const bridge = googleAdapter.googleTaskUpdateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, accountSession: { ...bridge.ports.accountSession,
          async open(target, signal) { sessions++; return bridge.ports.accountSession.open(target, signal); } } } };
      } };
    let passed = 0;
    const seed = async (empty = false, credentialScope = scope) => {
      const owner = `task-update:${randomUUID()}`, calendarID = randomUUID(), taskID = randomUUID(), id = randomUUID(), accountID = randomUUID();
      await db.insert(user).values({ id: owner, name: "C08 task fixture", email: `${randomUUID()}@example.invalid` });
      await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: accountID, scope: credentialScope,
        accessToken: "c08.task.access", refreshToken: "c08.task.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
      await db.insert(calendars).values({ id: calendarID, creatorID: owner, name: "Task fixture", color: "#112233" });
      await db.insert(calendarMembers).values({ calendarID, userID: owner, role: "owner" });
      const [source] = await db.insert(externalCalendars).values({ calendarID, provider: "google", userID: owner, accountID,
        externalCalendarID: `musubi-google-task-list:${nativeList}`, supportsEvents: false, supportsTasks: true }).returning();
      const [taskRow] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID, originCalendarID: calendarID,
        title: empty ? "Before" : "Accepted A", description: "Keep notes", status: "in-process", due: new Date("2026-10-26T14:45:00Z"), priority: 2 }).returning();
      await db.insert(calendarTasks).values({ calendarID, taskID });
      const task = TaskSchema.parse({ ...taskRow, calendarIDs: [calendarID] }), target = toGoogleTask(task);
      const baseline = { ...target, title: "Before" };
      const [mapping] = await db.insert(externalTasks).values({ taskID, calendarID, provider: "google", externalCalendarID: source.externalCalendarID,
        externalTaskID: nativeId, etag: '"v1"', accountID, externalCalendarLinkID: source.id, projectionBaseline: baseline }).returning();
      await db.transaction(tx => appendTaskOutbox(tx, task, [{ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID, calendarID,
        externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID, externalCalendarID: source.externalCalendarID,
        externalTaskID: nativeId, expectedEtag: '"v1"', providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0,
        action: "update", payload: { task, projectionBaseline: baseline } }]));
      const row = await getTaskOutbox(id); assert(row?.payload.operationEnvelope, "Actual host admission must pin this task");
      return { id, owner, accountID, taskID, calendarID, source, mapping, target,
        run: (adapter: CalendarAdapter, options: DeliveryAttemptOptions = {}) => deliverTaskOutbox(id, () => adapter, options),
        due: () => db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id)),
        mapped: async () => (await db.select().from(externalTasks).where(eq(externalTasks.id, mapping.id)))[0]!,
        canonical: async () => (await db.select().from(tasks).where(eq(tasks.id, taskID)))[0]!,
        async cleanup() { await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner)); await db.delete(user).where(eq(user.id, owner)); } };
    };
    for (const paired of ["success", "empty", "lost", "malformed", "missing-tag", "412", "final429", "initial429", "initial401", "exhausted401", "writer401", "patch401", "absent", "assigned", "untouched", "initial-network-error", "writer-network-error", "refresh-narrows", "calendar-grant", "recovery-null-tag", "recovery-weak-tag"] as const) {
      let oldWire: typeof requests = [], oldOutcome: unknown;
      for (const [label, adapter] of [["legacy", oldAdapter], ["shared", newAdapter]] as const) {
        remote = before(); mode = paired; applied = false; reads = refreshes = sessions = factoryCalls = 0; requests = []; failures = [];
        if (paired === "assigned") remote.assignmentInfo = { surfaceType: "DOCUMENT" };
        const fixture = await seed(paired === "empty", paired === "calendar-grant" ? "https://www.googleapis.com/auth/calendar.events" : scope);
        try {
          if (["recovery-null-tag", "recovery-weak-tag"].includes(paired)) {
            const oldTag = paired === "recovery-null-tag" ? null : 'W/"old"';
            remote = { ...remote, ...fixture.target, etag: '"v2"' };
            await db.update(taskOutbox).set({ expectedEtag: oldTag, uncertain: true, status: "unconfirmed" }).where(eq(taskOutbox.id, fixture.id));
            await db.update(externalTasks).set({ etag: oldTag }).where(eq(externalTasks.id, fixture.mapping.id));
          }
          let result = await fixture.run(adapter); assert(result);
          if (["lost", "malformed", "missing-tag"].includes(paired)) {
            assert.equal(result.status, "unconfirmed"); assert.equal(requests.filter(r => r.method === "PATCH").length, 1);
            await fixture.due(); result = await fixture.run(adapter); assert.equal(result?.status, "completed");
            assert.equal(requests.filter(r => r.method === "PATCH").length, 1, "Recovery must only observe the achieved patch");
          }
          const mapping = await fixture.mapped(), canonical = await fixture.canonical();
          assert.equal(canonical.status, "in-process"); assert.equal(canonical.due?.toISOString(), "2026-10-26T14:45:00.000Z"); assert.equal(canonical.priority, 2);
          const outcome = { status: result!.status, errorCode: result!.errorCode, uncertain: result!.uncertain,
            resultEtag: result!.resultRef?.etag ?? null, mappingEtag: mapping.etag, baseline: mapping.projectionBaseline,
            patch: result!.payload.dispatchProjection?.patch ?? null, refreshes };
          if (label === "legacy") { oldWire = structuredClone(requests); oldOutcome = outcome; }
          else {
            assert.deepEqual(requests, oldWire, `${paired}: exact native path/method/body/original If-Match parity`);
            assert.deepEqual(outcome, oldOutcome, `${paired}: durable outcome parity`);
            assert.equal(factoryCalls, ["lost", "malformed", "missing-tag"].includes(paired) ? 2 : 1);
            if (paired === "success") { assert.equal(sessions, 4); assert.equal(requests.length, 5); }
            if (paired === "empty") assert.deepEqual(requests.map(r => r.method), ["GET", "GET"]);
            if (["final429", "initial429"].includes(paired)) assert(result!.nextAttemptAt!.getTime() >= Date.now() + 85_000);
            passed++; console.log(`Google task UPDATE PG/HTTP parity: ${paired}: PASS`);
          }
          assert.deepEqual(failures, []);
        } finally { await fixture.cleanup(); }
      }
    }
    {
      remote = before(); mode = "success"; applied = false; reads = 0; requests = []; failures = []; factoryCalls = 0;
      const fixture = await seed();
      try {
        const row = await getTaskOutbox(fixture.id); assert(row);
        const predecessor = randomUUID(), command = randomUUID();
        const originalBaseline = { ...fixture.target, title: "Before" };
        const admittedEnvelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope);
        await db.insert(taskOutbox).values({ ...row, id: predecessor, mutationID: command, status: "completed", predecessorID: null,
          createdAt: new Date(row.createdAt.getTime() - 1), resultRef: { externalTaskId: nativeId, etag: '"v1"' }, remoteSnapshot: originalBaseline,
          payload: { ...row.payload, operationEnvelope: { ...row.payload.operationEnvelope!, operationId: predecessor, commandId: command } } });
        await db.update(taskOutbox).set({ externalTaskID: null, expectedEtag: null, predecessorID: predecessor,
          payload: { ...row.payload, operationEnvelope: { ...admittedEnvelope, predecessorOperationId: predecessor,
            locator: { ...admittedEnvelope.locator, resourceId: null } } } }).where(eq(taskOutbox.id, fixture.id));
        assert.equal((await fixture.run(newAdapter))?.status, "completed");
        assert.equal(factoryCalls, 1, "Deferred-address successor uses the shared kernel with host-proven lineage");
        assert.deepEqual(requests.map(r => r.method), ["GET", "GET", "GET", "PATCH", "GET"]); assert.deepEqual(failures, []);
        passed++; console.log("Google task UPDATE PG/HTTP: deferred-address successor uses host-proven shared delivery: PASS");
      } finally { await fixture.cleanup(); }
    }
    for (const retirement of ["before-dispatch", "before-ack"] as const) {
      remote = before(); mode = "success"; applied = false; reads = 0; requests = []; failures = [];
      const fixture = await seed();
      afterRead = async count => {
        if (retirement === "before-dispatch" ? count !== 3 : !applied) return;
        afterRead = undefined;
        await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, fixture.source.id));
      };
      try {
        const result = await fixture.run(newAdapter); assert(result);
        assert.equal(result.status, "blocked");
        assert.equal(result.errorCode, retirement === "before-dispatch" ? "task-source-read-only" : "operation-source-changed");
        assert.equal(result.uncertain, retirement === "before-ack");
        assert.equal(requests.filter(r => r.method === "PATCH").length, retirement === "before-dispatch" ? 0 : 1);
        assert.equal((await fixture.mapped()).etag, '"v1"'); assert.deepEqual(failures, []);
        passed++; console.log(`Google task UPDATE PG/HTTP: source retirement ${retirement} fences mutation/adoption: PASS`);
      } finally { afterRead = undefined; await fixture.cleanup(); }
    }
    {
      remote = before(); mode = "success"; applied = false; requests = []; failures = []; factoryCalls = 0;
      const fixture = await seed();
      try {
        const row = await getTaskOutbox(fixture.id); assert(row);
        const predecessor = randomUUID(), command = randomUUID();
        await db.insert(taskOutbox).values({ ...row, id: predecessor, mutationID: command, status: "completed", predecessorID: null,
          createdAt: new Date(row.createdAt.getTime() - 1), resultRef: { externalTaskId: "different-native-task", etag: '"v2"' }, remoteSnapshot: fixture.target,
          payload: { ...row.payload, operationEnvelope: { ...row.payload.operationEnvelope!, operationId: predecessor, commandId: command } } });
        await db.update(taskOutbox).set({ predecessorID: predecessor, payload: { ...row.payload,
          operationEnvelope: { ...row.payload.operationEnvelope!, predecessorOperationId: predecessor } } }).where(eq(taskOutbox.id, fixture.id));
        const result = await fixture.run(newAdapter);
        assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "task-projection-unavailable");
        assert.equal(factoryCalls, 0); assert.equal(requests.length, 0); assert.equal((await fixture.mapped()).etag, '"v1"');
        passed++; console.log("Google task UPDATE PG: addressed predecessor cannot readdress frozen native locator: PASS");
      } finally { await fixture.cleanup(); }
    }
    {
      remote = before(); mode = "success"; applied = false; requests = []; failures = [];
      const fixture = await seed(), lock = await observer.connect(), deadlineMs = 123_461;
      let expire: (() => void) | undefined;
      const originalTimer = globalThis.setTimeout;
      const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (delay === deadlineMs) { expire = () => callback(...args); return originalTimer(callback, 30_000, ...args); }
        return originalTimer(callback, delay, ...args);
      });
      let delivery: ReturnType<typeof fixture.run> | undefined;
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM external_tasks WHERE id=$1 FOR UPDATE", [fixture.mapping.id]);
        delivery = fixture.run(newAdapter, { timeoutMs: deadlineMs });
        let waiting = false;
        for (let index = 0; index < 600; index++) {
          if ((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%external_tasks%' AND pid<>pg_backend_pid()")).rowCount) { waiting = true; break; }
          await pause(10);
        }
        assert(waiting, "Shared task ACK must reach its real mapping lock"); assert(expire); expire(); await lock.query("COMMIT");
        const result = await delivery; assert.equal(result?.status, "unconfirmed"); assert.equal((await fixture.mapped()).etag, '"v1"');
        assert.equal(result?.resultRef?.etag, '"v2"'); assert.deepEqual(result?.remoteSnapshot, fixture.target);
        await fixture.due(); assert.equal((await fixture.run(newAdapter))?.status, "completed");
        assert.equal(requests.filter(r => r.method === "PATCH").length, 1); assert.deepEqual(failures, []);
        passed++; console.log("Google task UPDATE PG/HTTP: actual ACK-lock deadline rollback and GET-only recovery: PASS");
      } finally { timer.mock.restore(); await lock.query("ROLLBACK").catch(() => {}); lock.release(); await delivery?.catch(() => {}); await fixture.cleanup(); }
    }
    {
      remote = before(); mode = "success"; applied = false; requests = []; failures = [];
      const fixture = await seed();
      afterApplied = async () => {
        afterApplied = undefined;
        await upsertExternalTask("google", fixture.owner, fixture.calendarID, fixture.source.externalCalendarID, nativeId, {
          title: "New inbound content", description: "Keep notes", status: "needs-action", start: null, due: new Date("2026-10-26T00:00:00Z"), isAllDay: true,
          completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null,
        }, '"v3"', null, undefined, { sourceID: fixture.source.id, accountID: fixture.accountID, providerAccessRevision: fixture.source.providerAccessRevision }, { ...fixture.target, title: "New inbound content" });
      };
      try {
        const result = await fixture.run(newAdapter); assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "task-provider-conflict");
        assert.equal(result?.uncertain, true); assert.equal(result?.resultRef?.etag, '"v2"'); assert.deepEqual(result?.remoteSnapshot, fixture.target);
        assert.equal((await fixture.mapped()).etag, '"v3"'); assert.equal((await fixture.canonical()).title, "Accepted A");
        assert.deepEqual(failures, []); passed++; console.log("Google task UPDATE PG/HTTP: actual inbound mapping wins over shared ACK: PASS");
      } finally { afterApplied = undefined; await fixture.cleanup(); }
    }
    {
      remote = before(); mode = "success"; applied = false; requests = []; failures = [];
      const fixture = await seed(), deadlineMs = 123_462;
      let expire: (() => void) | undefined, committed!: () => void, release!: () => void;
      const didCommit = new Promise<void>(resolve => { committed = resolve; }), reply = new Promise<void>(resolve => { release = resolve; });
      const originalTimer = globalThis.setTimeout;
      const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (delay === deadlineMs) { expire = () => callback(...args); return originalTimer(callback, 30_000, ...args); }
        return originalTimer(callback, delay, ...args);
      });
      const pending = new WeakSet<Client>(), originalQuery = Client.prototype.query;
      const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
        if (typeof text === "string" && /^update "external_tasks"/i.test(text) && Array.isArray(values) && values.includes(fixture.mapping.id)) pending.add(this);
        const actual = Reflect.apply(originalQuery, this, args);
        if (typeof text === "string" && text.trim().toLowerCase() === "commit" && pending.has(this)) {
          pending.delete(this); return Promise.resolve(actual).then(async value => { committed(); await reply; return value; });
        }
        return actual;
      });
      let delivery: ReturnType<typeof fixture.run> | undefined;
      try {
        delivery = fixture.run(newAdapter, { timeoutMs: deadlineMs });
        await Promise.race([didCommit, pause(10_000, undefined, { ref: false }).then(() => { throw new Error("Actual shared ACK COMMIT was not observed"); })]);
        assert.equal((await getTaskOutbox(fixture.id))?.status, "completed"); assert(expire); expire();
        assert.equal((await delivery)?.status, "completed"); release(); await pause(20);
        assert.equal((await getTaskOutbox(fixture.id))?.status, "completed"); assert.equal((await fixture.mapped()).etag, '"v2"');
        assert.equal(requests.filter(r => r.method === "PATCH").length, 1); assert.deepEqual(failures, []);
        passed++; console.log("Google task UPDATE PG/HTTP: actual COMMIT wins deadline before delayed reply: PASS");
      } finally { release(); query.mock.restore(); timer.mock.restore(); await delivery?.catch(() => {}); await fixture.cleanup(); }
    }
    {
      remote = before(); mode = "success"; requests = []; failures = [];
      const fixture = await seed();
      try {
        // Real selected-family decoder failure must never call its lazy factory.
        const row = await getTaskOutbox(fixture.id); assert(row);
        await db.update(taskOutbox).set({ payload: { ...row.payload, operationEnvelope: { ...row.payload.operationEnvelope!, serializer: { id: "google-task", version: 999 } } } as any }).where(eq(taskOutbox.id, fixture.id));
        factoryCalls = 0;
        assert.equal((await fixture.run(newAdapter))?.status, "blocked"); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
        passed++; console.log("Google task UPDATE PG/HTTP: malformed present envelope fails closed: PASS");
      } finally { await fixture.cleanup(); }
    }
    console.log(`Google task UPDATE PostgreSQL/native HTTP: ${passed} cases passed`);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await Promise.all([...pools].map(pool => pool.end()));
      console.log(JSON.stringify({ cleanup: await dropOwnedTestDatabase(admin, databaseName, "google_task_update_") }));
      console.log(`Google task UPDATE cleanup: ${pools.size} owned pools closed, zero sessions, nonce DB dropped without FORCE: PASS`);
    } finally { connect.mock.restore(); await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
