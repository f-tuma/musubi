import { guardHttpDispatch } from "./http-dispatch";
import { providerDeferral } from "./provider-budget";
import {
  createMicrosoftPersonalEventCreateProvider, MicrosoftProviderError,
  type MicrosoftPersonalCreate,
} from "@musubi/provider-microsoft";
import { decodeSyncOperationPayload, SyncErrorSchema, SyncOperationRowBindingSchema, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError, type RuntimeAttemptOptions, type RuntimeErrorInfo, type RuntimePhase, type RuntimeTraceEntry } from "./ports";
import type {
  ClaimedMicrosoftPersonalCreate, MicrosoftPersonalCreateHostPorts, MicrosoftPersonalCreatePolicy, MicrosoftCreateRuntimeProviderPorts,
  MicrosoftRuntimeCreateCompletionEvidence, MicrosoftRuntimeCreateDecisionContext, MicrosoftRuntimeCreateDecisionFact, MicrosoftRuntimeCreateEvaluatedDecision,
  MicrosoftRuntimeCreateFinishOutcome, MicrosoftRuntimeCreateNativeFacts, MicrosoftRuntimeCreateProviderFact, MicrosoftRuntimeCreateRunResult, MicrosoftTimedProjection,
} from "./microsoft-create-ports";
import { evaluateMicrosoftPersonalCreateFact, microsoftPersonalCreateIdentityV1 } from "./microsoft-create-trace";

function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid runtime data.");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error("Invalid runtime data.");
  return descriptor.value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) throw new Error("Invalid runtime identity.");
  return value;
}
function frozen<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(item => frozen(item))) as T;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozen(item)]))) as T;
}
function projectionSnapshot(value: MicrosoftTimedProjection): MicrosoftTimedProjection {
  const title = data(value, "title"), description = data(value, "description"), location = data(value, "location"),
    start = data(value, "start"), end = data(value, "end");
  if (typeof title !== "string" || description !== null && typeof description !== "string" || location !== null && typeof location !== "string" ||
      typeof start !== "string" || typeof end !== "string" || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) ||
      new Date(start).toISOString() !== start || new Date(end).toISOString() !== end || data(value, "isAllDay") !== false || data(value, "recurrence") !== null)
    throw new Error("Invalid normalized creation observation.");
  return Object.freeze({ title, description, location, start, end, isAllDay: false, recurrence: null }) as MicrosoftTimedProjection;
}
function runtimeError(error: unknown, phase: RuntimePhase): RuntimeErrorInfo {
  const deferral = providerDeferral(error);
  if (deferral) return { code: "provider-budget-deferred", outcome: "not-written", phase, deferral };
  if (error instanceof SyncRuntimeInterrupted) return { code: "runtime-attempt-aborted", outcome: "unconfirmed", phase,
    interruption: error.reason === "finished" ? "cancelled" : error.reason };
  if (error instanceof MicrosoftProviderError) return frozen({ code: error.code, outcome: error.outcome, phase,
    ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    ...(error.capability === undefined ? {} : { capability: error.capability }), ...(error.evidence === undefined ? {} : { evidence: error.evidence }) });
  if (error instanceof SyncRuntimeHostError) {
    try {
      const code = data(error.info, "code"), outcome = data(error.info, "outcome");
      if (typeof code === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(code) && (outcome === "not-written" || outcome === "unconfirmed")) {
        const values = Object.getOwnPropertyDescriptors(error.info);
        const own = (key: string) => values[key] && "value" in values[key] ? values[key].value : undefined;
        const status = own("providerStatus"), delay = own("retryAfterMs"), capability = own("capability"), evidence = own("evidence");
        return frozen({ code, outcome, phase,
          ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { providerStatus: status } : {}),
          ...(typeof delay === "number" && delay >= 0 && (Number.isFinite(delay) || delay === Infinity) ? { retryAfterMs: delay } : {}),
          ...(capability === "event-write" || capability === "organizer" ? { capability } : {}),
          ...(evidence === "denied" || evidence === "unknown" || evidence === "unsupported" ? { evidence } : {}) });
      }
    } catch { /* Fall through to bounded metadata. */ }
  }
  return { code: "runtime-attempt-failed", outcome: phase === "mutation" ? "unconfirmed" : "not-written", phase };
}
function providerFact(value: unknown): MicrosoftRuntimeCreateProviderFact {
  const kind = data(value, "kind");
  if (kind === "not-dispatched" || kind === "uncertain") return { kind };
  if (kind === "accepted") {
    const validator = data(value, "validator"), status = data(value, "status"), eventId = id(data(value, "eventId"));
    if (validator !== null && typeof validator !== "string" || ![200, 201, 204].includes(status as number)) throw new Error("Invalid prior acceptance.");
    return { kind, validator: validator as string | null, eventId, status: status as 200 | 201 | 204 };
  }
  if (kind === "rejected") return { kind, error: SyncErrorSchema.parse(data(value, "error")) };
  throw new Error("Invalid prior native fact.");
}
function rejection(error: RuntimeErrorInfo): MicrosoftRuntimeCreateProviderFact {
  if ([401, 403].includes(error.providerStatus ?? 0)) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (error.providerStatus === 429) return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay",
    ...(error.retryAfterMs === undefined || error.retryAfterMs > Number.MAX_SAFE_INTEGER ? {} : { retryAfterMs: Math.ceil(error.retryAfterMs) }) } };
  return { kind: "rejected", error: { code: "transport-failed", retry: "never" } };
}
function copyPolicy(value: MicrosoftPersonalCreatePolicy): MicrosoftPersonalCreatePolicy {
  const completion = data(value, "completion"), ambiguousRecovery = data(value, "ambiguousRecovery"), nativeProfile = data(value, "nativeProfile");
  if (typeof completion !== "string" || !["provider-response", "correlated-readback"].includes(completion) ||
      typeof ambiguousRecovery !== "string" || !["deferred", "within-attempt"].includes(ambiguousRecovery) ||
      typeof nativeProfile !== "string" || !["strict-reference", "existing-microsoft"].includes(nativeProfile))
    throw new Error("Invalid runtime policy.");
  return Object.freeze({ completion, ambiguousRecovery, nativeProfile }) as MicrosoftPersonalCreatePolicy;
}

