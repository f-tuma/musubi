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

/** Real old/shared executors, OAuth, HTTP and PostgreSQL. The closed transport
 * has no live-provider fallback; only this fixture's nonce DB is mutated. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const name = `google_task_create_${randomUUID().replace(/-/g, "")}`, databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  process.env.DATABASE_URL = databaseUrl.href;
  const pools = new Set<Pool>(), originalConnect = Pool.prototype.connect;
  const connect = mock.method(Pool.prototype, "connect", function (this: Pool, ...args: any[]): any {
    if (this !== admin) pools.add(this);
    return Reflect.apply(originalConnect, this, args);
  });
  const originalFetch = globalThis.fetch, scope = "https://www.googleapis.com/auth/tasks";
  let nativeList = "native/list+id", nativeId = "provider/task+id", remote: Record<string, unknown> | null = null;
  let mode = "success", reads = 0, sessions = 0, refreshes = 0, factories = 0;
  let failures: unknown[] = [], requests: { method: string; path: string; body: string; ifMatch: string | null; contentType: string | null;
    cacheControl: string | null; redirect: RequestRedirect | undefined }[] = [];
  let afterRead: ((count: number, list: boolean) => Promise<void>) | undefined;
  let expire: (() => void) | undefined;
  const deadlineMs = 123_479, originalTimer = globalThis.setTimeout;
  const timer = mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === deadlineMs) { expire = () => callback(...args); return originalTimer(callback, 30_000, ...args); }
    return originalTimer(callback, delay, ...args);
  });
  const redirects: (RequestRedirect | undefined)[] = [];
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/token") {
        refreshes++; assert.equal(req.method, "POST");
        return json({ access_token: "c08.create.refreshed", token_type: "Bearer", expires_in: 3600,
          scope: mode === "refresh-narrows" ? "https://www.googleapis.com/auth/calendar.events" : scope });
      }
      const listPath = `/tasks/v1/users/@me/lists/${encodeURIComponent(nativeList)}`;
      const collection = `/tasks/v1/lists/${encodeURIComponent(nativeList)}/tasks`, taskPath = `${collection}/${encodeURIComponent(nativeId)}`;
      assert([listPath, collection, taskPath].includes(req.url!));
      requests.push({ method: req.method!, path: req.url!, body: bytes,
        ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : null,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        cacheControl: typeof req.headers["cache-control"] === "string" ? req.headers["cache-control"] : null, redirect: redirects.shift() });
      assert.match(String(req.headers.authorization), /^Bearer c08\.create\.(?:access|refreshed)$/);
      if (req.method === "DELETE") { assert.equal(req.url, taskPath); remote = null; res.writeHead(204); return res.end(); }
      if (req.method === "GET") {
        reads++; const list = req.url === listPath; await afterRead?.(reads, list);
        if (mode === "initial-network" && list || mode === "readback-network" && !list || mode === "partial-baseline-recovery" && !list && reads === 2) return res.destroy();
        if (mode === "initial429" && list || mode === "readback429" && !list) { res.setHeader("retry-after", "90"); return json({}, 429); }
        if (["initial401", "refresh-narrows"].includes(mode) && reads === 1 || mode === "exhausted401" && list || mode === "readback401" && reads === 2) return json({}, 401);
        if (mode === "list-id-mismatch" && list) return json({ id: "different-list" });
        if (list) {
          if (mode === "any-ok-list") return json({ id: nativeList }, 208);
          if (mode === "partial-list") res.setHeader("content-range", "bytes 0-1/99");
          return json({ id: nativeList });
        }
        if (mode === "readback404" || mode === "readback410") return json({}, mode === "readback404" ? 404 : 410);
        if (!remote) return json({}, 404);
        if (mode === "partial-read") res.setHeader("content-range", "bytes 0-1/99");
        let metadata: unknown;
        if (mode === "metadata-array") metadata = Array.from({ length: 257 }, (_, index) => ({ retained: index }));
        if (mode === "metadata-fields") metadata = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`retained${index}`, index]));
        if (mode === "metadata-depth") { metadata = { retained: true }; for (let depth = 0; depth < 20; depth++) metadata = { child: metadata }; }
        const observed = { ...remote, ...(metadata === undefined ? {} : { ignoredProviderMetadata: metadata }),
          ...(mode === "assigned" ? { assignmentInfo: { surfaceType: "DOCUMENT" } } : {}),
          ...(mode === "changed-title" ? { title: "Different title" } : {}), ...(["changed-notes", "partial-baseline", "partial-baseline-recovery"].includes(mode) ? { notes: "Provider notes" } : {}),
          ...(mode === "legacy-normalization" ? { notes: { opaque: true }, due: "12345T17:00:00Z" } : {}) };
        if (mode === "metadata-infinity") {
          // This is valid wire JSON. Its numeric token overflows the native JS
          // parser; JSON.stringify(Infinity) would silently replace it with null.
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify(observed).replace(/}$/, ',"ignoredProviderMetadata":1e400}'));
        }
        return json(observed, mode === "any-ok-read" ? 208 : 200);
      }
      assert.equal(req.method, "POST"); assert.equal(req.url, collection); assert.equal(req.headers["if-match"], undefined);
      assert.equal(req.headers["content-type"], "application/json");
      const rejection = { post401: 401, post412: 412, post429: 429, post408: 408, post503: 503 }[mode];
      if (rejection) { res.setHeader("retry-after", "90"); return json({}, rejection); }
      remote = { id: nativeId, ...JSON.parse(bytes), etag: '"created"' };
      if (mode === "lost-response") return res.destroy();
      if (mode === "malformed-json") { res.writeHead(201, { "content-type": "application/json" }); return res.end("{"); }
      if (mode === "missing-id") return json({ etag: '"created"' }, 201);
      if (mode === "missing-tag") return json({ id: nativeId }, 201);
      if (mode === "weak-tag") return json({ id: nativeId, etag: 'W/"created"' }, 201);
      if (mode === "empty-id") return json({ id: "", etag: '"created"' }, 201);
      const status = { response200: 200, response204: 204, response202: 202, response206: 206 }[mode] ?? 201;
      return json({ id: nativeId, etag: '"created"' }, status);
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned CREATE fixture assertion failed"); }
  });
  try {
    const database = await import("@musubi/db");
    const { db, user, account, calendars, calendarMembers, calendarTasks, tasks, externalCalendars, externalTasks, taskOutbox,
      appendTaskOutbox, getTaskOutbox, upsertExternalTask } = database;
    pools.add(db.$client); const observer = new Pool({ connectionString: databaseUrl.href, max: 3 }); pools.add(observer);
    const { migrateDatabase } = await import("../../../../packages/db/src/migrate"), { config } = await import("@musubi/config");
    const { deliverTaskOutbox } = await import("./task_delivery"), { googleAdapter, toGoogleTask } = await import("./adapters/google");
    await migrateDatabase(); assert.equal(config.api.syncOperationV1EncoderEnabled, true);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert(["https://tasks.googleapis.com", "https://oauth2.googleapis.com"].includes(url.origin), "No external network fallback");
      if (mode === "cancel-before-readback" && url.pathname.endsWith(`/tasks/${encodeURIComponent(nativeId)}`)) { assert(expire); expire(); }
      if (url.origin === "https://tasks.googleapis.com") redirects.push(init?.redirect);
      const response = await originalFetch(`${origin}${url.pathname}${url.search}`, init);
      if (mode === "cancel-after-raw-response" && init?.method === "POST" && response.status === 201) { assert(expire); expire(); }
      if (mode === "cancel-writer-return" && init?.method === "POST" && response.status === 201) {
        const parse = response.json.bind(response);
        response.json = async () => { const value = await parse(); assert(expire); expire(); return value; };
      }
      return response;
    };
    const oldAdapter: CalendarAdapter = { ...googleAdapter, googleTaskCreateV1: undefined };
    const newAdapter: CalendarAdapter = { ...googleAdapter, googleTaskCreateV1(...args) {
      factories++; const bridge = googleAdapter.googleTaskCreateV1!(...args);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { ...bridge.ports.accountSession,
        async open(target, signal) { sessions++; return bridge.ports.accountSession.open(target, signal); } } } };
    } };
    const reset = (next: string) => {
      mode = next; nativeList = next === "native-prefix" ? "musubi-google-task-list:physical/list" : "native/list+id";
      nativeId = next === "long-response-id" ? `native-${"x".repeat(2050)}` : "provider/task+id";
      remote = null; reads = sessions = refreshes = factories = 0; failures = []; requests = []; redirects.length = 0; afterRead = undefined; expire = undefined;
    };
    let passed = 0;
    const seed = async (options: { scope?: string; baseline?: Record<string, unknown> | null; recurring?: boolean; pinned?: boolean; action?: "create" | "update" | "delete" } = {}) => {
      const owner = `task-create:${randomUUID()}`, home = randomUUID(), secondary = randomUUID(), taskID = randomUUID(), id = randomUUID(), accountID = randomUUID();
      await db.insert(user).values({ id: owner, name: "C08 CREATE fixture", email: `${randomUUID()}@example.invalid` });
      const [credential] = await db.insert(account).values({ id: randomUUID(), userId: owner, providerId: "google", accountId: accountID, scope: options.scope ?? scope,
        accessToken: "c08.create.access", refreshToken: "c08.create.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }).returning();
      await db.insert(calendars).values([home, secondary].map(id => ({ id, creatorID: owner, name: "CREATE fixture", color: "#112233" })));
      await db.insert(calendarMembers).values([home, secondary].map(calendarID => ({ calendarID, userID: owner, role: "owner" as const })));
      const [source] = await db.insert(externalCalendars).values({ calendarID: secondary, provider: "google", userID: owner, accountID,
        externalCalendarID: `musubi-google-task-list:${nativeList}`, supportsEvents: false, supportsTasks: true }).returning();
      const [taskRow] = await db.insert(tasks).values({ id: taskID, creatorID: owner, calendarID: home, originCalendarID: home, title: "Accepted A", description: "Keep notes",
        status: "in-process", due: new Date("2026-10-26T14:45:00Z"), priority: 2, recurrence: options.recurring ? "FREQ=WEEKLY" : null }).returning();
      await db.insert(calendarTasks).values([home, secondary].map(calendarID => ({ calendarID, taskID })));
      const task = TaskSchema.parse({ ...taskRow, calendarIDs: [home, secondary] }), target = toGoogleTask(task);
      await db.transaction(tx => appendTaskOutbox(tx, task, [{ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID, calendarID: secondary,
        externalCalendarLinkID: source.id, provider: "google", userID: owner, accountID, externalCalendarID: source.externalCalendarID,
        externalTaskID: null, expectedEtag: null, providerAccessRevision: source.providerAccessRevision, retiredGeneration: 0,
        action: options.action ?? "create", payload: { task, projectionBaseline: options.baseline ?? null } }]));
      if (options.pinned === false) {
        const row = await getTaskOutbox(id); assert(row); const { operationEnvelope: _envelope, operationCapture: _capture, ...payload } = row.payload;
        await db.update(taskOutbox).set({ payload }).where(eq(taskOutbox.id, id));
      }
      return { id, owner, home, secondary, taskID, accountID, credential, source, task, target,
        run: (adapter: CalendarAdapter, options: DeliveryAttemptOptions = {}) => deliverTaskOutbox(id, () => adapter, options),
        due: () => db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, id)),
        mapped: async () => (await db.select().from(externalTasks).where(eq(externalTasks.taskID, taskID)))[0],
        canonical: async () => (await db.select().from(tasks).where(eq(tasks.id, taskID)))[0]!,
        async cleanup() { await db.delete(taskOutbox).where(eq(taskOutbox.userID, owner)); await db.delete(user).where(eq(user.id, owner)); } };
    };
    const modes = ["success", "response200", "response204", "response202", "response206", "lost-response", "malformed-json", "missing-id", "empty-id", "missing-tag", "weak-tag",
      "post401", "post412", "post429", "post408", "post503", "initial429", "initial401", "exhausted401", "readback401", "refresh-narrows", "calendar-grant", "list-id-mismatch",
      "initial-network", "readback-network", "readback429", "readback404", "readback410", "assigned", "changed-title", "changed-notes", "any-ok-list", "partial-list", "any-ok-read", "partial-read",
      "native-prefix", "long-response-id", "metadata-array", "metadata-fields", "metadata-depth", "metadata-infinity", "partial-baseline", "partial-baseline-recovery",
      "cancel-after-raw-response", "cancel-writer-return", "cancel-before-readback"];
    const noCapturedId = ["response204", "response202", "response206", "lost-response", "malformed-json", "missing-id", "empty-id", "missing-tag", "weak-tag", "post503"];
    for (const paired of modes) {
      let oldWire: typeof requests = [], oldOutcome: unknown;
      for (const [label, adapter] of [["legacy", oldAdapter], ["shared", newAdapter]] as const) {
        reset(paired);
        const f = await seed({ scope: paired === "calendar-grant" ? "https://www.googleapis.com/auth/calendar.events" : scope,
          baseline: paired.startsWith("partial-baseline") ? { notes: "Keep notes" } : null });
        try {
          const pinned = await getTaskOutbox(f.id); assert(pinned?.payload.operationEnvelope);
          let result = await f.run(adapter, paired.startsWith("cancel-") ? { timeoutMs: deadlineMs } : {}); assert(result);
          const first = { status: result.status, code: result.errorCode, uncertain: result.uncertain, resultRef: result.resultRef };
          if (paired === "partial-baseline-recovery") {
            assert.equal(result.status, "unconfirmed"); assert.equal(result.resultRef?.externalTaskId, nativeId);
            let count = requests.length; await f.due(); result = await f.run(adapter); assert.equal(result?.status, "unconfirmed");
            assert.equal(result.errorCode, "task-create-unconfirmed"); assert.equal(await f.mapped(), undefined);
            assert.deepEqual(requests.slice(count).map(r => r.method), ["GET"], "Recovery cannot ACK merely achieved saved-mask fields");
            count = requests.length; await f.due(); mode = "success"; result = await f.run(adapter); assert.equal(result?.status, "completed");
            assert.deepEqual(requests.slice(count).map(r => r.method), ["GET"]);
          }
          if (noCapturedId.includes(paired)) {
            assert.equal(result.status, "unconfirmed"); assert.equal(result.resultRef, null, "API does not durably adopt an early response candidate");
            const calls = requests.length; await f.due(); result = await f.run(adapter); assert.equal(result?.status, "unconfirmed");
            assert.equal(requests.length, calls, "Uncertain unaddressed CREATE never performs another native request");
          }
          if (["cancel-writer-return", "cancel-after-raw-response"].includes(paired)) {
            assert.equal(result.status, "unconfirmed");
            const calls = requests.length, returnedAddress = result.resultRef?.externalTaskId; await f.due(); mode = "success"; result = await f.run(adapter);
            if (returnedAddress) { assert.equal(result?.status, "completed"); assert.deepEqual(requests.slice(calls).map(r => r.method), ["GET"]); }
            else { assert.equal(result?.status, "unconfirmed"); assert.equal(requests.length, calls); }
          }
          if (["readback-network", "readback429", "readback404", "readback410", "changed-title", "changed-notes", "assigned", "cancel-before-readback"].includes(paired)) {
            assert.equal(result!.status, "unconfirmed"); assert.equal(result!.resultRef?.externalTaskId, nativeId, `${paired}/${label}: complete writer return survives caller cancellation`);
            const calls = requests.length; await f.due(); mode = "success"; result = await f.run(adapter); assert.equal(result?.status, "completed");
            assert.deepEqual(requests.slice(calls).map(r => r.method), ["GET"], "Captured-address CREATE recovery only reads");
          }
          if (paired === "post429") {
            assert.equal(result.status, "retry"); assert.equal(result.uncertain, false); assert(result.nextAttemptAt!.getTime() >= Date.now() + 85_000);
            await f.due(); mode = "success"; result = await f.run(adapter); assert.equal(result?.status, "completed");
            assert.equal(requests.filter(r => r.method === "POST").length, 2, "Conclusive rejected CREATE preserves the existing retry floor");
          }
          const mapping = await f.mapped(), canonical = await f.canonical();
          assert.equal(canonical.title, "Accepted A"); assert.equal(canonical.status, "in-process"); assert.equal(canonical.priority, 2);
          assert.equal(canonical.due?.toISOString(), "2026-10-26T14:45:00.000Z"); assert.equal(canonical.deletedAt, null);
          const outcome = { first, status: result!.status, code: result!.errorCode, uncertain: result!.uncertain, resultRef: result!.resultRef,
            mapping: mapping ? { id: mapping.externalTaskID, etag: mapping.etag, baseline: mapping.projectionBaseline } : null,
            saved: result!.payload.dispatchProjection, refreshes };
          if (label === "legacy") { oldWire = structuredClone(requests); oldOutcome = outcome; }
          else {
            assert.deepEqual(outcome, oldOutcome, `${paired}: durable API settlement parity`);
            assert.deepEqual(requests, oldWire, `${paired}: complete native path/method/body/headers/redirect parity`);
            if (paired === "success") {
              assert.equal(sessions, 3); assert.deepEqual(requests.map(r => r.method), ["GET", "POST", "GET"]);
              assert.deepEqual(requests.map(r => r.cacheControl), [null, null, "no-cache"], "Legacy collection preflight and task read retain distinct cache headers");
            }
            if (paired === "post401") assert.equal(refreshes, 0, "POST authentication failures are never replayed");
            if (["initial401", "readback401"].includes(paired)) assert.equal(refreshes, 1);
            if (paired === "partial-baseline") { assert.equal(result!.status, "completed"); assert.equal(mapping?.projectionBaseline?.notes, "Provider notes"); }
            assert(factories > 0); passed++; console.log(`Google task CREATE PG/HTTP parity: ${paired}: PASS`);
          }
          assert.deepEqual(failures, []);
        } finally { await f.cleanup(); }
      }
    }
    for (const phase of ["before-dispatch", "before-ack", "privacy-before-ack"] as const) {
      reset("success"); const f = await seed();
      afterRead = async (_count, list) => {
        if (phase === "before-dispatch" ? !list : list) return;
        afterRead = undefined;
        if (phase === "privacy-before-ack") await db.update(tasks).set({ providerReadRetiredGeneration: 1 }).where(eq(tasks.id, f.taskID));
        else await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id));
      };
      try {
        const result = await f.run(newAdapter); assert.equal(result?.status, "blocked"); assert.equal(result?.uncertain, phase !== "before-dispatch");
        assert.equal(requests.filter(r => r.method === "POST").length, phase === "before-dispatch" ? 0 : 1); assert.equal(await f.mapped(), undefined);
        assert.deepEqual(failures, []); passed++; console.log(`Google task CREATE PG/HTTP: source retirement ${phase}: PASS`);
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      afterRead = async (_count, list) => { if (!list) return; afterRead = undefined;
        await db.update(account).set({ syncStatus: "reconnect_required" }).where(eq(account.id, f.credential.id));
        const [reconnected] = await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, f.credential.id)).returning();
        assert.equal(reconnected.syncReadGeneration, f.credential.syncReadGeneration + 2); };
      try {
        const result = await f.run(newAdapter); assert.equal(result?.status, "blocked"); assert.equal(requests.filter(r => r.method === "POST").length, 0);
        assert.equal(await f.mapped(), undefined); assert.deepEqual(failures, []); passed++; console.log("Google task CREATE PG/HTTP: credential generation change prevents POST: PASS");
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    for (const interruption of ["cancellation", "lease-expiry"] as const) {
      reset("success"); const f = await seed(), lock = await observer.connect();
      let delivery: ReturnType<typeof f.run> | undefined;
      afterRead = async (_count, list) => { if (list) return; afterRead = undefined;
        await lock.query("BEGIN"); await lock.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [f.taskID]); };
      try {
        delivery = f.run(newAdapter, { timeoutMs: deadlineMs }); let waiting = false;
        for (let i = 0; i < 600; i++) {
          if ((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%tasks%' AND pid<>pg_backend_pid()")).rowCount) { waiting = true; break; }
          await pause(10);
        }
        assert(waiting, "CREATE ACK must reach its actual task lock");
        if (interruption === "cancellation") { assert(expire); expire(); }
        else await db.update(taskOutbox).set({ leaseUntil: new Date(0) }).where(eq(taskOutbox.id, f.id));
        await lock.query("COMMIT");
        const result = await delivery;
        assert.equal(await f.mapped(), undefined, "Unsuccessful ACK must not commit a provisional mapping");
        if (interruption === "cancellation") {
          assert.equal(result?.status, "unconfirmed"); assert.equal(result?.resultRef?.externalTaskId, nativeId); assert.deepEqual(result?.remoteSnapshot, f.target);
          const count = requests.length; await f.due(); assert.equal((await f.run(newAdapter))?.status, "completed");
          assert.deepEqual(requests.slice(count).map(r => r.method), ["GET"]);
        } else {
          assert.equal(result?.status, "attempting"); assert.equal(result.resultRef, null, "Expired worker cannot append CREATE history or ACK");
          await f.due(); const count = requests.length; assert.equal((await f.run(newAdapter))?.status, "unconfirmed");
          assert.equal(requests.length, count, "Unaddressed expired CREATE remains HOLD without a second POST");
        }
        assert.equal(requests.filter(r => r.method === "POST").length, 1);
        assert.deepEqual(failures, []); passed++; console.log(`Google task CREATE PG/HTTP: actual ACK lock ${interruption} rolls back mapping/history: PASS`);
      } finally { afterRead = undefined; await lock.query("ROLLBACK").catch(() => {}); lock.release(); await delivery?.catch(() => {}); await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      afterRead = async (_count, list) => { if (list) return; afterRead = undefined;
        await db.insert(externalTasks).values({ taskID: f.taskID, calendarID: f.secondary, provider: "google", externalCalendarID: f.source.externalCalendarID,
          externalTaskID: "newer-native-task", etag: '"newer"', accountID: f.accountID, externalCalendarLinkID: f.source.id,
          providerAccessRevision: f.source.providerAccessRevision, projectionBaseline: { ...f.target, title: "Newer mapping" } }); };
      try {
        const result = await f.run(newAdapter); assert.equal(result?.status, "conflict"); assert.equal(result?.uncertain, true);
        assert.equal(result?.resultRef?.externalTaskId, nativeId); assert.deepEqual(result?.remoteSnapshot, f.target);
        assert.equal((await f.mapped())?.externalTaskID, "newer-native-task"); assert.equal((await f.canonical()).title, "Accepted A");
        assert.deepEqual(failures, []); passed++; console.log("Google task CREATE PG/HTTP: competing mapping wins CAS without losing exact returned proof: PASS");
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      afterRead = async (_count, list) => {
        if (list) return; afterRead = undefined;
        await upsertExternalTask("google", f.owner, f.secondary, f.source.externalCalendarID, nativeId, {
          title: "New inbound", description: "Keep notes", status: "needs-action", start: null, due: new Date("2026-10-26T00:00:00Z"), isAllDay: true,
          completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null,
        }, '"inbound"', null, undefined, { sourceID: f.source.id, accountID: f.accountID, providerAccessRevision: f.source.providerAccessRevision }, { ...f.target, title: "New inbound" });
      };
      try {
        const result = await f.run(newAdapter); assert(result); assert.equal((await f.canonical()).title, "Accepted A");
        assert.deepEqual(failures, []); passed++; console.log("Google task CREATE PG/HTTP: actual inbound during readback preserves richer canonical task: PASS");
      } finally { afterRead = undefined; await f.cleanup(); }
    }
    for (const variant of ["invalid-plan", "invalid-host-task", "v0", "recurring-secondary", "predecessor-create", "deferred-update", "deferred-delete"] as const) {
      reset("success"); const f = await seed({ pinned: variant !== "v0", recurring: variant === "recurring-secondary" });
      try {
        const row = await getTaskOutbox(f.id); assert(row);
        if (variant === "invalid-plan") {
          const envelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope);
          await db.update(taskOutbox).set({ payload: { ...row.payload, operationEnvelope: { ...envelope, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: { title: "Injected" } } } } } }).where(eq(taskOutbox.id, f.id));
        } else if (variant === "invalid-host-task") await db.update(taskOutbox).set({ payload: { ...row.payload, task: { id: f.taskID } as any } }).where(eq(taskOutbox.id, f.id));
        else if (["predecessor-create", "deferred-update", "deferred-delete"].includes(variant)) {
          const envelope = SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), predecessor = randomUUID(), command = randomUUID();
          remote = { id: nativeId, ...f.target, etag: '"created"' };
          await db.insert(taskOutbox).values({ ...row, id: predecessor, mutationID: command, status: "completed", predecessorID: null,
            createdAt: new Date(row.createdAt.getTime() - 1), resultRef: { externalTaskId: nativeId, etag: '"created"', icalUid: null }, remoteSnapshot: f.target,
            payload: { ...row.payload, operationEnvelope: { ...envelope, operationId: predecessor, commandId: command } } });
          if (variant !== "predecessor-create") await db.insert(externalTasks).values({ taskID: f.taskID, calendarID: f.secondary, provider: "google",
            externalCalendarID: f.source.externalCalendarID, externalTaskID: nativeId, etag: '"created"', accountID: f.accountID,
            externalCalendarLinkID: f.source.id, providerAccessRevision: f.source.providerAccessRevision, projectionBaseline: f.target });
          const action = variant === "deferred-delete" ? "delete" : variant === "deferred-update" ? "update" : "create";
          const plan = action === "delete" ? { ...envelope.nativePlan, data: { planKind: "json-body", body: null } } : envelope.nativePlan;
          await db.update(taskOutbox).set({ predecessorID: predecessor, action, payload: { ...row.payload,
            operationEnvelope: { ...envelope, operation: { ...envelope.operation, action }, predecessorOperationId: predecessor, nativePlan: plan } } }).where(eq(taskOutbox.id, f.id));
        }
        const result = await f.run(newAdapter); assert(result); assert.equal(factories, 0, "Excluded or malformed family must not create the shared bridge");
        if (["invalid-plan", "invalid-host-task"].includes(variant)) assert.equal(requests.length, 0);
        else if (variant === "recurring-secondary") { assert.equal(result.status, "blocked"); assert.equal(requests.length, 0); }
        else assert.equal(result.status, "completed");
        assert.deepEqual(failures, []); passed++; console.log(`Google task CREATE PG/HTTP: ${variant} retains its declared route: PASS`);
      } finally { await f.cleanup(); }
    }
    {
      reset("success"); const f = await seed();
      let committed!: () => void, release!: () => void; const didCommit = new Promise<void>(resolve => { committed = resolve; }), reply = new Promise<void>(resolve => { release = resolve; });
      const pending = new WeakSet<Client>(), originalQuery = Client.prototype.query;
      const query = mock.method(Client.prototype, "query", function (this: Client, ...args: any[]): any {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
        if (typeof sql === "string" && /^insert into "external_tasks"/i.test(sql) && Array.isArray(values) && values.includes(f.taskID)) pending.add(this);
        const actual = Reflect.apply(originalQuery, this, args);
        if (typeof sql === "string" && sql.trim().toLowerCase() === "commit" && pending.has(this)) { pending.delete(this); return Promise.resolve(actual).then(async value => { committed(); await reply; return value; }); }
        return actual;
      });
      let delivery: ReturnType<typeof f.run> | undefined;
      try {
        delivery = f.run(newAdapter, { timeoutMs: deadlineMs });
        await Promise.race([didCommit, pause(10_000, undefined, { ref: false }).then(() => { throw new Error("CREATE ACK real COMMIT was not observed"); })]);
        assert.equal((await getTaskOutbox(f.id))?.status, "completed"); assert(expire); expire(); assert.equal((await delivery)?.status, "completed");
        release(); await pause(20); assert.equal((await f.mapped())?.externalTaskID, nativeId);
        assert.equal(requests.filter(r => r.method === "POST").length, 1); assert.deepEqual(failures, []); passed++; console.log("Google task CREATE PG/HTTP: real committed ACK wins delayed reply cancellation: PASS");
      } finally { release(); query.mock.restore(); await delivery?.catch(() => {}); await f.cleanup(); }
    }
    console.log(`Google task CREATE PostgreSQL/native HTTP: ${passed} cases passed`);
  } finally {
    timer.mock.restore(); globalThis.fetch = originalFetch; await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      await Promise.all([...pools].map(pool => pool.end()));
      console.log(JSON.stringify({ cleanup: await dropOwnedTestDatabase(admin, name, "google_task_create_") }));
      console.log(`Google task CREATE cleanup: ${pools.size} owned pools closed, zero sessions, nonce DB dropped without FORCE: PASS`);
    } finally { connect.mock.restore(); await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
