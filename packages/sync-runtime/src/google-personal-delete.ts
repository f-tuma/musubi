import {
  createGooglePersonalEventDeleteProvider, GoogleProviderError, strongGoogleEtag,
  type GoogleNativeDeleteReadEvidence, type GooglePersonalDelete,
} from "@musubi/provider-google";
import {
  decodeSyncOperationPayload, SyncErrorSchema, SyncOperationRowBindingSchema, type SyncOperationEnvelope,
} from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError } from "./ports";
import type { RuntimeAttemptOptions, RuntimeErrorInfo, RuntimePhase, RuntimeTraceEntry } from "./ports";
import type {
  ClaimedGooglePersonalDelete, GooglePersonalDeleteHostPorts, GooglePersonalDeletePolicy, GoogleDeleteRuntimeProviderPorts,
  RuntimeDeleteCompletionEvidence, RuntimeDeleteDecisionContext, RuntimeDeleteDecisionFact, RuntimeDeleteEvaluatedDecision,
  RuntimeDeleteFinishOutcome, RuntimeDeleteNativeFacts, RuntimeDeleteProviderFact, RuntimeDeleteRunResult,
} from "./delete-ports";
import { evaluateGooglePersonalDeleteFact } from "./delete-trace";

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
function rejected(error: RuntimeErrorInfo): RuntimeDeleteProviderFact {
  if (error.providerStatus === 412) return { kind: "rejected", error: { code: "conflict", retry: "never" } };
  if (error.providerStatus === 401 || error.providerStatus === 403) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (error.providerStatus === 429) {
    const ms = error.retryAfterMs === undefined || error.retryAfterMs > Number.MAX_SAFE_INTEGER ? undefined : Math.ceil(error.retryAfterMs);
    return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", ...(ms === undefined ? {} : { retryAfterMs: ms }) } };
  }
  return { kind: "rejected", error: { code: "transport-failed", retry: "never" } };
}
function providerFact(value: unknown): RuntimeDeleteProviderFact {
  const kind = data(value, "kind");
  if (kind === "not-dispatched" || kind === "uncertain") return { kind };
  if (kind === "accepted") {
    const status = data(value, "status");
    if (typeof status !== "number" || ![200, 201, 204, 404, 410].includes(status)) throw new Error("Invalid prior acceptance.");
    return { kind, status: status as 200 | 201 | 204 | 404 | 410 };
  }
  if (kind === "rejected") return { kind, error: SyncErrorSchema.parse(data(value, "error")) };
  throw new Error("Invalid prior native fact.");
}
export function supportsGooglePersonalDeleteEnvelope(envelope: SyncOperationEnvelope): boolean {
  if (envelope.operation.kind !== "event" || envelope.operation.action !== "delete" || envelope.locator.provider !== "google" ||
      envelope.locator.resourceId === null || envelope.serializer.id !== "google-personal-event" || envelope.serializer.version !== 1 ||
      envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") return false;
  const plan = parseNativeWritePlanV1(envelope.serializer, "delete", "event", envelope.nativePlan.data);
  return !!plan && plan.planKind === "json-body" && plan.body === null &&
    envelope.admittedProjection.data.isAllDay === false && envelope.admittedProjection.data.recurrence === null &&
    matchesPinnedProjectionV1(envelope.serializer, "delete", envelope.admittedProjection.data, envelope.nativePlan.data);
}
function copyPolicy(value: GooglePersonalDeletePolicy): GooglePersonalDeletePolicy {
  const completion = data(value, "completion"), ambiguousRecovery = data(value, "ambiguousRecovery"),
    nativeProfile = data(value, "nativeProfile"), observeConflict = data(value, "observeConflict");
  if (typeof completion !== "string" || !["provider-response", "exact-absence"].includes(completion) ||
      typeof ambiguousRecovery !== "string" || !["deferred", "within-attempt"].includes(ambiguousRecovery) ||
      typeof nativeProfile !== "string" || !["strict-reference", "existing-google"].includes(nativeProfile) || typeof observeConflict !== "boolean")
    throw new Error("Invalid runtime policy.");
  return Object.freeze({ completion, ambiguousRecovery, nativeProfile, observeConflict }) as GooglePersonalDeletePolicy;
}
class DecisionFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}
/** The host owns the existing claim. One shared finite lifecycle bounds preparation,
 * credentials, exact scoped observation, DELETE, evidence and atomic host ACK. */
