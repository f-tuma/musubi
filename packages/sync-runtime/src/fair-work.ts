/** Storage-free selection only. Real claims, source authority and settlement belong to the host. */
import { ProviderDispatchDeferred } from "./provider-budget";
export type WorkFamily = "pull" | "event-delivery" | "task-delivery" | "outlook-move";
export interface WorkCandidate<HostRef> {
  readonly key: string;
  readonly family: WorkFamily;
  readonly accountFairnessKey: string;
  readonly laneKey: string;
  readonly dueAtMs: number;
  readonly orderKey: string;
  readonly collisionKeys: readonly string[];
  readonly hostRef: HostRef;
  /** Explicit in-process dependency only; never populated by durable candidate data. */
  readonly auxiliary?: boolean;
}
export type WorkExecutionResult =
  | { readonly kind: "settled"; readonly changedCalendarIDs: readonly string[] }
  | { readonly kind: "deferred"; readonly retryAtMs: number; readonly changedCalendarIDs: readonly string[] }
  | { readonly kind: "skipped"; readonly reason: "not-eligible" | "settled" | "lost-lease" | "retired" };
declare const permitBrand: unique symbol;
export interface WorkPermit { readonly [permitBrand]: true }
export interface CandidatePage<HostRef> {
  readonly candidates: readonly WorkCandidate<HostRef>[];
  readonly nextAccountCursor?: string;
  readonly nextWakeAtMs?: number;
}
export interface WorkHost<HostRef> {
  candidates?(input: { nowMs: number; limit: number; accountCursor?: string;
    excludedAccounts: readonly string[]; excludedCollisionKeys: readonly string[] }): Promise<CandidatePage<HostRef>>;
  execute(candidate: WorkCandidate<HostRef>, permit: WorkPermit, signal: AbortSignal): Promise<WorkExecutionResult>;
  onFailure?(error: unknown): void;
}
export interface FairWorkOptions<HostRef> {
  readonly capacity: number;
  readonly candidateLimit?: number;
  readonly host: WorkHost<HostRef>;
  readonly nowMs?: () => number;
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}
type Waiter = { resolve(value: WorkExecutionResult): void; reject(error: unknown): void };
type Pending<H> = { candidate: WorkCandidate<H>; waiters: Waiter[]; queueKey: string | WorkPermit;
  resume?: { permit: WorkPermit; resolve(): void; reject(error: unknown): void; detach(): void } };

