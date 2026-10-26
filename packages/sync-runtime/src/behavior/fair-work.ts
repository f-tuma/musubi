import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGoogleTaskCreateProvider } from "@musubi/provider-google";
import { createMicrosoftPersonalEventCreateProvider } from "@musubi/provider-microsoft";
import { dispatchNativeHttp } from "../../../provider-google/src/http-dispatch";
import { TaskSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { createFairWorkCoordinator, type WorkCandidate, type WorkExecutionResult, type WorkPermit } from "../fair-work";
import { createProviderBudget, ProviderDispatchDeferred, parseProviderRetryAfter, requireBudgetContinuationWindow, type BudgetLeaf, type CooldownSnapshot, type DurableCooldownPort } from "../provider-budget";
import { runClaimedGoogleTaskCreate } from "../google-task-create";
import type { SendRawOnce } from "../http-dispatch";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const settled: WorkExecutionResult = { kind: "settled", changedCalendarIDs: [] };
const candidate = (key: string, account = key, family: WorkCandidate<string>["family"] = "pull", lane = key, collision = key): WorkCandidate<string> =>
  ({ key, family, accountFairnessKey: account, laneKey: lane, dueAtMs: 0, orderKey: key, collisionKeys: [collision], hostRef: key });
const scope = (key: string) => ({ key, dimension: "account" as const });
const leaf = (key: string, method = "GET", purpose: BudgetLeaf["purpose"] = "pull"): BudgetLeaf =>
  ({ scopes: [scope(key)], purpose, method, targetKey: key, incarnationKey: "grant-1", operationKey: "operation", attemptKey: "attempt" });
function fixture(cooldowns: DurableCooldownPort = { loadActive: async () => [], extend: async () => [] }, limited = false, capacity = 2) {
  let time = 0;
  const clock = { nowEpochMs: () => time, nowMonotonicMs: () => time };
  const budget = createProviderBudget({ limit: () => limited ? { capacity, refillPerSecond: 2 } : undefined,
    clock, cooldowns, reservationLifetimeMs: 10_000, retryPersistenceMs: 1000, schedule: () => () => {} });
  return { budget, clock, advance: (ms: number) => { time += ms; } };
}
function nativePreflight(key: string, http: ReturnType<ReturnType<typeof createProviderBudget>["decorate"]>, calls: string[], hold?: Promise<void>) {
  const target = { connectionId: key, connectionGeneration: "1", taskListId: key };
  const provider = createGoogleTaskCreateProvider({ http: { ...http, async fetch() { await hold; calls.push(`${key}:GET`); return Response.json({ id: key }); } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
    accountSession: { open: async connection => ({ ...connection, accessToken: "fixture", taskWriteAllowed: true }) },
    beforeMutation: async () => {}, onAcceptedResponse: async () => {}, onResponseAddress: async () => {},
  }, { nativeProfile: "existing-google" });
  return provider.preflightCreate({ target, body: { title: "Fixture", notes: null, status: "needsAction", due: null }, operationId: "operation", attemptId: "attempt", serializer: { id: "google-task", version: 1 } });
}
export interface FairWorkScenario { id: string; title: string; expected: Record<string, unknown> }
export async function loadFairWorkSuite() {
  const value = JSON.parse(await readFile(new URL("./fair-work.json", import.meta.url), "utf8"));
  assert.equal(value.schemaVersion, 1); assert.equal(value.driver, "fair-work"); assert(Array.isArray(value.scenarios));
  return value as { schemaVersion: 1; driver: "fair-work"; scenarios: FairWorkScenario[] };
}
export async function runFairWorkScenario(scenario: FairWorkScenario): Promise<Record<string, unknown>> {
  let summary: Record<string, unknown>;
  if (scenario.id === "account-a-429-b-ready") {
    const f = fixture(); await f.budget.ready(); await f.budget.observeCooldown({ scopes: [scope("A")], notBeforeEpochMs: 5000 });
    const calls: string[] = [];
    const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: () => 0, host: { async execute(c) {
      try { await nativePreflight(c.key, f.budget.decorate(() => leaf(c.key), () => {}), calls); return settled; }
      catch (error) { if (!(error instanceof ProviderDispatchDeferred)) throw error; return { kind: "deferred", retryAtMs: error.deferral.retryAtMs, changedCalendarIDs: [] }; }
    } } });
    try { const results = await Promise.all([coordinator.submit(candidate("A")), coordinator.submit(candidate("B"))]); await tick();
      summary = { results: results.map(r => r.kind), methods: calls, active: coordinator.snapshot().active }; }
    finally { coordinator.close(); f.budget.close(); }
  } else if (scenario.id === "slow-a-b-progress") {
    const f = fixture(); await f.budget.ready(); const gate = deferred<void>(), started: string[] = [], calls: string[] = [];
    let max = 0;
    const coordinator = createFairWorkCoordinator<string>({ capacity: 2, host: { async execute(c) {
      started.push(c.key); max = Math.max(max, coordinator.snapshot().active);
      await nativePreflight(c.key, f.budget.decorate(() => leaf(c.key), () => {}), calls, c.key === "A" ? gate.promise : undefined); return settled;
    } } });
    try { const a = coordinator.submit(candidate("A")), b = coordinator.submit(candidate("B")); await b;
      const beforeRelease = [...started]; assert.deepEqual(calls, ["B:GET"]); gate.resolve(); await a;
      summary = { beforeRelease, maxActive: max, methods: calls }; }
    finally { gate.resolve(); coordinator.close(); f.budget.close(); }
  } else if (scenario.id === "global-capacity-lanes") {
    const starts: string[] = []; let max = 0;
    const coordinator = createFairWorkCoordinator<string>({ capacity: 4, host: { async execute(c) { starts.push(c.key); max = Math.max(max, coordinator.snapshot().active); return settled; } } });
    try { await Promise.all([candidate("event-1", "A", "event-delivery", "components"), candidate("event-2", "A", "event-delivery", "components"),
      candidate("task-1", "A", "task-delivery", "components"), candidate("pull-1", "A", "pull", "other")].map(c => coordinator.submit(c)));
      summary = { starts, maxActive: max }; }
    finally { coordinator.close(); }
  } else if (scenario.id === "nested-child-collision") {
    const hold = deferred<void>(), bStarted = deferred<void>(); let childActive = 0, blockedChild = "", max = 0, captured: WorkPermit | undefined;
    const coordinator = createFairWorkCoordinator<string>({ capacity: 2, host: { async execute(c, permit) {
      max = Math.max(max, coordinator.snapshot().active);
      if (c.key === "A") { captured = permit; await bStarted.promise;
        await coordinator.runChild(permit, candidate("child", "A"), async () => { childActive = coordinator.snapshot().active - 1; return settled; });
        const result = await coordinator.runChild(permit, candidate("blocked", "A", "event-delivery", "lane", "busy"), async () => { throw new Error("Must not execute busy child"); });
        blockedChild = result.kind === "skipped" ? result.reason : result.kind; hold.resolve();
      } else { bStarted.resolve(); await hold.promise; } return settled;
    } } });
    try { await Promise.all([coordinator.submit(candidate("A")), coordinator.submit(candidate("B", "B", "task-delivery", "B", "busy"))]); await tick();
      let lateRejected = false; try { await coordinator.runChild(captured!, candidate("late", "A"), async () => settled); } catch { lateRejected = true; }
      summary = { childActive, blockedChild, lateRejected, maxActive: max }; }
    finally { hold.resolve(); coordinator.close(); }
  } else if (scenario.id === "native-leaf-lifetime") {
    let time = 0, sends = 0, twiceRejected = false, lateRejected = false, retained: SendRawOnce | undefined;
    const metrics: number[] = [];
    await dispatchNativeHttp({ async dispatch(_request, send) { retained = send; const response = await send();
      try { await send(); } catch { twiceRejected = true; } time += 1000; return response; } }, "https://fixture.test/", {},
      async () => { sends++; time += 7; return new Response(null, { status: 204 }); }, { nowMonotonicMs: () => time }, (_status, duration) => metrics.push(duration));
    try { await retained!(); } catch { lateRejected = true; }
    const aborted = new AbortController(); aborted.abort(); let abortedSends = 0;
    await assert.rejects(dispatchNativeHttp({}, "https://fixture.test/", { signal: aborted.signal }, async () => { abortedSends++; return new Response(); },
      { nowMonotonicMs: () => time }, () => { throw new Error("No aborted metric"); }));
    summary = { sends, metrics, twiceRejected, lateRejected, abortedSends };
  } else if (scenario.id === "unused-reservation-refund") {
    const f = fixture(undefined, true); await f.budget.ready(); assert.throws(() => f.budget.admit(leaf("A")), ProviderDispatchDeferred); f.advance(1000);
    const mutation = leaf("A", "POST", "mutation"), token = f.budget.reserveMutation(mutation), controller = new AbortController();
    let sends = 0, refusalMetrics = 0;
    const decoration = f.budget.decorate(() => { controller.abort(); return mutation; }, () => {}, undefined, () => token);
    await assert.rejects(dispatchNativeHttp(decoration, "https://fixture.test/", { method: "POST", signal: controller.signal }, async () => { sends++; return new Response(); },
      f.clock, () => { refusalMetrics++; }));
    let refundedCredits = 0; for (let i = 0; i < 2; i++) { f.budget.admit(leaf("A")); refundedCredits++; }
    summary = { sends, refundedCredits, refusalMetrics }; f.budget.close();
  } else if (scenario.id === "accepted-readback-persistence-failure") {
    summary = await stickyAccepted();
  } else if (scenario.id === "restart-shared-cooldown") {
    const rows: CooldownSnapshot[] = [{ scope: scope("A"), notBeforeEpochMs: 10_000, minimumRemainingMs: 10_000 }];
    const f = fixture({ loadActive: async () => rows, extend: async () => rows }, true); await f.budget.ready();
    let coldReason = "", aReason = "";
    try { f.budget.admit(leaf("B")); } catch (e) { coldReason = (e as ProviderDispatchDeferred).deferral.reason; }
    f.advance(1000); try { f.budget.admit(leaf("A")); } catch (e) { aReason = (e as ProviderDispatchDeferred).deferral.reason; }
    f.budget.admit(leaf("B")); summary = { coldReason, aReason, bReady: true, tenantScopes: leaf("A").scopes.filter(s => s.dimension === "tenant").length }; f.budget.close();
  } else if (scenario.id === "parked-pages-b-progress") {
    summary = await parkedPages();
  } else if (scenario.id === "park-until-auxiliary-cold-chain") {
    summary = await auxiliaryColdChain();
  } else if (scenario.id === "max-cooldown-fractional-clocks") {
    const until = 253_402_300_799_999, initialEpoch = 1_800_000_000_000;
    let refusals = 0, sends = 0, metrics = 0; const due: number[] = [];
    for (const source of ["hydrated", "observed"]) {
      let epoch = initialEpoch, mono = 0.2;
      const rows = [{ scope: scope("A"), notBeforeEpochMs: until, minimumRemainingMs: until - initialEpoch }];
      const budget = createProviderBudget({ limit: () => undefined, clock: { nowEpochMs: () => epoch, nowMonotonicMs: () => mono },
        cooldowns: { loadActive: async () => source === "hydrated" ? rows : [], extend: async () => rows },
        retryPersistenceMs: 1000, reservationLifetimeMs: 1000, schedule: () => () => {} });
      await budget.ready(); if (source === "observed") await budget.observeCooldown({ scopes: [scope("A")], notBeforeEpochMs: until });
      const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: () => epoch, schedule: () => () => {}, host: { async execute(c) {
        try { await dispatchNativeHttp(budget.decorate(() => leaf(c.accountFairnessKey), () => {}), `https://fixture.test/${c.accountFairnessKey}`, {},
          async () => { assert.equal(c.accountFairnessKey, "B"); sends++; return new Response(null, { status: 200 }); },
          { nowMonotonicMs: () => mono }, () => { metrics++; }); return settled; }
        catch (error) { assert(error instanceof ProviderDispatchDeferred); refusals++; due.push(error.deferral.retryAtMs);
          assert.equal(error.deferral.reason, "cooldown"); return { kind: "deferred", retryAtMs: error.deferral.retryAtMs, changedCalendarIDs: [] }; }
      } } });
      try {
        for (const [index, clock] of [{ epoch: initialEpoch + 1, mono: 0.2 + 0.1 }, { epoch: initialEpoch - 1000, mono: 0.4 },
          { epoch: initialEpoch + 1000, mono: 0.5 }, { epoch: until, mono: until + 1 }].entries()) {
          epoch = clock.epoch; mono = clock.mono;
          assert.deepEqual((await Promise.all([coordinator.submit(candidate(`A-${index}`, "A")), coordinator.submit(candidate(`B-${index}`, "B"))])).map(result => result.kind), ["deferred", "settled"]);
        }
      } finally { coordinator.close(); budget.close(); }
    }
    summary = { refusals, exactDue: due.every(value => value === until), sends, metrics };
  } else if (scenario.id === "long-cooldown-releases-continuations") {
    const until = 253_402_300_799_999;
    const rows = ["A", "B", "C", "D"].map(key => ({ scope: scope(key), notBeforeEpochMs: until, minimumRemainingMs: until }));
    const f = fixture({ loadActive: async () => rows, extend: async () => rows }); await f.budget.ready();
    const calls: string[] = []; let parks = 0;
    const coordinator = createFairWorkCoordinator<string>({ capacity: 4, nowMs: f.clock.nowEpochMs, schedule: () => () => {}, host: { async execute(c, permit, signal) {
      const http = f.budget.decorate(() => leaf(c.key), () => signal.throwIfAborted(), undefined, undefined, async (_deferral, error) => {
        requireBudgetContinuationWindow(error, f.clock.nowEpochMs(), 15_000);
        parks++; await coordinator.park(permit, error.deferral.retryAtMs, signal);
      });
      try { await nativePreflight(c.key, http, calls); return settled; }
      catch (error) { if (!(error instanceof ProviderDispatchDeferred)) throw error; return { kind: "deferred", retryAtMs: error.deferral.retryAtMs, changedCalendarIDs: [] }; }
    } } });
    try {
      const results = await Promise.all(["A", "B", "C", "D", "healthy"].map(key => coordinator.submit(candidate(key)))); await tick();
      summary = { results: results.map(r => r.kind), exactDue: results.slice(0, 4).every(r => r.kind === "deferred" && r.retryAtMs === until),
        methods: calls, parks, logicalActive: coordinator.snapshot().logicalActive };
    } finally { coordinator.close(); f.budget.close(); }
  } else if (scenario.id === "invalid-retry-after-b-progress") {
    let writes = 0; const f = fixture({ loadActive: async () => [], extend: async () => { writes++; throw new Error("Invalid header must not reach persistence"); } }); await f.budget.ready();
    const statuses: (number | string)[] = [];
    const http = f.budget.decorate(request => leaf(request.url), () => {}, (_leaf, response) => {
      const parsed = parseProviderRetryAfter(response.headers.get("retry-after"), 0);
      return parsed.kind === "supported" ? { scopes: [scope("A")], notBeforeEpochMs: parsed.notBeforeEpochMs } : undefined;
    });
    const a = new Response(null, { status: 429, headers: { "retry-after": "not-a-date" } });
    assert.equal(await dispatchNativeHttp(http, "https://fixture.test/A", {}, async () => a, f.clock, status => statuses.push(status)), a);
    await dispatchNativeHttp(http, "https://fixture.test/B", {}, async () => new Response(null, { status: 200 }), f.clock, status => statuses.push(status));
    summary = { statuses, writes, blocked: f.budget.snapshot().persistenceBlocked, parsed: parseProviderRetryAfter("not-a-date", 0).kind }; f.budget.close();
  } else throw new Error("Unknown fair work scenario.");
  assert.deepEqual(summary, scenario.expected); return summary;
}

