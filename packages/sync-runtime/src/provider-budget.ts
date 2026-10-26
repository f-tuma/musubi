import type { HttpDispatchPort, HttpDispatchRequest } from "./http-dispatch";

const MAX_BUDGET_EPOCH_MS = 253_402_300_799_999;
export type BudgetDimension = "provider" | "application" | "tenant" | "account";
export interface BudgetScope { readonly key: string; readonly dimension: BudgetDimension }
export interface BudgetDeferral {
  readonly retryAtMs: number;
  readonly blockedDimensions: readonly BudgetDimension[];
  readonly reason: "credit" | "cooldown" | "budget-persistence-pending" | "work-capacity";
}
export class ProviderDispatchDeferred extends Error {
  readonly deferral: BudgetDeferral;
  constructor(deferral: BudgetDeferral) {
    super("Provider dispatch deferred."); this.name = "ProviderDispatchDeferred";
    if (!Number.isSafeInteger(deferral.retryAtMs) || deferral.retryAtMs < 0 || deferral.retryAtMs > MAX_BUDGET_EPOCH_MS)
      throw new RangeError("Invalid budget eligibility.");
    if (!["credit", "cooldown", "budget-persistence-pending", "work-capacity"].includes(deferral.reason) || !Array.isArray(deferral.blockedDimensions) ||
      deferral.blockedDimensions.some(dimension => !["provider", "application", "tenant", "account"].includes(dimension)))
      throw new TypeError("Invalid budget deferral metadata.");
    this.deferral = Object.freeze({ ...deferral, blockedDimensions: Object.freeze([...new Set(deferral.blockedDimensions)]) });
  }
}
export function providerDeferral(error: unknown): BudgetDeferral | undefined {
  return error instanceof ProviderDispatchDeferred ? error.deferral : undefined;
}
/** Host retention policy only: keep exact eligibility and fault when a wait should be durable. */
export function requireBudgetContinuationWindow(error: ProviderDispatchDeferred, nowEpochMs: number, maximumWaitMs: number) {
  if (!Number.isFinite(nowEpochMs) || !Number.isFinite(maximumWaitMs) || maximumWaitMs < 0) throw new RangeError("Invalid continuation retention window.");
  if (error.deferral.retryAtMs - nowEpochMs > maximumWaitMs) throw error;
}
export interface BudgetLeaf {
  readonly scopes: readonly BudgetScope[];
  readonly purpose: "discovery" | "pull" | "preflight" | "mutation" | "readback" | "oauth-refresh" | "revoke";
  readonly method: string;
  readonly targetKey: string;
  readonly incarnationKey: string;
  readonly operationKey?: string;
  readonly attemptKey?: string;
}
export interface CooldownObservation {
  readonly scopes: readonly BudgetScope[];
  readonly notBeforeEpochMs: number;
  readonly minimumDelayMs?: number;
}
export interface CooldownSnapshot {
  readonly scope: BudgetScope;
  readonly notBeforeEpochMs: number;
  readonly minimumRemainingMs: number;
}
export interface DurableCooldownPort {
  loadActive(): Promise<readonly CooldownSnapshot[]>;
  extend(observations: readonly CooldownObservation[]): Promise<readonly CooldownSnapshot[]>;
}
export type ParsedProviderRetryAfter = { readonly kind: "missing" | "invalid" | "unsupported" } |
  { readonly kind: "supported"; readonly notBeforeEpochMs: number; readonly minimumDelayMs?: number };
