import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = () => done(); });
  return { promise, resolve };
}

const proofSources = [
  "apps/api/src/sync/engine.ts", "apps/api/src/sync/work_coordinator.ts", "apps/api/src/sync/provider_budget.ts",
  "apps/api/src/sync/oauth.ts", "apps/api/src/sync/provider_http_metrics.ts", "apps/api/src/sync/task_delivery.ts",
  "apps/api/src/sync/google_shared_task_create_delivery.ts", "apps/api/src/sync/adapters/google.ts",
  "apps/api/src/sync/adapters/google_task_provider_bridge.ts", "apps/api/src/tokenCrypto.ts",
  "packages/sync-runtime/src/fair-work.ts", "packages/sync-runtime/src/provider-budget.ts",
  "packages/sync-runtime/src/http-dispatch.ts", "packages/sync-runtime/src/google-task-create.ts",
  "packages/provider-google/src/task-create.ts", "packages/provider-google/src/task-transport.ts",
  "packages/provider-google/src/http-dispatch.ts", "packages/db/src/schema.ts",
  "packages/config/src/index.ts", "packages/config/src/provider-budget.ts",
  "packages/db/src/queries/sync-read-work.ts", "packages/db/src/queries/sync-work-candidates.ts",
  "packages/db/src/queries/provider-budget-cooldowns.ts", "packages/db/src/queries/read-work-transaction.ts",
  "packages/db/src/queries/oauth.ts", "packages/db/src/queries/task-outbox.ts",
  "packages/db/src/queries/operation-admission.ts", "packages/db/drizzle/0086_sync_scheduling.sql",
  "apps/api/src/sync/adapters/caldav.ts", "apps/api/src/sync/caldav_client.ts",
  "apps/api/src/sync/adapters/caldav_alarms.ts", "apps/api/src/sync/adapters/caldav_time.ts",
  "packages/db/src/queries/caldav.ts", "packages/db/src/queries/caldav-alarms.ts",
  "packages/provider-caldav/src/network.ts",
  "apps/api/src/sync/read_attempt.ts", "packages/db/src/queries/external.ts", "packages/db/src/queries/source-read.ts",
  "packages/db/src/queries/tasks.ts", "packages/db/src/queries/events.ts", "packages/db/src/queries/event-outbox.ts",
  "packages/db/src/queries/event-outbox-delivery.ts",
  "apps/api/src/sync/event_delivery.ts", "apps/api/src/sync/google_shared_delivery.ts",
  "apps/api/src/sync/adapters/google_provider_bridge.ts", "packages/sync-runtime/src/google-personal-update.ts",
  "packages/provider-google/src/index.ts",
];
async function sourceHashes() {
  const hashes: Record<string, string> = {}, root = new URL("../../../../", import.meta.url);
  for (const file of proofSources) hashes[file] = createHash("sha256").update(await readFile(new URL(file, root))).digest("hex");
  return hashes;
}

