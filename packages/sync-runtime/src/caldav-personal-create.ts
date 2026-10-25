import {
  createCaldavPersonalEventCreateProvider, CaldavProviderError, strongCaldavEtag,
  type CaldavPersonalCreate,
} from "@musubi/provider-caldav";
import { decodeSyncOperationPayload, SyncErrorSchema, SyncOperationRowBindingSchema, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError, type RuntimeAttemptOptions, type RuntimePhase, type RuntimeTraceEntry } from "./ports";
import type { CaldavRuntimeErrorInfo as RuntimeErrorInfo } from "./caldav-delete-ports";
import type {
  ClaimedCaldavPersonalCreate, CaldavPersonalCreateHostPorts, CaldavPersonalCreatePolicy, CaldavCreateRuntimeProviderPorts,
  CaldavRuntimeCreateCompletionEvidence, CaldavRuntimeCreateDecisionContext, CaldavRuntimeCreateDecisionFact, CaldavRuntimeCreateEvaluatedDecision,
  CaldavRuntimeCreateFinishOutcome, CaldavRuntimeCreateNativeFacts, CaldavRuntimeCreateProviderFact, CaldavRuntimeCreateRunResult, CaldavTimedProjection,
} from "./caldav-create-ports";
import { evaluateCaldavPersonalCreateFact, caldavPersonalCreateIdentityV1 } from "./caldav-create-trace";

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
function projectionSnapshot(value: CaldavTimedProjection): CaldavTimedProjection {
  const title = data(value, "title"), description = data(value, "description"), location = data(value, "location"),
    start = data(value, "start"), end = data(value, "end");
  if (typeof title !== "string" || description !== null && typeof description !== "string" || location !== null && typeof location !== "string" ||
      typeof start !== "string" || typeof end !== "string" || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) ||
      new Date(start).toISOString() !== start || new Date(end).toISOString() !== end || data(value, "isAllDay") !== false || data(value, "recurrence") !== null)
    throw new Error("Invalid normalized creation observation.");
  return Object.freeze({ title, description, location, start, end, isAllDay: false, recurrence: null }) as CaldavTimedProjection;
}
function runtimeError(error: unknown, phase: RuntimePhase): RuntimeErrorInfo {
  if (error instanceof SyncRuntimeInterrupted) return { code: "runtime-attempt-aborted", outcome: "unconfirmed", phase,
    interruption: error.reason === "finished" ? "cancelled" : error.reason };
  if (error instanceof CaldavProviderError) return frozen({ code: error.code, outcome: error.outcome, phase,
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
          ...(capability === "event-write" || capability === "organizer" || capability === "recurrence" ? { capability } : {}),
          ...(evidence === "denied" || evidence === "unknown" || evidence === "unsupported" ? { evidence } : {}) });
      }
    } catch { /* Fall through to bounded metadata. */ }
  }
  return { code: "runtime-attempt-failed", outcome: phase === "mutation" ? "unconfirmed" : "not-written", phase };
}
function providerFact(value: unknown): CaldavRuntimeCreateProviderFact {
  const kind = data(value, "kind");
  if (kind === "not-dispatched" || kind === "uncertain") return { kind };
  if (kind === "accepted") {
    const validator = data(value, "validator"), status = data(value, "status");
    if (validator !== null && !strongCaldavEtag(validator) || ![200, 201, 204].includes(status as number)) throw new Error("Invalid prior acceptance.");
    return { kind, validator: validator as string | null, status: status as 200 | 201 | 204 };
  }
  if (kind === "rejected") return { kind, error: SyncErrorSchema.parse(data(value, "error")) };
  throw new Error("Invalid prior native fact.");
}
function rejection(error: RuntimeErrorInfo): CaldavRuntimeCreateProviderFact {
  if ([401, 403].includes(error.providerStatus ?? 0)) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (error.providerStatus === 429) return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay",
    ...(error.retryAfterMs === undefined || error.retryAfterMs > Number.MAX_SAFE_INTEGER ? {} : { retryAfterMs: Math.ceil(error.retryAfterMs) }) } };
  return { kind: "rejected", error: { code: "transport-failed", retry: "never" } };
}
function copyPolicy(value: CaldavPersonalCreatePolicy): CaldavPersonalCreatePolicy {
  const completion = data(value, "completion"), ambiguousRecovery = data(value, "ambiguousRecovery"), nativeProfile = data(value, "nativeProfile"),
    requireStrongReadback = data(value, "requireStrongReadback");
  if (typeof completion !== "string" || !["provider-response", "exact-readback"].includes(completion) ||
      typeof ambiguousRecovery !== "string" || !["deferred", "within-attempt"].includes(ambiguousRecovery) ||
      typeof nativeProfile !== "string" || !["strict-reference", "existing-caldav"].includes(nativeProfile) || typeof requireStrongReadback !== "boolean")
    throw new Error("Invalid runtime policy.");
  return Object.freeze({ completion, ambiguousRecovery, nativeProfile, requireStrongReadback }) as CaldavPersonalCreatePolicy;
}