export function createFairWorkCoordinator<H>(options: FairWorkOptions<H>) {
  if (!Number.isInteger(options.capacity) || options.capacity < 1 ||
      !Number.isInteger(options.candidateLimit ?? 80) || (options.candidateLimit ?? 80) < 1)
    throw new RangeError("Invalid fair work bounds.");
  const now = options.nowMs ?? Date.now;
  const schedule = options.schedule ?? ((run, delay) => { const timer = setTimeout(run, Math.min(2_147_483_647, delay)); return () => clearTimeout(timer); });
  const pending = new Map<string | WorkPermit, Pending<H>>(), accounts = new Set<string>(), collisions = new Map<string, WorkPermit>();
  const active = new Map<string, { permit: WorkPermit; controller: AbortController }>();
  const permits = new Map<WorkPermit, { account: string; keys: Set<string>; controller: AbortController; item: Pending<H>; held: boolean; childActive: boolean }>();
  const lastFamily = new Map<string, string>();
  const refused = new Map<string, number>();
  const parkedWaits = new Map<WorkPermit, { reject(error: unknown): void; detach(): void }>();
  const lastLane = new Map<string, string>(), recoveryStreak = new Map<string, number>();
  let lastAccount = "", cursor: string | undefined, pumping = false, requested = false, closed = false;
  let cancelTimer: (() => void) | undefined;
  function owned(candidate: WorkCandidate<H>): WorkCandidate<H> {
    if (!candidate.key || !candidate.accountFairnessKey || !candidate.laneKey || !Number.isFinite(candidate.dueAtMs))
      throw new TypeError("Invalid work candidate.");
    return Object.freeze({ ...candidate, collisionKeys: Object.freeze([...new Set(candidate.collisionKeys)]) });
  }
  function add(candidate: WorkCandidate<H>, waiter?: Waiter) {
    const accountPending = [...pending.values()].filter(item => !item.resume && item.candidate.accountFairnessKey === candidate.accountFairnessKey && !item.candidate.auxiliary).length;
    if (!candidate.auxiliary && !pending.has(candidate.key) && accountPending >= Math.max(4, options.capacity)) {
      waiter?.reject(new ProviderDispatchDeferred({ retryAtMs: now() + 1000, reason: "work-capacity", blockedDimensions: [] })); return;
    }
    const until = refused.get(candidate.key);
    if (until !== undefined && until <= now()) refused.delete(candidate.key);
    if (until !== undefined && until > candidate.dueAtMs) candidate = { ...candidate, dueAtMs: until };
    // A descriptor read before the previous claim deferred can arrive after its
    // completion. Report the known due time rather than retaining its caller
    // until then; the background candidate still waits for a fresh host claim.
    if (waiter && until !== undefined && until > now()) {
      waiter.resolve({ kind: "deferred", retryAtMs: candidate.dueAtMs, changedCalendarIDs: [] }); waiter = undefined;
    }
    const existing = pending.get(candidate.key);
    if (existing) {
      if (waiter) { if (existing.waiters.length >= 128) { waiter.reject(new ProviderDispatchDeferred({ retryAtMs: now() + 1000, reason: "work-capacity", blockedDimensions: [] })); return; } existing.waiters.push(waiter); }
      return;
    }
    const maximum = (options.candidateLimit ?? 80) + (candidate.auxiliary ? options.capacity : 0);
    if (pending.size >= maximum) { waiter?.reject(new ProviderDispatchDeferred({ retryAtMs: now() + 1000, reason: "work-capacity", blockedDimensions: [] })); return; }
    pending.set(candidate.key, { candidate: owned(candidate), waiters: waiter ? [waiter] : [], queueKey: candidate.key });
  }
  function backoff(key: string, until: number, result?: Extract<WorkExecutionResult, { kind: "deferred" }>) {
    refused.delete(key); refused.set(key, until);
    const maximum = Math.max(128, (options.candidateLimit ?? 80) * 4);
    while (refused.size > maximum) refused.delete(refused.keys().next().value!);
    for (const item of pending.values()) if (!item.resume && item.candidate.key === key) {
      item.candidate = owned({ ...item.candidate, dueAtMs: Math.max(item.candidate.dueAtMs, until) });
      // These callers requested a later capture while this claim was active.
      // Deferral is control information, never an ACK of their newer work.
      // Keep the queued candidate, but release callers with the exact result.
      if (result) for (const waiter of item.waiters.splice(0)) waiter.resolve(result);
    }
  }
  function choose(): Pending<H> | undefined {
    const regular = [...permits.values()].filter(state => !state.item.candidate.auxiliary).length;
    const auxiliary = active.size - regular;
    const eligible = [...pending.values()].filter(item => { const c = item.candidate; return c.dueAtMs <= now() &&
      (item.resume ? permits.has(item.resume.permit) : !active.has(c.key) && (c.auxiliary ? auxiliary : regular) < options.capacity) &&
      (item.resume || c.auxiliary || ![...permits.values()].some(state => state.account === c.accountFairnessKey && !state.item.candidate.auxiliary)) &&
      !accounts.has(c.accountFairnessKey) && c.collisionKeys.every(key => !collisions.has(key)); });
    const accountKeys = [...new Set(eligible.map(p => p.candidate.accountFairnessKey))].sort();
    const account = accountKeys.find(key => key > lastAccount) ?? accountKeys[0];
    if (!account) return;
    let choices = eligible.filter(p => p.candidate.accountFairnessKey === account);
    const recovery = choices.filter(p => p.candidate.family !== "pull"), pulls = choices.filter(p => p.candidate.family === "pull");
    // Prefer recovery, but give a pending pull a turn after three recovery admissions.
    if (recovery.length && pulls.length) choices = (recoveryStreak.get(account) ?? 0) < 3 ? recovery : pulls;
    const lanes = [...new Set(choices.map(p => p.candidate.laneKey))].sort();
    const lane = lanes.find(key => key > (lastLane.get(account) ?? "")) ?? lanes[0]!;
    choices = choices.filter(p => p.candidate.laneKey === lane);
    const familyKey = JSON.stringify([account, lane]);
    const families = [...new Set(choices.map(p => p.candidate.family))].sort();
    const family = families.find(key => key > (lastFamily.get(familyKey) ?? "")) ?? families[0]!;
    lastFamily.set(familyKey, family);
    choices = choices.filter(p => p.candidate.family === family).sort((a, b) =>
      a.candidate.orderKey.localeCompare(b.candidate.orderKey) || a.candidate.key.localeCompare(b.candidate.key));
    const choice = choices[0]!;
    lastAccount = account; lastLane.set(account, lane);
    recoveryStreak.set(account, choice.candidate.family === "pull" ? 0 : (recoveryStreak.get(account) ?? 0) + 1);
    return choice;
  }
  function start(item: Pending<H>) {
    if (item.resume) {
      const state = permits.get(item.resume.permit); pending.delete(item.queueKey);
      if (!state) { item.resume.detach(); item.resume.reject(new Error("Inherited work permit expired.")); return; }
      state.held = true; accounts.add(state.account); for (const key of state.keys) collisions.set(key, item.resume.permit);
      item.resume.detach(); item.resume.resolve(); return;
    }
    const c = item.candidate, controller = new AbortController(), permit = Object.freeze({}) as WorkPermit;
    pending.delete(item.queueKey); accounts.add(c.accountFairnessKey);
    active.set(c.key, { permit, controller });
    const state = { account: c.accountFairnessKey, keys: new Set(c.collisionKeys), controller, item, held: true, childActive: false };
    permits.set(permit, state); for (const key of state.keys) collisions.set(key, permit);
    void Promise.resolve().then(() => options.host.execute(c, permit, controller.signal)).then(result => {
      if (result.kind === "skipped" && ["not-eligible", "lost-lease"].includes(result.reason)) backoff(c.key, now() + 100);
      else if (result.kind === "deferred") backoff(c.key, result.retryAtMs, result);
      for (const waiter of item.waiters) waiter.resolve(result);
    }, error => {
      backoff(c.key, now() + 1000);
      for (const waiter of item.waiters) waiter.reject(error);
      try { options.host.onFailure?.(error); } catch { /* Diagnostics have no authority. */ }
    }).finally(() => {
      controller.abort(new Error("Fair work execution finished."));
      const parked = pending.get(permit);
      if (parked?.resume) { pending.delete(permit); parked.resume.detach(); parked.resume.reject(new Error("Work execution finished while parked.")); }
      const waiting = parkedWaits.get(permit); if (waiting) { parkedWaits.delete(permit); waiting.detach(); waiting.reject(new Error("Work execution finished while awaiting a dependency.")); }
      active.delete(c.key); if (state.held) accounts.delete(c.accountFairnessKey); permits.delete(permit);
      for (const key of state.keys) if (collisions.get(key) === permit) collisions.delete(key);
      kick();
    });
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true; requested = false; cancelTimer?.(); cancelTimer = undefined;
    let nextWake: number | undefined;
    try {
      if (options.host.candidates && accounts.size < options.capacity && active.size < options.capacity * 2) {
        const page = await options.host.candidates({ nowMs: now(), limit: options.candidateLimit ?? 80,
          accountCursor: cursor, excludedAccounts: [...accounts], excludedCollisionKeys: [...collisions.keys()] });
        if (closed) return;
        cursor = page.nextAccountCursor; nextWake = page.nextWakeAtMs;
        for (const candidate of page.candidates) if (!active.has(candidate.key)) add(candidate);
      }
      while (!closed && accounts.size < options.capacity) { const item = choose(); if (!item) break; start(item); }
      const regular = [...permits.values()].filter(state => !state.item.candidate.auxiliary);
      if (regular.length >= options.capacity && regular.every(state => !state.held)) {
        for (const [key, item] of pending) if (!item.resume && !item.candidate.auxiliary) {
          pending.delete(key); backoff(item.candidate.key, now() + 1000);
          for (const waiter of item.waiters) waiter.reject(new ProviderDispatchDeferred({ retryAtMs: now() + 1000, reason: "work-capacity", blockedDimensions: [] }));
        }
      }
      for (const { candidate } of pending.values()) if (candidate.dueAtMs > now()) nextWake = Math.min(nextWake ?? Infinity, candidate.dueAtMs);
    } catch (error) { try { options.host.onFailure?.(error); } catch { /* Diagnostics only. */ } }
    finally {
      pumping = false;
      if (!closed && nextWake !== undefined && Number.isFinite(nextWake) && nextWake > now()) cancelTimer = schedule(kick, Math.max(1, nextWake - now()));
      if (requested && !closed) void Promise.resolve().then(pump);
    }
  }
  function kick() { if (closed) return; requested = true; if (!pumping) void Promise.resolve().then(pump); }
  function suspend<T>(permit: WorkPermit, retryAtMs: number, signal: AbortSignal | undefined,
    dependency?: Promise<T>): Promise<T | undefined> {
    const state = permits.get(permit);
    if (!state || !state.held || closed) return Promise.reject(new Error("Cannot park an inactive work permit."));
    if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253_402_300_799_999) return Promise.reject(new RangeError("Invalid parked eligibility."));
    signal?.throwIfAborted(); state.controller.signal.throwIfAborted();
    state.held = false; accounts.delete(state.account);
    for (const key of state.keys) if (collisions.get(key) === permit) collisions.delete(key);
    return new Promise<T | undefined>((resolve, reject) => {
      let ended = false;
      const detach = () => { signal?.removeEventListener("abort", aborted); state.controller.signal.removeEventListener("abort", aborted); };
      const aborted = () => { if (ended) return; ended = true; pending.delete(permit); parkedWaits.delete(permit); detach(); reject(signal?.aborted ? signal.reason : state.controller.signal.reason); kick(); };
      signal?.addEventListener("abort", aborted, { once: true }); state.controller.signal.addEventListener("abort", aborted, { once: true });
      parkedWaits.set(permit, { detach, reject(error) { if (!ended) { ended = true; reject(error); } } });
      const enqueue = (value?: T, error?: unknown, failed = false) => {
        if (ended || !permits.has(permit) || closed) return;
        pending.set(permit, { queueKey: permit, candidate: owned({ ...state.item.candidate, dueAtMs: dependency ? now() : retryAtMs, collisionKeys: [...state.keys] }), waiters: [],
          resume: { permit, detach() { ended = true; detach(); parkedWaits.delete(permit); },
            resolve() { if (failed) reject(error); else resolve(value); }, reject } }); kick();
      };
      if (dependency) void dependency.then(value => enqueue(value), error => enqueue(undefined, error, true));
      else enqueue();
      kick();
    });
  }
  return {
    kick,
    submit(candidate: WorkCandidate<H>): Promise<WorkExecutionResult> {
      if (closed) return Promise.reject(new Error("Fair work coordinator is closed."));
      return new Promise((resolve, reject) => { try { add(candidate, { resolve, reject }); kick(); } catch (error) { reject(error); } });
    },
    async runChild(parent: WorkPermit, child: WorkCandidate<H>, execute: () => Promise<WorkExecutionResult>): Promise<WorkExecutionResult> {
      const state = permits.get(parent);
      if (!state || !state.held || state.controller.signal.aborted || state.account !== child.accountFairnessKey)
        throw new Error("Inactive or unrelated inherited work permit.");
      if (state.childActive) return { kind: "skipped", reason: "not-eligible" };
      if (child.collisionKeys.some(key => collisions.has(key) && collisions.get(key) !== parent))
        return { kind: "skipped", reason: "not-eligible" };
      const added = child.collisionKeys.filter(key => !state.keys.has(key));
      for (const key of added) { state.keys.add(key); collisions.set(key, parent); }
      state.childActive = true;
      try { return await execute(); }
      finally { state.childActive = false; for (const key of added) { state.keys.delete(key); if (collisions.get(key) === parent) collisions.delete(key); } }
    },
    /** Preserve the native continuation while returning every temporary worker/account/collision hold. */
    park(permit: WorkPermit, retryAtMs: number, signal?: AbortSignal): Promise<void> {
      return suspend(permit, retryAtMs, signal).then(() => undefined);
    },
    parkUntil<T>(permit: WorkPermit, dependency: Promise<T>, signal?: AbortSignal): Promise<T> { return suspend(permit, now(), signal, dependency) as Promise<T>; },
    cancel(key: string, reason: unknown = new Error("Work cancelled.")) {
      const queued = pending.get(key); if (queued) { pending.delete(key); for (const waiter of queued.waiters) waiter.reject(reason); }
      active.get(key)?.controller.abort(reason); kick();
    },
    snapshot() { const regularLogical = [...permits.values()].filter(state => !state.item.candidate.auxiliary).length;
      return { active: accounts.size, logicalActive: active.size, regularLogical, auxiliaryLogical: active.size - regularLogical,
        parked: active.size - accounts.size, pending: pending.size, activeAccounts: accounts.size, heldCollisions: collisions.size }; },
    close() {
      closed = true; cancelTimer?.();
      for (const { controller } of active.values()) controller.abort(new Error("Fair work coordinator is closed."));
      for (const waiting of parkedWaits.values()) { waiting.detach(); waiting.reject(new Error("Fair work coordinator is closed.")); } parkedWaits.clear();
      for (const item of pending.values()) { if (item.resume) { item.resume.detach(); item.resume.reject(new Error("Fair work coordinator is closed.")); }
        for (const waiter of item.waiters) waiter.reject(new Error("Fair work coordinator is closed.")); }
      pending.clear();
    },
  };
}
