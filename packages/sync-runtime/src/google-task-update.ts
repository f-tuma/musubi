import {
  createGoogleTaskUpdateProvider, GoogleTaskProviderError, strongGoogleEtag,
  googleTaskProjectionFromNative, achievesGoogleTaskPatch,
  type GoogleTaskProjection, type GoogleTaskUpdate, type GoogleNativeTaskReadEvidence,
} from "@musubi/provider-google";
import { decodeSyncOperationPayload, SyncOperationRowBindingSchema, SyncErrorSchema, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError, type RuntimeErrorInfo, type RuntimeProviderFact, type RuntimePhase, type RuntimeTraceEntry } from "./ports";
import type {
  ClaimedGoogleTaskUpdate, GoogleTaskUpdateHostPorts, GoogleTaskRuntimeProviderPorts, GoogleTaskUpdatePolicy,
  GoogleTaskSavedProjection, RuntimeTaskNativeFacts, RuntimeTaskRunResult, RuntimeTaskFinishOutcome, RuntimeAttemptOptions,
} from "./google-task-update-ports";

import { own, copy, identity, projection, baseline, savedProjection, sameTask } from "./task-data";

/** Nominal selection deliberately does not inspect the mask, validator or plan.
 * Once selected, malformed admitted data must HOLD rather than use a legacy writer. */
export function supportsGoogleTaskUpdateEnvelope(envelope: SyncOperationEnvelope): boolean {
  return envelope.operation.kind === "task" && envelope.operation.action === "update" && envelope.locator.provider === "google" &&
    typeof envelope.locator.resourceId === "string" && envelope.locator.resourceId.length > 0 &&
    envelope.serializer.id === "google-task" && envelope.serializer.version === 1;
}
class TaskFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}
function failure(error: unknown, phase: RuntimePhase): RuntimeErrorInfo {
  if (error instanceof TaskFailure) return error.info;
  if (error instanceof SyncRuntimeInterrupted) return { code: "runtime-attempt-aborted", outcome: "unconfirmed", phase,
    interruption: error.reason === "finished" ? "cancelled" : error.reason };
  if (error instanceof GoogleTaskProviderError || error instanceof SyncRuntimeHostError) {
    const item = error instanceof SyncRuntimeHostError ? error.info : error;
    const code = item.code, outcome = item.outcome;
    if (typeof code === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(code) && (outcome === "not-written" || outcome === "unconfirmed"))
      return { code, outcome, phase,
        ...(Number.isInteger(item.providerStatus) && item.providerStatus! >= 100 && item.providerStatus! <= 599 ? { providerStatus: item.providerStatus } : {}),
        ...(typeof item.retryAfterMs === "number" && item.retryAfterMs >= 0 ? { retryAfterMs: item.retryAfterMs } : {}) };
  }
  return { code: "task-write-failed", outcome: phase === "mutation" ? "unconfirmed" : "not-written", phase };
}
function rejected(info: RuntimeErrorInfo): RuntimeProviderFact {
  if (info.providerStatus === 412) return { kind: "rejected", error: { code: "conflict", retry: "never" } };
  if (info.providerStatus === 401 || info.providerStatus === 403) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (info.providerStatus === 429) return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay",
    ...(info.retryAfterMs !== undefined && info.retryAfterMs <= Number.MAX_SAFE_INTEGER ? { retryAfterMs: Math.ceil(info.retryAfterMs) } : {}) } };
  return { kind: "rejected", error: { code: "transport-failed", retry: "never" } };
}

/** One already-claimed task attempt. Neither canonical storage nor credential
 * refresh belongs to this kernel; all writes stay behind typed host ports. */
