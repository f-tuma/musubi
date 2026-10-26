import { guardHttpDispatch } from "./http-dispatch";
import { providerDeferral } from "./provider-budget";
import { createGoogleTaskCreateProvider, GoogleTaskProviderError, strongGoogleEtag, googleTaskProjectionFromNative,
  achievesGoogleTaskPatch, parseGoogleTaskPatch, diffGoogleTaskProjection,
  type GoogleTaskCreate, type GoogleTaskProjection, type GoogleNativeTaskReadEvidence, type GoogleNativeTaskResponseAddress } from "@musubi/provider-google";
import { decodeSyncOperationPayload, SyncOperationRowBindingSchema, SyncErrorSchema, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError, type RuntimeErrorInfo, type RuntimePhase, type RuntimeProviderFact, type RuntimeTraceEntry } from "./ports";
import { own, copy, identity, projection, sameTask } from "./task-data";
import { copyNativeTaskEvidence } from "./task-native-data";
import type { ClaimedGoogleTaskCreate, GoogleTaskCreateHostPorts, GoogleTaskCreateRuntimeProviderPorts, GoogleTaskCreatePolicy,
  GoogleTaskCreateSavedProjection, RuntimeTaskCreateNativeFacts, RuntimeTaskCreateCompletionEvidence, RuntimeTaskCreateFinishOutcome, RuntimeTaskCreateRunResult, RuntimeAttemptOptions } from "./google-task-create-ports";

export function supportsGoogleTaskCreateEnvelope(envelope: SyncOperationEnvelope): boolean {
  return envelope.operation.kind === "task" && envelope.operation.action === "create" && envelope.locator.provider === "google" &&
    envelope.locator.resourceId === null && envelope.predecessorOperationId == null && envelope.serializer.id === "google-task" && envelope.serializer.version === 1;
}
class TaskFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}
function failure(error: unknown, phase: RuntimePhase): RuntimeErrorInfo {
  const deferral = providerDeferral(error);
  if (deferral) return { code: "provider-budget-deferred", outcome: "not-written", phase, deferral };
  if (error instanceof TaskFailure) return error.info;
  if (error instanceof SyncRuntimeInterrupted) return { code: "runtime-attempt-aborted", outcome: "unconfirmed", phase,
    interruption: error.reason === "finished" ? "cancelled" : error.reason };
  if (error instanceof GoogleTaskProviderError || error instanceof SyncRuntimeHostError) {
    const item = error instanceof SyncRuntimeHostError ? error.info : error;
    if (typeof item.code === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(item.code) && ["not-written", "unconfirmed"].includes(item.outcome))
      return { code: item.code, outcome: item.outcome, phase,
        ...(Number.isInteger(item.providerStatus) && item.providerStatus! >= 100 && item.providerStatus! <= 599 ? { providerStatus: item.providerStatus } : {}),
        ...(typeof item.retryAfterMs === "number" && item.retryAfterMs >= 0 ? { retryAfterMs: item.retryAfterMs } : {}) };
  }
  return { code: "task-write-failed", outcome: phase === "mutation" ? "unconfirmed" : "not-written", phase };
}
function rejected(info: RuntimeErrorInfo): RuntimeProviderFact {
  if (info.providerStatus === 412) return { kind: "rejected", error: { code: "conflict", retry: "never" } };
  if (info.providerStatus === 401 || info.providerStatus === 403) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (info.providerStatus === 429) return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay",
    ...(info.retryAfterMs === undefined ? {} : { retryAfterMs: Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(info.retryAfterMs)) }) } };
  return { kind: "rejected", error: { code: "transport-failed", retry: info.providerStatus === 408 ? "after-delay" : "never" } };
}
function address(value: unknown, strict: boolean): GoogleNativeTaskResponseAddress {
  const item = copyNativeTaskEvidence(value), taskId = own(item, "taskId"), validator = own(item, "validator");
  if (typeof taskId !== "string" || !taskId || strict && taskId.length > 2048 || validator !== null && !strongGoogleEtag(validator)) throw new Error("Invalid CREATE response address.");
  if (strict) encodeURIComponent(taskId);
  return copyNativeTaskEvidence({ taskId, validator: validator as string | null });
}
function savedProjection(value: unknown, target: GoogleTaskProjection): GoogleTaskCreateSavedProjection {
  const item = copy(value), admitted = projection(own(item, "projection")), raw = own(item, "baseline");
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("Invalid CREATE baseline.");
  const before = raw as Readonly<Record<string, unknown>> | null, patch = parseGoogleTaskPatch(own(item, "patch"));
  if (!sameTask(admitted, target) || !patch || !sameTask(patch, before ? diffGoogleTaskProjection(before, target) : target)) throw new Error("Invalid CREATE saved projection.");
  return copy({ projection: admitted, baseline: before, patch });
}

