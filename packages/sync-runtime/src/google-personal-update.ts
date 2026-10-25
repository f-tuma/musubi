import {
  createGooglePersonalEventProvider, GoogleProviderError, strongGoogleEtag,
  type GoogleNativeReadEvidence, type GooglePersonalUpdate,
} from "@musubi/provider-google";
import {
  decodeSyncOperationPayload, SyncErrorSchema, SyncOperationRowBindingSchema,
  type SyncOperationEnvelope,
} from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError } from "./ports";
import type {
  ClaimedGooglePersonalUpdate, GooglePersonalUpdateHostPorts, GooglePersonalUpdatePolicy, GoogleRuntimeProviderPorts,
  GoogleTimedProjection, RuntimeAttemptOptions, RuntimeCompletionEvidence, RuntimeDecisionContext, RuntimeDecisionFact,
  RuntimeErrorInfo, RuntimeEvaluatedDecision, RuntimeFinishOutcome, RuntimeNativeFacts, RuntimePhase, RuntimeProviderFact,
  RuntimeRunResult, RuntimeTraceEntry,
} from "./ports";
import { evaluateGooglePersonalUpdateFact, projectGoogleTimedEvent } from "./trace";

const safeCode = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(value);
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("Invalid runtime data.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("Invalid runtime data.");
  return descriptor.value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw new Error("Invalid runtime identity.");
  return value;
}
/** Snapshot native facts before an async host port can retain or mutate them. */
function frozen<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => frozen(item))) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozen(item)]))) as T;
}
function providerFact(value: unknown): RuntimeProviderFact {
  const kind = data(value, "kind");
  if (kind === "not-dispatched" || kind === "uncertain") return { kind };
  if (kind === "accepted") {
    const validator = data(value, "validator");
    if (validator !== null && !strongGoogleEtag(validator)) throw new Error("Invalid prior validator.");
    return { kind, validator: validator as string | null };
  }
  if (kind === "rejected") return { kind, error: SyncErrorSchema.parse(data(value, "error")) };
  throw new Error("Invalid prior native fact.");
}
export function supportsGooglePersonalUpdateEnvelope(envelope: SyncOperationEnvelope): boolean {
  if (envelope.operation.kind !== "event" || envelope.operation.action !== "update" || envelope.locator.provider !== "google" ||
      envelope.locator.resourceId === null || envelope.serializer.id !== "google-personal-event" || envelope.serializer.version !== 1 ||
      envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") return false;
  const plan = parseNativeWritePlanV1(envelope.serializer, "update", "event", envelope.nativePlan.data);
  return !!plan && plan.planKind === "json-body" && !!plan.body && Object.keys(plan.body).length > 0 &&
    Object.keys(plan.body).every(key => ["summary", "description", "location"].includes(key)) &&
    envelope.admittedProjection.data.isAllDay === false && envelope.admittedProjection.data.recurrence === null &&
    matchesPinnedProjectionV1(envelope.serializer, "update", envelope.admittedProjection.data, envelope.nativePlan.data);
}
function copyPolicy(value: GooglePersonalUpdatePolicy): GooglePersonalUpdatePolicy {
  const completion = data(value, "completion"), ambiguousRecovery = data(value, "ambiguousRecovery"), compareContent = data(value, "compareContent"),
    untouchedPreflight = data(value, "untouchedPreflight"), nativeProfile = data(value, "nativeProfile"), observeConflict = data(value, "observeConflict");
  if (typeof completion !== "string" || !["provider-response", "exact-readback"].includes(completion) ||
      typeof ambiguousRecovery !== "string" || !["deferred", "within-attempt"].includes(ambiguousRecovery) ||
      typeof compareContent !== "string" || !["literal", "nullable-empty"].includes(compareContent) || typeof untouchedPreflight !== "boolean" ||
      typeof nativeProfile !== "string" || !["strict-reference", "existing-google"].includes(nativeProfile) || typeof observeConflict !== "boolean") throw new Error("Invalid runtime policy.");
  return Object.freeze({ completion, ambiguousRecovery, compareContent, untouchedPreflight, nativeProfile, observeConflict }) as GooglePersonalUpdatePolicy;
}
function runtimeError(error: unknown, phase: RuntimePhase): RuntimeErrorInfo {
  if (error instanceof SyncRuntimeInterrupted) return { code: "runtime-attempt-aborted", outcome: "unconfirmed", phase,
    interruption: error.reason === "finished" ? "cancelled" : error.reason };
  if (error instanceof GoogleProviderError) return frozen({ code: error.code, outcome: error.outcome, phase,
    ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.capability === undefined ? {} : { capability: error.capability }), ...(error.evidence === undefined ? {} : { evidence: error.evidence }) });
  if (error instanceof SyncRuntimeHostError) {
    try {
      const code = data(error.info, "code"), outcome = data(error.info, "outcome");
      if (safeCode(code) && typeof outcome === "string" && ["not-written", "unconfirmed"].includes(outcome)) {
        // Copy only validated typed metadata; never return a host message, payload or cause.
        const values = Object.getOwnPropertyDescriptors(error.info);
        const own = (key: string) => values[key] && "value" in values[key] ? values[key].value : undefined;
        const status = own("providerStatus"), delay = own("retryAfterMs"), capability = own("capability"), evidence = own("evidence"), interruption = own("interruption");
        return frozen({ code: code as string, outcome: outcome as RuntimeErrorInfo["outcome"], phase,
          ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { providerStatus: status } : {}),
          ...(typeof delay === "number" && delay >= 0 && (Number.isFinite(delay) || delay === Infinity) ? { retryAfterMs: delay } : {}),
          ...(capability === "event-write" || capability === "organizer" ? { capability } : {}),
          ...(evidence === "denied" || evidence === "unknown" || evidence === "unsupported" ? { evidence } : {}),
          ...(interruption === "timeout" || interruption === "lease-lost" || interruption === "cancelled" ? { interruption } : {}) });
      }
    } catch { /* Use the bounded generic host failure. */ }
  }
  return { code: "runtime-attempt-failed", outcome: phase === "mutation" ? "unconfirmed" : "not-written", phase };
}
function rejected(error: RuntimeErrorInfo): RuntimeProviderFact {
  if (error.providerStatus === 412) return { kind: "rejected", error: { code: "conflict", retry: "never" } };
  if (error.providerStatus === 401 || error.providerStatus === 403) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (error.providerStatus === 429) {
    const ms = error.retryAfterMs === undefined || error.retryAfterMs > Number.MAX_SAFE_INTEGER ? undefined : Math.ceil(error.retryAfterMs);
    return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", ...(ms === undefined ? {} : { retryAfterMs: ms }) } };
  }
  return { kind: "rejected", error: { code: "transport-failed", retry: "never" } };
}
class DecisionFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}