async function parkedPages(): Promise<Record<string, unknown>> {
  const f = fixture(undefined, true, 1); await f.budget.ready(); let pages = 0, bComplete = false, bBeforeA = false, finished = false, maxActive = 0;
  const base = "https://graph.microsoft.com/v1.0/me/calendars/calendar/events";
  const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: f.clock.nowEpochMs, schedule: () => () => {}, host: { async execute(c, permit, signal) {
    maxActive = Math.max(maxActive, coordinator.snapshot().active);
    const http = f.budget.decorate(request => leaf(c.key, request.method), () => signal.throwIfAborted(), undefined, undefined,
      deferral => coordinator.park(permit, deferral.retryAtMs, signal));
    if (c.key === "B") { await nativePreflight("B", http, []); bComplete = true; return settled; }
    const provider = createMicrosoftPersonalEventCreateProvider({ http: { ...http, async fetch() {
      pages++; return Response.json({ value: [], ...(pages < 6 ? { "@odata.nextLink": `${base}?page=${pages + 1}` } : {}) });
    } }, accountSession: { open: async connection => ({ ...connection, accessToken: "fixture", eventWriteAllowed: true }) },
      beforeMutation: async () => {}, clock: f.clock, telemetry: { record() {} } }, { nativeProfile: "existing-microsoft" });
    const result = await provider.readCreated({ target: { connectionId: "physical", connectionGeneration: "1", calendarId: "calendar" },
      body: { subject: "Fixture", body: { contentType: "text", content: "" }, location: { displayName: "" }, isAllDay: false,
        start: { dateTime: "2026-10-26T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-26T10:00:00", timeZone: "UTC" }, transactionId: "abcdef01-abcd-4000-8000-abcdefabcdef" },
      operationId: "abcdef01-abcd-4000-8000-abcdefabcdef", attemptId: "attempt", serializer: { id: "microsoft-personal-event", version: 1 } }, signal);
    assert.equal(result.kind, "missing"); bBeforeA = bComplete; return settled;
  } } });
  try {
    const complete = Promise.all([coordinator.submit(candidate("A")), coordinator.submit(candidate("B"))]).then(() => { finished = true; });
    for (let i = 0; i < 100 && !finished; i++) { await tick(); f.advance(500); coordinator.kick(); }
    assert(finished, "Native pagination must resume beyond burst capacity without restarting pages"); await complete;
    return { pages, bBeforeA, maxActive };
  } finally { coordinator.close(); f.budget.close(); }
}

