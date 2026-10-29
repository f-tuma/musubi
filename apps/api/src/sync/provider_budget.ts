import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { config, logger } from "@musubi/config";
import * as database from "@musubi/db";
import { createProviderBudget, ProviderDispatchDeferred, providerDeferral, parseProviderRetryAfter, requireBudgetContinuationWindow, type BudgetLeaf, type BudgetScope, type HttpDispatchPort,
  type HttpDispatchRequest, type MutationReservation, type SendRawOnce } from "@musubi/sync-runtime";
import type { CalendarAdapter } from "./adapter";
import { currentSyncWorkParking, currentSyncWorkSignal, runScopedProviderWork, runCapabilityProviderWork, syncWorkCoordinatorEnabled, withSyncWorkHttpLeaf } from "./work_coordinator";

export { ProviderDispatchDeferred, providerDeferral };
type Provider = "google" | "microsoft" | "caldav";
export type HttpPurpose = BudgetLeaf["purpose"];
export type ScopeOptions = { signal?: AbortSignal; purpose?: HttpPurpose; park?: (retryAtMs: number, signal?: AbortSignal) => Promise<void>; onProgress?: () => void };
type AccountIdentity = { kind: "physical"; provider: Provider; userID: string; accountID: string; rowID: string; incarnation: string } |
  { kind: "pending-account"; provider: Provider; userID: string; accountID: string } |
  { kind: "preconnection" | "provider-wide-revoke"; provider: Provider; id: string };
type Scope = { identity: AccountIdentity; signal?: AbortSignal; purpose: HttpPurpose; live: boolean; generation: number;
  park?: ScopeOptions["park"];
  onProgress?: () => void;
  operation?: { operationId: string; attemptId: string; sourceIncarnationKey?: string };
  reservations: Map<string, { token: MutationReservation; leaf: BudgetLeaf }> };
const context = new AsyncLocalStorage<Scope>();
let runtime: ReturnType<typeof createProviderBudget> | undefined;
let generation = 0;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isProvider = (value: string): value is Provider => ["google", "microsoft", "caldav"].includes(value);
const mutation = (method: string) => !["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"].includes(method.toUpperCase());
// Local continuation-memory policy, never a quota or shortened provider retry.
const targetKey = (url: string, method: string) => hash([method.toUpperCase(), url]);
const combined = (a?: AbortSignal, b?: AbortSignal) => a && b && a !== b ? AbortSignal.any([a, b]) : a ?? b;

