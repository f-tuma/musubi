import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGoogleTaskCreateProvider } from "@musubi/provider-google";
import { createMicrosoftPersonalEventCreateProvider } from "@musubi/provider-microsoft";
import { dispatchNativeHttp } from "../../../provider-google/src/http-dispatch";
import { dispatchNativeHttp as dispatchCaldavHttp } from "../../../provider-caldav/src/http-dispatch";
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
  if (scenario.id === "parked-foreground-serial") {
    summary = await parkedForegroundSerial();
  } else if (RESERVE_SCENARIOS.includes(scenario.id)) {
    summary = await foregroundReserveScenario(scenario.id);
  } else if (["parked-pull-request-preflight", "parked-pull-durable-delivery", "full-account-pull-queue-request"].includes(scenario.id)) {
    summary = await requestDuringParkedPull(scenario.id);
  } else if (["due-crosses-during-wake-scan", "parked-due-crosses-before-timer"].includes(scenario.id)) {
    const parked = scenario.id === "parked-due-crosses-before-timer";
    let completions = 0;
    for (let crossing = 1; crossing <= 8; crossing++) {
      let time = 1000, armed = !parked, reads = 0, completed = false;
      const timers: { at: number; run(): void; active: boolean }[] = [];
      const coordinator = createFairWorkCoordinator<string>({ capacity: 1,
        nowMs() { if (armed && ++reads === crossing) time = Math.max(time, 1001); return time; },
        schedule(run, delay) { const timer = { at: time + delay, run, active: true }; timers.push(timer); return () => { timer.active = false; }; },
        host: { candidates: async () => ({ candidates: [] }), async execute(_candidate, permit) {
          if (parked) { armed = true; await coordinator.park(permit, 1001); }
          completed = true; return settled;
        } },
      });
      const execution = coordinator.submit({ ...candidate("crossing"), dueAtMs: parked ? 1000 : 1001 });
      void execution.catch(() => {});
      try {
        await tick();
        for (let wake = 0; !completed && wake < 8; wake++) {
          const timer = timers.find(item => item.active);
          assert.ok(timer, `Clock crossing ${crossing} must retain an automatic wake for ${parked ? "parked" : "queued"} work`);
          timer.active = false; time = Math.max(time, timer.at); timer.run(); await tick();
        }
        assert.equal(completed, true, `Clock crossing ${crossing} must complete without an unrelated kick`);
        await execution; await tick(); assert.equal(coordinator.snapshot().active, 0); assert.equal(coordinator.snapshot().pending, 0);
        completions++;
      } finally { coordinator.close(); await execution.catch(() => {}); }
    }
    summary = { clockCrossings: 8, completions, externalKicks: 0, active: 0, pending: 0 };
  } else if (scenario.id === "async-future-hint-crosses-due") {
    let time = 1000, lookups = 0, starts = 0;
    const timers: { at: number; run(): void; active: boolean }[] = [];
    const coordinator = createFairWorkCoordinator<string>({ capacity: 1, nowMs: () => time,
      schedule(run, delay) { const timer = { at: time + delay, run, active: true }; timers.push(timer); return () => { timer.active = false; }; },
      host: { async candidates(input) {
        if (++lookups === 1) { assert.equal(input.nowMs, 1000); time = 1001; return { candidates: [], nextWakeAtMs: 1001 }; }
        return { candidates: starts ? [] : [candidate("late-host")], nextWakeAtMs: 1001 };
      }, async execute() { starts++; return settled; } },
    });
    try {
      coordinator.kick(); await tick();
      const timer = timers.find(item => item.active); assert.ok(timer, "A hint future at lookup must survive becoming due during its async response");
      timer.active = false; time = Math.max(time, timer.at); timer.run(); await tick();
      assert.equal(starts, 1); assert.ok(lookups <= 4);
      summary = { starts, unrelatedKicks: 0, timersForRepeatedPastHint: timers.filter(item => item.active).length, active: coordinator.snapshot().active };
    } finally { coordinator.close(); }
  } else if (scenario.id === "due-collision-waits-for-release") {
    let time = 0, blockedStarts = 0;
    const held = deferred<void>(), started = deferred<void>(), timers: { at: number; run(): void; active: boolean }[] = [];
    const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: () => time,
      schedule(run, delay) { const timer = { at: time + delay, run, active: true }; timers.push(timer); return () => { timer.active = false; }; },
      host: { candidates: async () => ({ candidates: [] }), async execute(c) {
        if (c.key === "holder") { started.resolve(); await held.promise; } else blockedStarts++;
        return settled;
      } },
    });
    const holder = coordinator.submit(candidate("holder", "A", "pull", "A", "resource"));
    let blocked: Promise<WorkExecutionResult> | undefined;
    try {
      await started.promise;
      blocked = coordinator.submit({ ...candidate("blocked", "B", "pull", "B", "resource"), dueAtMs: 1 }); await tick();
      const timer = timers.find(item => item.active); assert.ok(timer); timer.active = false; time = timer.at; timer.run(); await tick();
      const pendingTimers = timers.filter(item => item.active).length;
      assert.equal(blockedStarts, 0); assert.equal(pendingTimers, 0, "A due resource-blocked job must wait for release without a timer loop");
      held.resolve(); await Promise.all([holder, blocked]); await tick();
      summary = { startsBeforeRelease: 0, timersWhileBlocked: pendingTimers, startsAfterRelease: blockedStarts, active: coordinator.snapshot().active };
    } finally { held.resolve(); coordinator.close(); await Promise.all([holder, blocked].map(item => item?.catch(() => {}))); }
  } else if (scenario.id === "active-deferral-releases-submitters") {
    const until = 253_402_300_799_999, gate = deferred<void>(), started = deferred<void>();
    let time = 0, offered = false, executions = 0;
    const results: WorkExecutionResult[] = [];
    const coordinator = createFairWorkCoordinator<string>({ capacity: 1, nowMs: () => time, schedule: () => () => {}, host: {
      candidates: async () => ({ candidates: offered ? [] : (offered = true, [candidate("A")]) }),
      async execute() { if (++executions === 1) { started.resolve(); await gate.promise;
        return { kind: "deferred", retryAtMs: until, changedCalendarIDs: ["partial"] }; } return settled; },
    } });
    const waiting: Promise<unknown>[] = [];
    try {
      coordinator.kick(); await started.promise;
      for (let i = 0; i < 2; i++) waiting.push(coordinator.submit(candidate("A")).then(result => { results.push(result); }, () => {}));
      gate.resolve(); await tick();
      assert.equal(results.length, 2, "A deferred background claim must release both direct submitters");
      assert(results.every(result => result.kind === "deferred" && result.retryAtMs === until));
      assert.deepEqual(results.map(result => result.kind === "skipped" ? [] : result.changedCalendarIDs), [["partial"], ["partial"]]);
      waiting.push(coordinator.submit(candidate("A")).then(result => { results.push(result); }, () => {}));
      await tick(); assert.equal(results.length, 3, "A stale descriptor after backoff must return its future eligibility");
      assert.equal(executions, 1, "No duplicate claim may execute before eligibility");
      time = until; coordinator.kick(); await tick();
      summary = { releasedSubmitters: results.length, exactDue: results.every(result => result.kind === "deferred" && result.retryAtMs === until),
        partialInvalidations: results.slice(0, 2).map(result => result.kind === "skipped" ? [] : result.changedCalendarIDs), executions, pending: coordinator.snapshot().pending };
    } finally { gate.resolve(); coordinator.close(); await Promise.all(waiting); }
  } else if (scenario.id === "account-a-429-b-ready") {
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
  } else if (scenario.id === "shared-permit-parallel-http") {
    summary = await parallelHttpLeaves();
  } else if (scenario.id === "shared-permit-inflight-collision") {
    summary = await httpLeafCollision();
  } else if (scenario.id === "shared-permit-abort-fallback") {
    summary = await httpLeafAbortFallback();
  } else if (scenario.id === "park-until-auxiliary-cold-chain") {
    summary = await auxiliaryColdChain();
  } else if (scenario.id === "finite-boundary-cooldown-clocks") {
    const max = 253_402_300_799_999, initialEpoch = 1_800_000_000_000;
    const parsed = parseProviderRetryAfter("Fri, 31 Dec 9999 23:59:59 GMT", initialEpoch);
    assert(parsed.kind === "supported"); assert.equal(parsed.notBeforeEpochMs, max - 999);
    let refusals = 0, capped = 0, aSends = 0, bSends = 0, metrics = 0;
    for (const target of [max - 1, parsed.notBeforeEpochMs]) for (const source of ["hydrated", "observed"]) {
      let epoch = initialEpoch, mono = 0.2, expired = false, expectedDue = max;
      const rows = [{ scope: scope("A"), notBeforeEpochMs: target, minimumRemainingMs: target - initialEpoch }];
      const budget = createProviderBudget({ limit: () => undefined, clock: { nowEpochMs: () => epoch, nowMonotonicMs: () => mono },
        cooldowns: { loadActive: async () => source === "hydrated" ? rows : [], extend: async () => rows },
        retryPersistenceMs: 1000, reservationLifetimeMs: 1000, schedule: () => () => {} });
      await budget.ready(); if (source === "observed") await budget.observeCooldown({ scopes: [scope("A")], notBeforeEpochMs: target });
      const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: () => epoch, schedule: () => () => {}, host: { async execute(c) {
        try { await dispatchNativeHttp(budget.decorate(() => leaf(c.accountFairnessKey), () => {}), `https://fixture.test/${c.accountFairnessKey}`, {},
          async () => { if (c.accountFairnessKey === "A") { assert(expired, "A must not send before its independent deadline"); aSends++; } else bSends++;
            return new Response(null, { status: 200 }); }, { nowMonotonicMs: () => mono }, () => { metrics++; }); return settled; }
        catch (error) { assert(error instanceof ProviderDispatchDeferred); refusals++; assert.equal(error.deferral.reason, "cooldown");
          assert.equal(error.deferral.retryAtMs, expectedDue); if (error.deferral.retryAtMs === max) capped++;
          return { kind: "deferred", retryAtMs: error.deferral.retryAtMs, changedCalendarIDs: [] }; }
      } } });
      try {
        for (const [index, clock] of [{ epoch: initialEpoch + 2, mono: 0.2 + 0.1, due: target === max - 1 ? max : target + 2 },
          { epoch: initialEpoch + 2000, mono: 0.4, due: max }, { epoch: initialEpoch - 1000, mono: 0.5, due: target - 1000 }].entries()) {
          epoch = clock.epoch; mono = clock.mono; expectedDue = clock.due;
          assert.deepEqual((await Promise.all([coordinator.submit(candidate(`A-${index}`, "A")), coordinator.submit(candidate(`B-${index}`, "B"))])).map(result => result.kind), ["deferred", "settled"]);
        }
        epoch = initialEpoch + 2000; mono = target - initialEpoch + 1; expired = true;
        assert.equal((await coordinator.submit(candidate("A-expired", "A"))).kind, "settled");
      } finally { coordinator.close(); budget.close(); }
    }
    summary = { refusals, capped, finiteExpired: aSends, aSends, bSends, metrics };
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