/** Parse external HTTP data without converting malformed input into an infrastructure fault. */
export function parseProviderRetryAfter(value: string | null, nowEpochMs: number): ParsedProviderRetryAfter {
  if (value === null) return { kind: "missing" };
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const delay = Number(text) * 1000, at = nowEpochMs + delay;
    return Number.isSafeInteger(delay) && Number.isSafeInteger(at) && at >= 0 && at <= MAX_BUDGET_EPOCH_MS
      ? { kind: "supported", notBeforeEpochMs: at, minimumDelayMs: delay } : { kind: "unsupported" };
  }
  // HTTP-date permits IMF-fixdate and the two obsolete recipient formats.
  if (!/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(text)) return { kind: "invalid" };
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return { kind: "invalid" };
  return Number.isSafeInteger(at) && at >= 0 && at <= MAX_BUDGET_EPOCH_MS ? { kind: "supported", notBeforeEpochMs: at } : { kind: "unsupported" };
}
export interface ProviderBudgetOptions {
  /** Explicit operator policy, not provider quota discovery. An absent limit disables that dimension. */
  readonly limit: (scope: BudgetScope) => { readonly capacity: number; readonly refillPerSecond: number } | undefined;
  readonly clock: { nowEpochMs(): number; nowMonotonicMs(): number };
  readonly cooldowns: DurableCooldownPort;
  readonly retryPersistenceMs: number;
  readonly reservationLifetimeMs: number;
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  readonly onPersistenceFailure?: () => void;
  readonly onPersistenceRecovered?: () => void;
}
declare const reservationBrand: unique symbol;
export interface MutationReservation { readonly [reservationBrand]: true }
const scopeID = (scope: BudgetScope) => JSON.stringify([scope.dimension, scope.key]);
const leafID = (leaf: BudgetLeaf) => JSON.stringify([leaf.purpose, leaf.method.toUpperCase(), leaf.targetKey,
  leaf.incarnationKey, leaf.operationKey, leaf.attemptKey, leaf.scopes.map(scopeID).sort()]);