async function auxiliaryColdChain(): Promise<Record<string, unknown>> {
  const f = fixture(undefined, true, 1); await f.budget.ready();
  const refreshes = new Map<string, ReturnType<typeof deferred<string>>>();
  let sends = 0, refreshCalls = 0, finished = false, maxActive = 0, maxLogical = 0;
  const coordinator = createFairWorkCoordinator<string>({ capacity: 4, nowMs: f.clock.nowEpochMs, schedule: () => () => {}, host: { async execute(c, permit, signal) {
    const state = coordinator.snapshot(); maxActive = Math.max(maxActive, state.active); maxLogical = Math.max(maxLogical, state.logicalActive);
    const account = c.accountFairnessKey;
    const http = f.budget.decorate(request => leaf(account, request.method, c.auxiliary ? "oauth-refresh" : "pull"), () => signal.throwIfAborted(), undefined, undefined,
      deferral => coordinator.park(permit, deferral.retryAtMs, signal));
    if (c.auxiliary) {
      await dispatchNativeHttp(http, "https://fixture.test/token", { method: "POST", signal }, async () => { sends++; refreshCalls++; return Response.json({ access_token: "fresh" }); }, f.clock, () => {});
      refreshes.get(account)!.resolve("fresh"); return settled;
    }
    const provider = createGoogleTaskCreateProvider({ http: { ...http, async fetch(_url, init) {
      sends++; return new Headers(init.headers).get("authorization") === "Bearer stale" ? new Response(null, { status: 401 }) : Response.json({ id: account });
    } }, accountSession: {
      open: async connection => ({ ...connection, accessToken: "stale", taskWriteAllowed: true }),
      async recoverRejectedRead(connection) {
        const shared = deferred<string>(); refreshes.set(account, shared);
        void coordinator.submit({ ...candidate(`aux-${account}`, account), auxiliary: true }).catch(error => { throw error; });
        const token = await coordinator.parkUntil(permit, shared.promise, signal);
        return { ...connection, accessToken: token, taskWriteAllowed: true };
      },
    }, beforeMutation: async () => {}, onAcceptedResponse: async () => {}, onResponseAddress: async () => {}, clock: f.clock, telemetry: { record() {} } }, { nativeProfile: "existing-google" });
    await provider.preflightCreate({ target: { connectionId: account, connectionGeneration: "1", taskListId: account }, body: { title: "Fixture", notes: null, status: "needsAction", due: null }, operationId: "operation", attemptId: "attempt", serializer: { id: "google-task", version: 1 } }, signal);
    return settled;
  } } });
  try {
    const done = Promise.all(["A", "B", "C", "D"].map(account => coordinator.submit(candidate(account, account)))).then(() => { finished = true; });
    for (let i = 0; i < 100 && !finished; i++) { await tick(); f.advance(500); coordinator.kick(); const state = coordinator.snapshot(); maxLogical = Math.max(maxLogical, state.logicalActive); assert(state.active <= 4 && state.logicalActive <= 8); }
    assert(finished, "Four parents and independent cold auxiliary jobs must not deadlock"); await done;
    return { sends, refreshCalls, maxActive, maxLogical };
  } finally { coordinator.close(); f.budget.close(); }
}