export async function runClaimedGooglePersonalDelete(input: ClaimedGooglePersonalDelete, host: GooglePersonalDeleteHostPorts,
  transport: GoogleDeleteRuntimeProviderPorts, inputPolicy: GooglePersonalDeletePolicy, options: RuntimeAttemptOptions = {}): Promise<RuntimeDeleteRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt";
  let facts: RuntimeDeleteNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { deletion: Omit<GooglePersonalDelete, "acceptedEtag">; etag: unknown; policy: GooglePersonalDeletePolicy };
  try {
    // Capture all admission, binding, address, policy and prior facts before any await.
    operationId = id(data(input, "operationId")); attemptId = id(data(input, "attemptId"));
    const recovery = data(input, "recovery"), required = data(recovery, "required"), possible = data(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possible !== "boolean" || required && !possible) throw new Error("Invalid recovery facts.");
    facts = frozen({ provider: providerFact(data(input, "priorProvider")), remote: { kind: "unobserved" }, possibleDispatch: possible });
    const binding = SyncOperationRowBindingSchema.parse(data(input, "binding"));
    const decoded = decodeSyncOperationPayload(data(input, "payload"), binding, { supports: supportsGooglePersonalDeleteEnvelope });
    if (decoded.kind !== "pinned-v1") throw new DecisionFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase: "decode" });
    const envelope = decoded.envelope;
    if (envelope.operationId !== operationId) throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const target = data(input, "nativeTarget");
    const nativeTarget = frozen({ connectionId: id(data(target, "connectionId")), connectionGeneration: id(data(target, "connectionGeneration")),
      calendarId: id(data(target, "calendarId")), eventId: id(data(target, "eventId")) });
    if (nativeTarget.calendarId !== envelope.locator.collectionId || nativeTarget.eventId !== envelope.locator.resourceId)
      throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    snapshot = { deletion: frozen({ operationId, attemptId, target: nativeTarget, serializer: { id: "google-personal-event", version: 1 } }),
      etag: data(input, "acceptedEtag"), policy: copyPolicy(inputPolicy) };
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
  let context: RuntimeDeleteDecisionContext | undefined;
  const addTrace = (decision: RuntimeTraceEntry["decision"], at: RuntimePhase) => { if (trace.length < 32) trace.push({ decision, phase: at }); };
  const choose = (fact: RuntimeDeleteDecisionFact, at: RuntimePhase): RuntimeDeleteEvaluatedDecision => {
    const copy = frozen(fact), decision = evaluateGooglePersonalDeleteFact(context!, copy);
    addTrace(decision.decision, at);
    try { host.recordDecision?.(context!, frozen({ fact: copy, authoritative: decision })); } catch { /* Diagnostics have no authority. */ }
    return decision;
  };
  const checkpoint = async (name: Parameters<NonNullable<typeof host.checkpoint>>[0]) => {
    attempt.guard(); await host.checkpoint?.(name, attempt.signal); attempt.guard();
  };
  let persistedFacts: RuntimeDeleteNativeFacts | undefined;
  const persist = async () => {
    attempt.guard(); if (persistedFacts === facts) return;
    phase = "evidence"; const current = facts; await host.recordEvidence(frozen(current), attempt.signal); attempt.guard();
    persistedFacts = current;
  };
  const observation = (read: GoogleNativeDeleteReadEvidence) => {
    const observationId = id(host.observationId());
    facts = frozen({ ...facts, remote: read.kind === "present" ? { kind: "conflict", observationId, read } : { kind: "absent", observationId, read } });
  };
  const failDecision = (decision: RuntimeDeleteEvaluatedDecision, at: RuntimePhase): never => {
    throw new DecisionFailure({ code: "runtime-" + (decision.reason ?? "attempt-failed"), outcome: "not-written", phase: at });
  };
  let provider: ReturnType<typeof createGooglePersonalEventDeleteProvider>;
  const complete = async (evidence: RuntimeDeleteCompletionEvidence) => {
    attempt.guard(); phase = "ack";
    const result = await host.ack(frozen(evidence), attempt.signal);
    // Known atomic ACK wins even if interruption raced its return.
    if (result.kind === "acknowledged") {
      acknowledged = true; addTrace("acknowledged", "ack");
      if (!attempt.signal.aborted) { try { await checkpoint("afterAck"); } catch { /* Committed truth wins. */ } }
      return;
    }
    attempt.guard();
    throw new DecisionFailure({ code: "runtime-ack-authority-changed", outcome: "not-written", phase: "ack" });
  };
  const read = async (mode: "delete-read" | "readback") => {
    attempt.guard(); phase = mode === "delete-read" ? "recovery-read" : "readback";
    const at = phase;
    const native = await provider.readForDelete(snapshot.deletion.target, attempt.signal); attempt.guard();
    const decision = choose({ kind: mode, read: native }, at);
    if (decision.decision === "confirmed" && native.kind !== "present") {
      observation(native); await persist(); await checkpoint("afterReadback");
      await complete({ kind: "exact-absence", read: native, facts }); return true;
    }
    if (decision.decision === "preflight") return false;
    observation(native); await persist(); failDecision(decision, at);
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
  let failure: RuntimeDeleteFinishOutcome | undefined;
  try {
    await attempt.run(async () => {
      let effectiveEtag = snapshot.etag;
      if (host.prepare) { attempt.guard(); const prepared = await host.prepare(attempt.signal); attempt.guard(); effectiveEtag = data(prepared, "acceptedEtag"); }
      const acceptedEtag = strongGoogleEtag(effectiveEtag);
      if (!acceptedEtag) throw new DecisionFailure({ code: "runtime-baseline-validator-unavailable", outcome: "not-written", phase: "decode" });
      context = frozen({ acceptedEtag, policy: snapshot.policy });
      const deletion: GooglePersonalDelete = frozen({ ...snapshot.deletion, acceptedEtag });
      provider = createGooglePersonalEventDeleteProvider({ ...transport,
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
      // Every admitted DELETE performs the exact scoped GET before fresh ACL/preflight.
      if (await read("delete-read")) return;
      phase = "preflight"; const preflight = await provider.preflightDelete(deletion, attempt.signal); attempt.guard();
      if (preflight.kind !== "allowed") {
        choose({ kind: "readback", read: preflight }, "preflight");
        observation(preflight); await persist(); await checkpoint("afterReadback");
        await complete({ kind: "exact-absence", read: preflight, facts }); return;
      }
      const decision = choose({ kind: "preflight", event: preflight.event, etag: preflight.etag }, "preflight");
      if (decision.decision !== "dispatch") {
        observation({ kind: "present", event: preflight.event, etag: preflight.etag }); await persist(); failDecision(decision, "preflight");
      }
      phase = "mutation";
      let deleted;
      try { deleted = await provider.delete(deletion, attempt.signal); attempt.guard(); }
      catch (error) { await handleMutationError(error); return; }
      choose({ kind: "delete", deletion: deleted }, "mutation");
      facts = frozen({ ...facts, provider: { kind: "accepted", status: deleted.status }, remote: { kind: "unobserved" } });
      await persist(); await checkpoint("afterAcceptance");
      if (context.policy.completion === "provider-response") await complete({ kind: "provider-response", status: deleted.status, facts });
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
      // A current rejection cannot erase older acceptance or unresolved dispatch.
      if (info.phase === "mutation" && info.providerStatus !== undefined && info.outcome === "not-written" &&
          facts.provider.kind !== "accepted" && facts.provider.kind !== "uncertain")
        facts = frozen({ ...facts, provider: rejected(info) });
      else if (facts.possibleDispatch && facts.provider.kind === "not-dispatched") facts = frozen({ ...facts, provider: { kind: "uncertain" } });
      if (attempt.signal.aborted) {
        failure = { status: "hold", error: runtimeError(attempt.signal.reason, info.phase), facts, cause: error };
      } else {
        if (info.code === "provider-conflict" && snapshot.policy.observeConflict && facts.remote.kind === "unobserved" && provider!) {
          try {
            await attempt.run(async () => {
              attempt.guard(); phase = "readback"; const observed = await provider.readForDelete(snapshot.deletion.target, attempt.signal); attempt.guard();
              observation(observed); await persist();
            });
          } catch { /* Preserve the conflict if exact observation is unavailable. */ }
        }
        try { if (!attempt.signal.aborted) await attempt.run(persist); } catch { /* Host finish remains fenced. */ }
        const delay = info.phase === "mutation" && [401, 403].includes(info.providerStatus ?? 0) ? Infinity :
          info.retryAfterMs === undefined ? undefined : info.retryAfterMs > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(info.retryAfterMs);
        failure = { status: info.code === "provider-conflict" ||
          ["runtime-remote-validator-unavailable", "runtime-recovery-validator-changed", "runtime-resource-present", "runtime-profile-unavailable"].includes(info.code)
          ? "conflict" : "hold", error: info, facts, ...(delay === undefined ? {} : { retryAfterMs: delay }),
          cause: error instanceof DecisionFailure ? error.cause : error };
      }
      addTrace(failure.status, failure.error.phase);
    }
  } finally { attempt.close(); }
  if (acknowledged) return frozen({ status: "acked", operationId, attemptId, facts, trace });
  failure ??= { status: "hold", error: { code: "runtime-attempt-failed", outcome: "not-written", phase }, facts };
  try { await host.finish({ ...failure, facts: frozen(failure.facts), error: frozen(failure.error) }); }
  catch (error) { if (!acknowledged) throw error; }
  if (acknowledged) return frozen({ status: "acked", operationId, attemptId, facts, trace });
  return frozen({ status: failure.status, operationId, attemptId, facts: failure.facts, error: failure.error, trace });
}
