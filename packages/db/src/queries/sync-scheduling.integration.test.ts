import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { EventSchema, TaskSchema } from "@musubi/types";

async function child() {
  const store = await import("..");
  if (process.argv[2] === "--claim-child") {
    const claim = await store.claimSyncReadWork(process.argv[3]!);
    console.log(JSON.stringify({ child: "claimed", claim }));
    setInterval(() => {}, 1000);
  } else if (process.argv[2] === "--read-status-child") {
    console.log(JSON.stringify({ child: "read-status", status: await store.getSyncReadWorkStatus(process.argv[3]!) }));
    await store.db.$client.end();
  } else if (process.argv[2] === "--delivery-status-child") {
    const ref = JSON.parse(process.argv[3]!);
    const row = ref.family === "event" ? await store.getEventOutboxRow(ref.id) : ref.family === "task" ? await store.getTaskOutbox(ref.id)
      : (await store.db.select().from(store.outlookMoves).where(eq(store.outlookMoves.id, ref.id)))[0];
    assert(row);
    console.log(JSON.stringify({ child: "delivery-status", status: row.status, claimToken: row.leaseToken, leaseUntil: row.leaseUntil, nextAttemptAt: row.nextAttemptAt }));
    await store.db.$client.end();
  } else {
    const snapshot = await store.loadActiveProviderCooldowns();
    console.log(JSON.stringify({ child: "cooldowns", snapshot }));
    await store.db.$client.end();
  }
}
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use only disposable test PostgreSQL");
  const adminURL = process.env.DATABASE_URL; assert(adminURL);
  const name = `c09db_${randomUUID().replace(/-/g, "")}`, databaseURL = new URL(adminURL); databaseURL.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminURL, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  process.env.DATABASE_URL = databaseURL.href;
  let store: Awaited<typeof import("..")> | undefined, observer: Pool | undefined;
  try {
    store = await import(".."); const s = store;
    await (await import("../migrate")).migrateDatabase();
    observer = new Pool({ connectionString: databaseURL.href, max: 3 });
    const watch = observer;
    const selected = process.argv[2] ?? "all"; let passed = 0;
    const cases: string[] = [];
    async function run(id: string, body: () => Promise<void>) { cases.push(id); if (selected !== "all" && selected !== id) return; await body(); passed++; console.log(`sync scheduling PostgreSQL: ${id}: PASS`); }
    async function fixture() {
      const userID = `c09-${randomUUID()}`, accountID = `opaque-${randomUUID()}`, physicalID = randomUUID();
      await s.db.insert(s.user).values({ id: userID, name: "Before", email: `${randomUUID()}@example.test` });
      await s.db.insert(s.account).values({ id: physicalID, userId: userID, providerId: "google", accountId: accountID,
        scope: "https://www.googleapis.com/auth/calendar.events", refreshToken: "fixture-refresh", accessToken: "fixture-access" });
      const address = { userID, provider: "google" as const, accountID, stream: "discovery" as const, configurationFingerprint: "discovery-v1" };
      return { userID, accountID, physicalID, address, cleanup: () => s.db.delete(s.user).where(eq(s.user.id, userID)) };
    }
    async function claimed(workID: string) { const result = await s.claimSyncReadWork(workID); assert.equal(result.kind, "claimed"); if (result.kind !== "claimed") throw new Error("No claim"); return result.capture; }
    const pullContains = async (workID: string) => (await s.getSyncWorkCandidates({ families: ["pull"] })).candidates.some(row => row.hostRef.id === workID);
    async function waitForWorkWaiters(count: number) {
      for (let i = 0; i < 400; i++) {
        const result = await watch.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%sync_read_work%'");
        if (result.rows[0].count >= count) return; await pause(5);
      }
      throw new Error("Expected queued real work-row lock waits");
    }
    async function waitForLock(pid?: number) {
      for (let i = 0; i < 400; i++) {
        const result = await watch.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and ($1::int is null or pid=$1)", [pid ?? null]);
        if (result.rowCount) return; await pause(5);
      }
      throw new Error("Expected a real PostgreSQL lock wait");
    }
    async function worker(mode: string, argument?: string) {
      const proc = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), mode, ...(argument ? [argument] : [])],
        { env: { ...process.env, DATABASE_URL: databaseURL.href }, stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<void>(resolve => proc.once("exit", () => resolve()));
      const result = await new Promise<any>((resolve, reject) => {
        let output = "", errors = "";
        const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Scheduling child deadline exceeded")); }, 10_000);
        proc.stderr.on("data", chunk => { errors += chunk; });
        proc.stdout.on("data", chunk => { output += chunk; for (const line of output.split("\n")) { try { const value = JSON.parse(line); if (value.child) { clearTimeout(timer); resolve(value); return; } } catch {} } });
        proc.once("exit", code => { if (code) { clearTimeout(timer); reject(new Error(`Scheduling child failed: ${errors.slice(0, 500)}`)); } });
      });
      return { proc, result, exited };
    }
    await run("dirty-mid-pull-enqueue-and-bigint", async () => {
      const f = await fixture(); try {
        const request = await s.requestSyncReadWork(f.address), capture = await claimed(request.workID);
        const selected = await s.getSyncWorkCandidate({ family: "pull", id: request.workID }); assert(selected);
        assert.equal(selected.accountFairnessKey, await s.getSyncPhysicalAccountFairnessKey("google", f.physicalID));
        const next = await s.requestSyncReadWork(f.address); assert.equal(next.requestedGeneration, "2");
        assert.equal((await s.getSyncReadWorkStatus(request.workID))!.claimToken, capture.claimToken);
        assert.equal(await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, capture)), "newer-pending");
        let status = (await s.getSyncReadWorkStatus(request.workID))!; assert.equal(status.completedGeneration, "1"); assert.equal(status.requestedGeneration, "2");
        const nextCapture = await claimed(request.workID); assert.equal(nextCapture.capturedGeneration, "2");
        assert.equal(await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, nextCapture)), "completed");
        await s.db.update(s.syncReadWork).set({ requestedGeneration: 9007199254740993n, completedGeneration: 9007199254740992n }).where(eq(s.syncReadWork.id, request.workID));
        assert.equal((await s.requestSyncReadWork(f.address)).requestedGeneration, "9007199254740994");
        const huge = await claimed(request.workID); assert.equal(huge.capturedGeneration, "9007199254740994");
        await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, huge));
        status = (await s.getSyncReadWorkStatus(request.workID))!; assert.equal(status.completedGeneration, "9007199254740994");
      } finally { await f.cleanup(); }
    });
    await run("budget-identity-is-not-calendar-authorization", async () => {
      const f = await fixture(); try {
        const scope = "https://www.googleapis.com/auth/calendar.freebusy";
        await s.db.update(s.account).set({ scope }).where(eq(s.account.id, f.physicalID));
        const binding = await s.getOwnedOAuthBudgetBinding(f.userID, "google", f.accountID); assert(binding); assert.equal(binding.id, f.physicalID); assert.equal(binding.scope, scope);
        assert.equal(s.hasProviderSyncScopes("google", scope), false); assert.equal(s.googleAvailabilityScope(scope), true);
        await assert.rejects(s.requestSyncReadWork(f.address), s.SyncReadWorkChanged, "Rate identity cannot authorize calendar-content work");
        const duplicate = randomUUID(); await s.db.insert(s.account).values({ id: duplicate, userId: f.userID, providerId: "google", accountId: f.accountID, scope, refreshToken: "fixture-refresh" });
        assert.equal(await s.getOwnedOAuthBudgetBinding(f.userID, "google", f.accountID), null);
        await s.db.delete(s.account).where(eq(s.account.id, duplicate));
        await s.db.update(s.account).set({ syncStatus: "reconnect_required" }).where(eq(s.account.id, f.physicalID));
        assert.equal(await s.getOwnedOAuthBudgetBinding(f.userID, "google", f.accountID), null);
      } finally { await f.cleanup(); }
    });
    await run("claim-race-defer-and-rebind", async () => {
      const f = await fixture(); try {
        const request = await s.requestSyncReadWork(f.address);
        const claims = await Promise.all([s.claimSyncReadWork(request.workID), s.claimSyncReadWork(request.workID)]);
        assert.equal(claims.filter(result => result.kind === "claimed").length, 1);
        const capture = claims.find(result => result.kind === "claimed")!; assert.equal(capture.kind, "claimed"); if (capture.kind !== "claimed") return;
        const retryAt = Date.now() + 60_000; assert.equal(await s.deferSyncReadWork(capture.capture, retryAt), true);
        await s.requestSyncReadWork(f.address); assert((await s.getSyncReadWorkStatus(request.workID))!.notBeforeEpochMs >= retryAt);
        assert.equal((await s.claimSyncReadWork(request.workID)).kind, "not-eligible");
        await s.db.update(s.syncReadWork).set({ notBefore: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        const before = await claimed(request.workID);
        await s.db.update(s.account).set({ accessToken: "normal-rotation", refreshToken: "normal-rotation" }).where(eq(s.account.id, f.physicalID));
        assert.equal(await s.renewSyncReadWork(before), true);
        await s.db.update(s.account).set({ scope: "https://www.googleapis.com/auth/calendar.events extra" }).where(eq(s.account.id, f.physicalID));
        await s.db.update(s.account).set({ scope: "https://www.googleapis.com/auth/calendar.events" }).where(eq(s.account.id, f.physicalID));
        const rebound = await s.requestSyncReadWork(f.address); assert.equal(rebound.workID, request.workID);
        assert.notEqual((await s.getSyncReadWorkStatus(request.workID))!.bindingToken, before.bindingToken);
        await assert.rejects(s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, before)), s.SyncReadWorkChanged);
        assert.equal(await s.releaseSyncReadWork(before), false);
        const fresh = await claimed(request.workID); await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, fresh));
      } finally { await f.cleanup(); }
    });
    await run("post-wait-clock-rolls-back", async () => {
      const f = await fixture(), blocker = await watch.connect(); try {
        const request = await s.requestSyncReadWork(f.address), capture = await claimed(request.workID);
        await blocker.query("begin"); await blocker.query("update sync_read_work set lease_until=clock_timestamp()+interval '120 milliseconds' where id=$1", [request.workID]);
        let pid = 0, signal!: () => void; const started = new Promise<void>(resolve => { signal = resolve; });
        const applying = s.db.transaction(async tx => { pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
          await tx.update(s.user).set({ name: "Must roll back" }).where(eq(s.user.id, f.userID)); signal(); await s.ackSyncReadWorkInTransaction(tx, capture); });
        const rejected = assert.rejects(applying, s.SyncReadWorkChanged);
        await started; await waitForLock(pid); await pause(180); await blocker.query("commit"); await rejected;
        assert.equal((await s.db.select().from(s.user).where(eq(s.user.id, f.userID)))[0]!.name, "Before");
      } finally { await blocker.query("rollback"); blocker.release(); await f.cleanup(); }
    });
    await run("sigkill-preserves-newer-generation", async () => {
      const f = await fixture(); try {
        const request = await s.requestSyncReadWork(f.address), child = await worker("--claim-child", request.workID);
        assert.equal(child.result.claim.kind, "claimed"); await s.requestSyncReadWork(f.address);
        child.proc.kill("SIGKILL"); await child.exited;
        assert.equal((await s.getSyncReadWorkStatus(request.workID))!.completedGeneration, "0");
        await s.db.update(s.syncReadWork).set({ leaseUntil: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        const fresh = await claimed(request.workID); assert.equal(fresh.capturedGeneration, "2");
        assert.equal(await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, fresh)), "completed");
      } finally { await f.cleanup(); }
    });
    await run("dav-microseconds-and-credential-fingerprint", async () => {
      const f = await fixture(); try {
        const [dav] = await s.db.insert(s.caldavAccounts).values({ userID: f.userID, serverUrl: "https://dav.example.test/", username: "fixture", encryptedPassword: "cipher-one" }).returning(); assert(dav);
        await s.db.execute(sql`update caldav_accounts set updated_at='2026-10-26 12:00:00.123456'::timestamp where id=${dav.id}`);
        const first = await s.getOwnedCaldavAccountBinding(f.userID, dav.id); assert(first); assert.equal(first.credentialRevision, "2026-10-26T12:00:00.123456");
        const request = await s.requestSyncReadWork({ ...f.address, provider: "caldav", accountID: dav.id }), capture = await claimed(request.workID);
        await s.db.execute(sql`update caldav_accounts set encrypted_password='cipher-two' where id=${dav.id}`);
        const second = await s.getOwnedCaldavAccountBinding(f.userID, dav.id); assert(second); assert.equal(second.credentialRevision, first.credentialRevision); assert.notEqual(second.credentialFingerprint, first.credentialFingerprint);
        await assert.rejects(s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, capture)), s.SyncReadWorkChanged);
        await s.db.update(s.syncReadWork).set({ leaseUntil: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        assert(await pullContains(request.workID), "The SQL hint alone cannot attest an equal-timestamp credential digest");
        assert.equal((await s.claimSyncReadWork(request.workID)).kind, "retired");
        assert(!(await pullContains(request.workID)), "Composed candidate/claim/candidate cannot hot-loop stale credentials");
        const retired = (await s.getSyncReadWorkStatus(request.workID))!; assert(retired.retiredAt); assert.equal(retired.completedGeneration, "0");
        await s.requestSyncReadWork({ ...f.address, provider: "caldav", accountID: dav.id });
        assert.equal((await s.getSyncReadWorkStatus(request.workID))!.retiredAt, null);
        const fresh = await claimed(request.workID); assert.equal(fresh.capturedGeneration, "2");
        await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, fresh));
        const calendar = await s.importExternalCalendar("caldav", f.userID, dav.id, "DAV", { externalId: "https://dav.example.test/calendar/", name: "DAV", color: "red" });
        const [source] = await s.db.select().from(s.externalCalendars).where(eq(s.externalCalendars.calendarID, calendar.id)); assert(source);
        const address = { ...f.address, provider: "caldav" as const, accountID: dav.id, sourceID: source.id, stream: "components" as const };
        const collection = await s.requestSyncReadWork(address); assert(await pullContains(collection.workID));
        await s.db.update(s.externalCalendars).set({ providerAccessRole: "caldav:read=no;" }).where(eq(s.externalCalendars.id, source.id));
        assert.equal((await s.claimSyncReadWork(collection.workID)).kind, "retired"); assert(!(await pullContains(collection.workID)));
        await s.db.update(s.externalCalendars).set({ providerAccessRole: null }).where(eq(s.externalCalendars.id, source.id));
        await s.requestSyncReadWork(address); assert(await pullContains(collection.workID));
      } finally { await f.cleanup(); }
    });
    for (const mutation of ["membership", "capability", "grant"] as const) await run(`stale-${mutation}-candidate-claim-recovery`, async () => {
      const f = await fixture(); try {
        const calendar = await s.importExternalCalendar("google", f.userID, f.accountID, "Fixture", { externalId: "native", name: "Fixture", color: "red" });
        const [source] = await s.db.select().from(s.externalCalendars).where(eq(s.externalCalendars.calendarID, calendar.id)); assert(source);
        const address = { ...f.address, sourceID: source.id, stream: "events" as const, configurationFingerprint: "events-v1" };
        const request = await s.requestSyncReadWork(address); assert(await pullContains(request.workID));
        if (mutation === "membership") await s.db.delete(s.calendarMembers).where(eq(s.calendarMembers.calendarID, calendar.id));
        if (mutation === "capability") await s.db.update(s.externalCalendars).set({ supportsEvents: false }).where(eq(s.externalCalendars.id, source.id));
        if (mutation === "grant") await s.db.update(s.account).set({ scope: "unavailable" }).where(eq(s.account.id, f.physicalID));
        assert.equal((await s.claimSyncReadWork(request.workID)).kind, "retired");
        assert(!(await pullContains(request.workID))); assert.equal(await s.getNextSyncWorkEligibility(["pull"]), undefined);
        const retired = (await s.getSyncReadWorkStatus(request.workID))!; assert(retired.retiredAt); assert.equal(retired.requestedGeneration, "1"); assert.equal(retired.completedGeneration, "0");
        if (mutation === "membership") await s.db.insert(s.calendarMembers).values({ userID: f.userID, calendarID: calendar.id, role: "owner" });
        if (mutation === "capability") await s.db.update(s.externalCalendars).set({ supportsEvents: true }).where(eq(s.externalCalendars.id, source.id));
        if (mutation === "grant") await s.db.update(s.account).set({ scope: "https://www.googleapis.com/auth/calendar.events" }).where(eq(s.account.id, f.physicalID));
        await s.requestSyncReadWork(address); assert(await pullContains(request.workID));
        const fresh = await claimed(request.workID); assert.equal(fresh.capturedGeneration, "2"); await s.db.transaction(tx => s.ackSyncReadWorkInTransaction(tx, fresh));
      } finally { await f.cleanup(); }
    });
    await run("stale-retirement-cannot-retire-fresh-enqueue", async () => {
      const f = await fixture(), blocker = await watch.connect(); try {
        await s.db.update(s.account).set({ providerId: "microsoft", scope: "Calendars.ReadWrite" }).where(eq(s.account.id, f.physicalID));
        const calendar = await s.importExternalCalendar("microsoft", f.userID, f.accountID, "Fixture", { externalId: "native", name: "Fixture", color: "red" });
        const [source] = await s.db.select().from(s.externalCalendars).where(eq(s.externalCalendars.calendarID, calendar.id)); assert(source);
        const address = { ...f.address, provider: "microsoft" as const, sourceID: source.id, stream: "events" as const, configurationFingerprint: "profile-one" };
        await s.prepareGraphReadConfiguration({ ...address, calendarID: calendar.id }); const request = await s.requestSyncReadWork(address);
        await s.prepareGraphReadConfiguration({ ...address, calendarID: calendar.id, configurationFingerprint: "profile-two" });
        await blocker.query("begin"); await blocker.query("select id from sync_read_work where id=$1 for update", [request.workID]);
        const freshRequest = s.requestSyncReadWork({ ...address, configurationFingerprint: "profile-two" }); await waitForWorkWaiters(1);
        const staleClaim = s.claimSyncReadWork(request.workID); await waitForWorkWaiters(2);
        await blocker.query("commit"); const [fresh] = await Promise.all([freshRequest, staleClaim]); assert.equal(fresh.requestedGeneration, "2");
        const status = (await s.getSyncReadWorkStatus(request.workID))!; assert.equal(status.retiredAt, null); assert.equal(status.requestedGeneration, "2"); assert.equal(status.completedGeneration, "0");
        assert(await pullContains(request.workID)); const capture = await claimed(request.workID); assert.equal(capture.capturedGeneration, "2");
      } finally { await blocker.query("rollback"); blocker.release(); await f.cleanup(); }
    });
    await run("optional-disposition-persists-until-real-claim", async () => {
      const f = await fixture(); try {
        const request = await s.requestSyncReadWork(f.address), capture = await claimed(request.workID), future = Date.now() + 60_000;
        assert.equal(await s.deferSyncReadWork(capture, future, { reason: "optional-unavailable" }), true);
        await s.requestSyncReadWork(f.address); await s.requestSyncReadWork(f.address);
        let status = (await s.getSyncReadWorkStatus(request.workID))!;
        assert.equal(status.lastDeferralKind, "optional-unavailable"); assert.equal(status.requestedGeneration, "3"); assert.equal(status.completedGeneration, "0"); assert(status.notBeforeEpochMs >= future);
        const restart = await worker("--read-status-child", request.workID); await restart.exited; assert.equal(restart.result.status.lastDeferralKind, "optional-unavailable");
        assert.equal((await s.claimSyncReadWork(request.workID)).kind, "not-eligible"); assert.equal((await s.getSyncReadWorkStatus(request.workID))!.lastDeferralKind, "optional-unavailable");
        await s.requestSyncReadWork({ ...f.address, configurationFingerprint: "discovery-v2" }); status = (await s.getSyncReadWorkStatus(request.workID))!;
        assert.equal(status.lastDeferralKind, null); assert(status.notBeforeEpochMs >= future); assert.equal(status.completedGeneration, "0");
        await s.db.update(s.syncReadWork).set({ notBefore: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        const running = await claimed(request.workID); assert.equal(await s.deferSyncReadWork(running, future, { reason: "budget" }), true);
        await s.requestSyncReadWork({ ...f.address, configurationFingerprint: "discovery-v2" }); assert.equal((await s.getSyncReadWorkStatus(request.workID))!.lastDeferralKind, "budget");
        await s.db.update(s.syncReadWork).set({ notBefore: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        await claimed(request.workID); assert.equal((await s.getSyncReadWorkStatus(request.workID))!.lastDeferralKind, null);
      } finally { await f.cleanup(); }
    });
    await run("read-postpone-preserves-claim-restart-and-expiry", async () => {
      const f = await fixture(); try {
        const request = await s.requestSyncReadWork(f.address), capture = await claimed(request.workID), future = Date.now() + 60_000;
        assert.equal(await s.postponeSyncReadWork(capture, future), true); await s.requestSyncReadWork(f.address);
        const status = (await s.getSyncReadWorkStatus(request.workID))!; assert.equal(status.claimToken, capture.claimToken); assert.equal(status.claimGeneration, "1");
        assert.equal(status.completedGeneration, "0"); assert.equal(status.requestedGeneration, "2"); assert(status.notBeforeEpochMs >= future);
        const restart = await worker("--read-status-child", request.workID); await restart.exited; assert.equal(restart.result.status.claimToken, capture.claimToken); assert(restart.result.status.notBeforeEpochMs >= future);
        await s.db.update(s.syncReadWork).set({ leaseUntil: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        assert.equal(await s.postponeSyncReadWork(capture, future + 60_000), false); assert.equal((await s.claimSyncReadWork(request.workID)).kind, "not-eligible");
        await s.db.update(s.syncReadWork).set({ notBefore: new Date(0) }).where(eq(s.syncReadWork.id, request.workID));
        assert.equal((await claimed(request.workID)).capturedGeneration, "2");
      } finally { await f.cleanup(); }
    });
    await run("legacy-write-captures-cannot-split-current-account", async () => {
      const a = await fixture(), b = await fixture(); try {
        const aKey = await s.getSyncPhysicalAccountFairnessKey("google", a.physicalID), bKey = await s.getSyncPhysicalAccountFairnessKey("google", b.physicalID);
        const read = await s.requestSyncReadWork(a.address);
        assert.equal((await s.getSyncWorkCandidate({ family: "pull", id: read.workID }))!.accountFairnessKey, aKey);
        const allA: { family: "event-delivery" | "task-delivery"; id: string }[] = [], allB: string[] = [];
        for (const family of ["event-delivery", "task-delivery"] as const) {
          const insert = async (f: typeof a, captured: string, unknownEnvelope = false) => {
            const id = randomUUID(), objectID = randomUUID(), calendarID = randomUUID(), common = {
              id, actorID: f.userID, userID: f.userID, accountID: f.accountID, provider: "google", mutationID: randomUUID(), position: 0,
              calendarID, externalCalendarLinkID: randomUUID(), externalCalendarID: "retained-without-source", revision: 1, action: "update" as const, nextAttemptAt: new Date(0) };
            const capture = { connectionId: captured }, envelope = unknownEnvelope ? { operationEnvelope: { unknownVersion: 99 } } : {};
            if (family === "event-delivery") {
              await s.db.insert(s.eventOutbox).values({ ...common, eventID: objectID, payload: {
                event: EventSchema.parse({ id: objectID, creatorID: f.userID, title: "Legacy", color: "red", organizer: "", start: new Date(), end: new Date(), isAllDay: false, isCanceled: false, calendars: [calendarID] }),
                operationCapture: capture, ...envelope } });
              if (!unknownEnvelope) assert.equal(s.decodeEventOutboxOperation((await s.getEventOutboxRow(id))!).kind, "legacy-v0");
            } else {
              await s.db.insert(s.taskOutbox).values({ ...common, taskID: objectID, providerAccessRevision: 0, payload: {
                task: TaskSchema.parse({ id: objectID, creatorID: f.userID, calendarID, title: "Legacy" }), operationCapture: capture, ...envelope } });
              if (!unknownEnvelope) assert.equal(s.decodeTaskOutboxOperation((await s.getTaskOutbox(id))!).kind, "legacy-v0");
            }
            return id;
          };
          for (const captured of ["bogus-one", "bogus-two", randomUUID(), b.physicalID]) {
            const id = await insert(a, captured); allA.push({ family, id });
            assert.equal((await s.getSyncWorkCandidate({ family, id }))!.accountFairnessKey, aKey);
          }
          const unknownID = await insert(a, "retained-old-physical-row", true); allA.push({ family, id: unknownID });
          assert.equal((await s.getSyncWorkCandidate({ family, id: unknownID }))!.accountFairnessKey, aKey);
          const bID = await insert(b, a.physicalID); allB.push(bID);
          assert.equal((await s.getSyncWorkCandidate({ family, id: bID }))!.accountFairnessKey, bKey);
          const page = await s.getSyncWorkCandidates({ limit: 2, families: [family] });
          assert(page.candidates.some(row => row.hostRef.id === bID)); assert.equal(new Set(page.candidates.map(row => row.accountFairnessKey)).size, 2);
        }
        const blockedA = await s.getSyncWorkCandidates({ limit: 20, families: ["event-delivery", "task-delivery"], excludedAccounts: [aKey] });
        assert.deepEqual(new Set(blockedA.candidates.map(row => row.hostRef.id)), new Set(allB), "An active actual A excludes all its captured aliases while B remains exposed");
        const duplicate = randomUUID(); await s.db.insert(s.account).values({ id: duplicate, userId: a.userID, providerId: "google", accountId: a.accountID, scope: "https://www.googleapis.com/auth/calendar.events", refreshToken: "fixture-refresh" });
        const logicalKeys = await Promise.all(allA.map(async ref => (await s.getSyncWorkCandidate(ref))!.accountFairnessKey));
        assert.equal(new Set(logicalKeys).size, 1); assert.notEqual(logicalKeys[0], aKey, "Ambiguous association uses one logical fallback, never an arbitrary physical row");
        assert.equal((await s.getSyncWorkCandidate({ family: "pull", id: read.workID }))!.accountFairnessKey, aKey, "Dirty read's real physical FK identity stays unchanged");
        await s.db.delete(s.account).where(eq(s.account.userId, a.userID));
        for (const ref of allA) assert.equal((await s.getSyncWorkCandidate(ref))!.accountFairnessKey, logicalKeys[0]);
        const retained = await s.getSyncWorkCandidates({ limit: 20, families: ["event-delivery", "task-delivery"] });
        for (const ref of allA) assert(retained.candidates.some(row => row.hostRef.id === ref.id), "Legacy/unknown rows survive missing physical/source metadata");
      } finally { await a.cleanup(); await b.cleanup(); }
    });
    await run("caldav-write-hints-require-owned-row", async () => {
      const a = await fixture(), b = await fixture(); try {
        const [own] = await s.db.insert(s.caldavAccounts).values({ userID: a.userID, serverUrl: "https://dav.example.test/own", username: "own", encryptedPassword: "fixture" }).returning(); assert(own);
        const [foreign] = await s.db.insert(s.caldavAccounts).values({ userID: b.userID, serverUrl: "https://dav.example.test/foreign", username: "foreign", encryptedPassword: "fixture" }).returning(); assert(foreign);
        const ownKey = await s.getSyncPhysicalAccountFairnessKey("caldav", own.id), foreignKey = await s.getSyncPhysicalAccountFairnessKey("caldav", foreign.id);
        const refs: { family: "event-delivery"; id: string }[] = [];
        for (const [accountID, captured] of [[own.id, "bogus"], [own.id.toUpperCase(), foreign.id], [foreign.id, own.id], [randomUUID(), own.id]]) {
          const id = randomUUID(), eventID = randomUUID(), calendarID = randomUUID(); refs.push({ family: "event-delivery", id });
          await s.db.insert(s.eventOutbox).values({ id, actorID: a.userID, userID: a.userID, accountID, provider: "caldav", mutationID: randomUUID(), position: 0,
            calendarID, externalCalendarLinkID: randomUUID(), externalCalendarID: "https://dav.example.test/retained", revision: 1, action: "update", payload: {
              event: EventSchema.parse({ id: eventID, creatorID: a.userID, title: "DAV legacy", color: "red", organizer: "", start: new Date(), end: new Date(), isAllDay: false, isCanceled: false, calendars: [calendarID] }),
              operationCapture: { connectionId: captured } }, eventID });
        }
        assert.equal((await s.getSyncWorkCandidate(refs[0]!))!.accountFairnessKey, ownKey);
        assert.equal((await s.getSyncWorkCandidate(refs[1]!))!.accountFairnessKey, ownKey, "Only a host UUID's casing is canonicalized after owned row association");
        assert.notEqual((await s.getSyncWorkCandidate(refs[2]!))!.accountFairnessKey, foreignKey, "A foreign UUID does not attest an owned scheduling identity");
        assert.notEqual((await s.getSyncWorkCandidate(refs[3]!))!.accountFairnessKey, ownKey, "An unavailable UUID does not adopt its payload's capture");
        const page = await s.getSyncWorkCandidates({ limit: 10, families: ["event-delivery"] });
        for (const ref of refs) assert(page.candidates.some(row => row.hostRef.id === ref.id));
      } finally { await a.cleanup(); await b.cleanup(); }
    });
    for (const family of ["event-delivery", "task-delivery"] as const) await run(`${family}-b-behind-40-a`, async () => {
      const a = await fixture(), b = await fixture(); try {
        const insert = async (f: typeof a, count: number, at: Date) => { const ids: string[] = []; for (let i = 0; i < count; i++) {
          const id = randomUUID(), objectID = randomUUID(), calendarID = randomUUID(); ids.push(id);
          const common = { id, actorID: f.userID, userID: f.userID, accountID: f.accountID, provider: "google", mutationID: randomUUID(), position: 0,
            calendarID, externalCalendarLinkID: randomUUID(), externalCalendarID: "retained-no-source", revision: 1, action: "update" as const, nextAttemptAt: at, createdAt: at };
          if (family === "event-delivery") await s.db.insert(s.eventOutbox).values({ ...common, eventID: objectID,
            payload: { event: EventSchema.parse({ id: objectID, creatorID: f.userID, title: "Fixture", color: "red", organizer: "", start: new Date(), end: new Date(), isAllDay: false, isCanceled: false, calendars: [calendarID] }), operationEnvelope: { unknownVersion: 99 } } });
          else await s.db.insert(s.taskOutbox).values({ ...common, taskID: objectID, providerAccessRevision: 0,
            payload: { task: TaskSchema.parse({ id: objectID, creatorID: f.userID, calendarID, title: "Fixture" }), operationEnvelope: { unknownVersion: 99 } } });
        } return ids; };
        const aIDs = await insert(a, 45, new Date(0)); const [bID] = await insert(b, 1, new Date(1000));
        const page = await s.getSyncWorkCandidates({ limit: 2, families: [family] }); assert.equal(page.candidates.length, 2); assert(page.candidates.some(row => row.hostRef.id === bID));
        assert(await s.getSyncWorkCandidate({ family, id: bID! }), "Retained unknown/deleted-source hint is not filtered away");
        if (family === "event-delivery") {
          const taskID = randomUUID(), taskOperationID = randomUUID(), calendarID = randomUUID();
          await s.db.insert(s.taskOutbox).values({ id: taskOperationID, actorID: a.userID, userID: a.userID, accountID: a.accountID,
            provider: "google", mutationID: randomUUID(), position: 0, calendarID, externalCalendarLinkID: randomUUID(),
            externalCalendarID: "retained-task-list", revision: 1, action: "update", taskID, providerAccessRevision: 0, nextAttemptAt: new Date(1000),
            payload: { task: TaskSchema.parse({ id: taskID, creatorID: a.userID, calendarID, title: "Fixture" }) } });
          assert((await s.getSyncWorkCandidates({ limit: 3, families: ["event-delivery", "task-delivery"] })).candidates.some(row => row.hostRef.id === taskOperationID),
            "All-eligible family ranking exposes A's task behind its 45 older events");
        }
        const table = family === "event-delivery" ? s.eventOutbox : s.taskOutbox;
        const future = Date.now() + 60_000;
        await s.db.update(table).set({ nextAttemptAt: new Date(future) }).where(eq(table.id, bID!));
        const futurePage = await s.getSyncWorkCandidates({ limit: 50, families: [family] });
        assert(!futurePage.candidates.some(row => row.hostRef.id === bID)); assert(futurePage.nextWakeAtMs! >= future);
        assert(await s.getSyncWorkCandidate({ family, id: bID! }), "Direct lookup remains advisory for future work");
        await s.db.update(table).set({ predecessorID: aIDs[0]! }).where(eq(table.id, bID!));
        assert.equal(await s.getNextSyncWorkEligibility([family]), undefined, "Pending predecessor cannot create a future hot-loop wake");
        await s.db.update(table).set({ status: "completed" }).where(eq(table.id, aIDs[0]!));
        assert((await s.getNextSyncWorkEligibility([family]))! >= future);
      } finally { await a.cleanup(); await b.cleanup(); }
    });
    for (const kind of ["event", "task"] as const) await run(`${kind}-postpone-preserves-claim-and-expiry`, async () => {
      const f = await fixture(), blocker = await watch.connect(); try {
        const id = randomUUID(), objectID = randomUUID(), calendarID = randomUUID(), common = {
          id, actorID: f.userID, userID: f.userID, accountID: f.accountID, provider: "google", mutationID: randomUUID(), position: 0,
          calendarID, externalCalendarLinkID: randomUUID(), externalCalendarID: "retained", revision: 1, action: "update" as const };
        if (kind === "event") await s.db.insert(s.eventOutbox).values({ ...common, eventID: objectID,
          payload: { event: EventSchema.parse({ id: objectID, creatorID: f.userID, title: "Fixture", color: "red", organizer: "", start: new Date(), end: new Date(), isAllDay: false, isCanceled: false, calendars: [calendarID] }) } });
        else await s.db.insert(s.taskOutbox).values({ ...common, taskID: objectID, providerAccessRevision: 0,
          payload: { task: TaskSchema.parse({ id: objectID, creatorID: f.userID, calendarID, title: "Fixture" }) } });
        const claim = kind === "event" ? await s.claimEventOutbox(id) : await s.claimTaskOutbox(id); assert(claim?.leaseToken);
        const postpone = kind === "event" ? s.postponeEventOutbox : s.postponeTaskOutbox, future = Date.now() + 60_000;
        assert.equal(await postpone(id, claim.leaseToken, future), true);
        const getRow = () => kind === "event" ? s.getEventOutboxRow(id) : s.getTaskOutbox(id);
        const stored = (await getRow())!; assert.equal(stored.leaseToken, claim.leaseToken); assert.equal(stored.status, "attempting"); assert.equal(stored.uncertain, true); assert.equal(stored.leaseUntil!.getTime(), claim.leaseUntil!.getTime());
        const restarted = await worker("--delivery-status-child", JSON.stringify({ family: kind, id })); await restarted.exited;
        assert.equal(restarted.result.claimToken, claim.leaseToken); assert(Date.parse(restarted.result.nextAttemptAt) >= future);
        const table = kind === "event" ? s.eventOutbox : s.taskOutbox;
        if (kind === "event") {
          await blocker.query("begin"); await blocker.query("update event_outbox set lease_until=clock_timestamp()+interval '120 milliseconds' where id=$1", [id]);
          const waiting = postpone(id, claim.leaseToken, future + 60_000); await waitForLock(); await pause(180); await blocker.query("commit"); assert.equal(await waiting, false);
        } else {
          await s.db.update(table).set({ leaseUntil: new Date(0) }).where(eq(table.id, id)); assert.equal(await postpone(id, claim.leaseToken, future + 60_000), false);
        }
        assert.equal((await getRow())!.nextAttemptAt.getTime(), stored.nextAttemptAt.getTime());
        await s.db.update(table).set({ nextAttemptAt: new Date(0) }).where(eq(table.id, id));
        const recovered = kind === "event" ? await s.claimEventOutbox(id) : await s.claimTaskOutbox(id); assert(recovered?.reconciling); assert.notEqual(recovered.leaseToken, claim.leaseToken);
      } finally { await blocker.query("rollback"); blocker.release(); await f.cleanup(); }
    });
    await run("account-cursor-wrap", async () => {
      const fixtures: Awaited<ReturnType<typeof fixture>>[] = []; try {
        const expected = new Set<string>(); for (let i = 0; i < 11; i++) { const f = await fixture(); fixtures.push(f); expected.add((await s.requestSyncReadWork(f.address)).workID); }
        const seen = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 5; page++) { const result = await s.getSyncWorkCandidates({ limit: 3, accountCursor: cursor, families: ["pull"] }); cursor = result.nextAccountCursor; for (const row of result.candidates) seen.add(row.hostRef.id); }
        assert.deepEqual(seen, expected);
      } finally { for (const f of fixtures) await f.cleanup(); }
    });
    await run("move-storage-eligibility-and-defer", async () => {
      // Deliberately tests only the opaque journal's storage/timing boundary.
      // Full first-child admission/native/late-ACK proof stays in the existing
      // outlook_moves integration suite; no family authority is inferred here.
      const f = await fixture(); try {
        const calendar = await s.importExternalCalendar("microsoft", f.userID, f.accountID, "Fixture", { externalId: "native-calendar", name: "Fixture", color: "red" });
        const [source] = await s.db.select().from(s.externalCalendars).where(eq(s.externalCalendars.calendarID, calendar.id)); assert(source);
        const id = randomUUID(), journal = { items: [{ status: "pending", eventID: randomUUID() }], opaqueFixture: true };
        await s.db.execute(sql`insert into outlook_moves(id,actor_id,calendar_id,link_id,event_id,master_id,status,journal,expires_at)
          values(${id},${f.userID},${calendar.id},${source.id},${randomUUID()},'master','running',${JSON.stringify(journal)}::jsonb,clock_timestamp()+interval '10 minutes')`);
        const claim = await s.claimOutlookMove(id); assert(claim?.leaseToken);
        assert.equal(await s.claimOutlookMove(id), undefined);
        const retryAt = Date.now() + 30_000; assert.equal(await s.postponeOutlookMove(claim, retryAt), true);
        const restarted = await worker("--delivery-status-child", JSON.stringify({ family: "move", id })); await restarted.exited;
        assert.equal(restarted.result.claimToken, claim.leaseToken); assert(Date.parse(restarted.result.nextAttemptAt) >= retryAt);
        assert.equal(await s.deferOutlookMove(claim, retryAt), true);
        assert.equal(await s.claimOutlookMove(id), undefined);
        assert(!(await s.pendingOutlookMoves()).some(row => row.id === id));
        assert((await s.getNextSyncWorkEligibility(["outlook-move"]))! >= retryAt);
        assert.deepEqual((await s.db.select().from(s.outlookMoves).where(eq(s.outlookMoves.id, id)))[0]!.journal, journal);
        await s.db.update(s.outlookMoves).set({ nextAttemptAt: new Date(0) }).where(eq(s.outlookMoves.id, id));
        const recovered = await s.claimOutlookMove(id); assert(recovered);
        await s.db.update(s.outlookMoves).set({ leaseUntil: new Date(0) }).where(eq(s.outlookMoves.id, id));
        assert.equal(await s.postponeOutlookMove(recovered, retryAt + 30_000), false);
        assert.deepEqual((await s.getSyncWorkCandidates({ families: [] })).candidates, []);
      } finally { await f.cleanup(); }
    });
    await run("cooldown-max-postwait-and-restart", async () => {
      const key = s.providerBudgetScopeKey(`fixture-${randomUUID()}`, { dimension: "account", provider: "google", physicalAccountRowID: randomUUID() });
      const scope = { key, dimension: "account" as const }, blocker = await watch.connect(); try {
        const future = Date.now() + 60_000;
        await Promise.all([s.extendProviderCooldowns([{ scopes: [scope], notBeforeEpochMs: future }]), s.extendProviderCooldowns([{ scopes: [scope], notBeforeEpochMs: future + 60_000 }])]);
        let row = (await s.extendProviderCooldowns([{ scopes: [scope], notBeforeEpochMs: future - 1 }])).rows[0]!; assert(row.notBeforeEpochMs >= future + 60_000);
        const restarted = await worker("--cooldown-child"); await restarted.exited;
        assert(restarted.result.snapshot.rows.some((r: any) => r.scope.key === key && r.notBeforeEpochMs >= row.notBeforeEpochMs));
        await s.db.update(s.providerBudgetCooldowns).set({ notBefore: new Date(0) }).where(eq(s.providerBudgetCooldowns.scopeKey, key));
        await blocker.query("begin"); await blocker.query("select scope_key from provider_budget_cooldowns where scope_key=$1 for update", [key]);
        const extending = s.extendProviderCooldowns([{ scopes: [scope], notBeforeEpochMs: 0, minimumDelayMs: 250 }]);
        await waitForLock(); await pause(300); await blocker.query("commit"); row = (await extending).rows[0]!;
        assert(row.minimumRemainingMs >= 200, "Relative gate anchors after actual lock wait, not before it");
      } finally { await blocker.query("rollback"); blocker.release(); await s.db.delete(s.providerBudgetCooldowns).where(eq(s.providerBudgetCooldowns.scopeKey, key)); }
    });
    assert(passed > 0, `Unknown scheduling scenario ${selected}; known ${cases.join(",")}`);
  } finally {
    try {
      await observer?.end(); await store?.db.$client.end();
      // Closing our sockets can finish before PostgreSQL observes disconnects.
      // Wait for our own database to become idle; never terminate a session.
      const deadline = Date.now() + 2_000;
      let sessions: number;
      do {
        sessions = (await admin.query("select count(*)::int as count from pg_stat_activity where datname=$1", [name])).rows[0].count;
        if (sessions === 0 || Date.now() >= deadline) break;
        await pause(25);
      } while (true);
      assert.equal(sessions, 0, "Never force-drop a database with live sessions");
      await admin.query(`DROP DATABASE "${name}"`);
    } finally { await admin.end(); }
  }
}
(process.argv[2]?.startsWith("--") ? child() : main()).catch(error => { console.error(error); process.exitCode = 1; });