async function httpLeafAbortFallback(): Promise<Record<string, unknown>> {
  const entered = deferred<void>(), release = deferred<void>(), fallbackQueued = deferred<void>();
  const aborted = new AbortController(); let oldSettled = false, fallbackBeforeSettlement = false, siblings = 0, fallbacks = 0;
  const coordinator = createFairWorkCoordinator<string>({ capacity: 1, host: { async execute(_candidate, permit, signal): Promise<WorkExecutionResult> {
    const first = coordinator.runHttpLeaf(permit, assertCurrent => dispatchCaldavHttp({ dispatch: (_request, send) => send(() => { assertCurrent(); return undefined; }) },
      "https://fixture.test/dav/first", { method: "PROPFIND", signal: aborted.signal }, async () => {
        entered.resolve(); await release.promise; oldSettled = true; aborted.signal.throwIfAborted(); return new Response(null, { status: 207 });
      }, { nowMonotonicMs: () => 0 }, () => {}), aborted.signal);
    const sibling = coordinator.runHttpLeaf(permit, async assertCurrent => { assertCurrent(); siblings++; }, signal);
    const cancelled = await Promise.allSettled([first, sibling]);
    assert.ok(cancelled.every(result => result.status === "rejected" && result.reason === aborted.signal.reason));
    const fallback = coordinator.runHttpLeaf(permit, assertCurrent => dispatchCaldavHttp({ dispatch: (_request, send) => send(() => { assertCurrent(); return undefined; }) },
      "https://fixture.test/dav/fallback", { method: "PROPFIND", signal }, async () => {
        fallbackBeforeSettlement = !oldSettled; fallbacks++; return new Response(null, { status: 207 });
      }, { nowMonotonicMs: () => 0 }, () => {}), signal);
    fallbackQueued.resolve(); const response = await fallback; assert.equal(response.status, 207); return settled;
  } } });
  const work = coordinator.submit(candidate("A")); void work.catch(() => {});
  try { await entered.promise; aborted.abort(new Error("Controlled active leaf cancellation")); await fallbackQueued.promise;
    assert.equal(fallbacks, 0); release.resolve(); await work; await tick();
    return { siblings, fallbacks, fallbackBeforeSettlement, logicalActive: coordinator.snapshot().logicalActive };
  } finally { release.resolve(); coordinator.close(); }
}