/** CREATE alone refines operation identity to the already admitted canonical UUID. */
export function supportsMicrosoftPersonalCreateEnvelope(envelope: SyncOperationEnvelope): boolean {
  if (envelope.operation.kind !== "event" || envelope.operation.action !== "create" || envelope.locator.provider !== "microsoft" ||
      envelope.serializer.id !== "microsoft-personal-event" || envelope.serializer.version !== 1 ||
      envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") return false;
  const identity = microsoftPersonalCreateIdentityV1(envelope.operationId);
  const plan = parseNativeWritePlanV1(envelope.serializer, "create", "event", envelope.nativePlan.data);
  if (!identity || !plan || plan.planKind !== "json-body" || !plan.body ||
      envelope.locator.resourceId !== null || plan.body.transactionId !== identity.operationId) return false;
  return envelope.admittedProjection.data.isAllDay === false && envelope.admittedProjection.data.recurrence === null &&
    matchesPinnedProjectionV1(envelope.serializer, "create", envelope.admittedProjection.data, envelope.nativePlan.data);
}
class DecisionFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}

/** One host claim, one finite lifecycle, immutable CREATE identity/body and fenced ACK. */
export async function runClaimedMicrosoftPersonalCreate(input: ClaimedMicrosoftPersonalCreate, host: MicrosoftPersonalCreateHostPorts,
  transport: MicrosoftCreateRuntimeProviderPorts, inputPolicy: MicrosoftPersonalCreatePolicy, options: RuntimeAttemptOptions = {}): Promise<MicrosoftRuntimeCreateRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt";
  let facts: MicrosoftRuntimeCreateNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { creation: MicrosoftPersonalCreate; projection: MicrosoftTimedProjection; policy: MicrosoftPersonalCreatePolicy;
    recovery: boolean; priorCandidateEventId: string | null };
  try {
    operationId = id(data(input, "operationId")); attemptId = id(data(input, "attemptId"));
    const recovery = data(input, "recovery"), required = data(recovery, "required"), possibleDispatch = data(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possibleDispatch !== "boolean" || required !== possibleDispatch) throw new Error("Invalid recovery facts.");
    const prior = providerFact(data(input, "priorProvider"));
    if (prior.kind !== "not-dispatched" && !possibleDispatch) throw new Error("Invalid prior dispatch facts.");
    const candidateField = Object.getOwnPropertyDescriptor(input, "priorCandidateEventId");
    if (candidateField && !("value" in candidateField)) throw new Error("Invalid prior candidate.");
    const priorCandidateEventId = candidateField?.value == null
      ? prior.kind === "accepted" ? prior.eventId : null : id(candidateField.value);
    if (priorCandidateEventId !== null && (!possibleDispatch || prior.kind === "accepted" && priorCandidateEventId !== prior.eventId))
      throw new Error("Inconsistent prior candidate.");
    facts = frozen({ provider: prior, remote: { kind: "unobserved" }, possibleDispatch });
    const binding = SyncOperationRowBindingSchema.parse(data(input, "binding"));
    const decoded = decodeSyncOperationPayload(data(input, "payload"), binding, { supports: supportsMicrosoftPersonalCreateEnvelope });
    if (decoded.kind !== "pinned-v1") throw new DecisionFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase: "decode" });
    const envelope = decoded.envelope;
    if (envelope.operationId !== operationId) throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const target = data(input, "nativeTarget");
    const nativeTarget = frozen({ connectionId: id(data(target, "connectionId")), connectionGeneration: id(data(target, "connectionGeneration")),
      calendarId: id(data(target, "calendarId")) });
    if (nativeTarget.calendarId !== envelope.locator.collectionId || binding.resourceId !== null || envelope.locator.resourceId !== null)
      throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const plan = parseNativeWritePlanV1(envelope.serializer, "create", "event", envelope.nativePlan.data)!;
    if (plan.planKind !== "json-body" || !plan.body) throw new Error("Invalid admitted plan.");
    snapshot = { creation: frozen({ operationId, attemptId, target: nativeTarget, serializer: { id: "microsoft-personal-event", version: 1 }, body: plan.body }) as unknown as MicrosoftPersonalCreate,
      projection: frozen(envelope.admittedProjection.data) as unknown as MicrosoftTimedProjection, policy: copyPolicy(inputPolicy),
      recovery: required, priorCandidateEventId };
  } catch (error) {
    const info = error instanceof DecisionFailure ? error.info : { code: "operation-payload-malformed", outcome: "not-written" as const, phase: "decode" as const };
    trace.push({ decision: "hold", phase: "decode" });
    await host.finish({ status: "hold", error: frozen(info), facts: frozen(facts), cause: error });
    return frozen({ status: "hold", operationId, attemptId, facts, error: info, trace });
  }
  const attempt = createRuntimeAttempt(signal => host.renew(signal), bounds);
  const context = (): MicrosoftRuntimeCreateDecisionContext => frozen({ operationId,
    candidateEventId: facts.provider.kind === "accepted" ? facts.provider.eventId : snapshot.priorCandidateEventId,
    projection: snapshot.projection, policy: snapshot.policy });
  let phase: RuntimePhase = "decode", acknowledged = false, persistedFacts: MicrosoftRuntimeCreateNativeFacts | undefined;
  const errorPhases = new WeakMap<object, RuntimePhase>();
  const recordedFailures = new WeakSet<object>();
  const addTrace = (decision: RuntimeTraceEntry["decision"], at: RuntimePhase) => { if (trace.length < 32) trace.push({ decision, phase: at }); };
  const choose = (fact: MicrosoftRuntimeCreateDecisionFact, at: RuntimePhase): MicrosoftRuntimeCreateEvaluatedDecision => {
    const saved = frozen(fact), decisionContext = context(), evaluated = evaluateMicrosoftPersonalCreateFact(decisionContext, saved);
    addTrace(evaluated.decision, at);
    try { host.recordDecision?.(decisionContext, frozen({ fact: saved, authoritative: evaluated })); } catch { /* Diagnostics have no authority. */ }
    return evaluated;
  };
  const checkpoint = async (name: Parameters<NonNullable<typeof host.checkpoint>>[0]) => {
    attempt.guard(); await host.checkpoint?.(name, attempt.signal); attempt.guard();
  };
  const persist = async () => {
    attempt.guard(); if (persistedFacts === facts) return;
    phase = "evidence"; const current = facts; await host.recordEvidence(current, attempt.signal); attempt.guard(); persistedFacts = current;
  };
  const complete = async (evidence: MicrosoftRuntimeCreateCompletionEvidence) => {
    attempt.guard(); phase = "ack";
    const result = await host.ack(frozen(evidence), attempt.signal);
    if (result.kind === "acknowledged") {
      acknowledged = true; addTrace("acknowledged", "ack");
      if (!attempt.signal.aborted) { try { await checkpoint("afterAck"); } catch { /* Committed truth wins. */ } }
      return;
    }
    attempt.guard(); throw new DecisionFailure({ code: "runtime-ack-authority-changed", outcome: "not-written", phase: "ack" });
  };
  let provider: ReturnType<typeof createMicrosoftPersonalEventCreateProvider>;
  const read = async (mode: "recovery-read" | "readback") => {
    attempt.guard(); phase = mode;
    const native = await provider.readCreated(snapshot.creation, attempt.signal); attempt.guard();
    let projection: MicrosoftTimedProjection | null = null;
    if (native.kind === "present") {
      const normalized = await host.normalizeObservation(native, attempt.signal); attempt.guard();
      projection = normalized === null ? null : projectionSnapshot(normalized);
    }
    const decision = choose({ kind: mode, read: native, projection }, mode);
    if (native.kind === "missing") {
      facts = frozen({ ...facts, remote: { kind: "missing", observationId: id(host.observationId()) } });
      await persist();
    }
    if (native.kind === "present") {
      const observationId = id(host.observationId());
      facts = frozen({ ...facts, remote: decision.decision === "confirmed" && projection
        ? { kind: "confirmed", observationId, read: native, projection }
        : { kind: "conflict", observationId, read: native, projection } });
      await persist();
      if (decision.decision === "confirmed" && projection) {
        await checkpoint("afterReadback");
        await complete({ kind: "correlated-readback", eventId: native.event.id, validator: native.etag, projection, read: native, facts });
        return true;
      }
    }
    throw new DecisionFailure({ code: `runtime-${decision.reason ?? "readback-differs"}`, outcome: "not-written", phase: mode });
  };
  const handleMutationError = async (error: unknown) => {
    const at = error && typeof error === "object" ? errorPhases.get(error) ?? "mutation" : "mutation";
    const info = runtimeError(error, at);
    if (!info.deferral && at === "mutation" && info.outcome === "unconfirmed" && facts.possibleDispatch) {
      facts = frozen({ ...facts, provider: facts.provider.kind === "accepted" ? facts.provider : { kind: "uncertain" } });
      await persist(); await checkpoint("afterUncertain");
      const decision = choose({ kind: "failure", error: info }, at);
      if (error && typeof error === "object") recordedFailures.add(error);
      if (decision.decision === "observe") { await read("readback"); return; }
    }
    throw new DecisionFailure(info, error);
  };
  let failure: MicrosoftRuntimeCreateFinishOutcome | undefined;
  try {
    await attempt.run(async () => {
      if (host.prepare) { attempt.guard(); await host.prepare(attempt.signal); attempt.guard(); }
      provider = createMicrosoftPersonalEventCreateProvider({ ...transport,
        http: guardHttpDispatch(transport.http, attempt.guard),
        accountSession: { async open(connection, signal) {
          attempt.guard(); const previous = phase; phase = "credentials";
          try {
            const current = await host.accountSession.open(connection, signal); attempt.guard(); await checkpoint("afterCredentials"); return current;
          } catch (error) { if (error && typeof error === "object") errorPhases.set(error, "credentials"); throw error; }
          finally { phase = previous; }
        } },
        beforeMutation: async (request, signal) => {
          attempt.guard(); await host.beforeMutation(request, signal!);
          facts = frozen({ ...facts, possibleDispatch: true });
          attempt.guard(); await checkpoint("beforeDispatch"); attempt.guard();
        },
      }, { nativeProfile: snapshot.policy.nativeProfile });
      if (snapshot.recovery) { await read("recovery-read"); return; }
      phase = "preflight"; await provider.preflightCreate(snapshot.creation, attempt.signal); attempt.guard(); addTrace("dispatch", "preflight");
      phase = "mutation";
      let created;
      try { created = await provider.create(snapshot.creation, attempt.signal); attempt.guard(); }
      catch (error) { await handleMutationError(error); return; }
      choose({ kind: "create" }, "mutation");
      facts = frozen({ ...facts, provider: { kind: "accepted", eventId: created.eventId, validator: created.etag, status: created.status }, remote: { kind: "unobserved" } });
      await persist(); await checkpoint("afterAcceptance");
      if (snapshot.policy.completion === "provider-response") await complete({ kind: "provider-response", eventId: created.eventId, validator: created.etag, facts });
      else await read("readback");
    });
  } catch (error) {
    if (!acknowledged) {
      const info = error instanceof DecisionFailure ? error.info : runtimeError(error, error && typeof error === "object" ? errorPhases.get(error) ?? phase : phase);
      const original = error instanceof DecisionFailure ? error.cause : error;
      if (!attempt.signal.aborted && (!original || typeof original !== "object" || !recordedFailures.has(original))) choose({ kind: "failure", error: info }, info.phase);
      if (info.phase === "mutation" && info.providerStatus !== undefined && info.outcome === "not-written" && facts.provider.kind !== "accepted")
        facts = frozen({ ...facts, provider: rejection(info) });
      else if (facts.possibleDispatch && facts.provider.kind === "not-dispatched") facts = frozen({ ...facts, provider: { kind: "uncertain" } });
      if (attempt.signal.aborted) failure = { status: "hold", error: runtimeError(attempt.signal.reason, info.phase), facts, cause: error };
      else {
        try { await attempt.run(persist); } catch { /* Fenced host finish owns final settlement. */ }
        const delay = info.phase === "mutation" && [401, 403].includes(info.providerStatus ?? 0) ? Infinity :
          info.retryAfterMs === undefined ? undefined : info.retryAfterMs > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(info.retryAfterMs);
        failure = { status: info.code === "provider-conflict" || ["runtime-profile-unavailable", "runtime-creation-identity-changed", "runtime-readback-differs", "runtime-remote-validator-unavailable"].includes(info.code) ? "conflict" : "hold",
          error: info, facts, ...(delay === undefined ? {} : { retryAfterMs: delay }), cause: error instanceof DecisionFailure ? error.cause : error };
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
