import {
  createGoogleTaskDeleteProvider, GoogleTaskProviderError, strongGoogleEtag, isGoogleTaskDeleteAcceptedStatus,
  googleTaskProjectionFromNative, type GoogleTaskDelete, type GoogleNativeTaskDeleteReadEvidence,
} from "@musubi/provider-google";
import { decodeSyncOperationPayload, SyncOperationRowBindingSchema, SyncErrorSchema, type SyncOperationEnvelope } from "@musubi/types";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { createRuntimeAttempt, SyncRuntimeInterrupted, validateRuntimeAttemptOptions } from "./attempt";
import { SyncRuntimeHostError, type RuntimeErrorInfo, type RuntimeProviderFact, type RuntimePhase, type RuntimeTraceEntry } from "./ports";
import { own, copy, identity, projection, baseline, savedProjection, sameTask } from "./task-data";
import type { ClaimedGoogleTaskDelete, GoogleTaskDeleteHostPorts, GoogleTaskDeletePolicy, GoogleTaskDeleteRuntimeProviderPorts,
  RuntimeTaskDeleteNativeFacts, RuntimeTaskDeleteRunResult, RuntimeTaskDeleteCompletionEvidence, RuntimeTaskDeleteFinishOutcome,
  RuntimeTaskDeleteAbsenceSource, RuntimeAttemptOptions } from "./google-task-delete-ports";

/** Nominal selection is separate from complete validation. Deferred addresses
 * and genuine legacy/unsupported families retain their existing executor. */
export function supportsGoogleTaskDeleteEnvelope(envelope: SyncOperationEnvelope): boolean {
  return envelope.operation.kind === "task" && envelope.operation.action === "delete" && envelope.locator.provider === "google" &&
    typeof envelope.locator.resourceId === "string" && envelope.locator.resourceId.length > 0 && envelope.serializer.id === "google-task" && envelope.serializer.version === 1;
}
class DeleteFailure extends Error {
  constructor(readonly info: RuntimeErrorInfo, readonly cause?: unknown) { super(info.code); }
}
function failure(error: unknown, phase: RuntimePhase): RuntimeErrorInfo {
  if (error instanceof DeleteFailure) return error.info;
  if (error instanceof SyncRuntimeInterrupted) return { code: "runtime-attempt-aborted", outcome: "unconfirmed", phase,
    interruption: error.reason === "finished" ? "cancelled" : error.reason };
  if (error instanceof GoogleTaskProviderError || error instanceof SyncRuntimeHostError) {
    const item = error instanceof SyncRuntimeHostError ? error.info : error;
    if (/^[a-z][a-z0-9-]{0,127}$/.test(item.code) && (item.outcome === "not-written" || item.outcome === "unconfirmed")) return {
      code: item.code, outcome: item.outcome, phase,
      ...(Number.isInteger(item.providerStatus) && item.providerStatus! >= 100 && item.providerStatus! <= 599 ? { providerStatus: item.providerStatus } : {}),
      ...(typeof item.retryAfterMs === "number" && item.retryAfterMs >= 0 ? { retryAfterMs: item.retryAfterMs } : {}),
    };
  }
  return { code: "task-write-failed", outcome: phase === "mutation" ? "unconfirmed" : "not-written", phase };
}
function rejected(info: RuntimeErrorInfo): RuntimeProviderFact {
  if (info.providerStatus === 412) return { kind: "rejected", error: { code: "conflict", retry: "never" } };
  if (info.providerStatus === 401 || info.providerStatus === 403) return { kind: "rejected", error: { code: "permission-denied", retry: "after-reconnect" } };
  if (info.providerStatus === 429) return { kind: "rejected", error: { code: "rate-limited", retry: "after-delay",
    ...(info.retryAfterMs !== undefined && info.retryAfterMs <= Number.MAX_SAFE_INTEGER ? { retryAfterMs: Math.ceil(info.retryAfterMs) } : {}) } };
  if (info.providerStatus === 408) return { kind: "rejected", error: { code: "transport-failed", retry: "after-delay",
    ...(info.retryAfterMs !== undefined && info.retryAfterMs <= Number.MAX_SAFE_INTEGER ? { retryAfterMs: Math.ceil(info.retryAfterMs) } : {}) } };
  return { kind: "rejected", error: { code: "transport-failed", retry: "never" } };
}
function optional(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Error("Invalid task DELETE data.");
  return descriptor?.value;
}