async function parallelHttpLeaves(): Promise<Record<string, unknown>> {
  const f = fixture(undefined, true, 1); await f.budget.ready();
  let raw = 0, maxRaw = 0, sends = 0, parks = 0, bComplete = false, bBeforeA = false, finished = false;
  let statuses: number[] = [];
  const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: f.clock.nowEpochMs, schedule: () => () => {}, host: {
    async execute(c, permit, signal) {
      if (c.key === "B") { bComplete = true; return settled; }
      const responses = await Promise.all(["one", "two"].map(label => coordinator.runHttpLeaf(permit, async assertCurrent => {
        const http = f.budget.decorate(() => ({ ...leaf("A"), targetKey: label }), () => { assertCurrent(); signal.throwIfAborted(); },
          undefined, undefined, deferral => { parks++; return coordinator.park(permit, deferral.retryAtMs, signal); });
        return dispatchCaldavHttp(http, `https://fixture.test/dav/${label}`, { method: "PROPFIND", signal }, async () => {
          raw++; maxRaw = Math.max(raw, maxRaw); sends++;
          try { await Promise.resolve(); return new Response(null, { status: 207 }); } finally { raw--; }
        }, f.clock, () => {});
      }, signal)));
      statuses = responses.map(response => response.status); bBeforeA = bComplete; return settled;
    },
  } });
  try {
    const work = Promise.all([coordinator.submit(candidate("A")), coordinator.submit(candidate("B"))]).then(() => { finished = true; });
    for (let i = 0; i < 30 && !finished; i++) { await tick(); f.advance(500); coordinator.kick(); }
    assert(finished, "Concurrent SDK leaves must each resume through their original native continuation"); await work; await tick();
    return { statuses, sends, parks, maxRaw, bBeforeA, logicalActive: coordinator.snapshot().logicalActive };
  } finally { coordinator.close(); f.budget.close(); }
}