export async function runClaimedGoogleTaskUpdate(input: ClaimedGoogleTaskUpdate, host: GoogleTaskUpdateHostPorts,
  transport: GoogleTaskRuntimeProviderPorts, inputPolicy: GoogleTaskUpdatePolicy, options: RuntimeAttemptOptions = {}): Promise<RuntimeTaskRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt", phase: RuntimePhase = "decode", acknowledged = false;
  let facts: RuntimeTaskNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { target: ClaimedGoogleTaskUpdate["nativeTarget"]; projection: GoogleTaskProjection; acceptedEtag: unknown; recovery: boolean; policy: GoogleTaskUpdatePolicy };
  try {
    operationId = identity(own(input, "operationId")); attemptId = identity(own(input, "attemptId"));
    const recovery = copy(own(input, "recovery"));
    const required = own(recovery, "required"), possibleDispatch = own(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possibleDispatch !== "boolean" || required && !possibleDispatch) throw new Error("Invalid task recovery.");
    const prior = copy(own(input, "priorProvider"));
    const priorKind = own(prior, "kind");
    if (priorKind !== "not-dispatched" && (!required || !possibleDispatch)) throw new Error("Invalid task prior dispatch.");
    let provider: RuntimeProviderFact;
    if (priorKind === "not-dispatched" || priorKind === "uncertain") provider = { kind: priorKind };
    else if (priorKind === "accepted") {
      const validator = own(prior, "validator");
      if (validator !== null && !strongGoogleEtag(validator)) throw new Error("Invalid task acceptance.");
      provider = { kind: "accepted", validator: validator as string | null };
    } else if (priorKind === "rejected") provider = { kind: "rejected", error: SyncErrorSchema.parse(own(prior, "error")) };
    else throw new Error("Invalid task provider facts.");
    const acceptedStatus = Object.getOwnPropertyDescriptor(input, "priorAcceptedStatus");
    if (acceptedStatus && !("value" in acceptedStatus)) throw new Error("Invalid task accepted status.");
    const status = acceptedStatus && "value" in acceptedStatus ? acceptedStatus.value : undefined;
    if (status != null && (![200, 201, 204].includes(status) || priorKind !== "accepted")) throw new Error("Invalid task accepted status.");
    facts = copy({ provider, remote: { kind: "unobserved" }, possibleDispatch, ...(status == null ? {} : { acceptedStatus: status }) });
    const binding = SyncOperationRowBindingSchema.parse(copy(own(input, "binding")));
    const decoded = decodeSyncOperationPayload(copy(own(input, "payload")), binding, { supports: supportsGoogleTaskUpdateEnvelope });
    if (decoded.kind !== "pinned-v1") throw new TaskFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase });
    const envelope = decoded.envelope;
    const nativeTarget = copy(own(input, "nativeTarget"));
    const target = { connectionId: identity(own(nativeTarget, "connectionId")), connectionGeneration: identity(own(nativeTarget, "connectionGeneration")),
      taskListId: identity(own(nativeTarget, "taskListId")), taskId: identity(own(nativeTarget, "taskId")) };
    const collectionIdentity = own(input, "collectionIdentity");
    const physicalCollection = collectionIdentity === "native" ? envelope.locator.collectionId :
      collectionIdentity === "musubi-google-task-list" && envelope.locator.collectionId.startsWith("musubi-google-task-list:")
        ? envelope.locator.collectionId.slice("musubi-google-task-list:".length) : null;
    if (operationId !== envelope.operationId || target.taskId !== envelope.locator.resourceId ||
        target.taskListId !== physicalCollection ||
        envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write")
      throw new TaskFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase });
    const plan = parseNativeWritePlanV1(envelope.serializer, "update", "task", envelope.nativePlan.data);
    const targetProjection = projection(envelope.admittedProjection.data);
    if (!plan || plan.planKind !== "json-body" || !plan.body || !sameTask(plan.body, targetProjection) ||
        !matchesPinnedProjectionV1(envelope.serializer, "update", targetProjection, envelope.nativePlan.data)) throw new Error("Invalid task native plan.");
    const policy = copy(inputPolicy);
    if (!["strict-reference", "existing-google"].includes(own(policy, "nativeProfile") as string) ||
        !["saved-patch", "full-target"].includes(own(policy, "readback") as string) ||
        !["deferred", "within-attempt"].includes(own(policy, "ambiguousRecovery") as string)) throw new Error("Invalid task policy.");
    snapshot = copy({ target, projection: targetProjection, acceptedEtag: own(input, "acceptedEtag") ?? null, recovery: required, policy });
  } catch (error) {
    const info = error instanceof TaskFailure ? error.info : { code: "runtime-task-plan-unavailable", outcome: "not-written" as const, phase };
    await host.finish({ status: "hold", error: info, facts });
    return copy({ status: "hold", operationId, attemptId, facts, error: info, trace: [{ decision: "hold", phase }] });
  }
  const attempt = createRuntimeAttempt(signal => host.renew(signal), bounds);
  let saved: GoogleTaskSavedProjection;
  let provider: ReturnType<typeof createGoogleTaskUpdateProvider>;
  const persist = async () => { attempt.guard(); const previous = phase; phase = "evidence";
    try { await host.recordEvidence(copy(facts), attempt.signal); attempt.guard(); } finally { phase = previous; } };
  const checkpoint = async (point: Parameters<NonNullable<GoogleTaskUpdateHostPorts["checkpoint"]>>[0]) => { attempt.guard(); await host.checkpoint?.(point, attempt.signal); attempt.guard(); };
  const observe = (read: GoogleNativeTaskReadEvidence, confirmed: boolean) => {
    const projected = read.kind === "present" ? googleTaskProjectionFromNative(read.task) : null;
    facts = copy({ ...facts, remote: { kind: confirmed ? "confirmed" : "conflict", observationId: identity(host.observationId()), read, projection: projected } });
    trace.push({ decision: confirmed ? "confirmed" : "conflict", phase });
  };
  const achieved = (observed: Readonly<Record<string, unknown>>) => snapshot.policy.readback === "full-target"
    ? sameTask(snapshot.projection, observed) : achievesGoogleTaskPatch(observed, saved.patch);
  const complete = async (read: Extract<GoogleNativeTaskReadEvidence, { kind: "present" }>) => {
    attempt.guard(); observe(read, true); await persist(); await checkpoint("afterReadback"); phase = "ack";
    const result = await host.ack(copy({ kind: "exact-readback", validator: read.etag,
      projection: googleTaskProjectionFromNative(read.task), read, saved, facts }), attempt.signal);
    if (result.kind === "acknowledged") { acknowledged = true; trace.push({ decision: "acknowledged", phase: "ack" }); return; }
    attempt.guard(); throw new TaskFailure({ code: "runtime-ack-authority-changed", outcome: "not-written", phase: "ack" });
  };
  const verify = async () => {
    attempt.guard(); phase = "readback";
    const read = await provider.readForUpdate(snapshot.target, attempt.signal); attempt.guard();
    if (read.kind === "present" && achieved(googleTaskProjectionFromNative(read.task))) { await complete(read); return; }
    observe(read, false); await persist();
    throw new TaskFailure({ code: "task-write-failed", outcome: "unconfirmed", phase: "readback" });
  };
  let terminal: RuntimeTaskFinishOutcome | undefined;
  let currentDispatched = false;
  let acceptedThisAttempt = false;
  try {
    await attempt.run(async () => {
      const prepared = await host.prepare(attempt.signal); attempt.guard();
      const dispatchDescriptor = Object.getOwnPropertyDescriptor(prepared, "dispatchAllowed");
      if (dispatchDescriptor && (!("value" in dispatchDescriptor) || typeof dispatchDescriptor.value !== "boolean")) throw new Error("Invalid task dispatch authority.");
      const dispatchAllowed = dispatchDescriptor ? dispatchDescriptor.value as boolean : true;
      const effectiveEtag = own(prepared, "acceptedEtag");
      const rawBaseline = own(prepared, "baseline");
      const preparedBaseline = rawBaseline == null ? null : baseline(rawBaseline);
      const descriptor = Object.getOwnPropertyDescriptor(prepared, "saved");
      if (descriptor && !("value" in descriptor)) throw new Error("Invalid task saved data.");
      const initialSaved = descriptor && "value" in descriptor && descriptor.value != null ? savedProjection(descriptor.value, snapshot.projection) : undefined;
      if (initialSaved && preparedBaseline && !sameTask(initialSaved.baseline, preparedBaseline)) throw new Error("Invalid task saved baseline.");
      const accountCall = async <T>(call: () => Promise<T>) => {
        attempt.guard(); const previous = phase; phase = "credentials";
        try { const session = await call(); attempt.guard(); await checkpoint("afterCredentials"); return session; }
        catch (error) { throw new TaskFailure(failure(error, "credentials"), error); }
        finally { phase = previous; }
      };
      provider = createGoogleTaskUpdateProvider({ ...transport,
        http: { fetch(url, init) { attempt.guard(); return transport.http.fetch(url, init); } },
        accountSession: { open: (connection, signal) => accountCall(() => host.accountSession.open(connection, signal)),
          ...(host.accountSession.onReadAuthenticationRejected ? { onReadAuthenticationRejected: (signal?: AbortSignal) =>
            accountCall(() => host.accountSession.onReadAuthenticationRejected!(signal)) } : {}),
          ...(host.accountSession.recoverRejectedRead ? { recoverRejectedRead: (connection: Parameters<NonNullable<typeof host.accountSession.recoverRejectedRead>>[0], token: string, signal?: AbortSignal) =>
            accountCall(() => host.accountSession.recoverRejectedRead!(connection, token, signal)) } : {}) },
        async beforeMutation(request, signal) {
          attempt.guard(); await host.beforeMutation(request, signal!); attempt.guard();
          phase = "mutation"; currentDispatched = true; facts = copy({ ...facts, possibleDispatch: true }); trace.push({ decision: "dispatch", phase });
          await checkpoint("beforeDispatch");
        },
        async onAcceptedResponse(receipt, signal) {
          // The native response is known before JSON/tag parsing or a failing
          // persistence callback. It cannot be revoked by later verification.
          acceptedThisAttempt = true;
          facts = copy({ ...facts, possibleDispatch: true, provider: { kind: "accepted", validator: null }, acceptedStatus: receipt.status });
          attempt.guard(); signal?.throwIfAborted(); await persist(); await checkpoint("afterAcceptance");
        },
      }, { nativeProfile: snapshot.policy.nativeProfile });
      phase = snapshot.recovery ? "recovery-read" : "preflight";
      const current = await provider.readForUpdate(snapshot.target, attempt.signal); attempt.guard();
      if (current.kind !== "present") { observe(current, false); throw new TaskFailure({ code: "task-provider-conflict", outcome: "not-written", phase }); }
      const observedProjection = copy(googleTaskProjectionFromNative(current.task));
      const originalBaseline = initialSaved?.baseline ?? preparedBaseline ?? observedProjection;
      saved = savedProjection(await host.prepareProjection(copy({ observedProjection, target: snapshot.projection, baseline: originalBaseline,
        ...(initialSaved ? { saved: initialSaved } : {}) }), attempt.signal), snapshot.projection);
      attempt.guard();
      if (!sameTask(saved.baseline, originalBaseline) || initialSaved && !sameTask(saved.patch, initialSaved.patch)) throw new Error("Invalid task prepared mask.");
      if (snapshot.recovery && achieved(observedProjection)) { await complete(current); return; }
      if (!dispatchAllowed) { observe(current, false); throw new TaskFailure({ code: "task-not-needed", outcome: "not-written", phase }); }
      if (current.etag !== effectiveEtag || !sameTask(saved.baseline, observedProjection)) {
        observe(current, false); throw new TaskFailure({ code: "task-provider-conflict", outcome: "not-written", phase: "preflight" });
      }
      const acceptedEtag = strongGoogleEtag(effectiveEtag);
      if (!acceptedEtag) throw new TaskFailure({ code: "task-version-unavailable", outcome: "not-written", phase: "preflight" });
      const update: GoogleTaskUpdate = copy({ target: snapshot.target, acceptedEtag, body: saved.patch, operationId, attemptId, serializer: { id: "google-task", version: 1 } });
      phase = "preflight"; trace.push({ decision: "preflight", phase });
      await provider.preflightUpdate(update, attempt.signal); attempt.guard();
      if (!Object.keys(saved.patch).length) { await complete(current); return; }
      // update() still opens credentials and performs its final GET. A failure
      // there has not dispatched PATCH; only beforeMutation advances the phase.
      phase = "preflight";
      try {
        const written = await provider.update(update, attempt.signal); attempt.guard();
        if (written.kind !== "written") throw new TaskFailure({ code: "task-write-failed", outcome: "unconfirmed", phase: "mutation" });
        facts = copy({ ...facts, provider: { kind: "accepted", validator: written.etag } }); trace.push({ decision: "accepted", phase: "mutation" });
        await persist();
      } catch (error) {
        let info = failure(error, error instanceof TaskFailure ? error.info.phase : phase);
        if (acceptedThisAttempt && info.outcome === "not-written") info = { ...info, outcome: "unconfirmed" };
        if (currentDispatched && info.outcome === "unconfirmed" && facts.provider.kind !== "accepted")
          facts = copy({ ...facts, provider: { kind: "uncertain" } });
        if (facts.possibleDispatch && info.outcome === "unconfirmed" && snapshot.policy.ambiguousRecovery === "within-attempt") {
          if (facts.provider.kind !== "accepted") facts = copy({ ...facts, provider: { kind: "uncertain" } });
          await persist(); await checkpoint("afterUncertain"); await verify(); return;
        }
        throw new TaskFailure(info, error);
      }
      await verify();
    });
  } catch (error) {
    if (!acknowledged) {
      const info = failure(error, phase);
      if (currentDispatched && info.outcome === "unconfirmed" && facts.provider.kind !== "accepted")
        facts = copy({ ...facts, provider: { kind: "uncertain" } });
      if (currentDispatched && info.phase === "mutation" && info.outcome === "not-written" && info.providerStatus !== undefined && facts.provider.kind !== "accepted" && facts.provider.kind !== "uncertain") facts = copy({ ...facts, provider: rejected(info) });
      else if (facts.possibleDispatch && facts.provider.kind === "not-dispatched") facts = copy({ ...facts, provider: { kind: "uncertain" } });
      const interrupted = attempt.signal.aborted ? failure(attempt.signal.reason, info.phase) : info;
      terminal = { status: interrupted.code === "task-provider-conflict" ? "conflict" : "hold", error: interrupted, facts,
        ...(interrupted.retryAfterMs === undefined ? {} : { retryAfterMs: interrupted.retryAfterMs }), cause: error instanceof TaskFailure ? error.cause : error };
      trace.push({ decision: terminal.status, phase: interrupted.phase });
    }
  } finally { attempt.close(); }
  if (acknowledged) return copy({ status: "acked", operationId, attemptId, facts, trace });
  terminal ??= { status: "hold", error: { code: "task-write-failed", outcome: "not-written", phase }, facts };
  await host.finish({ ...terminal, facts: copy(terminal.facts) });
  if (acknowledged) return copy({ status: "acked", operationId, attemptId, facts, trace });
  return copy({ status: terminal.status, operationId, attemptId, facts: terminal.facts, error: terminal.error, trace });
}