/** One claimed Task DELETE, with no DB/auth/config imports and no second worker.
 * API response completion and reference observed-absence completion are distinct. */
export async function runClaimedGoogleTaskDelete(input: ClaimedGoogleTaskDelete, host: GoogleTaskDeleteHostPorts,
  transport: GoogleTaskDeleteRuntimeProviderPorts, inputPolicy: GoogleTaskDeletePolicy, options: RuntimeAttemptOptions = {}): Promise<RuntimeTaskDeleteRunResult> {
  const bounds = validateRuntimeAttemptOptions(options);
  let operationId = "invalid-operation", attemptId = "invalid-attempt", phase: RuntimePhase = "decode", acknowledged = false;
  let facts: RuntimeTaskDeleteNativeFacts = { provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, possibleDispatch: false };
  const trace: RuntimeTraceEntry[] = [];
  let snapshot: { target: ClaimedGoogleTaskDelete["nativeTarget"]; projection: ReturnType<typeof projection>; recovery: boolean;
    policy: GoogleTaskDeletePolicy; knownResponse: boolean };
  try {
    operationId = identity(own(input, "operationId")); attemptId = identity(own(input, "attemptId"));
    const recovery = copy(own(input, "recovery")), required = own(recovery, "required"), possible = own(recovery, "possibleDispatch");
    if (typeof required !== "boolean" || typeof possible !== "boolean" || required && !possible) throw new Error("Invalid task recovery.");
    const prior = copy(own(input, "priorProvider")), kind = own(prior, "kind");
    if (kind !== "not-dispatched" && (!required || !possible)) throw new Error("Invalid prior dispatch.");
    let provider: RuntimeProviderFact;
    if (kind === "not-dispatched" || kind === "uncertain") provider = { kind };
    else if (kind === "accepted" && own(prior, "validator") === null) provider = { kind, validator: null };
    else if (kind === "rejected") provider = { kind, error: SyncErrorSchema.parse(own(prior, "error")) };
    else throw new Error("Invalid prior task DELETE response.");
    const accepted = optional(input, "priorAcceptedStatus"), absent = optional(input, "priorResponseAbsenceStatus");
    if (accepted != null && !isGoogleTaskDeleteAcceptedStatus(accepted) || absent != null && absent !== 404 && absent !== 410 ||
        (accepted != null || absent != null) && kind !== "accepted" || kind === "accepted" && accepted == null && absent == null) throw new Error("Invalid task DELETE sidecars.");
    facts = copy({ provider, remote: { kind: "unobserved" }, possibleDispatch: possible,
      ...(accepted == null ? {} : { acceptedStatus: accepted }), ...(absent == null ? {} : { responseAbsenceStatus: absent }) }) as RuntimeTaskDeleteNativeFacts;
    const binding = SyncOperationRowBindingSchema.parse(copy(own(input, "binding")));
    const decoded = decodeSyncOperationPayload(copy(own(input, "payload")), binding, { supports: supportsGoogleTaskDeleteEnvelope });
    if (decoded.kind !== "pinned-v1") throw new DeleteFailure({ code: decoded.kind === "blocked" ? decoded.code : "runtime-legacy-unsupported", outcome: "not-written", phase });
    const envelope = decoded.envelope, targetData = copy(own(input, "nativeTarget"));
    const target = { connectionId: identity(own(targetData, "connectionId")), connectionGeneration: identity(own(targetData, "connectionGeneration")),
      taskListId: identity(own(targetData, "taskListId")), taskId: identity(own(targetData, "taskId")) };
    const mode = own(input, "collectionIdentity"), collection = mode === "native" ? envelope.locator.collectionId :
      mode === "musubi-google-task-list" && envelope.locator.collectionId.startsWith("musubi-google-task-list:") ? envelope.locator.collectionId.slice("musubi-google-task-list:".length) : null;
    if (envelope.operationId !== operationId || target.taskId !== envelope.locator.resourceId || target.taskListId !== collection ||
        envelope.allowedSideEffects.length !== 1 || envelope.allowedSideEffects[0] !== "provider-content-write") throw new DeleteFailure({ code: "operation-envelope-binding-mismatch", outcome: "not-written", phase });
    const plan = parseNativeWritePlanV1(envelope.serializer, "delete", "task", envelope.nativePlan.data), targetProjection = projection(envelope.admittedProjection.data);
    if (!plan || plan.planKind !== "json-body" || plan.body !== null || !matchesPinnedProjectionV1(envelope.serializer, "delete", targetProjection, envelope.nativePlan.data)) throw new Error("Invalid DELETE plan.");
    const policy = copy(inputPolicy);
    if (!["provider-response", "exact-absence"].includes(own(policy, "completion") as string) || !["deferred", "within-attempt"].includes(own(policy, "ambiguousRecovery") as string) ||
        !["existing-google", "strict-reference"].includes(own(policy, "nativeProfile") as string) || !["conditional-retry", "observe-only"].includes(own(policy, "knownResponseRecovery") as string)) throw new Error("Invalid task DELETE policy.");
    snapshot = copy({ target, projection: targetProjection, recovery: required, policy, knownResponse: accepted != null || absent != null });
  } catch (error) {
    const info = error instanceof DeleteFailure ? error.info : { code: "runtime-task-plan-unavailable", outcome: "not-written" as const, phase };
    await host.finish({ status: "hold", error: info, facts }); return copy({ status: "hold", operationId, attemptId, facts, error: info, trace: [{ decision: "hold", phase }] });
  }
  const attempt = createRuntimeAttempt(signal => host.renew(signal), bounds);
  let provider: ReturnType<typeof createGoogleTaskDeleteProvider>, dispatched = false, responseSeen = false;
  const checkpoint = async (point: Parameters<NonNullable<GoogleTaskDeleteHostPorts["checkpoint"]>>[0]) => { attempt.guard(); await host.checkpoint?.(point, attempt.signal); attempt.guard(); };
  const persist = async () => { attempt.guard(); const previous = phase; phase = "evidence";
    try { await host.recordEvidence(copy(facts), attempt.signal); attempt.guard(); } finally { phase = previous; } };
  const observe = (read: GoogleNativeTaskDeleteReadEvidence, source: RuntimeTaskDeleteAbsenceSource = "initial-read") => {
    facts = copy({ ...facts, remote: { kind: read.kind === "absent" ? "absent" : "conflict", ...(read.kind === "absent" ? { source } : {}), read, observationId: identity(host.observationId()) } }) as RuntimeTaskDeleteNativeFacts;
    trace.push({ decision: read.kind === "absent" ? "confirmed" : "conflict", phase });
  };
  const complete = async (evidence: RuntimeTaskDeleteCompletionEvidence) => {
    attempt.guard(); phase = "ack"; const result = await host.ack(copy(evidence), attempt.signal);
    if (result.kind === "acknowledged") {
      acknowledged = true; trace.push({ decision: "acknowledged", phase });
      if (!attempt.signal.aborted) { try { await checkpoint("afterAck"); } catch { /* Committed truth wins diagnostics/cancellation. */ } }
      return;
    }
    attempt.guard(); throw new DeleteFailure({ code: "runtime-ack-authority-changed", outcome: "not-written", phase });
  };
  const completeAbsence = async (read: Extract<GoogleNativeTaskDeleteReadEvidence, { kind: "absent" }>, source: RuntimeTaskDeleteAbsenceSource) => {
    observe(read, source); await persist(); await checkpoint("afterReadback"); await complete({ kind: "exact-absence", source, read, facts });
  };
  const verify = async () => {
    attempt.guard(); phase = "readback"; const read = await provider.readForDelete(snapshot.target, attempt.signal); attempt.guard();
    if (read.kind === "absent") { await completeAbsence(read, "readback"); return; }
    observe(read); await persist(); throw new DeleteFailure({ code: "task-write-failed", outcome: "unconfirmed", phase });
  };
  let terminal: RuntimeTaskDeleteFinishOutcome | undefined;
  try {
    await attempt.run(async () => {
      const prepared = await host.prepare(attempt.signal); attempt.guard();
      const effectiveEtag = own(prepared, "acceptedEtag"), rawBaseline = own(prepared, "baseline"), preparedBaseline = rawBaseline == null ? null : baseline(rawBaseline);
      const rawSaved = optional(prepared, "saved"), initialSaved = rawSaved == null ? undefined : savedProjection(rawSaved, snapshot.projection);
      const dispatchAllowed = optional(prepared, "dispatchAllowed");
      if (dispatchAllowed !== undefined && typeof dispatchAllowed !== "boolean" || initialSaved && preparedBaseline && !sameTask(initialSaved.baseline, preparedBaseline)) throw new Error("Invalid task preparation.");
      const accountCall = async <T>(call: () => Promise<T>) => {
        attempt.guard(); const previous = phase; phase = "credentials";
        try { const session = await call(); attempt.guard(); await checkpoint("afterCredentials"); return session; }
        catch (error) { throw new DeleteFailure(failure(error, "credentials"), error); } finally { phase = previous; }
      };
      provider = createGoogleTaskDeleteProvider({ ...transport,
        http: { fetch(url, init) { attempt.guard(); return transport.http.fetch(url, init); } },
        accountSession: { open: (connection, signal) => accountCall(() => host.accountSession.open(connection, signal)),
          ...(host.accountSession.recoverRejectedRead ? { recoverRejectedRead: (connection: Parameters<NonNullable<typeof host.accountSession.recoverRejectedRead>>[0], token: string, signal?: AbortSignal) => accountCall(() => host.accountSession.recoverRejectedRead!(connection, token, signal)) } : {}),
          ...(host.accountSession.onReadAuthenticationRejected ? { onReadAuthenticationRejected: (signal?: AbortSignal) => accountCall(() => host.accountSession.onReadAuthenticationRejected!(signal)) } : {}) },
        async beforeMutation(request, signal) {
          attempt.guard(); await host.beforeMutation(request, signal!); attempt.guard(); phase = "mutation"; dispatched = true;
          facts = copy({ ...facts, possibleDispatch: true }); trace.push({ decision: "dispatch", phase }); await checkpoint("beforeDispatch");
        },
        async onDeleteResponse(response, signal) {
          responseSeen = true;
          facts = copy({ ...facts, possibleDispatch: true, provider: { kind: "accepted", validator: null },
            ...(response.kind === "accepted" ? { acceptedStatus: response.status } : { responseAbsenceStatus: response.status }) });
          attempt.guard(); signal?.throwIfAborted(); await persist(); await checkpoint("afterAcceptance");
        },
      }, { nativeProfile: snapshot.policy.nativeProfile });
      phase = snapshot.recovery ? "recovery-read" : "preflight";
      const current = await provider.readForDelete(snapshot.target, attempt.signal); attempt.guard();
      if (current.kind === "absent") { await completeAbsence(current, "initial-read"); return; }
      if (snapshot.recovery && snapshot.knownResponse && snapshot.policy.knownResponseRecovery === "observe-only") {
        observe(current); throw new DeleteFailure({ code: "task-write-failed", outcome: "unconfirmed", phase });
      }
      const observed = copy(googleTaskProjectionFromNative(current.task)), originalBaseline = initialSaved?.baseline ?? preparedBaseline ?? observed;
      if (host.prepareProjection) {
        const saved = savedProjection(await host.prepareProjection(copy({ observedProjection: observed, target: snapshot.projection, baseline: originalBaseline,
          ...(initialSaved ? { saved: initialSaved } : {}) }), attempt.signal), snapshot.projection); attempt.guard();
        if (!sameTask(saved.baseline, originalBaseline) || initialSaved && !sameTask(saved.patch, initialSaved.patch)) throw new Error("Invalid DELETE preparation.");
      }
      if (dispatchAllowed === false) { observe(current); throw new DeleteFailure({ code: "task-not-needed", outcome: "not-written", phase }); }
      if (current.etag !== effectiveEtag || !sameTask(originalBaseline, observed)) {
        observe(current); throw new DeleteFailure({ code: "task-provider-conflict", outcome: "not-written", phase: "preflight" });
      }
      const acceptedEtag = strongGoogleEtag(effectiveEtag);
      if (!acceptedEtag) throw new DeleteFailure({ code: "task-version-unavailable", outcome: "not-written", phase: "preflight" });
      const request: GoogleTaskDelete = copy({ target: snapshot.target, acceptedEtag, operationId, attemptId, serializer: { id: "google-task", version: 1 } });
      phase = "preflight"; trace.push({ decision: "preflight", phase });
      await provider.preflightDelete(request, attempt.signal); attempt.guard();
      // A permission-read absence still proceeds to the writer-final GET.
      let result: Awaited<ReturnType<typeof provider.delete>>;
      try {
        result = await provider.delete(request, attempt.signal);
        facts = copy({ ...facts, writerResult: result });
        attempt.guard();
      } catch (error) {
        let info = failure(error, phase);
        if (responseSeen && info.outcome === "not-written") info = { ...info, outcome: "unconfirmed" };
        if (dispatched && info.outcome === "unconfirmed" && facts.provider.kind !== "accepted") facts = copy({ ...facts, provider: { kind: "uncertain" } });
        if (facts.possibleDispatch && info.outcome === "unconfirmed" && snapshot.policy.ambiguousRecovery === "within-attempt") {
          await persist(); await checkpoint("afterUncertain"); await verify(); return;
        }
        throw new DeleteFailure(info, error);
      }
      if (result.kind === "absent" && result.source === "writer-read") { await completeAbsence({ kind: "absent", status: result.status }, "writer-read"); return; }
      if (snapshot.policy.completion === "provider-response") {
        await complete({ kind: "provider-response", response: result.kind === "deleted" ? { kind: "accepted", status: result.status } : { kind: "absent", status: result.status }, facts }); return;
      }
      await verify();
    });
  } catch (error) {
    if (!acknowledged) {
      let info = failure(error, phase);
      if (dispatched && info.outcome === "unconfirmed" && facts.provider.kind !== "accepted") facts = copy({ ...facts, provider: { kind: "uncertain" } });
      if (dispatched && info.phase === "mutation" && info.outcome === "not-written" && info.providerStatus !== undefined && facts.provider.kind !== "accepted" && facts.provider.kind !== "uncertain") facts = copy({ ...facts, provider: rejected(info) });
      if (attempt.signal.aborted) info = { ...failure(attempt.signal.reason, info.phase), outcome: facts.possibleDispatch ? "unconfirmed" : "not-written" };
      terminal = { status: info.code === "task-provider-conflict" ? "conflict" : "hold", error: info, facts,
        ...(info.retryAfterMs === undefined ? {} : { retryAfterMs: info.retryAfterMs }), cause: error instanceof DeleteFailure ? error.cause : error };
      trace.push({ decision: terminal.status, phase: info.phase });
    }
  } finally { attempt.close(); }
  if (acknowledged) return copy({ status: "acked", operationId, attemptId, facts, trace });
  terminal ??= { status: "hold", error: { code: "task-write-failed", outcome: "not-written", phase }, facts };
  await host.finish({ ...terminal, facts: copy(terminal.facts) });
  if (acknowledged) return copy({ status: "acked", operationId, attemptId, facts, trace });
  return copy({ status: terminal.status, operationId, attemptId, facts: terminal.facts, error: terminal.error, trace });
}