async function httpLeafCollision(): Promise<Record<string, unknown>> {
  const f = fixture(undefined, true, 1); await f.budget.ready();
  assert.throws(() => f.budget.admit(leaf("A")), ProviderDispatchDeferred); f.advance(500);
  const entered = deferred<void>(), release = deferred<void>();
  let raw = 0, maxRaw = 0, parks = 0, sends = 0, bComplete = false, bWhileRaw = false, bBeforeSecond = false, finished = false;
  const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: f.clock.nowEpochMs, schedule: () => () => {}, host: {
    async execute(c, permit, signal) {
      if (c.key === "B") { bWhileRaw = raw !== 0; bComplete = true; return settled; }
      await Promise.all(["one", "two"].map(label => coordinator.runHttpLeaf(permit, async assertCurrent => {
        const http = f.budget.decorate(() => ({ ...leaf("A"), targetKey: label }), () => { assertCurrent(); signal.throwIfAborted(); },
          undefined, undefined, deferral => { parks++; return coordinator.park(permit, deferral.retryAtMs, signal); });
        await dispatchCaldavHttp(http, `https://fixture.test/dav/${label}`, { method: "PROPFIND", signal }, async () => {
          raw++; maxRaw = Math.max(raw, maxRaw); sends++;
          try { if (label === "one") { entered.resolve(); await release.promise; } else bBeforeSecond = bComplete;
            return new Response(null, { status: 207 });
          } finally { raw--; }
        }, f.clock, () => {});
      }, signal)));
      return settled;
    },
  } });
  try {
    const a = coordinator.submit(candidate("A", "A", "pull", "A", "shared")); await entered.promise;
    const b = coordinator.submit(candidate("B", "B", "pull", "B", "shared")); await tick();
    const bBeforeFirstRelease = bComplete, heldWhileRaw = coordinator.snapshot().heldCollisions;
    assert.equal(parks, 0, "Queued siblings cannot park while the first raw HTTP request is in flight");
    release.resolve(); const work = Promise.all([a, b]).then(() => { finished = true; });
    for (let i = 0; i < 30 && !finished; i++) { await tick(); f.advance(500); coordinator.kick(); }
    assert(finished); await work; await tick();
    return { bBeforeFirstRelease, heldWhileRaw, bBeforeSecond, bWhileRaw, sends, parks, maxRaw, logicalActive: coordinator.snapshot().logicalActive };
  } finally { release.resolve(); coordinator.close(); f.budget.close(); }
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