/** Already-claimed generated-address CREATE. A dispatch marker with no returned
 * address is an unresolved outcome, never permission to POST or search again. */
export async function runClaimedGoogleTaskCreate(input: ClaimedGoogleTaskCreate, host: GoogleTaskCreateHostPorts,
  transport: GoogleTaskCreateRuntimeProviderPorts, inputPolicy: GoogleTaskCreatePolicy, options: RuntimeAttemptOptions = {}): Promise<RuntimeTaskCreateRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt", phase: RuntimePhase = "decode", acknowledged = false;
  let facts: RuntimeTaskCreateNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { target: ClaimedGoogleTaskCreate["nativeTarget"]; projection: GoogleTaskProjection; recovery: boolean; policy: GoogleTaskCreatePolicy };
  try {
    operationId = identity(own(input, "operationId")); attemptId = identity(own(input, "attemptId"));
    const policy = copy(inputPolicy);
    if (!["existing-google", "strict-reference"].includes(own(policy, "nativeProfile") as string) ||
        !["saved-patch", "full-target"].includes(own(policy, "readback") as string) || !["deferred", "within-attempt"].includes(own(policy, "ambiguousRecovery") as string)) throw new Error("Invalid CREATE policy.");
    const recovery = copy(own(input, "recovery")), required = own(recovery, "required"), possibleDispatch = own(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possibleDispatch !== "boolean" || required && !possibleDispatch) throw new Error("Invalid CREATE recovery.");
    const prior = copy(own(input, "priorProvider")), kind = own(prior, "kind");
    let provider: RuntimeProviderFact;
    if (kind === "not-dispatched" || kind === "uncertain") provider = { kind };
    else if (kind === "accepted") {
      const validator = own(prior, "validator"); if (validator !== null && !strongGoogleEtag(validator)) throw new Error("Invalid CREATE acceptance.");
      provider = { kind, validator: validator as string | null };
    } else if (kind === "rejected") provider = { kind, error: SyncErrorSchema.parse(own(prior, "error")) };
    else throw new Error("Invalid CREATE provider fact.");
    if (kind !== "not-dispatched" && !possibleDispatch) throw new Error("Missing CREATE dispatch.");
    const optional = (key: string) => { const d = Object.getOwnPropertyDescriptor(input, key); if (d && !("value" in d)) throw new Error("Invalid CREATE evidence."); return d && "value" in d ? d.value : null; };
    const accepted = optional("priorAcceptedStatus"), candidate = optional("priorResponseAddress");
    if (accepted !== null && accepted !== undefined && (![200, 201, 204].includes(accepted) || kind !== "accepted")) throw new Error("Invalid CREATE accepted status.");
    if (candidate != null && !possibleDispatch) throw new Error("CREATE address without dispatch.");
    facts = copyNativeTaskEvidence({ provider, possibleDispatch, remote: { kind: "unobserved" }, ...(accepted == null ? {} : { acceptedStatus: accepted }),
      ...(candidate == null ? {} : { responseAddress: address(candidate, policy.nativeProfile === "strict-reference") }) });
    const binding = SyncOperationRowBindingSchema.parse(copy(own(input, "binding")));
    const decoded = decodeSyncOperationPayload(copy(own(input, "payload")), binding, { supports: supportsGoogleTaskCreateEnvelope });
    if (decoded.kind !== "pinned-v1") throw new TaskFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase });
    const envelope = decoded.envelope, raw = copy(own(input, "nativeTarget"));
    const target = { connectionId: identity(own(raw, "connectionId")), connectionGeneration: identity(own(raw, "connectionGeneration")), taskListId: identity(own(raw, "taskListId")) };
    const collectionIdentity = own(input, "collectionIdentity"), collection = collectionIdentity === "native" ? envelope.locator.collectionId :
      collectionIdentity === "musubi-google-task-list" && envelope.locator.collectionId.startsWith("musubi-google-task-list:") ? envelope.locator.collectionId.slice("musubi-google-task-list:".length) : null;
    if (operationId !== envelope.operationId || target.taskListId !== collection || envelope.locator.resourceId !== null ||
        envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") throw new Error("Invalid CREATE binding.");
    const plan = parseNativeWritePlanV1(envelope.serializer, "create", "task", envelope.nativePlan.data), targetProjection = projection(envelope.admittedProjection.data);
    if (!plan || plan.planKind !== "json-body" || !plan.body || !sameTask(plan.body, targetProjection) || !matchesPinnedProjectionV1(envelope.serializer, "create", targetProjection, envelope.nativePlan.data)) throw new Error("Invalid CREATE native plan.");
    snapshot = copy({ target, projection: targetProjection, recovery: required || possibleDispatch, policy });
  } catch (error) {
    const info = error instanceof TaskFailure ? error.info : { code: "runtime-task-plan-unavailable", outcome: "not-written" as const, phase };
    await host.finish({ status: "hold", error: info, facts });
    return copyNativeTaskEvidence({ status: "hold", operationId, attemptId, facts, error: info, trace: [{ decision: "hold", phase }] });
  }
  const attempt = createRuntimeAttempt(signal => host.renew(signal), bounds);
  let saved = copy({ projection: snapshot.projection, baseline: null, patch: snapshot.projection }) as GoogleTaskCreateSavedProjection;
  let currentDispatched = false, provider: ReturnType<typeof createGoogleTaskCreateProvider>;
  const persist = async () => { attempt.guard(); await host.recordEvidence(copyNativeTaskEvidence(facts), attempt.signal); attempt.guard(); };
  const checkpoint = async (point: Parameters<NonNullable<GoogleTaskCreateHostPorts["checkpoint"]>>[0]) => { attempt.guard(); await host.checkpoint?.(point, attempt.signal); attempt.guard(); };
  const verify = async (recovery: boolean) => {
    attempt.guard(); const candidate = facts.responseAddress;
    if (!candidate) throw new TaskFailure({ code: "task-create-unconfirmed", outcome: "unconfirmed", phase: "recovery-read" });
    phase = recovery ? "recovery-read" : "readback";
    const read = await provider.readForCreate({ ...snapshot.target, taskId: candidate.taskId }, attempt.signal); attempt.guard();
    const projected = read.kind === "present" ? googleTaskProjectionFromNative(read.task) : null;
    const confirmed = projected !== null && (recovery || snapshot.policy.readback === "full-target" ? sameTask(projected, snapshot.projection) : achievesGoogleTaskPatch(projected, saved.patch));
    facts = copyNativeTaskEvidence({ ...facts, remote: { kind: confirmed ? "confirmed" : "conflict", observationId: identity(host.observationId()), read, projection: projected } });
    trace.push({ decision: confirmed ? "confirmed" : "conflict", phase }); await persist();
    if (!confirmed || read.kind !== "present") throw new TaskFailure({ code: recovery ? "task-create-unconfirmed" : "task-write-failed", outcome: "unconfirmed", phase });
    await checkpoint("afterReadback"); phase = "ack";
    const evidence: RuntimeTaskCreateCompletionEvidence = copyNativeTaskEvidence({ kind: "exact-readback", taskId: candidate.taskId, validator: read.etag, projection: projected!, read, saved, facts });
    const result = await host.ack(evidence, attempt.signal);
    if (result.kind === "acknowledged") { acknowledged = true; trace.push({ decision: "acknowledged", phase }); return; }
    attempt.guard(); throw new TaskFailure({ code: "runtime-ack-authority-changed", outcome: "unconfirmed", phase });
  };
  let terminal: RuntimeTaskCreateFinishOutcome | undefined;
  try {
    await attempt.run(async () => {
      const prepared = await host.prepare(attempt.signal); attempt.guard();
      const descriptor = Object.getOwnPropertyDescriptor(prepared, "dispatchAllowed");
      if (descriptor && (!("value" in descriptor) || typeof descriptor.value !== "boolean")) throw new Error("Invalid CREATE dispatch authority.");
      const dispatchAllowed = descriptor ? descriptor.value as boolean : true;
      const stored = Object.getOwnPropertyDescriptor(prepared, "saved");
      if (stored && !("value" in stored)) throw new Error("Invalid CREATE saved state.");
      if (stored && stored.value != null) saved = savedProjection(stored.value, snapshot.projection);
      if (!snapshot.recovery && host.prepareProjection) saved = savedProjection(await host.prepareProjection(copy({ target: snapshot.projection, ...(stored?.value == null ? {} : { saved }) }), attempt.signal), snapshot.projection);
      attempt.guard();
      const accountCall = async <T>(call: () => Promise<T>) => { attempt.guard(); const previous = phase; phase = "credentials";
        try { const result = await call(); attempt.guard(); await checkpoint("afterCredentials"); return result; }
        catch (error) { throw new TaskFailure(failure(error, "credentials"), error); } finally { phase = previous; } };
      provider = createGoogleTaskCreateProvider({ ...transport, http: guardHttpDispatch(transport.http, attempt.guard),
        accountSession: { open: (connection, signal) => accountCall(() => host.accountSession.open(connection, signal)),
          ...(host.accountSession.recoverRejectedRead ? { recoverRejectedRead: (connection: Parameters<NonNullable<typeof host.accountSession.recoverRejectedRead>>[0], token: string, signal?: AbortSignal) => accountCall(() => host.accountSession.recoverRejectedRead!(connection, token, signal)) } : {}),
          ...(host.accountSession.onReadAuthenticationRejected ? { onReadAuthenticationRejected: (signal?: AbortSignal) => accountCall(() => host.accountSession.onReadAuthenticationRejected!(signal)) } : {}) },
        async beforeMutation(request, signal) { attempt.guard(); await host.beforeMutation(request, signal!); attempt.guard(); phase = "mutation"; currentDispatched = true;
          facts = copyNativeTaskEvidence({ ...facts, possibleDispatch: true }); trace.push({ decision: "dispatch", phase }); await checkpoint("beforeDispatch"); },
        async onAcceptedResponse(receipt, signal) { facts = copyNativeTaskEvidence({ ...facts, possibleDispatch: true, acceptedStatus: receipt.status, provider: { kind: "accepted", validator: null } });
          // Legacy API parsing has no post-response host await. Its raw facts
          // remain attempt-local; do not insert a new cancellation boundary.
          if (snapshot.policy.nativeProfile === "existing-google") return;
          attempt.guard(); signal?.throwIfAborted(); await persist(); await checkpoint("afterAcceptance"); },
        async onResponseAddress(candidate, signal) { facts = copyNativeTaskEvidence({ ...facts, responseAddress: address(candidate, snapshot.policy.nativeProfile === "strict-reference") });
          if (snapshot.policy.nativeProfile === "existing-google") {
            return;
          }
          attempt.guard(); signal?.throwIfAborted(); await persist(); },
      }, { nativeProfile: snapshot.policy.nativeProfile });
      if (snapshot.recovery) { await verify(true); return; }
      if (!dispatchAllowed) throw new TaskFailure({ code: "task-not-needed", outcome: "not-written", phase: "preflight" });
      const request: GoogleTaskCreate = copy({ target: snapshot.target, body: snapshot.projection, operationId, attemptId, serializer: { id: "google-task", version: 1 } });
      phase = "preflight"; trace.push({ decision: "preflight", phase }); await provider.preflightCreate(request, attempt.signal); attempt.guard();
      try {
        const written = await provider.create(request, attempt.signal);
        // The legacy API assigns the complete returned ref before checking its
        // signal. Keep that receipt even if the next guard discovers timeout.
        facts = copyNativeTaskEvidence({ ...facts, writerResult: { taskId: written.taskId, etag: written.etag }, responseAddress: { taskId: written.taskId, validator: written.etag }, provider: { kind: "accepted", validator: written.etag } });
        attempt.guard(); await persist();
      } catch (error) {
        let info = failure(error, phase);
        if (facts.provider.kind === "accepted" && info.outcome === "not-written") info = { ...info, outcome: "unconfirmed" };
        if (currentDispatched && info.outcome === "unconfirmed" && facts.provider.kind !== "accepted") facts = copyNativeTaskEvidence({ ...facts, provider: { kind: "uncertain" } });
        if (!info.deferral && facts.responseAddress && snapshot.policy.ambiguousRecovery === "within-attempt" && info.outcome === "unconfirmed") { await persist(); await checkpoint("afterUncertain"); await verify(true); return; }
        throw new TaskFailure(info, error);
      }
      await verify(false);
    });
  } catch (error) {
    if (!acknowledged) {
      const info = failure(error, phase);
      if (currentDispatched && info.outcome === "unconfirmed" && facts.provider.kind !== "accepted") facts = copyNativeTaskEvidence({ ...facts, provider: { kind: "uncertain" } });
      if (currentDispatched && info.phase === "mutation" && info.outcome === "not-written" && info.providerStatus !== undefined && facts.provider.kind !== "accepted" && facts.provider.kind !== "uncertain") facts = copyNativeTaskEvidence({ ...facts, provider: rejected(info) });
      else if (facts.possibleDispatch && facts.provider.kind === "not-dispatched") facts = copyNativeTaskEvidence({ ...facts, provider: { kind: "uncertain" } });
      const interrupted = attempt.signal.aborted ? failure(attempt.signal.reason, info.phase) : info;
      terminal = { status: interrupted.code === "task-provider-conflict" ? "conflict" : "hold", error: interrupted, facts,
        ...(interrupted.retryAfterMs === undefined ? {} : { retryAfterMs: interrupted.retryAfterMs }), cause: error instanceof TaskFailure ? error.cause : error };
      trace.push({ decision: terminal.status, phase: interrupted.phase });
    }
  } finally { attempt.close(); }
  if (acknowledged) return copyNativeTaskEvidence({ status: "acked", operationId, attemptId, facts, trace });
  terminal ??= { status: "hold", error: { code: "task-write-failed", outcome: "not-written", phase }, facts };
  await host.finish({ ...terminal, facts: copyNativeTaskEvidence(terminal.facts) });
  return copyNativeTaskEvidence({ status: terminal.status, operationId, attemptId, facts: terminal.facts, error: terminal.error, trace });
}