async function cooldownChild() {
  const { bootstrapProviderBudget, stopProviderBudget, withAccountBudgetScope, providerDeferral } = await import("./provider_budget");
  const { observedProviderFetch } = await import("./provider_http_metrics");
  const { db } = await import("@musubi/db");
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches++; throw new Error("A restarted cooldown may not dispatch"); };
  await bootstrapProviderBudget();
  try {
    const error = await withAccountBudgetScope("google", process.argv[3]!, process.argv[4]!,
      () => observedProviderFetch("https://www.googleapis.com/calendar/v3/probe")).then(() => null, error => error);
    const refusal = providerDeferral(error);
    assert.equal(dispatches, 0); assert.equal(refusal?.reason, "cooldown");
    assert.ok(refusal!.blockedDimensions.includes("account"));
    assert.ok(refusal!.retryAtMs > Date.now());
    console.log(JSON.stringify({ child: "cooldown", dispatches, reason: refusal!.reason }));
  } finally { stopProviderBudget(); await db.$client.end(); }
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use an owned disposable PostgreSQL database");
  const adminURL = process.env.DATABASE_URL; assert.ok(adminURL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminURL).hostname));
  process.env.BETTER_AUTH_URL ??= "http://localhost:7531";
  process.env.BETTER_AUTH_SECRET ??= "musubi-budget-integration-synthetic-auth-secret-20261026";
  process.env.GOOGLE_WEB_CLIENT_ID = "budget-fixture-client";
  process.env.GOOGLE_CLIENT_SECRET = "budget-fixture-secret";
  process.env.CALDAV_ENC_KEY ??= "66".repeat(32);
  process.env.FEDERATION_ALLOW_PRIVATE_HOSTS = "true";
  process.env.EXTERNAL_PROVIDER_BUDGET_NAMESPACE = `fixture_${randomUUID().replace(/-/g, "")}`;
  const oneTokenPolicy = {
    provider: { capacity: 1, refillPerSecond: 100 },
    application: { capacity: 1, refillPerSecond: 100 },
    account: { capacity: 1, refillPerSecond: 100 },
  };
  process.env.EXTERNAL_PROVIDER_BUDGETS_JSON = JSON.stringify({ google: oneTokenPolicy, caldav: oneTokenPolicy });
  const name = `c09budget_${randomUUID().replace(/-/g, "")}`, databaseURL = new URL(adminURL);
  databaseURL.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminURL, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  console.log(JSON.stringify({ fixture: { database: name, ownedNonce: true } }));
  process.env.DATABASE_URL = databaseURL.href;
  let store: Awaited<typeof import("@musubi/db")> | undefined;
  let stopBudget: (() => void) | undefined, stopCoordinator: (() => void) | undefined;
  const realFetch = globalThis.fetch;
  const trace: { account: string; method: string; path: string; status: number }[] = [];
  let fixtureFailure: unknown, activeHTTP = 0, maxActiveHTTP = 0;
  let taskFailure = false, tokenHold: ReturnType<typeof deferred> | undefined, tokenEntered: ReturnType<typeof deferred> | undefined;
  let aHold: ReturnType<typeof deferred> | undefined, aEntered: ReturnType<typeof deferred> | undefined;
  let faultRemote: Record<string, unknown> | undefined;
  let preparedTaskRemote: Record<string, unknown> | undefined;
  const preparedEventRemote = { id: "event-logical", etag: '"event-accepted"', status: "confirmed", summary: "Before pooled closure",
    description: null, location: null, start: { dateTime: "2026-10-26T09:00:00.000Z" },
    end: { dateTime: "2026-10-26T10:00:00.000Z" }, organizer: { self: true }, attendees: [] };
  let capturePreparedEvent = false, currentWorkSignal: (() => AbortSignal | undefined) | undefined;
  const preparedEventSignals: (AbortSignal | undefined)[] = [];
  const alarmData = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:alarm-one", "DTSTART;TZID=Europe/Prague:20261026T090000",
    "DTEND;TZID=Europe/Prague:20261026T100000", "SUMMARY:Alarm fixture", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M",
    "DESCRIPTION:Private alarm", "END:VALARM", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const fixture = createServer(async (req, res) => {
    activeHTTP++; maxActiveHTTP = Math.max(maxActiveHTTP, activeHTTP);
    res.once("close", () => { activeHTTP--; });
    const url = new URL(req.url!, "http://fixture.test");
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const who = token.endsWith("-b") ? "b" : token.endsWith("-c") ? "c" : token.endsWith("-d") ? "d" : token.endsWith("-e") ? "e"
      : token.endsWith("-f") ? "f" : token.endsWith("-g") ? "g" : "a";
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      trace.push({ account: who, method: req.method!, path: url.pathname + url.search, status });
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    try {
      if (url.pathname.startsWith("/dav/")) {
        assert.equal(req.headers.authorization, `Basic ${Buffer.from("fixture:fixture-password").toString("base64")}`);
        assert.ok(["PROPFIND", "GET"].includes(req.method!), "Alarm preview is read-only");
        const status = req.method === "PROPFIND" ? 207 : 200;
        trace.push({ account: "dav", method: req.method!, path: url.pathname, status });
        if (req.method === "PROPFIND") {
          res.writeHead(207, { "content-type": "application/xml" });
          return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        }
        res.writeHead(200, { "content-type": "text/calendar", etag: '"alarm-before"' }); return res.end(alarmData);
      }
      if (url.pathname === "/token") {
        assert.equal(req.method, "POST");
        let body = ""; for await (const chunk of req) body += chunk;
        assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
        const held = tokenHold; tokenHold = undefined; tokenEntered?.resolve();
        if (held) await held.promise;
        return json({ access_token: "fresh-a", expires_in: 3600 });
      }
      if (token === "stale-a") return json({}, 401);
      assert.ok(["access-a", "fresh-a", "access-b", "access-c", "access-d", "access-e", "access-f", "access-g"].includes(token));
      if (url.pathname === "/tasks/v1/lists/prepared-list/tasks" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        preparedTaskRemote = { ...JSON.parse(body), id: "prepared-task", etag: '"prepared-created"' };
        return json({ id: "prepared-task", etag: '"prepared-created"' }, 201);
      }
      if (url.pathname === "/calendar/v3/calendars/event-calendar/events/event-logical") {
        assert.equal(who, "g");
        if (req.method === "GET") return json(preparedEventRemote);
        assert.equal(req.method, "PATCH"); assert.equal(req.headers["if-match"], preparedEventRemote.etag);
        let body = ""; for await (const chunk of req) body += chunk;
        assert.deepEqual(JSON.parse(body), { summary: "After pooled closure" });
        Object.assign(preparedEventRemote, JSON.parse(body), { etag: '"event-written"' });
        return json(preparedEventRemote);
      }
      if (url.pathname === "/tasks/v1/lists/fault-list/tasks" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        faultRemote = { id: "fault-task", ...JSON.parse(body), etag: '"fault-created"' };
        return json({ id: "fault-task", etag: '"fault-created"' }, 201);
      }
      assert.equal(req.method, "GET");
      if (url.pathname === "/calendar/v3/malformed-throttle") return json({ error: "Known malformed throttle hint" }, 429,
        { "retry-after": url.searchParams.get("hint") === "unsupported" ? "999999999999999999999999999999" : "not-a-provider-date" });
      if (url.pathname === "/calendar/v3/probe") return json({ healthy: true });
      if (url.pathname === "/tasks/v1/users/@me/lists/fault-list") return json({ id: "fault-list" });
      if (url.pathname === "/tasks/v1/users/@me/lists/prepared-list") return json({ id: "prepared-list" });
      if (url.pathname === "/tasks/v1/lists/prepared-list/tasks/prepared-task") {
        assert.ok(preparedTaskRemote, "Readback follows the actual prepared native CREATE");
        return json(preparedTaskRemote);
      }
      if (url.pathname === "/calendar/v3/users/me/calendarList/event-calendar") return json({ id: "event-calendar", accessRole: "owner" });
      if (url.pathname === "/tasks/v1/lists/fault-list/tasks/fault-task") {
        assert.ok(faultRemote, "Readback follows the accepted native CREATE");
        return json({ error: { message: "Known readback throttle" } }, 429, { "retry-after": "60" });
      }
      if (url.pathname === "/oauth2/v3/userinfo") return json({ email: `budget-${who}@example.test` });
      if (url.pathname === "/calendar/v3/users/me/calendarList") {
        if (who === "c") return json({ error: { message: "Fixture account throttle" } }, 429, { "retry-after": "60" });
        const page = Number(url.searchParams.get("pageToken") ?? "0"), pages = who === "a" ? 4 : 1;
        assert.ok(page >= 0 && page < pages);
        return json({ items: page === 0 ? [{ id: `calendar-${who}`, summary: "Events", backgroundColor: "#7A8BA3", accessRole: "owner" }] : [],
          ...(page + 1 < pages ? { nextPageToken: String(page + 1) } : {}) });
      }
      if (url.pathname === "/tasks/v1/users/@me/lists") return json({ items: [{ id: "list", title: "Tasks" }] });
      if (url.pathname === "/tasks/v1/lists/list/tasks") {
        if (taskFailure) return json({}, 403);
        return json({ items: [{ id: "task", title: "Remote task", status: "needsAction", etag: '"task-v1"' }] });
      }
      if (/^\/calendar\/v3\/calendars\/calendar-[ab]\/events$/.test(url.pathname)) {
        const page = Number(url.searchParams.get("pageToken") ?? "0"), pages = who === "a" ? 5 : 1;
        assert.ok(page >= 0 && page < pages);
        if (who === "a" && page === 0 && aHold) {
          const held = aHold; aHold = undefined; aEntered?.resolve(); await held.promise;
        }
        return json({ items: [{ id: `event-${page}`, summary: `Event ${who}-${page}`, etag: `"event-${who}-${page}"`, iCalUID: `native-${page}`,
          start: { dateTime: "2026-10-26T09:00:00Z" }, end: { dateTime: "2026-10-26T10:00:00Z" } }],
          ...(page + 1 < pages ? { nextPageToken: String(page + 1) } : { nextSyncToken: `cursor-${who}` }) });
      }
      throw new Error(`Unexpected fixture route: ${url.pathname}`);
    } catch (error) { fixtureFailure = error; json({ error: "Fixture failed" }, 500); }
  });
  let observer: Pool | undefined;
  try {
    const sourceBefore = await sourceHashes();
    await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (capturePreparedEvent) preparedEventSignals.push(currentWorkSignal?.());
      if (url.origin === origin && url.pathname.startsWith("/dav/")) return realFetch(input, init);
      assert.ok(["www.googleapis.com", "tasks.googleapis.com", "oauth2.googleapis.com"].includes(url.hostname), "No live provider requests");
      return realFetch(`${origin}${url.pathname}${url.search}`, init);
    };
    store = await import("@musubi/db"); const s = store;
    await (await import("@musubi/db/migrate")).migrateDatabase();
    observer = new Pool({ connectionString: databaseURL.href, max: 1 });
    const { eq, and } = await import("drizzle-orm");
    const { config } = await import("@musubi/config");
    const budget = await import("./provider_budget");
    const work = await import("./work_coordinator");
    currentWorkSignal = work.currentSyncWorkSignal;
    const engine = await import("./engine");
    const { getOAuthAccessToken } = await import("./oauth");
    const metrics = await import("./provider_http_metrics");
    stopBudget = budget.stopProviderBudget; stopCoordinator = work.stopSyncWorkCoordinator;
    const owners = { a: `budget-a-${randomUUID()}`, b: `budget-b-${randomUUID()}`, c: `budget-c-${randomUUID()}`, d: `budget-d-${randomUUID()}`, e: `budget-e-${randomUUID()}`, f: `budget-f-${randomUUID()}`, g: `budget-g-${randomUUID()}` };
    const accounts = { a: "account-a", b: "account-b", c: "account-c", d: "account-d", e: "account-e", f: "account-f", g: "account-g" };
    const physical = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), e: randomUUID(), f: randomUUID(), g: randomUUID() };
    for (const who of ["a", "b", "c", "d", "e", "f", "g"] as const) {
      await s.db.insert(s.user).values({ id: owners[who], name: `Budget ${who}`, email: `${owners[who]}@example.test` });
      await s.db.insert(s.account).values({ id: physical[who], userId: owners[who], providerId: "google", accountId: accounts[who],
        scope: `${s.CALENDAR_SCOPE.google}${who === "d" || who === "f" ? `,${s.TASK_SCOPE.google}` : ""}`, refreshToken: "fixture-refresh-a", accessToken: `access-${who}`, accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
    }
    engine.initializeSyncEngine(["pull"]);
    await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    const strict = (who: "a" | "b" | "c") => engine.syncUser(owners[who], { provider: "google", accountId: accounts[who], throwOnError: true });
    const deadline = async <T>(pending: Promise<T>, label: string, timeoutMs = 10_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded bounded fixture deadline`)), timeoutMs);
      })]); } finally { if (timer) clearTimeout(timer); }
    };
    const waitForCredentialLock = async () => {
      for (let i = 0; i < 400; i++) {
        const result = await admin.query("select 1 from pg_stat_activity where datname=$1 and wait_event_type='Lock' and query like '%from \"account\"%'", [name]);
        if (result.rowCount) return; await pause(5);
      }
      throw new Error("Expected the actual current-credential SELECT to block");
    };

    // Actual pagination is longer than the configured one-token burst. Its
    // original continuation must progress, not repeat page zero on every retry.
    aHold = deferred(); aEntered = deferred(); const heldA = aHold;
    const firstA = metrics.withProviderCallMetrics("google", "event", () => strict("a"));
    await deadline(aEntered.promise, "A native read entry");
    const idle = await observer.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'");
    assert.equal(idle.rows[0].n, 0, "Provider HTTP may not hold a DB transaction");
    await deadline(strict("b"), "B progress while A native HTTP is held");
    heldA.resolve(); await deadline(firstA, "A multi-page native continuation");
    assert.equal(fixtureFailure, undefined);
    for (const prefix of ["/calendar/v3/users/me/calendarList", "/calendar/v3/calendars/calendar-a/events"]) {
      const entries = trace.filter(row => row.account === "a" && row.path.startsWith(prefix));
      assert.equal(entries.length, prefix.includes("calendarList") ? 4 : 5);
      assert.equal(new Set(entries.map(row => new URL(row.path, origin).searchParams.get("pageToken") ?? "0")).size, entries.length);
    }
    const aSources = await s.getUserExternalCalendars("google", owners.a, accounts.a);
    assert.equal(aSources[0]!.cursor, "cursor-a");
    let aRows = await s.db.select().from(s.syncReadWork).where(eq(s.syncReadWork.userID, owners.a));
    assert.ok(aRows.every(row => row.requestedGeneration === row.completedGeneration && row.claimToken === null));

    // Cold restart of the budget, with an actual resource 401, must still reach
    // one independent token POST and retry the same native GET exactly once.
    budget.stopProviderBudget(); await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    await s.db.update(s.account).set({ accessToken: "stale-a" }).where(eq(s.account.id, physical.a));
    const eventRow = aRows.find(row => row.stream === "events")!;
    const status = (await s.getSyncReadWorkStatus(eventRow.id))!;
    const request = await s.requestSyncReadWork(status.binding);
    const before401 = trace.length;
    await deadline(work.submitSyncWork({ family: "pull", id: request.workID }), "Cold 401 refresh continuation");
    const flow = trace.slice(before401);
    assert.deepEqual(flow.slice(0, 3).map(row => [row.method, row.status]), [["GET", 401], ["POST", 200], ["GET", 200]]);
    assert.equal(flow.filter(row => row.path === "/token").length, 1);
    assert.equal(flow.filter(row => row.status === 401).length, 1);
    assert.equal((await s.getSyncReadWorkStatus(eventRow.id))!.completedGeneration, request.requestedGeneration);

    // A cancelled waiter cannot cancel the independent shared refresh job.
    await s.db.update(s.account).set({ accessToken: "stale-a", accessTokenExpiresAt: new Date(0) }).where(eq(s.account.id, physical.a));
    const cfg = { tokenEndpoint: "https://oauth2.googleapis.com/token", clientId: "fixture", clientSecret: "fixture" };
    tokenHold = deferred(); tokenEntered = deferred(); const heldToken = tokenHold;
    const leaderController = new AbortController(), beforeShared = trace.length;
    const leader = getOAuthAccessToken("google", owners.a, accounts.a, cfg, { signal: leaderController.signal }).then(() => null, error => error);
    await deadline(tokenEntered.promise, "Shared refresh native entry");
    const sibling = getOAuthAccessToken("google", owners.a, accounts.a, cfg);
    leaderController.abort(new Error("Controlled leader cancellation"));
    assert.match(String(await leader), /Controlled leader cancellation/);
    heldToken.resolve(); assert.equal(await deadline(sibling, "Sibling refresh"), "fresh-a");
    assert.equal(trace.slice(beforeShared).filter(row => row.path === "/token").length, 1);

    // Optional Tasks failure remains a successful strict account sync on the
    // immediately following request, while unread generations remain pending.
    await s.db.update(s.account).set({ scope: `${s.CALENDAR_SCOPE.google},${s.TASK_SCOPE.google}` }).where(eq(s.account.id, physical.a));
    await deadline(strict("a"), "Initial Tasks import");
    const [taskBefore] = await s.db.select().from(s.tasks).where(eq(s.tasks.creatorID, owners.a)); assert.ok(taskBefore);
    taskFailure = true;
    await deadline(strict("a"), "Optional Tasks failure");
    await deadline(strict("a"), "Repeated strict sync during optional Tasks deferral");
    const taskWork = (await s.db.select().from(s.syncReadWork).where(and(eq(s.syncReadWork.userID, owners.a), eq(s.syncReadWork.stream, "tasks"))))[0]!;
    assert.equal(taskWork.lastDeferralKind, "optional-unavailable");
    assert.ok(taskWork.requestedGeneration > taskWork.completedGeneration); assert.equal(taskWork.claimToken, null);
    assert.deepEqual((await s.db.select().from(s.tasks).where(eq(s.tasks.creatorID, owners.a)))[0], taskBefore);

    // A real 429 creates an account-scoped durable gate. No-send refusal and a
    // new process hydrating that gate must not fabricate a native HTTP response.
    await assert.rejects(deadline(strict("c"), "Actual 429"));
    const beforeRefusal = trace.length;
    const priorMetrics = await metrics.providerHttpMetricsRegistry.getMetricsAsJSON();
    const refusal = await deadline(metrics.withProviderCallMetrics("google", "event", () => budget.withAccountBudgetScope("google", owners.c, accounts.c,
      () => metrics.observedProviderFetch("https://www.googleapis.com/calendar/v3/probe"))).then(() => null, error => error), "Long cooldown releases preview", 5000);
    const cooldownRefusal = budget.providerDeferral(refusal);
    assert.equal(cooldownRefusal?.reason, "cooldown");
    assert.ok(cooldownRefusal!.blockedDimensions.includes("account"));
    assert.ok(cooldownRefusal!.retryAtMs > Date.now() + 15_000);
    assert.equal(trace.length, beforeRefusal);
    assert.deepEqual(await metrics.providerHttpMetricsRegistry.getMetricsAsJSON(), priorMetrics, "No HTTP metric for a no-send refusal");
    const durable = await s.loadActiveProviderCooldowns();
    assert.ok(durable.rows.some(row => row.scope.dimension === "account" && row.minimumRemainingMs > 0));
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--cooldown-child", owners.c, accounts.c],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "", childError = "";
    child.stdout.on("data", part => { childOut += part; }); child.stderr.on("data", part => { childError += part; });
    let childExited = false;
    const childExit = new Promise<number | null>(resolve => child.once("exit", code => { childExited = true; resolve(code); }));
    let childCode: number | null;
    try { childCode = await deadline(childExit, "Cooldown child"); }
    finally { if (!childExited) { child.kill("SIGTERM"); await childExit; } }
    assert.equal(childCode, 0, childError);
    assert.ok(childOut.split("\n").some(line => { try { return JSON.parse(line).child === "cooldown"; } catch { return false; } }));

    // The actual queued shared CREATE host must retain a fully returned writer
    // address and uncertainty when readback 429 is real but its cooldown SQL
    // persistence fails. A trigger affects only this owned nonce DB and scope.
    assert.equal(config.api.syncOperationV1EncoderEnabled, true);
    const { TaskSchema } = await import("@musubi/types");
    const home = randomUUID(), secondary = randomUUID(), taskID = randomUUID(), operationID = randomUUID();
    await s.db.insert(s.calendars).values([home, secondary].map(id => ({ id, creatorID: owners.d, name: "Budget CREATE", color: "#112233" })));
    await s.db.insert(s.calendarMembers).values([home, secondary].map(calendarID => ({ calendarID, userID: owners.d, role: "owner" as const })));
    const [taskSource] = await s.db.insert(s.externalCalendars).values({ calendarID: secondary, provider: "google", userID: owners.d,
      accountID: accounts.d, externalCalendarID: "musubi-google-task-list:fault-list", supportsEvents: false, supportsTasks: true }).returning();
    const [taskRow] = await s.db.insert(s.tasks).values({ id: taskID, creatorID: owners.d, calendarID: home, originCalendarID: home,
      title: "Accepted native CREATE", description: "Keep canonical notes", status: "in-process" }).returning();
    await s.db.insert(s.calendarTasks).values([home, secondary].map(calendarID => ({ calendarID, taskID })));
    const task = TaskSchema.parse({ ...taskRow, calendarIDs: [home, secondary] });
    await s.db.transaction(tx => s.appendTaskOutbox(tx, task, [{ id: operationID, actorID: owners.d, mutationID: randomUUID(), position: 0,
      taskID, calendarID: secondary, externalCalendarLinkID: taskSource!.id, provider: "google", userID: owners.d, accountID: accounts.d,
      externalCalendarID: taskSource!.externalCalendarID, externalTaskID: null, expectedEtag: null,
      providerAccessRevision: taskSource!.providerAccessRevision, retiredGeneration: 0, action: "create", payload: { task, projectionBaseline: null } }]));
    const faultKey = s.providerBudgetScopeKey(config.api.providerBudgetNamespace, { dimension: "account", provider: "google", physicalAccountRowID: physical.d });
    assert.match(faultKey, /^[a-f0-9]{64}$/);
    await observer.query(`CREATE FUNCTION c09_budget_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.scope_key = '${faultKey}' THEN RAISE EXCEPTION 'Owned C09 cooldown persistence fault'; END IF; RETURN NEW; END $$`);
    await observer.query("CREATE TRIGGER c09_budget_fault BEFORE INSERT OR UPDATE ON provider_budget_cooldowns FOR EACH ROW EXECUTE FUNCTION c09_budget_fault()");
    const beforeFault = trace.length;
    try {
      await deadline(engine.deliverTaskOutbox(operationID), "Accepted CREATE with cooldown SQL fault");
      const outcome = await s.getTaskOutbox(operationID); assert.ok(outcome);
      assert.equal(outcome.status, "unconfirmed"); assert.equal(outcome.uncertain, true);
      assert.equal(outcome.resultRef?.externalTaskId, "fault-task"); assert.equal(outcome.resultRef?.etag, '"fault-created"');
      assert.ok(outcome.nextAttemptAt.getTime() > Date.now() + 55_000);
      assert.deepEqual(trace.slice(beforeFault).map(row => [row.method, row.status]), [["GET", 200], ["POST", 201], ["GET", 429]]);
      assert.equal(faultRemote?.title, "Accepted native CREATE");
      assert.equal(budget.providerBudgetReadiness().persistenceBlocked, true);
      const beforeBlocked = trace.length, beforeBlockedMetrics = await metrics.providerHttpMetricsRegistry.getMetricsAsJSON();
      const blockedWaiter = new AbortController();
      const blockedCancel = setTimeout(() => blockedWaiter.abort(new Error("Controlled persistence waiter cancellation")), 30);
      const blocked = await metrics.withProviderCallMetrics("google", "event", () => budget.withAccountBudgetScope("google", owners.b, accounts.b,
        () => metrics.observedProviderFetch("https://www.googleapis.com/calendar/v3/probe"), { signal: blockedWaiter.signal })).then(() => null, error => error);
      clearTimeout(blockedCancel);
      assert.match(String(blocked), /Controlled persistence waiter cancellation/);
      assert.equal(budget.providerBudgetReadiness().persistenceBlocked, true);
      assert.equal(trace.length, beforeBlocked);
      assert.deepEqual(await metrics.providerHttpMetricsRegistry.getMetricsAsJSON(), beforeBlockedMetrics);
    } finally {
      await observer.query("DROP TRIGGER c09_budget_fault ON provider_budget_cooldowns");
      await observer.query("DROP FUNCTION c09_budget_fault()");
    }
    await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    assert.equal(budget.providerBudgetReadiness().persistenceBlocked, false);
    assert.ok((await s.loadActiveProviderCooldowns()).rows.some(row => row.scope.key === faultKey && row.minimumRemainingMs > 0));
    assert.equal((await s.getTaskOutbox(operationID))!.resultRef?.externalTaskId, "fault-task");

    // A budget refusal during the actual request preflight is not a provider
    // validation verdict. Canonical/outbox admission must freeze the projection
    // without poisoning every future executor retry with task-write-failed.
    const preparedHome = await s.createCalendar({ creatorID: owners.f, name: "Prepared task home", color: "#112233" });
    const [preparedSource] = await s.db.insert(s.externalCalendars).values({ calendarID: preparedHome.id, provider: "google", userID: owners.f,
      accountID: accounts.f, externalCalendarID: "musubi-google-task-list:prepared-list", supportsEvents: false, supportsTasks: true }).returning();
    const preparedTask = TaskSchema.parse({ id: randomUUID(), creatorID: owners.f, calendarID: preparedHome.id, originCalendarID: preparedHome.id,
      calendarIDs: [preparedHome.id], title: "Prepared after budget hold", description: "Retain frozen content", status: "needs-action" });
    const preparedKey = s.providerBudgetScopeKey(config.api.providerBudgetNamespace,
      { dimension: "account", provider: "google", physicalAccountRowID: physical.f });
    await s.extendProviderCooldowns([{ notBeforeEpochMs: Date.now() + 60_000, scopes: [{ dimension: "account", key: preparedKey }] }]);
    budget.stopProviderBudget(); await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    const beforePreparedPreflight = trace.length;
    const preparedTaskWrites = await deadline(engine.prepareTaskWrites(preparedTask, [{ calendarID: preparedHome.id, action: "create" }]), "Deferred task request preflight", 5000);
    assert.equal(trace.length, beforePreparedPreflight);
    assert.equal(preparedTaskWrites.length, 1);
    const frozenProjection = preparedTaskWrites[0]!.providerProjection;
    assert.ok(frozenProjection); assert.equal(frozenProjection.errorCode, undefined);
    assert.equal(frozenProjection.projection.title, preparedTask.title);
    assert.equal(frozenProjection.baseline, null); assert.deepEqual(frozenProjection.patch, frozenProjection.projection);
    const providerRejected = await engine.prepareTaskWrites({ ...preparedTask, originCalendarID: randomUUID(), recurrence: "FREQ=DAILY" },
      [{ calendarID: preparedHome.id, action: "create" }]);
    assert.equal(providerRejected[0]!.providerProjection!.errorCode, "task-recurrence-projection-unsupported", "Real provider validation remains immutable");
    assert.equal(trace.length, beforePreparedPreflight);
    const preparedMutation = randomUUID();
    const admittedTask = await s.createTask(preparedTask, { actorID: owners.f, mutationID: preparedMutation, preparedDestinations: preparedTaskWrites });
    assert.equal(admittedTask.id, preparedTask.id); assert.equal(admittedTask.title, preparedTask.title);
    const preparedIDs = await s.getTaskMutationOutboxIDs(owners.f, preparedMutation);
    assert.equal(preparedIDs.length, 1); const preparedTaskID = preparedIDs[0]!.id;
    const savedPrepared = (await s.getTaskOutbox(preparedTaskID))!;
    assert.equal(savedPrepared.status, "pending"); assert.equal(savedPrepared.errorCode, null);
    assert.deepEqual(savedPrepared.payload.providerProjection, frozenProjection);
    assert.equal(trace.length, beforePreparedPreflight);
    const otherCooldowns = (await s.db.select().from(s.providerBudgetCooldowns)).filter(row => row.scopeKey !== preparedKey).sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
    const removedCooldown = await s.db.delete(s.providerBudgetCooldowns).where(eq(s.providerBudgetCooldowns.scopeKey, preparedKey)).returning();
    assert.equal(removedCooldown.length, 1, "Only this fixture's verified physical account gate is cleared");
    assert.deepEqual((await s.db.select().from(s.providerBudgetCooldowns)).sort((a, b) => a.scopeKey.localeCompare(b.scopeKey)), otherCooldowns);
    budget.stopProviderBudget(); await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    const beforePreparedDelivery = trace.length;
    await deadline(engine.deliverTaskOutbox(preparedTaskID), "Admitted task retries preflight after budget hold");
    const completedPrepared = (await s.getTaskOutbox(preparedTaskID))!;
    assert.equal(completedPrepared.status, "completed"); assert.equal(completedPrepared.uncertain, false); assert.equal(completedPrepared.errorCode, null);
    assert.equal(completedPrepared.resultRef?.externalTaskId, "prepared-task"); assert.equal(completedPrepared.resultRef?.etag, '"prepared-created"');
    assert.deepEqual(completedPrepared.payload.providerProjection, frozenProjection, "Executor cannot rewrite the admitted projection");
    assert.deepEqual(trace.slice(beforePreparedDelivery).map(row => [row.account, row.method, row.status]), [["f", "GET", 200], ["f", "POST", 201], ["f", "GET", 200]]);
    const [preparedMapping] = await s.db.select().from(s.externalTasks).where(eq(s.externalTasks.taskID, preparedTask.id));
    assert.equal(preparedMapping!.externalCalendarLinkID, preparedSource!.id); assert.equal(preparedMapping!.externalTaskID, "prepared-task");
    assert.equal(preparedMapping!.etag, '"prepared-created"'); assert.equal((await s.getTask(preparedTask.id))!.title, preparedTask.title);

    // The durable request closure must queue the whole operation. Capture the
    // existing coordinator capability at the native HTTP dependency port: one
    // shared signal across all leaves distinguishes a whole operation from
    // separately pooled SDK leaves, including the cold first dispatch wait.
    const { EventSchema } = await import("@musubi/types");
    const preparedEventCalendar = await s.createCalendar({ creatorID: owners.g, name: "Prepared event", color: "#112233" });
    await s.db.insert(s.externalCalendars).values({ calendarID: preparedEventCalendar.id, provider: "google", userID: owners.g,
      accountID: accounts.g, externalCalendarID: "event-calendar", providerAccessRole: "owner", providerAccessRevision: 1 });
    const preparedEvent = EventSchema.parse({ id: randomUUID(), creatorID: owners.g, organizer: owners.g, calendars: [preparedEventCalendar.id],
      originCalendarID: preparedEventCalendar.id, title: preparedEventRemote.summary, description: null, location: null, color: "#112233",
      start: preparedEventRemote.start.dateTime, end: preparedEventRemote.end.dateTime, isAllDay: false, isCanceled: false });
    await s.createEvent(preparedEvent, preparedEvent.calendars);
    const [preparedEventMapping] = await s.db.insert(s.externalEvents).values({ provider: "google", eventID: preparedEvent.id, calendarID: preparedEventCalendar.id,
      externalCalendarID: "event-calendar", externalEventID: "event-logical", etag: preparedEventRemote.etag }).returning();
    const preparedEventNext = { ...preparedEvent, title: "After pooled closure" };
    const deliverPreparedEvent = await deadline(engine.prepareEventWrites([{ action: "update", event: preparedEventNext, previous: preparedEvent,
      patch: { title: preparedEventNext.title }, calendarIDs: [preparedEventCalendar.id] }], { actorID: owners.g, mutationID: randomUUID() }), "Prepare durable event request");
    assert.equal(deliverPreparedEvent.outbox.length, 1);
    const eventCommit = await s.patchEventAndCalendarLinks(preparedEvent.id, 1, { title: preparedEventNext.title }, false, deliverPreparedEvent.outbox);
    assert.equal(eventCommit.status, "saved"); assert.ok(eventCommit.changed);
    budget.stopProviderBudget(); await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    const beforePreparedEvent = trace.length;
    capturePreparedEvent = true;
    let eventReceipts: Awaited<ReturnType<typeof deliverPreparedEvent>>;
    try { eventReceipts = await deadline(deliverPreparedEvent("update", eventCommit.event.revision), "Whole-operation prepared event delivery"); }
    finally { capturePreparedEvent = false; }
    assert.deepEqual(trace.slice(beforePreparedEvent).map(row => [row.account, row.method, row.status]), [["g", "GET", 200], ["g", "GET", 200], ["g", "PATCH", 200]]);
    assert.equal(preparedEventSignals.length, 3); assert.ok(preparedEventSignals.every(signal => signal instanceof AbortSignal));
    assert.equal(new Set(preparedEventSignals).size, 1, "All leaves must retain the same whole-operation coordinator capability");
    assert.equal(eventReceipts.length, 1); assert.equal(eventReceipts[0]!.status, "completed"); assert.equal(eventReceipts[0]!.externalEventID, "event-logical");
    const deliveredEvent = (await s.getEventOutboxRow(deliverPreparedEvent.outbox[0]!.id!))!;
    assert.equal(deliveredEvent.status, "completed"); assert.equal(deliveredEvent.uncertain, false);
    assert.equal(deliveredEvent.resultRef?.externalEventId, "event-logical"); assert.equal(deliveredEvent.resultRef?.etag, '"event-written"');
    assert.equal((await s.db.select().from(s.externalEvents).where(eq(s.externalEvents.id, preparedEventMapping!.id)))[0]!.etag, '"event-written"');
    assert.equal(preparedEventRemote.summary, preparedEventNext.title);
    const beforeRepeatedClosure = trace.length;
    assert.deepEqual(await deliverPreparedEvent("update", eventCommit.event.revision), eventReceipts);
    assert.equal(trace.length, beforeRepeatedClosure, "The completed prepared closure cannot send again");

    // Untrusted malformed headers cannot close the shared persistence gate.
    // A syntactically valid unrepresentable hint quarantines only its verified
    // physical account; it does not manufacture an application-wide quota.
    const malformed = (hint: string) => budget.withAccountBudgetScope("google", owners.e, accounts.e,
      () => metrics.observedProviderFetch(`https://www.googleapis.com/calendar/v3/malformed-throttle?hint=${hint}`,
        { headers: { authorization: "Bearer access-e" } }));
    assert.equal((await deadline(malformed("invalid"), "Invalid Retry-After")).status, 429);
    assert.equal(budget.providerBudgetReadiness().persistenceBlocked, false);
    const unsupportedKey = s.providerBudgetScopeKey(config.api.providerBudgetNamespace,
      { dimension: "account", provider: "google", physicalAccountRowID: physical.e });
    assert.ok(!(await s.loadActiveProviderCooldowns()).rows.some(row => row.scope.key === unsupportedKey));
    assert.equal((await deadline(malformed("unsupported"), "Unsupported Retry-After")).status, 429);
    assert.equal(budget.providerBudgetReadiness().persistenceBlocked, false);
    const quarantined = (await s.loadActiveProviderCooldowns()).rows;
    assert.equal(quarantined.find(row => row.scope.key === unsupportedKey)!.notBeforeEpochMs, 253402300799999);
    assert.ok(quarantined.every(row => row.scope.dimension === "account"));
    const healthy = await deadline(budget.withAccountBudgetScope("google", owners.b, accounts.b,
      () => metrics.observedProviderFetch("https://www.googleapis.com/calendar/v3/probe", { headers: { authorization: "Bearer access-b" } })), "B after unsupported A hint");
    assert.equal(healthy.status, 200);

    // Four durable long quota holds must not occupy every regular continuation
    // slot forever. The host releases each claim at the exact persisted due
    // time; no native page or unread dirty generation is falsely acknowledged.
    const longAccounts: { userID: string; accountID: string; physicalID: string }[] = [];
    for (let index = 0; index < 4; index++) {
      const userID = `budget-long-${randomUUID()}`, accountID = `long-${index}`, physicalID = randomUUID();
      await s.db.insert(s.user).values({ id: userID, name: "Long quota fixture", email: `${userID}@example.test` });
      await s.db.insert(s.account).values({ id: physicalID, userId: userID, providerId: "google", accountId: accountID,
        scope: s.CALENDAR_SCOPE.google, refreshToken: "fixture-refresh-long", accessToken: `access-long-${index}`, accessTokenExpiresAt: new Date(Date.now() + 3600_000) });
      longAccounts.push({ userID, accountID, physicalID });
    }
    await s.extendProviderCooldowns(longAccounts.map(value => ({ notBeforeEpochMs: 253402300799999,
      scopes: [{ dimension: "account" as const, key: s.providerBudgetScopeKey(config.api.providerBudgetNamespace,
        { dimension: "account", provider: "google", physicalAccountRowID: value.physicalID }) }] })));
    budget.stopProviderBudget(); await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
    const beforeLong = trace.length;
    const longResults = await deadline(Promise.all(longAccounts.map(value => engine.syncUser(value.userID,
      { provider: "google", accountId: value.accountID, throwOnError: true }).then(() => null, error => error))), "Long quota claims released", 5000);
    assert.ok(longResults.every(error => error instanceof engine.SyncWorkDeferred));
    assert.equal(trace.length, beforeLong);
    for (const value of longAccounts) {
      const [row] = await s.db.select().from(s.syncReadWork).where(eq(s.syncReadWork.userID, value.userID)); assert.ok(row);
      const state = (await s.getSyncReadWorkStatus(row.id))!;
      assert.equal(state.requestedGeneration, "1"); assert.equal(state.completedGeneration, "0");
      assert.equal(state.notBeforeEpochMs, 253402300799999); assert.equal(state.lastDeferralKind, "budget");
      assert.equal(state.claimToken, null); assert.equal(state.claimGeneration, null); assert.equal(state.leaseUntilEpochMs, null);
    }
    assert.equal((await deadline(budget.withAccountBudgetScope("google", owners.b, accounts.b,
      () => metrics.observedProviderFetch("https://www.googleapis.com/calendar/v3/probe", { headers: { authorization: "Bearer access-b" } })), "B after four long quota holds")).status, 200);

    // Real alarm preview context owns its actor in link.userID rather than
    // address.actorID. The actual wrapped CalDAV adapter must scope both native
    // ACL and resource reads, without granting another connection's identity.
    const alarmOwner = `budget-alarm-${randomUUID()}`;
    await s.db.insert(s.user).values({ id: alarmOwner, name: "Alarm scope", email: `${alarmOwner}@example.test` });
    const { encryptSecret } = await import("./crypto");
    const { normalizeCaldavResource } = await import("./adapters/caldav_time");
    const { caldavAdapter } = await import("./adapters/caldav");
    const alarmAccount = await s.saveCaldavAccount(alarmOwner, `${origin}/dav/`, "fixture", encryptSecret("fixture-password"));
    const alarmCollection = `${origin}/dav/collection/`, alarmResource = `${alarmCollection}one.ics`;
    const alarmCalendar = await s.importExternalCalendar("caldav", alarmOwner, alarmAccount.id, "Alarm fixture",
      { externalId: alarmCollection, name: "Alarm fixture", color: "#7A8BA3", supportsEvents: true });
    await s.replaceExternalEventResource("caldav", alarmOwner, alarmCalendar.id, alarmCollection, alarmResource,
      normalizeCaldavResource({ url: alarmResource, etag: '"alarm-before"', data: alarmData }).map(event => ({
        externalId: event.externalId, etag: '"alarm-before"', icalUid: "alarm-one", values: { title: event.title, start: event.start,
          end: event.end, color: "#7A8BA3", isAllDay: event.isAllDay, description: event.description, location: event.location,
          organizer: "", recurrence: event.recurrence, url: event.url }, providerState: event.providerState, time: { timeModel: event.timeModel! },
      })));
    const [alarmEvent] = await s.db.select().from(s.events).where(eq(s.events.creatorID, alarmOwner)); assert.ok(alarmEvent);
    const alarmContext = await s.getCaldavAlarmContext(alarmOwner, alarmEvent.id);
    assert.equal(alarmContext.link.userID, alarmOwner);
    const beforeAlarm = trace.length, oldAlarmFlag = config.api.caldavAlarmEditsEnabled, oldPrivateFlag = config.security.federationAllowPrivateHosts;
    try {
      config.api.caldavAlarmEditsEnabled = true; config.security.federationAllowPrivateHosts = true;
      const alarm = await deadline(caldavAdapter.readCaldavAlarm!(alarmContext), "Active-budget alarm preview");
      assert.equal(alarm.alarms.minutesBeforeStart, 15); assert.equal(alarm.data, alarmData);
      assert.deepEqual(trace.slice(beforeAlarm).map(row => [row.method, row.status]), [["PROPFIND", 207], ["GET", 200]]);
    } finally { config.api.caldavAlarmEditsEnabled = oldAlarmFlag; config.security.federationAllowPrivateHosts = oldPrivateFlag; }

    // Close the actual coordinator while a scoped preview is blocked in its
    // final credential query. Releasing the real DB wait must not permit HTTP.
    await pause(20); // Existing one-token B/provider/app buckets can refill before the controlled shutdown.
    const previewEntered = deferred(), releasePreview = deferred(), beforeClosed = trace.length;
    const closedMetrics = await metrics.providerHttpMetricsRegistry.getMetricsAsJSON();
    const preview = metrics.withProviderCallMetrics("google", "event", () => budget.withAccountBudgetScope("google", owners.b, accounts.b, async () => {
      previewEntered.resolve(); await releasePreview.promise;
      return metrics.observedProviderFetch("https://www.googleapis.com/calendar/v3/probe", { headers: { authorization: "Bearer access-b" } });
    })).then(() => null, error => error);
    await deadline(previewEntered.promise, "Scoped preview pool entry");
    const blocker = await observer.connect();
    await blocker.query("begin");
    try {
      await blocker.query("LOCK TABLE account IN ACCESS EXCLUSIVE MODE");
      releasePreview.resolve();
      await waitForCredentialLock();
      work.stopSyncWorkCoordinator();
      await blocker.query("commit");
      assert.ok(await deadline(preview, "Closed preview continuation"));
      assert.equal(trace.length, beforeClosed);
      assert.deepEqual(await metrics.providerHttpMetricsRegistry.getMetricsAsJSON(), closedMetrics);
    } finally { await blocker.query("rollback"); blocker.release(); }

    // Also stop/rebootstrap while the very FIRST identity lookup is waiting,
    // before it has acquired a queue capability. The old continuation must not
    // attach itself to a newly activated budget/coordinator after release.
    engine.initializeSyncEngine(["pull"]);
    const initialBlocker = await observer.connect(), beforeReactivation = trace.length;
    const reactivationMetrics = await metrics.providerHttpMetricsRegistry.getMetricsAsJSON();
    await initialBlocker.query("begin");
    try {
      await initialBlocker.query("LOCK TABLE account IN ACCESS EXCLUSIVE MODE");
      const stale = metrics.withProviderCallMetrics("google", "event", () => budget.withAccountBudgetScope("google", owners.b, accounts.b,
        () => metrics.observedProviderFetch("https://www.googleapis.com/calendar/v3/probe", { headers: { authorization: "Bearer access-b" } })))
        .then(() => null, error => error);
      await waitForCredentialLock();
      work.stopSyncWorkCoordinator(); budget.stopProviderBudget();
      engine.initializeSyncEngine(["pull"]);
      await budget.bootstrapProviderBudget({ onRecovered: work.kickSyncWork });
      await initialBlocker.query("commit");
      assert.ok(await deadline(stale, "Pre-queue identity continuation after reactivation"));
      assert.equal(trace.length, beforeReactivation);
      assert.deepEqual(await metrics.providerHttpMetricsRegistry.getMetricsAsJSON(), reactivationMetrics);
    } finally { await initialBlocker.query("rollback"); initialBlocker.release(); }
    assert.equal(fixtureFailure, undefined); assert.ok(maxActiveHTTP <= 4);
    const source = await sourceHashes();
    assert.deepEqual(source, sourceBefore, "Proof sources must not change while the process executes");
    console.log(JSON.stringify({ boundary: "actual-postgres-api-budget-coordinator-native-http", buckets: { capacity: 1, refillPerSecond: 100 },
      pages: { discoveryA: 4, collectionA: 5, repeatedPageZero: false }, cold401: { gets401: 1, tokenPosts: 1, retryGet: true },
      leaderCancellationSharedRefresh: true, optionalTasksRepeatedStrict: true, persistedCooldownChildNoSend: true,
      acceptedCreateReadback429SqlFault: { nativeStatus: 201, readbackStatus: 429, durableStatus: "unconfirmed", retainedResponseAddress: true, failClosedThenRecovered: true },
      taskPreflightBudgetDeferral: { noSavedValidationPoison: true, realCanonicalAdmission: true, frozenProjectionRetained: true, actualRetryCompleted: true, realValidationErrorRetained: true },
      preparedEventDurableClosure: { wholeOperationCapability: true, nativeMethods: ["GET", "GET", "PATCH"], completedReceipt: true, repeatedClosureNoSend: true },
      malformedHints: { invalidIgnored: true, unsupportedPhysicalAccountQuarantine: true, healthyBProgress: true },
      alarmPreviewLinkUserScope: true, coordinatorClosedDuringCredentialWaitNoSend: true,
      stoppedPrequeueIdentityCannotAttachToReactivatedBudget: true,
      longQuotaHoldsReleaseRegularCapacity: { accounts: 4, exactFutureDue: true, noFalseAck: true, noNativeDispatch: true, healthyBProgress: true },
      maxActiveHTTP, fourSlotSaturationProved: false, installed: false, liveProvider: false, productionDeployment: false, source }));
  } finally {
    tokenHold?.resolve(); aHold?.resolve();
    stopCoordinator?.(); stopBudget?.(); globalThis.fetch = realFetch;
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    // Let already-issued read-only candidate SQL settle after closing its
    // scheduler, before ending the pool that owns those queries.
    await pause(30);
    await observer?.end(); await store?.db.$client.end();
    const sessions = await admin.query("select count(*)::int as n from pg_stat_activity where datname=$1", [name]);
    assert.equal(sessions.rows[0].n, 0, "Only drop a nonce DB after every client closes");
    await admin.query(`DROP DATABASE "${name}"`);
    assert.equal((await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount, 0);
    console.log(JSON.stringify({ cleanup: { database: name, sessionsBeforeDrop: 0, plainDrop: true, databaseAbsent: true } }));
    await admin.end();
  }
}

(process.argv[2] === "--cooldown-child" ? cooldownChild() : main()).catch(error => { console.error(error); process.exitCode = 1; });