/** Singleton host policy; empty cold buckets and durable scope cooldowns, never storage/auth authority. */
export function createProviderBudget(options: ProviderBudgetOptions) {
  for (const value of [options.retryPersistenceMs, options.reservationLifetimeMs])
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Invalid budget bounds.");
  const schedule = options.schedule ?? ((run, delay) => { const timer = setTimeout(run, Math.min(2_147_483_647, delay)); return () => clearTimeout(timer); });
  const buckets = new Map<string, { tokens: number; at: number; capacity: number; rate: number }>();
  const cooldowns = new Map<string, { untilMonotonicMs: number; supportedDomainHold: boolean }>(), pending = new Map<string, CooldownObservation>();
  const reservations = new Map<MutationReservation, { identity: string; expires: number; scopes: readonly BudgetScope[];
    debits: readonly { key: string; bucket: NonNullable<ReturnType<typeof bucket>> }[]; used: boolean }>();
  let hydrated = false, blocked = false, nextPersistenceAtMs: number | undefined, flushing: Promise<boolean> | undefined;
  let cancelFlush: (() => void) | undefined, closed = false, invalidObservation = false;
  const uniqueScopes = (scopes: readonly BudgetScope[]) => [...new Map(scopes.map(scope => {
    if (!scope.key || !["provider", "application", "tenant", "account"].includes(scope.dimension)) throw new TypeError("Invalid budget scope.");
    return [scopeID(scope), Object.freeze({ ...scope })] as const;
  })).values()];
  function bucket(scope: BudgetScope) {
    const limit = options.limit(scope); if (!limit) return;
    if (!Number.isFinite(limit.capacity) || limit.capacity < 1 || !Number.isFinite(limit.refillPerSecond) || limit.refillPerSecond <= 0)
      throw new RangeError("Invalid configured token bucket.");
    const key = scopeID(scope), current = options.clock.nowMonotonicMs(), rate = limit.refillPerSecond / 1000;
    let value = buckets.get(key);
    if (!value || value.capacity !== limit.capacity || value.rate !== rate) {
      // Restart/config change cannot mint a burst or credit for process downtime.
      value = { tokens: 0, at: current, capacity: limit.capacity, rate }; buckets.set(key, value);
    }
    const at = Math.max(value.at, current);
    value.tokens = Math.min(value.capacity, value.tokens + (at - value.at) * value.rate); value.at = at;
    return value;
  }
  function eligibility(scopes: readonly BudgetScope[], credit: boolean): BudgetDeferral | undefined {
    const epoch = options.clock.nowEpochMs(), mono = options.clock.nowMonotonicMs();
    if (closed || !hydrated || blocked) return { reason: "budget-persistence-pending", blockedDimensions: [],
      retryAtMs: nextPersistenceAtMs ?? epoch + options.retryPersistenceMs };
    let retry = 0, supportedDomainHold = false, reason: BudgetDeferral["reason"] = "credit";
    const dimensions: BudgetDimension[] = [];
    for (const scope of scopes) {
      const state = cooldowns.get(scopeID(scope));
      const cooldown = Math.max(0, (state?.untilMonotonicMs ?? mono) - mono);
      const value = credit ? bucket(scope) : undefined;
      const refill = value && value.tokens < 1 ? Math.ceil((1 - value.tokens) / value.rate) : 0;
      if (state?.supportedDomainHold || cooldown > 0 || refill > 0) {
        dimensions.push(scope.dimension); retry = Math.max(retry, cooldown, refill);
        if (state?.supportedDomainHold) supportedDomainHold = true;
        if (state?.supportedDomainHold || cooldown > 0) reason = "cooldown";
      }
    }
    // MAX is an unavailable-through-domain hold, not a duration to round-trip
    // through fractional monotonic time. Keep its exact durable control value
    // while the independent admission gate stays closed, even after clock jumps.
    return dimensions.length ? { retryAtMs: supportedDomainHold ? MAX_BUDGET_EPOCH_MS : epoch + Math.ceil(retry), blockedDimensions: dimensions, reason } : undefined;
  }
  function raiseCooldown(key: string, untilMonotonicMs: number, supportedDomainHold: boolean, mono: number) {
    const prior = cooldowns.get(key);
    cooldowns.set(key, { untilMonotonicMs: Math.max(prior?.untilMonotonicMs ?? mono, untilMonotonicMs),
      supportedDomainHold: supportedDomainHold || prior?.supportedDomainHold === true });
  }
  function admit(leaf: BudgetLeaf) {
    const scopes = uniqueScopes(leaf.scopes), refused = eligibility(scopes, true);
    if (refused) throw new ProviderDispatchDeferred(refused);
    for (const scope of scopes) { const value = bucket(scope); if (value) value.tokens -= 1; }
  }
  function apply(rows: readonly CooldownSnapshot[]) {
    const epoch = options.clock.nowEpochMs(), mono = options.clock.nowMonotonicMs();
    for (const row of rows) {
      if (!Number.isFinite(row.notBeforeEpochMs) || !Number.isFinite(row.minimumRemainingMs) || row.minimumRemainingMs < 0)
        throw new TypeError("Invalid durable cooldown snapshot.");
      const key = scopeID(row.scope), until = mono + Math.max(0, row.minimumRemainingMs, row.notBeforeEpochMs - epoch);
      raiseCooldown(key, until, row.notBeforeEpochMs === MAX_BUDGET_EPOCH_MS, mono);
    }
  }
  function retry() {
    blocked = true; nextPersistenceAtMs = options.clock.nowEpochMs() + options.retryPersistenceMs;
    cancelFlush?.(); if (!closed) cancelFlush = schedule(() => { void flushPending(); }, options.retryPersistenceMs);
    try { options.onPersistenceFailure?.(); } catch { /* Diagnostics only. */ }
  }
  async function ready() {
    try { apply(await options.cooldowns.loadActive()); hydrated = true; }
    catch (error) { retry(); throw error; }
  }
  async function flushPending(): Promise<boolean> {
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        if (invalidObservation) throw new TypeError("Invalid cooldown observation remains fail-closed.");
        if (!hydrated) await ready();
        while (pending.size) {
          const batch = [...pending.entries()]; apply(await options.cooldowns.extend(batch.map(([, value]) => value)));
          for (const [key, value] of batch) if (pending.get(key) === value) pending.delete(key);
        }
        const recovering = blocked;
        blocked = false; nextPersistenceAtMs = undefined; cancelFlush?.(); cancelFlush = undefined;
        if (recovering) try { options.onPersistenceRecovered?.(); } catch { /* Diagnostics only. */ }
        return true;
      } catch { retry(); return false; }
    })().finally(() => { flushing = undefined; });
    return flushing;
  }
  async function observeCooldown(observation: CooldownObservation) {
    if (!Number.isFinite(observation.notBeforeEpochMs) || observation.minimumDelayMs !== undefined &&
      (!Number.isFinite(observation.minimumDelayMs) || observation.minimumDelayMs < 0)) { invalidObservation = true; retry(); return; }
    const scopes = uniqueScopes(observation.scopes), epoch = options.clock.nowEpochMs(), mono = options.clock.nowMonotonicMs();
    for (const scope of scopes) {
      const key = scopeID(scope), until = mono + Math.max(0, observation.notBeforeEpochMs - epoch, observation.minimumDelayMs ?? 0);
      raiseCooldown(key, until, observation.notBeforeEpochMs === MAX_BUDGET_EPOCH_MS, mono);
      const prior = pending.get(key);
      pending.set(key, { scopes: [scope], notBeforeEpochMs: Math.max(prior?.notBeforeEpochMs ?? -Infinity, observation.notBeforeEpochMs),
        minimumDelayMs: Math.max(prior?.minimumDelayMs ?? 0, observation.minimumDelayMs ?? 0) });
    }
    await flushPending(); // Failure is retained by the health gate, never substituted for the real Response.
  }
  function reserveDispatch(leaf: BudgetLeaf): MutationReservation {
    admit(leaf); const token = Object.freeze({}) as MutationReservation;
    reservations.set(token, { identity: leafID(leaf), expires: options.clock.nowMonotonicMs() + options.reservationLifetimeMs,
      scopes: uniqueScopes(leaf.scopes), debits: uniqueScopes(leaf.scopes).flatMap(scope => {
        const key = scopeID(scope), value = buckets.get(key); return value ? [{ key, bucket: value }] : [];
      }), used: false }); return token;
  }
  function reserveMutation(leaf: BudgetLeaf): MutationReservation {
    if (leaf.purpose !== "mutation") throw new TypeError("Only matching physical mutations can reserve.");
    return reserveDispatch(leaf);
  }
  function refundUnused(token: MutationReservation) {
    const reservation = reservations.get(token); if (!reservation) return;
    reservations.delete(token);
    if (!reservation.used) for (const debit of reservation.debits) {
      if (buckets.get(debit.key) === debit.bucket) debit.bucket.tokens = Math.min(debit.bucket.capacity, debit.bucket.tokens + 1);
    }
  }
  function validateReservation(token: MutationReservation, leaf: BudgetLeaf) {
    const reservation = reservations.get(token);
    if (!reservation || reservation.used || reservation.identity !== leafID(leaf)) throw new Error("Mutation reservation mismatch or reuse.");
    const refused = eligibility(reservation.scopes, false);
    if (refused) throw new ProviderDispatchDeferred(refused);
    if (reservation.expires <= options.clock.nowMonotonicMs()) throw new ProviderDispatchDeferred({ reason: "credit",
      blockedDimensions: [], retryAtMs: options.clock.nowEpochMs() + 1 });
    return reservation;
  }
  function consume(token: MutationReservation, leaf: BudgetLeaf) { validateReservation(token, leaf).used = true; }
  return {
    ready, admit, reserveDispatch, reserveMutation, consume, refundUnused, observeCooldown, flushPending,
    /** Scope/purpose/authority resolution is host-owned; a URL or queued hint is not a grant. */
    decorate(resolveLeaf: (request: HttpDispatchRequest) => BudgetLeaf,
      guard: () => void,
      cooldownForResponse?: (leaf: BudgetLeaf, response: Response) => CooldownObservation | undefined,
      reservationFor?: (leaf: BudgetLeaf) => MutationReservation | undefined,
      waitForBudget?: (deferral: BudgetDeferral, error: ProviderDispatchDeferred) => Promise<void>): HttpDispatchPort {
      return {
        isDispatchDeferred: error => error instanceof ProviderDispatchDeferred,
        async dispatch(request, send) {
          guard(); request.signal?.throwIfAborted(); const leaf = resolveLeaf(request);
          let token = reservationFor?.(leaf);
          if (token) validateReservation(token, leaf); // A permanent marker cannot silently acquire replacement permission.
          else for (;;) {
            try { token = reserveDispatch(leaf); break; }
            catch (error) {
              const deferral = providerDeferral(error); if (!deferral || !waitForBudget) throw error;
              await waitForBudget(deferral, error as ProviderDispatchDeferred); guard(); request.signal?.throwIfAborted();
            }
          }
          try {
            const response = await send(() => { guard(); request.signal?.throwIfAborted();
              consume(token!, leaf); return undefined; });
            try {
              const observation = cooldownForResponse?.(leaf, response);
              if (observation) await observeCooldown(observation);
            } catch {
              // A malformed host observation cannot replace known HTTP evidence or open a dispatch bypass.
              invalidObservation = true; retry();
            }
            return response;
          } finally { if (token) refundUnused(token); }
        },
      };
    },
    snapshot() { return { ready: hydrated, persistenceBlocked: blocked, pendingCooldowns: pending.size, nextPersistenceAtMs }; },
    close() { closed = true; cancelFlush?.(); for (const token of reservations.keys()) refundUnused(token); },
  };
}