async function stickyAccepted(): Promise<Record<string, unknown>> {
  let fail = true;
  const f = fixture({ loadActive: async () => [], extend: async () => { if (fail) throw new Error("fixture SQL unavailable"); return []; } }); await f.budget.ready();
  const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: "home", title: "Target", status: "needs-action" });
  const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
  const encoded = encodeTaskV1("google", task, undefined, { action: "create", operationId, acceptedAt: "2026-10-26T09:00:00Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "create", version: 1 },
    operationId, commandId: "command", hostObjectId: task.id, locator: { provider: "google", connectionId: "logical", collectionId: "list", resourceId: null },
    sourceEpoch: { sourceId: "source", generation: 1 }, privacyEpoch: "private", acceptedRevision: 2, allowedSideEffects: ["provider-content-write"], ...encoded });
  const methods: string[] = [], statuses: (number | string)[] = [];
  const decoration = f.budget.decorate(request => leaf("A", request.method), () => {}, (_leaf, response) => response.status === 429 ?
    { scopes: [scope("A")], notBeforeEpochMs: 5000, minimumDelayMs: 5000 } : undefined);
  try {
    const result = await runClaimedGoogleTaskCreate({ operationId, attemptId: "attempt", payload: { operationEnvelope: envelope },
      binding: { kind: "task", action: "create", operationId, commandId: "command", hostObjectId: task.id, provider: "google", connectionId: "logical", collectionId: "list", resourceId: null, acceptedRevision: 2, predecessorOperationId: null },
      nativeTarget: { connectionId: "physical", connectionGeneration: "1", taskListId: "list" }, collectionIdentity: "native",
      recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } }, {
      prepare: async () => ({}), renew: async () => true,
      accountSession: { open: async connection => ({ ...connection, accessToken: "fixture", taskWriteAllowed: true }) },
      beforeMutation: async () => {}, recordEvidence: async () => {}, ack: async () => { throw new Error("No ACK after readback 429"); }, finish: async () => {}, observationId: () => "observation",
    }, { http: { ...decoration, async fetch(url, init) { methods.push(init.method ?? "GET");
      return init.method === "POST" ? Response.json({ id: "created", etag: '"response"' }, { status: 201 }) :
        url.includes("/users/@me/") ? Response.json({ id: "list" }) : new Response(null, { status: 429, headers: { "retry-after": "5" } });
    } }, clock: f.clock, telemetry: { record(metric) { statuses.push(metric.status); } } },
    { nativeProfile: "existing-google", readback: "saved-patch", ambiguousRecovery: "deferred" });
    let nextReason = ""; try { f.budget.admit(leaf("B")); } catch (e) { nextReason = (e as ProviderDispatchDeferred).deferral.reason; }
    const blocked = f.budget.snapshot().persistenceBlocked; fail = false; const flushed = await f.budget.flushPending();
    return { provider: result.facts.provider.kind, acceptedStatus: result.facts.acceptedStatus, writerTaskId: result.facts.writerResult?.taskId,
      methods, statuses, blocked, nextReason, flushed };
  } finally { f.budget.close(); }
}