/** The host has already claimed once. This function owns the only attempt timer
 * for this route; all database authority, durable evidence and atomic ACK remain host ports. */
export async function runClaimedGooglePersonalUpdate(input: ClaimedGooglePersonalUpdate, host: GooglePersonalUpdateHostPorts,
  transport: GoogleRuntimeProviderPorts, inputPolicy: GooglePersonalUpdatePolicy, options: RuntimeAttemptOptions = {}): Promise<RuntimeRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt";
  let facts: RuntimeNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { update: Omit<GooglePersonalUpdate, "acceptedEtag">; etag: unknown; context: Omit<RuntimeDecisionContext, "acceptedEtag">; recovery: boolean };
  try {
    // Every admitted field, binding, policy, native identity and prior fact is
    // copied synchronously, before prepare/credentials or any other host await.
    operationId = id(data(input, "operationId")); attemptId = id(data(input, "attemptId"));
    const recovery = data(input, "recovery"), required = data(recovery, "required"), possible = data(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possible !== "boolean" || required && !possible) throw new Error("Invalid recovery facts.");
    facts = frozen({ provider: providerFact(data(input, "priorProvider")), remote: { kind: "unobserved" }, possibleDispatch: possible });
    const binding = SyncOperationRowBindingSchema.parse(data(input, "binding"));
    const decoded = decodeSyncOperationPayload(data(input, "payload"), binding, { supports: supportsGooglePersonalUpdateEnvelope });
    if (decoded.kind !== "pinned-v1") throw new DecisionFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase: "decode" });
    const envelope = decoded.envelope;
    if (envelope.operationId !== operationId) throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const target = data(input, "nativeTarget");
    const nativeTarget = frozen({ connectionId: id(data(target, "connectionId")), connectionGeneration: id(data(target, "connectionGeneration")),
      calendarId: id(data(target, "calendarId")), eventId: id(data(target, "eventId")) });
    if (nativeTarget.calendarId !== envelope.locator.collectionId || nativeTarget.eventId !== envelope.locator.resourceId)
      throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const plan = parseNativeWritePlanV1(envelope.serializer, "update", "event", envelope.nativePlan.data)!;
    if (plan.planKind !== "json-body" || !plan.body) throw new DecisionFailure({ code: "runtime-native-plan-unavailable", outcome: "not-written", phase: "decode" });
    const body = frozen({ ...plan.body }) as Readonly<Record<string, string | null>>;
    snapshot = { update: frozen({ operationId, attemptId, target: nativeTarget, body, serializer: { id: "google-personal-event", version: 1 } }),
      etag: data(input, "acceptedEtag"), context: frozen({ projection: { ...envelope.admittedProjection.data } as unknown as GoogleTimedProjection,
        body, policy: copyPolicy(inputPolicy) }), recovery: required };
  } catch (error) {
    const info = error instanceof DecisionFailure ? error.info : { code: "operation-payload-malformed", outcome: "not-written" as const, phase: "decode" as const };
    trace.push({ decision: "hold", phase: "decode" });
    await host.finish({ status: "hold", error: frozen(info), facts: frozen(facts), cause: error });
    return frozen({ status: "hold", operationId, attemptId, facts, error: info, trace });
  }
  const attempt = createRuntimeAttempt(signal => host.renew(signal), bounds);
  let phase: RuntimePhase = "decode", acknowledged = false;
  const errorPhases = new WeakMap<object, RuntimePhase>();
  const recordedFailures = new WeakSet<object>();
  let context: RuntimeDecisionContext | undefined;
  const addTrace = (decision: RuntimeTraceEntry["decision"], at: RuntimePhase) => { if (trace.length < 32) trace.push({ decision, phase: at }); };
  const choose = (fact: RuntimeDecisionFact, at: RuntimePhase): RuntimeEvaluatedDecision => {
    const copy = frozen(fact), decision = evaluateGooglePersonalUpdateFact(context!, copy);
    addTrace(decision.decision, at);
    try { host.recordDecision?.(context!, frozen({ fact: copy, authoritative: decision })); } catch { /* Private diagnostics cannot alter authority. */ }
    return decision;
  };
  const checkpoint = async (name: Parameters<NonNullable<typeof host.checkpoint>>[0]) => {
    attempt.guard(); await host.checkpoint?.(name, attempt.signal); attempt.guard();
  };
  let persistedFacts: RuntimeNativeFacts | undefined;
  const persist = async () => {
    attempt.guard(); if (persistedFacts === facts) return;
    phase = "evidence"; const current = facts; await host.recordEvidence(frozen(current), attempt.signal); attempt.guard();
    persistedFacts = current;
  };
  const observation = (read: GoogleNativeReadEvidence, confirmed: boolean) => {
    const observationId = id(host.observationId());
    const projection = read.kind === "present" ? projectGoogleTimedEvent(read.event, context!.policy) : null;
    if (confirmed && read.kind === "present" && projection) facts = frozen({ ...facts, remote: { kind: "confirmed", observationId, read, projection } });
    else facts = frozen({ ...facts, remote: { kind: "conflict", observationId, read, projection } });
  };
  const failDecision = (decision: RuntimeEvaluatedDecision, at: RuntimePhase): never => {
    throw new DecisionFailure({ code: "runtime-" + (decision.reason ?? "attempt-failed"), outcome: "not-written", phase: at });
  };
  let provider: ReturnType<typeof createGooglePersonalEventProvider>;
  const complete = async (evidence: RuntimeCompletionEvidence) => {
    attempt.guard(); phase = "ack";
    const result = await host.ack(frozen(evidence), attempt.signal);
    // A known atomic ACK is authoritative even when cancellation raced with its return.
    if (result.kind === "acknowledged") {
      acknowledged = true; addTrace("acknowledged", "ack");
      if (!attempt.signal.aborted) {
        try { await checkpoint("afterAck"); } catch { /* Committed truth cannot be downgraded by diagnostics/cancellation. */ }
      }
      return;
    }
    attempt.guard();
    throw new DecisionFailure({ code: "runtime-ack-authority-changed", outcome: "not-written", phase: "ack" });
  };
  const read = async (mode: "recovery-read" | "readback") => {
    attempt.guard(); phase = mode;
    const native = await provider.readEvent(snapshot.update.target, attempt.signal); attempt.guard();
    const decision = choose({ kind: mode, read: native }, mode);
    if (decision.decision === "confirmed") {
      observation(native, true); await persist(); await checkpoint("afterReadback");
      const remote = facts.remote;
      if (native.kind !== "present" || remote.kind !== "confirmed") throw new DecisionFailure({ code: "runtime-profile-unavailable", outcome: "not-written", phase: mode });
      await complete({ kind: "exact-readback", validator: native.etag, projection: remote.projection, read: native, facts });
      return true;
    }
    if (decision.decision === "preflight") return false;
    observation(native, false); await persist(); failDecision(decision, mode);
  };
  const handleMutationError = async (error: unknown) => {
    const errorPhase = error && typeof error === "object" ? errorPhases.get(error) ?? "mutation" : "mutation";
    const info = runtimeError(error, errorPhase);
    if (error && typeof error === "object") errorPhases.set(error, errorPhase);
    if (info.phase === "mutation" && info.outcome === "unconfirmed" && facts.possibleDispatch) {
      facts = frozen({ ...facts, provider: facts.provider.kind === "accepted" ? facts.provider : { kind: "uncertain" } });
      await persist(); await checkpoint("afterUncertain");
      const decision = choose({ kind: "failure", error: info }, "mutation");
      if (error && typeof error === "object") recordedFailures.add(error);
      if (decision.decision === "observe") { await read("readback"); return; }
    }
    throw new DecisionFailure(info, error);
  };
  let failure: RuntimeFinishOutcome | undefined;
  try {
    await attempt.run(async () => {
      phase = "decode";
      let effectiveEtag = snapshot.etag;
      if (host.prepare) { attempt.guard(); const prepared = await host.prepare(attempt.signal); attempt.guard(); effectiveEtag = data(prepared, "acceptedEtag"); }
      const acceptedEtag = strongGoogleEtag(effectiveEtag);
      if (!acceptedEtag) throw new DecisionFailure({ code: "runtime-baseline-validator-unavailable", outcome: "not-written", phase: "decode" });
      context = frozen({ ...snapshot.context, acceptedEtag });
      const update: GooglePersonalUpdate = frozen({ ...snapshot.update, acceptedEtag });
      provider = createGooglePersonalEventProvider({
        ...transport,
        http: { fetch(url, init) { attempt.guard(); return transport.http.fetch(url, init); } },
        accountSession: { async open(connection, signal) {
          attempt.guard(); const previous = phase; phase = "credentials";
          try {
            const current = await host.accountSession.open(connection, signal); attempt.guard();
            await checkpoint("afterCredentials"); return current;
          } catch (error) { if (error && typeof error === "object") errorPhases.set(error, "credentials"); throw error; }
          finally { phase = previous; }
        } },
        beforeMutation: async (request, signal) => {
          attempt.guard(); await host.beforeMutation(request, signal!);
          facts = frozen({ ...facts, possibleDispatch: true });
          attempt.guard(); await checkpoint("beforeDispatch"); attempt.guard();
        },
      });
      if (snapshot.recovery && await read("recovery-read")) return;
      phase = "preflight"; const preflight = await provider.preflightUpdate(update, attempt.signal); attempt.guard();
      const decision = choose({ kind: "preflight", event: preflight.event }, "preflight");
      if (decision.decision !== "dispatch") { observation({ kind: "present", event: preflight.event, etag: preflight.etag }, false); await persist(); failDecision(decision, "preflight"); }
      let written;
      phase = "mutation";
      try { written = await provider.update(update, attempt.signal); attempt.guard(); }
      catch (error) { await handleMutationError(error); return; }
      choose({ kind: "write", write: written }, "mutation");
      if (written.kind !== "written") throw new DecisionFailure({ code: "runtime-empty-update", outcome: "not-written", phase: "mutation" });
      facts = frozen({ ...facts, provider: { kind: "accepted", validator: written.etag }, remote: { kind: "unobserved" } });
      await persist(); await checkpoint("afterAcceptance");
      if (context.policy.completion === "provider-response") await complete({ kind: "provider-response", validator: written.etag, facts });
      else await read("readback");
    });
  } catch (error) {
    if (!acknowledged) {
      const info = error instanceof DecisionFailure ? error.info : runtimeError(error,
        error && typeof error === "object" ? errorPhases.get(error) ?? phase : phase);
      const originalError = error instanceof DecisionFailure ? error.cause : error;
      if (context && !attempt.signal.aborted && originalError && typeof originalError === "object" && !recordedFailures.has(originalError)) {
        choose({ kind: "failure", error: info }, info.phase); recordedFailures.add(originalError);
      }
      // Native rejection belongs to the PATCH phase. Later GET failures must not
      // rewrite any prior acceptance, uncertainty or rejection/error evidence.
      if (info.phase === "mutation" && info.providerStatus !== undefined && info.outcome === "not-written" &&
          facts.provider.kind !== "accepted" && facts.provider.kind !== "uncertain")
        facts = frozen({ ...facts, provider: rejected(info) });
      else if (facts.possibleDispatch && facts.provider.kind === "not-dispatched") facts = frozen({ ...facts, provider: { kind: "uncertain" } });
      if (attempt.signal.aborted) {
        const interrupted = runtimeError(attempt.signal.reason, info.phase);
        failure = { status: "hold", error: interrupted, facts, cause: error };
      } else {
        if (info.code === "provider-conflict" && snapshot.context.policy.observeConflict && facts.remote.kind === "unobserved" && provider!) {
          try {
            await attempt.run(async () => {
              attempt.guard(); phase = "readback"; const observed = await provider.readEvent(snapshot.update.target, attempt.signal); attempt.guard();
              observation(observed, false); await persist();
            });
          } catch { /* Preserve the original conflict when observation is unavailable. */ }
        }
        try { if (!attempt.signal.aborted) await attempt.run(persist); } catch { /* Host finish still owns fenced settlement. */ }
        const delay = info.phase === "mutation" && [401, 403].includes(info.providerStatus ?? 0) ? Infinity :
          info.retryAfterMs === undefined ? undefined : info.retryAfterMs > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(info.retryAfterMs);
        failure = { status: info.code === "provider-conflict" || info.code.startsWith("runtime-resource-") ||
          ["runtime-readback-differs", "runtime-recovery-validator-changed", "runtime-untouched-fields-differ", "runtime-profile-unavailable"].includes(info.code)
          ? "conflict" : "hold", error: info, facts, ...(delay === undefined ? {} : { retryAfterMs: delay }),
          cause: error instanceof DecisionFailure ? error.cause : error };
      }
      addTrace(failure.status, failure.error.phase);
    }
  } finally { attempt.close(); }
  if (acknowledged) return frozen({ status: "acked", operationId, attemptId, facts, trace });
  failure ??= { status: "hold", error: { code: "runtime-attempt-failed", outcome: "not-written", phase }, facts };
  // Exactly one authoritative terminal settlement; detached work cannot call it.
  try { await host.finish({ ...failure, facts: frozen(failure.facts), error: frozen(failure.error) }); }
  catch (error) { if (!acknowledged) throw error; }
  // An already-sent atomic COMMIT may resolve while fenced finish waits for its lock.
  if (acknowledged) return frozen({ status: "acked", operationId, attemptId, facts, trace });
  return frozen({ status: failure.status, operationId, attemptId, facts: failure.facts, error: failure.error, trace });
}