/** CREATE alone refines operation identity to the already admitted canonical UUID. */
export function supportsCaldavPersonalCreateEnvelope(envelope: SyncOperationEnvelope): boolean {
  if (envelope.operation.kind !== "event" || envelope.operation.action !== "create" || envelope.locator.provider !== "caldav" ||
      envelope.serializer.id !== "caldav-personal-event" || envelope.serializer.version !== 1 ||
      envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") return false;
  const identity = caldavPersonalCreateIdentityV1(envelope.locator.collectionId, envelope.operationId);
  const plan = parseNativeWritePlanV1(envelope.serializer, "create", "event", envelope.nativePlan.data);
  if (!identity || !plan || plan.planKind !== "caldav-properties" || plan.component !== "VEVENT" || plan.properties.length !== 0 ||
      envelope.locator.resourceId !== identity.resourceUrl || plan.uid !== identity.uid) return false;
  return envelope.admittedProjection.data.isAllDay === false && envelope.admittedProjection.data.recurrence === null &&
    matchesPinnedProjectionV1(envelope.serializer, "create", envelope.admittedProjection.data, envelope.nativePlan.data);
}
class DecisionFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}

/** One host claim, one finite lifecycle, immutable CREATE identity/body and fenced ACK. */
export async function runClaimedCaldavPersonalCreate(input: ClaimedCaldavPersonalCreate, host: CaldavPersonalCreateHostPorts,
  transport: CaldavCreateRuntimeProviderPorts, inputPolicy: CaldavPersonalCreatePolicy, options: RuntimeAttemptOptions = {}): Promise<CaldavRuntimeCreateRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt";
  let facts: CaldavRuntimeCreateNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { creation: CaldavPersonalCreate; projection: CaldavTimedProjection; policy: CaldavPersonalCreatePolicy;
    recovery: boolean };
  try {
    operationId = id(data(input, "operationId")); attemptId = id(data(input, "attemptId"));
    const recovery = data(input, "recovery"), required = data(recovery, "required"), possibleDispatch = data(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possibleDispatch !== "boolean" || required !== possibleDispatch) throw new Error("Invalid recovery facts.");
    const prior = providerFact(data(input, "priorProvider"));
    if (prior.kind !== "not-dispatched" && !possibleDispatch) throw new Error("Invalid prior dispatch facts.");
    facts = frozen({ provider: prior, remote: { kind: "unobserved" }, possibleDispatch });
    const binding = SyncOperationRowBindingSchema.parse(data(input, "binding"));
    const decoded = decodeSyncOperationPayload(data(input, "payload"), binding, { supports: supportsCaldavPersonalCreateEnvelope });
    if (decoded.kind !== "pinned-v1") throw new DecisionFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase: "decode" });
    const envelope = decoded.envelope;
    if (envelope.operationId !== operationId) throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const target = data(input, "nativeTarget");
    const resourceUrl = data(target, "resourceUrl");
    if (typeof resourceUrl !== "string" || !resourceUrl) throw new Error("Invalid resource URL.");
    const nativeTarget = frozen({ connectionId: id(data(target, "connectionId")), connectionGeneration: id(data(target, "connectionGeneration")),
      calendarUrl: id(data(target, "calendarUrl")), resourceUrl, uid: id(data(target, "uid")) });
    const identity = caldavPersonalCreateIdentityV1(nativeTarget.calendarUrl, operationId);
    if (!identity || nativeTarget.calendarUrl !== envelope.locator.collectionId || nativeTarget.resourceUrl !== envelope.locator.resourceId ||
        nativeTarget.resourceUrl !== identity.resourceUrl || nativeTarget.uid !== identity.uid)
      throw new DecisionFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase: "decode" });
    const plan = parseNativeWritePlanV1(envelope.serializer, "create", "event", envelope.nativePlan.data)!;
    if (plan.planKind !== "caldav-properties" || plan.uid !== nativeTarget.uid) throw new Error("Invalid admitted plan.");
    snapshot = { creation: frozen({ operationId, attemptId, target: nativeTarget, serializer: { id: "caldav-personal-event", version: 1 }, body: plan.createResource }) as CaldavPersonalCreate,
      projection: frozen(envelope.admittedProjection.data) as unknown as CaldavTimedProjection, policy: copyPolicy(inputPolicy),
      recovery: required };
  } catch (error) {
    const info = error instanceof DecisionFailure ? error.info : { code: "operation-payload-malformed", outcome: "not-written" as const, phase: "decode" as const };
    trace.push({ decision: "hold", phase: "decode" });
    await host.finish({ status: "hold", error: frozen(info), facts: frozen(facts), cause: error });
    return frozen({ status: "hold", operationId, attemptId, facts, error: info, trace });
  }
  const attempt = createRuntimeAttempt(signal => host.renew(signal), bounds);
  const context = (): CaldavRuntimeCreateDecisionContext => frozen({ operationId, resourceUrl: snapshot.creation.target.resourceUrl,
    uid: snapshot.creation.target.uid, projection: snapshot.projection, policy: snapshot.policy });
  let phase: RuntimePhase = "decode", acknowledged = false, persistedFacts: CaldavRuntimeCreateNativeFacts | undefined;
  const errorPhases = new WeakMap<object, RuntimePhase>();
  const recordedFailures = new WeakSet<object>();
  const addTrace = (decision: RuntimeTraceEntry["decision"], at: RuntimePhase) => { if (trace.length < 32) trace.push({ decision, phase: at }); };
  const choose = (fact: CaldavRuntimeCreateDecisionFact, at: RuntimePhase): CaldavRuntimeCreateEvaluatedDecision => {
    const saved = frozen(fact), decisionContext = context(), evaluated = evaluateCaldavPersonalCreateFact(decisionContext, saved);
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
  const complete = async (evidence: CaldavRuntimeCreateCompletionEvidence) => {
    attempt.guard(); phase = "ack";
    const result = await host.ack(frozen(evidence), attempt.signal);
    if (result.kind === "acknowledged") {
      acknowledged = true; addTrace("acknowledged", "ack");
      if (!attempt.signal.aborted) { try { await checkpoint("afterAck"); } catch { /* Committed truth wins. */ } }
      return;
    }
    attempt.guard(); throw new DecisionFailure({ code: "runtime-ack-authority-changed", outcome: "not-written", phase: "ack" });
  };
  let provider: ReturnType<typeof createCaldavPersonalEventCreateProvider>;
  const read = async (mode: "recovery-read" | "readback") => {
    attempt.guard(); phase = mode;
    const native = await provider.readCreated(snapshot.creation, attempt.signal); attempt.guard();
    let projection: CaldavTimedProjection | null = null;
    if (native.kind === "present") {
      const normalized = await host.normalizeObservation(native, attempt.signal); attempt.guard();
      projection = normalized === null ? null : projectionSnapshot(normalized);
    }
    const decision = choose({ kind: mode, read: native, projection }, mode);
    if (native.kind === "absent") {
      facts = frozen({ ...facts, remote: { kind: "absent", observationId: id(host.observationId()) } });
      await persist();
      if (decision.decision === "preflight") return false;
    }
    if (native.kind === "present") {
      const observationId = id(host.observationId());
      facts = frozen({ ...facts, remote: decision.decision === "confirmed" && projection
        ? { kind: "confirmed", observationId, read: native, projection }
        : { kind: "conflict", observationId, read: native, projection } });
      await persist();
      if (decision.decision === "confirmed" && projection) {
        await checkpoint("afterReadback");
        await complete({ kind: "exact-readback", resourceUrl: native.resource.resourceUrl, uid: native.resource.uid,
          validator: native.etag, projection, read: native, facts });
        return true;
      }
    }
    throw new DecisionFailure({ code: `runtime-${decision.reason ?? "readback-differs"}`, outcome: "not-written", phase: mode });
  };
  const handleMutationError = async (error: unknown) => {
    const at = error && typeof error === "object" ? errorPhases.get(error) ?? "mutation" : "mutation";
    const info = runtimeError(error, at);
    if (at === "mutation" && info.outcome === "unconfirmed" && facts.possibleDispatch) {
      facts = frozen({ ...facts, provider: facts.provider.kind === "accepted" ? facts.provider : { kind: "uncertain" } });
      await persist(); await checkpoint("afterUncertain");
      const decision = choose({ kind: "failure", error: info }, at);
      if (error && typeof error === "object") recordedFailures.add(error);
      if (decision.decision === "observe") { await read("readback"); return; }
    }
    throw new DecisionFailure(info, error);
  };
  let failure: CaldavRuntimeCreateFinishOutcome | undefined;
  try {
    await attempt.run(async () => {
      if (host.prepare) { attempt.guard(); await host.prepare(attempt.signal); attempt.guard(); }
      provider = createCaldavPersonalEventCreateProvider({ ...transport,
        network: { allowPrivate: transport.network.allowPrivate, async lookupImpl(hostname, lookupOptions) {
          attempt.guard(); const addresses = await transport.network.lookupImpl(hostname, lookupOptions); attempt.guard(); return addresses;
        } },
        http: { fetchPinned(url, init, address) { attempt.guard(); return transport.http.fetchPinned(url, init, address); } },
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
      if (snapshot.recovery && await read("recovery-read")) return;
      phase = "preflight"; await provider.preflightCreate(snapshot.creation, attempt.signal); attempt.guard(); addTrace("dispatch", "preflight");
      phase = "mutation";
      let created;
      try { created = await provider.create(snapshot.creation, attempt.signal); attempt.guard(); }
      catch (error) { await handleMutationError(error); return; }
      choose({ kind: "create" }, "mutation");
      facts = frozen({ ...facts, provider: { kind: "accepted", validator: created.etag, status: created.status }, remote: { kind: "unobserved" } });
      await persist(); await checkpoint("afterAcceptance");
      if (snapshot.policy.completion === "provider-response") await complete({ kind: "provider-response", resourceUrl: created.resourceUrl, uid: created.uid,
        validator: created.etag, facts });
      else await read("readback");
    });
  } catch (error) {
    if (!acknowledged) {
      const info = error instanceof DecisionFailure ? error.info : runtimeError(error, error && typeof error === "object" ? errorPhases.get(error) ?? phase : phase);
      const original = error instanceof DecisionFailure ? error.cause : error;
      if (!attempt.signal.aborted && (!original || typeof original !== "object" || !recordedFailures.has(original))) choose({ kind: "failure", error: info }, info.phase);
      // A rejection of this conditional retry cannot settle an older ambiguous
      // PUT. Keep that uncertainty independently of the current error/status.
      if (info.phase === "mutation" && info.providerStatus !== undefined && info.outcome === "not-written" &&
          facts.provider.kind !== "accepted" && facts.provider.kind !== "uncertain")
        facts = frozen({ ...facts, provider: rejection(info) });
      else if (facts.possibleDispatch && facts.provider.kind === "not-dispatched") facts = frozen({ ...facts, provider: { kind: "uncertain" } });
      if (attempt.signal.aborted) failure = { status: "hold", error: runtimeError(attempt.signal.reason, info.phase), facts, cause: error };
      else {
        try { await attempt.run(persist); } catch { /* Fenced host finish owns final settlement. */ }
        const delay = info.phase === "mutation" && [401, 403].includes(info.providerStatus ?? 0) ? Infinity :
          info.retryAfterMs === undefined ? undefined : info.retryAfterMs > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(info.retryAfterMs);
        failure = { status: info.code === "provider-conflict" || ["runtime-profile-unavailable", "runtime-creation-identity-changed", "runtime-readback-differs", "runtime-remote-validator-unavailable", "runtime-resource-absent"].includes(info.code) ? "conflict" : "hold",
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
