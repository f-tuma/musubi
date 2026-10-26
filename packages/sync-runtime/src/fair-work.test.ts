import assert from "node:assert/strict";
import { test } from "node:test";
import { createFairWorkCoordinator, type WorkCandidate } from "./fair-work";
import { createProviderBudget, ProviderDispatchDeferred, parseProviderRetryAfter, requireBudgetContinuationWindow, type BudgetLeaf } from "./provider-budget";
import { dispatchNativeHttp } from "../../provider-google/src/http-dispatch";

const scope = { dimension: "account" as const, key: "stable-physical-row" };
const leaf: BudgetLeaf = { scopes: [scope], purpose: "mutation", method: "POST", targetKey: "target", incarnationKey: "grant-1", operationKey: "operation", attemptKey: "attempt" };
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function budgetFixture() {
  let now = 0, capacity = 2, offline = false;
  const budget = createProviderBudget({ clock: { nowEpochMs: () => now, nowMonotonicMs: () => now },
    limit: () => ({ capacity, refillPerSecond: 2 }), retryPersistenceMs: 100, reservationLifetimeMs: 500,
    cooldowns: { loadActive: async () => { if (offline) throw new Error("offline"); return []; }, extend: async () => [] }, schedule: () => () => {} });
  return { budget, advance: (ms: number) => { now += ms; }, reconfigure: () => { capacity = 3; }, offline: (value: boolean) => { offline = value; } };
}
test("deferral rejects invalid time, reason and dimensions and owns bounded metadata", () => {
  for (const retryAtMs of [-1, 0.1, Infinity, NaN, 253_402_300_800_000])
    assert.throws(() => new ProviderDispatchDeferred({ retryAtMs, reason: "credit", blockedDimensions: [] }));
  assert.throws(() => new ProviderDispatchDeferred({ retryAtMs: 0, reason: "fake" as "credit", blockedDimensions: [] }));
  assert.throws(() => new ProviderDispatchDeferred({ retryAtMs: 0, reason: "credit", blockedDimensions: ["email" as "account"] }));
  const dimensions: "account"[] = ["account"], error = new ProviderDispatchDeferred({ retryAtMs: 1, reason: "credit", blockedDimensions: dimensions });
  dimensions.length = 0; assert.deepEqual(error.deferral.blockedDimensions, ["account"]);
});
test("bootstrap failure stays fail-closed, schedules retry, and can recover through the same production port", async () => {
  const f = budgetFixture(); f.offline(true); await assert.rejects(f.budget.ready());
  assert.equal(f.budget.snapshot().persistenceBlocked, true);
  assert.throws(() => f.budget.admit(leaf), (e: unknown) => e instanceof ProviderDispatchDeferred && e.deferral.reason === "budget-persistence-pending");
  f.offline(false); assert.equal(await f.budget.flushPending(), true); assert.equal(f.budget.snapshot().ready, true); f.budget.close();
});
test("continuation retention preserves the exact original fault for durable long waits", () => {
  const long = new ProviderDispatchDeferred({ retryAtMs: 253_402_300_799_999, reason: "cooldown", blockedDimensions: ["account"] });
  assert.throws(() => requireBudgetContinuationWindow(long, 1000, 15_000), error => error === long);
  const short = new ProviderDispatchDeferred({ retryAtMs: 1500, reason: "credit", blockedDimensions: ["account"] });
  assert.doesNotThrow(() => requireBudgetContinuationWindow(short, 1000, 15_000));
  assert.doesNotThrow(() => requireBudgetContinuationWindow(new ProviderDispatchDeferred({ retryAtMs: 16_000, reason: "credit", blockedDimensions: [] }), 1000, 15_000));
});
test("consumed mutation permission is not refunded or reused and changed configuration starts empty", async () => {
  const f = budgetFixture(); await f.budget.ready(); assert.throws(() => f.budget.admit(leaf)); f.advance(1000);
  const token = f.budget.reserveMutation(leaf); f.budget.consume(token, leaf); assert.throws(() => f.budget.consume(token, leaf));
  f.budget.refundUnused(token); f.budget.admit(leaf); assert.throws(() => f.budget.admit(leaf), ProviderDispatchDeferred);
  f.advance(1000); const unused = f.budget.reserveMutation(leaf); f.reconfigure(); assert.throws(() => f.budget.admit(leaf));
  f.budget.refundUnused(unused); assert.throws(() => f.budget.admit(leaf), ProviderDispatchDeferred); f.budget.close();
});
test("physical account cooldown survives authorization incarnation changes", async () => {
  const f = budgetFixture(); await f.budget.ready(); await f.budget.observeCooldown({ scopes: [scope], notBeforeEpochMs: 5000 }); f.advance(1000);
  assert.throws(() => f.budget.admit({ ...leaf, incarnationKey: "grant-2" }), (e: unknown) => e instanceof ProviderDispatchDeferred && e.deferral.reason === "cooldown"); f.budget.close();
});
test("MAX cooldown remains a supported-domain hold without fractional-clock overflow or early admission", async () => {
  const max = 253_402_300_799_999, initialEpoch = 1_800_000_000_000;
  let epoch = initialEpoch, mono = 0.2;
  const budget = createProviderBudget({ limit: () => undefined, clock: { nowEpochMs: () => epoch, nowMonotonicMs: () => mono },
    cooldowns: { loadActive: async () => [{ scope, notBeforeEpochMs: max, minimumRemainingMs: max - epoch }], extend: async () => [] },
    retryPersistenceMs: 1000, reservationLifetimeMs: 1000 });
  await budget.ready();
  try {
    for (const clock of [{ epoch: initialEpoch + 1, mono: 0.2 + 0.1 }, { epoch: initialEpoch - 1000, mono: 0.4 },
      { epoch: initialEpoch + 1000, mono: 0.5 }, { epoch: max, mono: max + 1 }]) {
      epoch = clock.epoch; mono = clock.mono;
      assert.throws(() => budget.admit(leaf), (error: unknown) => error instanceof ProviderDispatchDeferred &&
        error.deferral.retryAtMs === max && error.deferral.reason === "cooldown");
    }
  } finally { budget.close(); }
});
test("ordinary cooldown retains the conservative monotonic duration and still expires", async () => {
  let epoch = 1000, mono = 0.2;
  const budget = createProviderBudget({ limit: () => undefined, clock: { nowEpochMs: () => epoch, nowMonotonicMs: () => mono },
    cooldowns: { loadActive: async () => [{ scope, notBeforeEpochMs: 2000, minimumRemainingMs: 1500 }], extend: async () => [] },
    retryPersistenceMs: 1000, reservationLifetimeMs: 1000 });
  await budget.ready();
  try {
    epoch = 500; mono = 1499.2;
    assert.throws(() => budget.admit(leaf), (error: unknown) => error instanceof ProviderDispatchDeferred && error.deferral.retryAtMs === 501);
    mono = 1500.2; assert.doesNotThrow(() => budget.admit(leaf));
  } finally { budget.close(); }
});
test("request during active work runs a later host claim instead of joining the captured generation", async () => {
  const gate = deferred<void>(), firstStarted = deferred<void>(); let calls = 0;
  const c: WorkCandidate<string> = { key: "work", accountFairnessKey: "account", laneKey: "stream", family: "pull", dueAtMs: 0, orderKey: "1", collisionKeys: ["resource"], hostRef: "work" };
  const coordinator = createFairWorkCoordinator({ capacity: 2, host: { async execute() { if (++calls === 1) { firstStarted.resolve(); await gate.promise; } return { kind: "settled" as const, changedCalendarIDs: [] }; } } });
  try { const first = coordinator.submit(c); await firstStarted.promise; const newer = coordinator.submit(c); gate.resolve(); await Promise.all([first, newer]); assert.equal(calls, 2); }
  finally { gate.resolve(); coordinator.close(); }
});
test("decorator cannot fabricate a response or retain an aborted raw capability", async () => {
  let calls = 0;
  await assert.rejects(dispatchNativeHttp({ dispatch: async () => new Response() }, "https://fixture.test/", {}, async () => { calls++; return new Response(); },
    { nowMonotonicMs: () => 0 }, () => {})); assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(dispatchNativeHttp({ async dispatch(_request, send) { controller.abort(); return send(); } }, "https://fixture.test/", { signal: controller.signal },
    async () => { calls++; return new Response(); }, { nowMonotonicMs: () => 0 }, () => { throw new Error("No no-send metric"); })); assert.equal(calls, 0);
});
test("external Retry-After parsing distinguishes invalid, unsupported and supported hints", () => {
  for (const value of ["not-a-date", "-1", "1.5", "", "2026-10-26"]) assert.equal(parseProviderRetryAfter(value, 0).kind, "invalid");
  assert.equal(parseProviderRetryAfter("9999999999999999999999999999999", 0).kind, "unsupported");
  assert.deepEqual(parseProviderRetryAfter("2", 1000), { kind: "supported", notBeforeEpochMs: 3000, minimumDelayMs: 2000 });
  assert.deepEqual(parseProviderRetryAfter("Mon, 26 Oct 2026 10:00:00 GMT", 0), { kind: "supported", notBeforeEpochMs: Date.parse("2026-10-26T10:00:00Z") });
});
test("overlapping inherited children cannot send concurrently under one parent permit", async () => {
  const gate = deferred<void>(); let children = 0;
  const candidate: WorkCandidate<string> = { key: "parent", family: "pull", accountFairnessKey: "A", laneKey: "lane", orderKey: "1", dueAtMs: 0, collisionKeys: ["resource"], hostRef: "parent" };
  const coordinator = createFairWorkCoordinator<string>({ capacity: 1, host: { async execute(_c, permit) {
    const first = coordinator.runChild(permit, candidate, async () => { children++; await gate.promise; return { kind: "settled", changedCalendarIDs: [] }; });
    const second = await coordinator.runChild(permit, candidate, async () => { children++; throw new Error("Must not overlap"); });
    assert.deepEqual(second, { kind: "skipped", reason: "not-eligible" }); gate.resolve(); await first;
    return { kind: "settled", changedCalendarIDs: [] };
  } } });
  try { await coordinator.submit(candidate); assert.equal(children, 1); } finally { gate.resolve(); coordinator.close(); }
});
test("unclaimable re-offers back off while a ready account progresses", async () => {
  let now = 0, a = 0, b = 0;
  const item = (key: string): WorkCandidate<string> => ({ key, family: "pull", accountFairnessKey: key, laneKey: key, orderKey: key, dueAtMs: 0, collisionKeys: [key], hostRef: key });
  const coordinator = createFairWorkCoordinator<string>({ capacity: 2, nowMs: () => now, schedule: () => () => {}, host: {
    candidates: async () => ({ candidates: [item("A"), ...(!b ? [item("B")] : [])] }),
    async execute(c) { if (c.key === "A") { a++; return { kind: "skipped", reason: "not-eligible" }; } b++; return { kind: "settled", changedCalendarIDs: [] }; },
  } });
  try { coordinator.kick(); for (let i = 0; i < 100; i++) await Promise.resolve(); assert.equal(a, 1); assert.equal(b, 1);
    now = 99; coordinator.kick(); for (let i = 0; i < 30; i++) await Promise.resolve(); assert.equal(a, 1);
    now = 100; coordinator.kick(); for (let i = 0; i < 50; i++) await Promise.resolve(); assert.equal(a, 2);
  } finally { coordinator.close(); }
});
test("parked account cannot fill pending capacity and cancelled continuation never sends", async () => {
  const started = deferred<void>(), controller = new AbortController(); let sends = 0, b = 0;
  const item = (key: string, account = key): WorkCandidate<string> => ({ key, family: "pull", accountFairnessKey: account, laneKey: key, orderKey: key, dueAtMs: 0, collisionKeys: [key], hostRef: key });
  const coordinator = createFairWorkCoordinator<string>({ capacity: 2, candidateLimit: 8, nowMs: () => 0, schedule: () => () => {}, host: {
    async execute(c, permit) { if (c.key === "A") { started.resolve(); await coordinator.park(permit, 10_000, controller.signal); sends++; } else b++;
      return { kind: "settled", changedCalendarIDs: [] }; },
  } });
  const a = coordinator.submit(item("A")); void a.catch(() => {});
  try { await started.promise; const queued = Array.from({ length: 20 }, (_, i) => coordinator.submit(item(`A-${i}`, "A")).catch(() => undefined));
    await coordinator.submit(item("B")); assert.equal(b, 1); assert(coordinator.snapshot().pending <= 8);
    controller.abort(new Error("cancel")); await assert.rejects(a); assert.equal(sends, 0); coordinator.close(); await Promise.all(queued);
  } finally { controller.abort(); coordinator.close(); }
});
test("four parked regular jobs reserve auxiliary headroom and overload new regular work explicitly", async () => {
  const started = deferred<void>(); let regular = 0, auxiliary = 0;
  const item = (key: string, account = key): WorkCandidate<string> => ({ key, family: "pull", accountFairnessKey: account, laneKey: key, orderKey: key, dueAtMs: 0, collisionKeys: [], hostRef: key });
  const coordinator = createFairWorkCoordinator<string>({ capacity: 4, nowMs: () => 0, schedule: () => () => {}, host: {
    async execute(c, permit) {
      if (c.auxiliary) { auxiliary++; return { kind: "settled", changedCalendarIDs: [] }; }
      if (++regular === 4) started.resolve(); await coordinator.park(permit, 60_000);
      return { kind: "settled", changedCalendarIDs: [] };
    },
  } });
  const parents = ["A", "B", "C", "D"].map(key => coordinator.submit(item(key)).catch(() => undefined));
  try { await started.promise; for (let i = 0; i < 20; i++) await Promise.resolve();
    await assert.rejects(coordinator.submit(item("healthy")), (e: unknown) => e instanceof ProviderDispatchDeferred && e.deferral.reason === "work-capacity");
    await Promise.all(["A", "B", "C", "D"].map(key => coordinator.submit({ ...item(`aux-${key}`, key), auxiliary: true })));
    assert.equal(auxiliary, 4); assert(coordinator.snapshot().regularLogical <= 4); assert(coordinator.snapshot().auxiliaryLogical <= 4);
  } finally { coordinator.close(); await Promise.all(parents); }
});