/** Called only after migration + singleton admission. Importing this module never activates budgets. */
export async function bootstrapProviderBudget(options: { onRecovered?: () => void } = {}) {
  if (runtime) { if (!await runtime.flushPending()) throw new Error("Provider budget cooldown readiness is unavailable."); return runtime; }
  const instance = createProviderBudget({ clock: { nowEpochMs: Date.now, nowMonotonicMs: () => performance.now() },
    limit(scope) {
      const policy = scopePolicies.get(scope.key); return policy ? config.api.providerBudgetLimits[policy.provider][policy.dimension] : undefined;
    }, cooldowns: { loadActive: async () => (await database.loadActiveProviderCooldowns()).rows,
      extend: async observations => (await database.extendProviderCooldowns(observations)).rows },
    retryPersistenceMs: 1000, reservationLifetimeMs: 45_000,
    onPersistenceFailure: () => logger.warn("sync.budget.persistence_unavailable", { code: "provider-budget-persistence-pending" }),
    onPersistenceRecovered: options.onRecovered,
  });
  runtime = instance;
  // The instance is visible fail-closed while its durable gates load; failure remains retriable.
  if (!await instance.flushPending()) throw new Error("Provider budget cooldown readiness is unavailable.");
  return instance;
}
export function stopProviderBudget() { generation++; runtime?.close(); runtime = undefined; scopePolicies.clear(); }
export function providerBudgetReadiness() { return runtime?.snapshot() ?? { ready: false, persistenceBlocked: false, pendingCooldowns: 0, nextPersistenceAtMs: undefined }; }
const scopePolicies = new Map<string, { provider: Provider; dimension: "provider" | "application" | "account" }>();
function scopes(identity: AccountIdentity): BudgetScope[] {
  const provider = identity.provider, namespace = config.api.providerBudgetNamespace;
  const configuredApplication = provider === "google" ? config.social.googleWebClientID : provider === "microsoft" ? config.social.microsoftClientID : "musubi-caldav";
  // Rate identity only: an unconfigured provider has an explicit deployment-local
  // bucket, not claimed client/tenant/authentication evidence.
  const applicationID = configuredApplication || `unconfigured:${provider}`;
  const result: BudgetScope[] = [
    { dimension: "provider", key: database.providerBudgetScopeKey(namespace, { dimension: "provider", provider }) },
    { dimension: "application", key: database.providerBudgetScopeKey(namespace, { dimension: "application", provider, applicationID }) },
  ];
  if (identity.kind === "physical") result.push({ dimension: "account", key: database.providerBudgetScopeKey(namespace, { dimension: "account", provider, physicalAccountRowID: identity.rowID }) });
  // No verified tenant exists. Preconnection/revoke explicitly lack a persisted account scope.
  for (const scope of result) scopePolicies.set(scope.key, { provider, dimension: scope.dimension as "provider" | "application" | "account" });
  return result;
}
async function accountIdentity(provider: Provider, userID: string, accountID: string): Promise<AccountIdentity> {
  if (provider === "caldav") {
    const row = await database.getOwnedCaldavAccountBinding(userID, accountID);
    if (!row) throw new Error("Current provider budget connection is unavailable.");
    return { kind: "physical", provider, userID, accountID, rowID: row.id, incarnation: hash([row.id, row.credentialRevision, row.credentialFingerprint]) };
  }
  const row = await database.getOwnedOAuthBudgetBinding(userID, provider, accountID);
  if (!row) throw new Error("Current provider budget connection is unavailable.");
  return { kind: "physical", provider, userID, accountID, rowID: row.id, incarnation: hash([row.id, row.generation, row.scope]) };
}
async function verify(scope: Scope, checkSignal = true) {
  if (scope.generation !== generation || checkSignal && !scope.live) throw new Error("Provider execution budget context is closed.");
  if (checkSignal) scope.signal?.throwIfAborted();
  if (scope.identity.kind === "pending-account") scope.identity = await accountIdentity(scope.identity.provider, scope.identity.userID, scope.identity.accountID);
  if (scope.identity.kind !== "physical") return;
  const current = await accountIdentity(scope.identity.provider, scope.identity.userID, scope.identity.accountID);
  if (current.kind !== "physical" || current.rowID !== scope.identity.rowID || current.incarnation !== scope.identity.incarnation)
    throw new Error("Provider budget connection changed.");
  if (checkSignal) scope.signal?.throwIfAborted();
  if (scope.generation !== generation) throw new Error("Provider execution budget context is closed.");
}
function scopeFrom(identity: AccountIdentity, options: ScopeOptions = {}): Scope {
  const inherited = context.getStore();
  const parent = inherited?.live && "userID" in inherited.identity && "userID" in identity &&
    inherited.identity.provider === identity.provider && inherited.identity.userID === identity.userID && inherited.identity.accountID === identity.accountID ? inherited : undefined;
  return { identity, live: true, generation, purpose: options.purpose ?? parent?.purpose ?? "preflight", signal: combined(currentSyncWorkSignal(), combined(options.signal, parent?.signal)),
    park: options.park ?? parent?.park,
    onProgress: options.onProgress ?? parent?.onProgress,
    operation: parent?.operation, reservations: parent?.reservations ?? new Map() };
}
async function runScope<T>(scope: Scope, run: () => Promise<T>, ownsBag: boolean): Promise<T> {
  try { return await context.run(scope, run); }
  finally { scope.live = false; if (ownsBag) { for (const { token } of scope.reservations.values()) runtime?.refundUnused(token); scope.reservations.clear(); } }
}
async function awaitSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) { void pending.catch(() => {}); throw signal.reason; }
  let aborted!: () => void;
  const interruption = new Promise<never>((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener("abort", aborted, { once: true }); });
  try { return await Promise.race([pending, interruption]); }
  finally { signal.removeEventListener("abort", aborted); }
}
export async function withAccountBudgetScope<T>(provider: string, userID: string, accountID: string, run: () => Promise<T>, options: ScopeOptions = {}): Promise<T> {
  const activation = runtime, epoch = generation;
  if (!activation) return run();
  const active = () => { if (runtime !== activation || generation !== epoch) throw new Error("Provider budget activation changed."); };
  options.signal?.throwIfAborted();
  if (!isProvider(provider)) throw new Error("Unsupported provider budget context.");
  const identity = await accountIdentity(provider, userID, accountID);
  active();
  const bound = async (controllerSignal?: AbortSignal) => {
    active();
    const scope = scopeFrom(identity, { ...options, signal: combined(options.signal, controllerSignal), park: options.park ?? currentSyncWorkParking() });
    return runScope(scope, async () => { await verify(scope); return run(); }, scope.reservations !== context.getStore()?.reservations);
  };
  return !currentSyncWorkParking() && syncWorkCoordinatorEnabled() && identity.kind === "physical" ? awaitSignal(runScopedProviderWork(provider, identity.rowID, bound, options.signal), options.signal) : bound();
}
export async function withCaldavBudgetScope<T>(binding: { id: string; userID: string; credentialRevision: string; credentialFingerprint: string },
  run: () => Promise<T>, options: ScopeOptions = {}): Promise<T> {
  const activation = runtime, epoch = generation; if (!activation) return run();
  const identity = await accountIdentity("caldav", binding.userID, binding.id);
  if (runtime !== activation || generation !== epoch) throw new Error("Provider budget activation changed.");
  if (identity.kind !== "physical" || identity.incarnation !== hash([binding.id, binding.credentialRevision, binding.credentialFingerprint])) throw new Error("Provider budget connection changed.");
  const scope = scopeFrom(identity, options); return runScope(scope, run, scope.reservations !== context.getStore()?.reservations);
}
export function withPreconnectionBudgetScope<T>(provider: Provider, run: () => Promise<T>, options: ScopeOptions = {}): Promise<T> {
  if (!runtime) return run();
  const identity: AccountIdentity = { kind: "preconnection", provider, id: randomUUID() }, signal = options.signal ?? AbortSignal.timeout(45_000);
  const bound = (controllerSignal?: AbortSignal) => { const scope = scopeFrom(identity, { ...options, signal: combined(signal, controllerSignal), park: options.park ?? currentSyncWorkParking(), purpose: options.purpose ?? "discovery" });
    return runScope(scope, async () => { signal.throwIfAborted(); return run(); }, true); };
  return !currentSyncWorkParking() && syncWorkCoordinatorEnabled() ? awaitSignal(runCapabilityProviderWork(provider, bound, signal), signal) : bound();
}
export function withProviderRevokeBudgetScope<T>(provider: Provider, run: () => Promise<T>): Promise<T> {
  if (!runtime) return run();
  const identity: AccountIdentity = { kind: "provider-wide-revoke", provider, id: randomUUID() }, signal = AbortSignal.timeout(10_000);
  const bound = (controllerSignal?: AbortSignal) => { const scope = scopeFrom(identity, { signal: combined(signal, controllerSignal), purpose: "revoke", park: currentSyncWorkParking() });
    return runScope(scope, async () => { signal.throwIfAborted(); return run(); }, true); };
  return !currentSyncWorkParking() && syncWorkCoordinatorEnabled() ? awaitSignal(runCapabilityProviderWork(provider, bound, signal), signal) : bound();
}
/** Shared OAuth refresh owns a context/signal independent of any delivery waiter. */
export async function withOAuthRefreshBudgetScope<T>(provider: string, userID: string, accountID: string,
  credentials: { id: string; syncReadGeneration: number; scope: string | null }, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted(); const activation = runtime, epoch = generation; if (!activation) return run();
  if (provider !== "google" && provider !== "microsoft") throw new Error("Unsupported refresh budget context.");
  const identity = await accountIdentity(provider, userID, accountID);
  if (runtime !== activation || generation !== epoch) throw new Error("Provider budget activation changed.");
  if (identity.kind !== "physical" || identity.rowID !== credentials.id || identity.incarnation !== hash([credentials.id, credentials.syncReadGeneration, credentials.scope])) throw new Error("Refresh budget grant changed.");
  return runScope({ identity, live: true, generation, signal: combined(signal, currentSyncWorkSignal()), purpose: "oauth-refresh", reservations: new Map(), park: currentSyncWorkParking() }, run, true);
}
export async function withDeliveryBudgetScope<T>(provider: string, userID: string, accountID: string,
  operation: NonNullable<Scope["operation"]>, run: () => Promise<T>, options: ScopeOptions = {}): Promise<T> {
  if (!runtime) return run();
  if (!isProvider(provider)) return run(); // Existing unsupported-provider executor settles without HTTP.
  // Claim/decode/source settlement must still run for retained work whose grant vanished.
  // This hint becomes a verified physical identity only at a real leaf or mutation reservation.
  const scope: Scope = { ...scopeFrom({ kind: "pending-account", provider, userID, accountID }, options), operation, reservations: new Map() };
  return runScope(scope, run, true);
}
function budgetLeaf(scope: Scope, request: HttpDispatchRequest): BudgetLeaf {
  if (scope.identity.kind === "pending-account") throw new Error("Provider budget scope is not verified.");
  const purpose = ["oauth-refresh", "revoke"].includes(scope.purpose) ? scope.purpose : mutation(request.method) ? "mutation" : scope.purpose;
  return { scopes: scopes(scope.identity), purpose, method: request.method.toUpperCase(), targetKey: targetKey(request.url, request.method),
    incarnationKey: hash([scope.identity.kind === "physical" ? scope.identity.incarnation : scope.identity.id, scope.operation?.sourceIncarnationKey]),
    operationKey: scope.operation?.operationId, attemptKey: scope.operation?.attemptId };
}
function cooldown(scope: Scope, leaf: BudgetLeaf, response: Response) {
  if (![429, 503].includes(response.status)) return;
  const parsed = parseProviderRetryAfter(response.headers.get("retry-after"), Date.now());
  if (parsed.kind === "missing" || parsed.kind === "invalid") return;
  if (parsed.kind === "unsupported") {
    logger.warn("sync.budget.retry_after_unsupported", { code: "provider-retry-after-unsupported", provider: scope.identity.provider });
    // A syntactically valid but unrepresentable hint makes this physical account
    // unavailable over the supported time domain. This is a scoped hold, not a
    // claim that an earlier certified provider retry was calculated.
    return scope.identity.kind === "physical" ? { scopes: leaf.scopes.filter(s => s.dimension === "account"), notBeforeEpochMs: 253_402_300_799_999 } : undefined;
  }
  if (parsed.kind !== "supported") return;
  // The existing providers do not supply verified app/tenant throttle evidence.
  // Default observed throttling to this physical account; preconnection/revoke has only app proof.
  const dimension = scope.identity.kind === "physical" ? "account" : "application";
  return { scopes: leaf.scopes.filter(s => s.dimension === dimension), notBeforeEpochMs: parsed.notBeforeEpochMs,
    ...(parsed.minimumDelayMs === undefined ? {} : { minimumDelayMs: parsed.minimumDelayMs }) };
}
export function budgetAttemptSignal(signal?: AbortSignal) {
  const scope = context.getStore();
  if (scope && (!scope.live || scope.generation !== generation)) throw new Error("Provider execution budget context is closed.");
  return combined(signal, combined(scope?.signal, currentSyncWorkSignal()));
}
async function waitBudgetContinuation(error: ProviderDispatchDeferred, scope: Scope, signal?: AbortSignal) {
  requireBudgetContinuationWindow(error, Date.now(), config.api.providerBudgetContinuationWindowMs);
  if (!scope.park) throw error;
  await scope.park(error.deferral.retryAtMs, signal ?? scope.signal);
  await verify(scope);
}
/** Native SDKs own telemetry. This leaf only propagates the explicit attempt signal. */
export const rawProviderFetch: typeof fetch = (input, init) => {
  const signal = budgetAttemptSignal(init?.signal ?? (input instanceof Request ? input.signal : undefined)); signal?.throwIfAborted();
  return globalThis.fetch(input, { ...init, signal });
};
export async function dispatchProviderHttp(request: HttpDispatchRequest, send: SendRawOnce): Promise<Response> {
  const signal = budgetAttemptSignal(request.signal); signal?.throwIfAborted();
  const instance = runtime; if (!instance) return send();
  const scope = context.getStore(); if (!scope?.live) throw new Error("Provider HTTP requires an explicit live execution budget context.");
  const progress = () => { try { scope.onProgress?.(); } catch { /* Watchdog diagnostics have no provider authority. */ } };
  return withSyncWorkHttpLeaf(async assertCurrent => {
    assertCurrent(); progress(); await verify(scope);
    const decoration = instance.decorate(r => budgetLeaf(scope, r), () => { assertCurrent(); scope.signal?.throwIfAborted(); },
      (leaf, response) => { progress(); return cooldown(scope, leaf, response); }, leaf => scope.reservations.get(leaf.targetKey)?.token,
      scope.park ? async (_deferral, error) => waitBudgetContinuation(error, scope, request.signal) : undefined);
    return decoration.dispatch!(request, send);
  }, signal);
}
export function createSdkBudgetHttp(provider: Provider, userID: string, accountID: string,
  expected?: { connectionId: string; connectionGeneration?: string | number },
  davMaterial?: () => { credentialRevision: string; credentialFingerprint: string } | undefined): HttpDispatchPort {
  return { isDispatchDeferred: error => error instanceof ProviderDispatchDeferred,
    async dispatch(request, send) {
      const signal = budgetAttemptSignal(request.signal); signal?.throwIfAborted();
      if (!runtime) return send(() => { signal?.throwIfAborted(); return undefined; });
      return withAccountBudgetScope(provider, userID, accountID, async () => {
        const scope = context.getStore()!;
        if (scope.identity.kind !== "physical" || expected && scope.identity.rowID !== expected.connectionId) throw new Error("Native budget account changed.");
        if (provider === "caldav" && davMaterial) {
          const material = davMaterial();
          if (!material || scope.identity.incarnation !== hash([scope.identity.rowID, material.credentialRevision, material.credentialFingerprint])) throw new Error("Native DAV budget material changed.");
        }
        if (expected?.connectionGeneration !== undefined && provider !== "caldav") {
          const row = await database.getOwnedOAuthBudgetBinding(userID, provider, accountID);
          if (!row || String(row.generation) !== String(expected.connectionGeneration)) throw new Error("Native budget grant changed.");
        }
        return dispatchProviderHttp({ ...request, signal: budgetAttemptSignal(request.signal) }, send);
      }, { signal: request.signal });
    } };
}
/** Last native callback, before any permanent possible-notification marker. */
export async function reserveProviderMutation<T>(request: { url: string; method: string }, mark: () => Promise<T>): Promise<T> {
  const instance = runtime, scope = context.getStore(); budgetAttemptSignal()?.throwIfAborted(); if (!instance) return mark();
  if (!scope?.live) throw new Error("Provider mutation requires an explicit live budget context.");
  await verify(scope);
  const leaf = budgetLeaf(scope, request), key = leaf.targetKey;
  const previous = scope.reservations.get(key); if (previous) throw new Error("Mutation permission already reserved.");
  let token: MutationReservation;
  for (;;) {
    try { token = instance.reserveMutation(leaf); break; }
    catch (error) { if (!(error instanceof ProviderDispatchDeferred)) throw error;
      await waitBudgetContinuation(error, scope, scope.signal); }
  }
  scope.reservations.set(key, { token, leaf });
  try { const result = await mark(); if (result === false) { instance.refundUnused(token); scope.reservations.delete(key); } return result; }
  catch (error) { instance.refundUnused(token); scope.reservations.delete(key); throw error; }
}
/** Preserve method names/contracts; wrappers apply only when explicit bootstrap enabled. */
export function scopeCalendarAdapter(adapter: CalendarAdapter): CalendarAdapter {
  function container(source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...source };
  for (const [name, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) { result[name] = container(value as Record<string, unknown>); continue; }
    if (typeof value !== "function" || name.endsWith("V1") || name.startsWith("project") || name === "listAccounts") continue;
    const invoke = value as (...args: unknown[]) => unknown;
    (result as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      if (!runtime) return invoke.apply(source, args);
      const head = args[0] as { address?: { actorID?: string }; link?: { userID?: string; accountID?: string }; context?: { address?: { actorID?: string }; link?: { userID?: string; accountID?: string } } } | undefined;
      const capture = head && typeof head === "object" ? head.context ?? head : undefined;
      const userID = typeof args[0] === "string" ? args[0] : capture?.address?.actorID ?? capture?.link?.userID;
      const accountID = typeof args[1] === "string" ? args[1] : capture?.link?.accountID;
      if (!userID || !accountID) return invoke.apply(source, args); // Any unexpected HTTP still fails closed at the leaf.
      const directSignal = args.find(value => value instanceof AbortSignal) as AbortSignal | undefined;
      const optionsSignal = args.flatMap(value => value && typeof value === "object" ? [Object.getOwnPropertyDescriptor(value, "signal")?.value] : [])
        .find(value => value instanceof AbortSignal) as AbortSignal | undefined;
      return withAccountBudgetScope(adapter.provider, userID, accountID, async () => {
        const answer = await invoke.apply(source, args), captured = context.getStore()!;
        if (answer && typeof answer === "object") for (const [method, capability] of Object.entries(answer)) if (typeof capability === "function") {
          (answer as Record<string, unknown>)[method] = (...parameters: unknown[]) => {
            if (captured.identity.kind !== "physical") throw new Error("Returned provider capability requires a physical session.");
            return withAccountBudgetScope(captured.identity.provider, captured.identity.userID, captured.identity.accountID,
              async () => { await verify(captured, false); return capability.apply(answer, parameters); }, { signal: directSignal ?? optionsSignal });
          };
        }
        return answer;
      }, { signal: directSignal ?? optionsSignal });
    };
  }
  return result;
  }
  return container(adapter as unknown as Record<string, unknown>) as unknown as CalendarAdapter;
}