async function requestDuringParkedPull(id: string): Promise<Record<string, unknown>> {
  const releaseRead = deferred<void>(), readParked = deferred<void>();
  let foregroundStarted = false, otherAccountCompleted = false, queuedBackgroundStarted = 0;
  let rejection: string | null = null;
  const jobs: Promise<unknown>[] = [];
  const coordinator = createFairWorkCoordinator<string>({ capacity: 4, nowMs: () => 0, schedule: () => () => {},
    host: { async execute(c, permit, signal) {
      if (c.key === "background") {
        const parked = coordinator.parkUntil(permit, releaseRead.promise, signal); readParked.resolve(); await parked;
      } else if (c.key.startsWith("queued-background")) queuedBackgroundStarted++;
      else if (c.key === "request") foregroundStarted = true;
      else otherAccountCompleted = true;
      assert(coordinator.snapshot().regularLogical <= 4, "Foreground work retains the global logical bound");
      return settled;
    } } });
  try {
    jobs.push(coordinator.submit(candidate("background", "A"))); await readParked.promise;
    if (id === "full-account-pull-queue-request") for (let i = 0; i < 4; i++)
      jobs.push(coordinator.submit(candidate(`queued-background-${i}`, "A")));
    const request = id === "parked-pull-durable-delivery" ? candidate("request", "A", "event-delivery") :
      { ...candidate("request", "A"), foreground: true };
    jobs.push(coordinator.submit(request).catch(error => { rejection = error instanceof ProviderDispatchDeferred ? error.deferral.reason : "unexpected"; }));
    jobs.push(coordinator.submit(candidate("other", "B"))); await tick();
    return { foregroundBeforeReadRelease: foregroundStarted, otherAccountCompleted, queuedBackgroundStarted, rejection };
  } finally { releaseRead.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
}


async function parkedForegroundSerial(): Promise<Record<string, unknown>> {
  const readGate = deferred<void>(), readParked = deferred<void>(), firstGate = deferred<void>(), firstParked = deferred<void>();
  let secondStarted = false, otherAccountCompleted = false, foregroundLogical = 0, maxForegroundLogical = 0;
  const jobs: Promise<unknown>[] = [];
  const coordinator = createFairWorkCoordinator<string>({ capacity: 4, nowMs: () => 0, schedule: () => () => {}, host: {
    async execute(c, permit, signal) {
      if (c.key === "background") {
        const waiting = coordinator.parkUntil(permit, readGate.promise, signal); readParked.resolve(); await waiting;
      } else if (c.key === "other") otherAccountCompleted = true;
      else {
        foregroundLogical++; maxForegroundLogical = Math.max(maxForegroundLogical, foregroundLogical);
        try {
          if (c.key === "first") {
            const waiting = coordinator.parkUntil(permit, firstGate.promise, signal); firstParked.resolve(); await waiting;
          } else secondStarted = true;
        } finally { foregroundLogical--; }
      }
      return settled;
    },
  } });
  try {
    jobs.push(coordinator.submit(candidate("background", "A"))); await readParked.promise;
    jobs.push(coordinator.submit({ ...candidate("first", "A"), foreground: true })); await firstParked.promise;
    jobs.push(coordinator.submit(candidate("second", "A", "event-delivery")));
    jobs.push(coordinator.submit(candidate("other", "B"))); await tick();
    const secondBeforeFirstRelease = secondStarted;
    firstGate.resolve(); await tick();
    return { secondBeforeFirstRelease, otherAccountCompleted, secondAfterFirstRelease: secondStarted, maxForegroundLogical };
  } finally { firstGate.resolve(); readGate.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
}

const RESERVE_SCENARIOS = ["four-held-other-accounts-request", "four-held-other-accounts-durable-delivery", "four-parked-other-accounts-request",
  "reserve-blocks-fourth-background-until-background-release", "reserve-same-account-held-pull-still-waits", "reserve-auxiliary-under-full-regular",
  "reserve-foreground-deadline-cancel", "reserve-all-parked-with-foreground"];
const OTHER_ACCOUNTS = ["other0", "other1", "other2", "other3"];

/** The actual coordinator at the production capacity (4) through its clock,
 * candidate and execute ports. `foregroundReserve` is the option under test;
 * `0` is the shared-pool baseline that production ran before the reserve. */
function reservePool(foregroundReserve: number, options: { nowMs?: () => number; offered?: WorkCandidate<string>[];
  execute(c: WorkCandidate<string>, permit: WorkPermit, signal: AbortSignal, pool: ReservePool): Promise<WorkExecutionResult> }) {
  let offered = false, backgroundLogical = 0;
  const pool = { maxHeld: 0, maxRegularLogical: 0, maxBackgroundLogical: 0,
    coordinator: undefined as unknown as ReturnType<typeof createFairWorkCoordinator<string>> };
  const observe = () => { const state = pool.coordinator.snapshot(); pool.maxHeld = Math.max(pool.maxHeld, state.active);
    pool.maxRegularLogical = Math.max(pool.maxRegularLogical, state.regularLogical); pool.maxBackgroundLogical = Math.max(pool.maxBackgroundLogical, backgroundLogical); };
  pool.coordinator = createFairWorkCoordinator<string>({ capacity: 4, foregroundReserve, nowMs: options.nowMs ?? (() => 0), schedule: () => () => {}, host: {
    async candidates() { if (offered || !options.offered) return { candidates: [] }; offered = true; return { candidates: options.offered }; },
    async execute(c, permit, signal) {
      const background = !c.auxiliary && c.family === "pull" && c.foreground !== true;
      if (background) backgroundLogical++;
      observe();
      try { return await options.execute(c, permit, signal, { ...pool, observe } as ReservePool); }
      finally { if (background) backgroundLogical--; }
    },
  } });
  return { ...pool, get coordinator() { return pool.coordinator; }, observe,
    get maxHeld() { return pool.maxHeld; }, get maxRegularLogical() { return pool.maxRegularLogical; }, get maxBackgroundLogical() { return pool.maxBackgroundLogical; } };
}
type ReservePool = { observe(): void; readonly coordinator: ReturnType<typeof createFairWorkCoordinator<string>>;
  readonly maxHeld: number; readonly maxRegularLogical: number; readonly maxBackgroundLogical: number };
const deferralReason = (error: unknown) => error instanceof ProviderDispatchDeferred ? error.deferral.reason : error instanceof Error ? error.message : "unexpected";

async function foregroundReserveScenario(id: string): Promise<Record<string, unknown>> {
  if (id === "four-held-other-accounts-request" || id === "four-held-other-accounts-durable-delivery") {
    const family = id.endsWith("durable-delivery") ? "event-delivery" : "pull";
    const run = async (reserve: number) => {
      const releases = new Map(OTHER_ACCOUNTS.map(key => [key, deferred<void>()]));
      let backgroundStarted = 0, requestStarted = false, rejection: string | null = null;
      const pool = reservePool(reserve, { offered: OTHER_ACCOUNTS.map(key => candidate(key)), async execute(c) {
        if (c.key === "request") { requestStarted = true; return settled; }
        backgroundStarted++; await releases.get(c.key)!.promise; return settled;
      } });
      const { coordinator } = pool;
      try {
        coordinator.kick(); await tick();
        const started = backgroundStarted, fourthBackgroundPending = coordinator.snapshot().pending === 1 && backgroundStarted === 3;
        const request = family === "pull" ? { ...candidate("request", "mine"), foreground: true } : candidate("request", "mine", "event-delivery");
        const job = coordinator.submit(request).catch(error => { rejection = deferralReason(error); });
        await tick(); const startedWhileSaturated = requestStarted;
        releases.get("other0")!.resolve(); await tick(); const admittedAfterOneRelease = requestStarted;
        for (const release of releases.values()) release.resolve(); await job; await tick();
        return reserve ? { backgroundStarted: started, fourthBackgroundPending, startedWhileSaturated, rejection, maxHeld: pool.maxHeld, maxRegularLogical: pool.maxRegularLogical }
          : { backgroundStarted: started, startedWhileSaturated, rejection, admittedAfterOneRelease, maxHeld: pool.maxHeld, maxRegularLogical: pool.maxRegularLogical };
      } finally { for (const release of releases.values()) release.resolve(); coordinator.close(); }
    };
    return { withReserve: await run(1), withoutReserve: await run(0) };
  }
  if (id === "four-parked-other-accounts-request") {
    const run = async (reserve: number) => {
      const release = deferred<void>(); let backgroundStarted = 0, foregroundStarted = false, rejection: string | null = null;
      const jobs: Promise<unknown>[] = [];
      const pool = reservePool(reserve, { async execute(c, permit, signal) {
        if (c.key === "request") { foregroundStarted = true; return settled; }
        backgroundStarted++; await pool.coordinator.parkUntil(permit, release.promise, signal); return settled;
      } });
      const { coordinator } = pool;
      try {
        for (const key of OTHER_ACCOUNTS) jobs.push(coordinator.submit(candidate(key))); await tick();
        const parkedBackground = coordinator.snapshot().parked;
        jobs.push(coordinator.submit({ ...candidate("request", "mine"), foreground: true }).catch(error => { rejection = deferralReason(error); })); await tick();
        const summary = { backgroundStarted, parkedBackground, foregroundStarted, rejection };
        release.resolve(); await Promise.allSettled(jobs); return summary;
      } finally { release.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
    };
    return { withReserve: await run(1), withoutReserve: await run(0) };
  }
  if (id === "reserve-blocks-fourth-background-until-background-release") {
    const releases = new Map([...OTHER_ACCOUNTS, "request"].map(key => [key, deferred<void>()]));
    let backgroundStarted = 0, requestStarted = false;
    const pool = reservePool(1, { offered: OTHER_ACCOUNTS.map(key => candidate(key)), async execute(c) {
      if (c.key === "request") requestStarted = true; else backgroundStarted++;
      await releases.get(c.key)!.promise; return settled;
    } });
    const { coordinator } = pool;
    try {
      coordinator.kick(); await tick(); const started = () => backgroundStarted; assert.equal(started(), 3);
      const job = coordinator.submit({ ...candidate("request", "mine"), foreground: true }); await tick();
      const foregroundStartedWhileSaturated = requestStarted;
      releases.get("request")!.resolve(); await job; await tick();
      const fourthPendingAfterForegroundRelease = started() === 3 && coordinator.snapshot().pending === 1;
      releases.get("other0")!.resolve(); await tick();
      const fourthStartedAfterBackgroundRelease = started() === 4;
      for (const release of releases.values()) release.resolve(); await tick();
      return { foregroundStartedWhileSaturated, fourthPendingAfterForegroundRelease, fourthStartedAfterBackgroundRelease,
        maxBackgroundLogical: pool.maxBackgroundLogical, maxHeld: pool.maxHeld, maxRegularLogical: pool.maxRegularLogical };
    } finally { for (const release of releases.values()) release.resolve(); coordinator.close(); }
  }
  if (id === "reserve-same-account-held-pull-still-waits") {
    const run = async (reserve: number) => {
      const release = deferred<void>(); let foregroundStarted = false, rejection: string | null = null;
      const pool = reservePool(reserve, { async execute(c) { if (c.key === "request") { foregroundStarted = true; return settled; } await release.promise; return settled; } });
      const { coordinator } = pool;
      const jobs: Promise<unknown>[] = [];
      try {
        jobs.push(coordinator.submit(candidate("own-pull", "mine"))); await tick();
        jobs.push(coordinator.submit({ ...candidate("request", "mine"), foreground: true }).catch(error => { rejection = deferralReason(error); })); await tick();
        const foregroundBeforeOwnPullRelease = foregroundStarted, spareRegularWhileWaiting = 4 - coordinator.snapshot().regularLogical;
        release.resolve(); await Promise.allSettled(jobs); await tick();
        return { foregroundBeforeOwnPullRelease, foregroundAfterOwnPullRelease: foregroundStarted, rejection, spareRegularWhileWaiting };
      } finally { release.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
    };
    return { withReserve: await run(1), withoutReserve: await run(0) };
  }
  if (id === "reserve-auxiliary-under-full-regular") {
    const release = deferred<void>(), parentDependency = deferred<void>();
    let auxiliaryStarted = false, regularLogicalAtAuxiliaryStart = 0, furtherPullStarted = false, furtherForegroundStarted = false;
    const pool = reservePool(1, { async execute(c, permit, signal) {
      // The refresh result arrives later: the parent stays parked, so the regular pool stays full.
      if (c.auxiliary) { auxiliaryStarted = true; regularLogicalAtAuxiliaryStart = pool.coordinator.snapshot().regularLogical; return settled; }
      if (c.key === "parent") { await pool.coordinator.parkUntil(permit, parentDependency.promise, signal); return settled; }
      if (c.key === "further-pull") { furtherPullStarted = true; return settled; }
      if (c.key === "further-foreground") { furtherForegroundStarted = true; return settled; }
      await release.promise; return settled;
    } });
    const { coordinator } = pool;
    const jobs: Promise<unknown>[] = [];
    try {
      jobs.push(coordinator.submit(candidate("parent", "A"))); await tick();
      jobs.push(coordinator.submit(candidate("B")), coordinator.submit(candidate("C")), coordinator.submit({ ...candidate("D"), foreground: true })); await tick();
      assert.equal(coordinator.snapshot().regularLogical, 4, "Three pulls (one parked) and one foreground fill the regular pool");
      jobs.push(coordinator.submit(candidate("further-pull", "E")), coordinator.submit({ ...candidate("further-foreground", "F"), foreground: true })); await tick();
      jobs.push(coordinator.submit({ ...candidate("aux-A", "A"), auxiliary: true })); await tick();
      const summary = { auxiliaryStartedUnderFullRegular: auxiliaryStarted, regularLogicalAtAuxiliaryStart,
        furtherPullStartedBeforeRelease: furtherPullStarted, furtherForegroundStartedBeforeRelease: furtherForegroundStarted };
      release.resolve(); parentDependency.resolve(); const results = await Promise.allSettled(jobs); await tick();
      return { ...summary, maxHeld: pool.maxHeld, completed: results.every(result => result.status === "fulfilled") && furtherPullStarted && furtherForegroundStarted };
    } finally { release.resolve(); parentDependency.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
  }
  if (id === "reserve-foreground-deadline-cancel") {
    const run = async (reserve: number) => {
      let time = 0, executions = 0, rejection: string | null = null;
      const releases = new Map(OTHER_ACCOUNTS.map(key => [key, deferred<void>()]));
      const pool = reservePool(reserve, { nowMs: () => time, async execute(c) { if (c.key === "request") { executions++; return settled; } await releases.get(c.key)!.promise; return settled; } });
      const { coordinator } = pool;
      const jobs: Promise<unknown>[] = [];
      try {
        for (const key of OTHER_ACCOUNTS) jobs.push(coordinator.submit(candidate(key))); await tick();
        const request = coordinator.submit({ ...candidate("request", "mine"), foreground: true }).catch(error => { rejection = deferralReason(error); });
        jobs.push(request); await tick();
        const startedBeforeDeadline = executions === 1;
        if (!startedBeforeDeadline) { time = 45_000; coordinator.cancel("request", new Error("Delivery attempt timeout.")); await request; }
        releases.get("other0")!.resolve(); await tick();
        const summary = reserve ? { startedBeforeDeadline, executions } : { startedBeforeDeadline, rejection, executionsAfterCancel: executions };
        for (const release of releases.values()) release.resolve(); await Promise.allSettled(jobs); return summary;
      } finally { for (const release of releases.values()) release.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
    };
    return { withReserve: await run(1), withoutReserve: await run(0) };
  }
  if (id === "reserve-all-parked-with-foreground") {
    const release = deferred<void>(); let rejection: string | null = null, retryDelayMs: number | null = null;
    const pool = reservePool(1, { async execute(c, permit, signal) {
      if (c.key === "late-foreground") throw new Error("A swept foreground must not execute");
      await pool.coordinator.parkUntil(permit, release.promise, signal); return settled;
    } });
    const { coordinator } = pool;
    const jobs: Promise<unknown>[] = [];
    try {
      for (const key of OTHER_ACCOUNTS.slice(0, 3)) jobs.push(coordinator.submit(candidate(key)));
      jobs.push(coordinator.submit({ ...candidate("parked-foreground", "X"), foreground: true })); await tick();
      const parkedRegular = coordinator.snapshot().parked, heldRegular = coordinator.snapshot().active;
      jobs.push(coordinator.submit({ ...candidate("late-foreground", "Y"), foreground: true }).catch(error => {
        rejection = deferralReason(error); if (error instanceof ProviderDispatchDeferred) retryDelayMs = error.deferral.retryAtMs; })); await tick();
      const summary = { parkedRegular, heldRegular, rejection, retryDelayMs };
      release.resolve(); await Promise.allSettled(jobs); return summary;
    } finally { release.resolve(); await Promise.allSettled(jobs); coordinator.close(); }
  }
  throw new Error("Unknown fair work scenario.");
}
