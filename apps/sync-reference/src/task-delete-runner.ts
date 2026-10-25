import { randomUUID } from "node:crypto";
import { runClaimedGoogleTaskDelete, SYNC_RUNTIME_TIMEOUT_MS, SYNC_RUNTIME_HEARTBEAT_MS, SyncRuntimeHostError,
  type GoogleTaskDeletePolicy, type GoogleTaskDeleteRuntimeProviderPorts, type RuntimeProviderFact, type RuntimeTaskDeleteNativeFacts } from "@musubi/sync-runtime";
import { ReferenceHoldError } from "./model.js";
import { taskIdentity } from "./task-admission.js";
import { REFERENCE_TASK_DELETE_PROFILE } from "./task-delete-admission.js";
import type { ReferenceTaskRunnerOptions } from "./task-runner.js";
import type { ReferenceTaskStore } from "./task-store.js";
export const REFERENCE_TASK_DELETE_POLICY: GoogleTaskDeletePolicy = Object.freeze({ nativeProfile: "strict-reference", completion: "exact-absence", ambiguousRecovery: "within-attempt", knownResponseRecovery: "observe-only" });
export type ReferenceTaskDeleteRunnerStore = Pick<ReferenceTaskStore, "claimDelete" | "prepareDelete" | "renew" | "getDeleteSession" | "markDeleteDispatch" | "recordDeleteEvidence" | "completeDelete" | "finish">;
async function hostCall<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { if (error instanceof ReferenceHoldError) throw new SyncRuntimeHostError({ code: error.code, outcome: "not-written" }); throw error; }
}
/** Already-addressed Task DELETE; strict GET absence never fabricates an HTTP response. */
export async function deliverReferenceTaskDelete(store: ReferenceTaskDeleteRunnerStore, operationId: string, ports: GoogleTaskDeleteRuntimeProviderPorts, options: ReferenceTaskRunnerOptions = {}) {
  const timeoutMs = options.deadlineMs ?? SYNC_RUNTIME_TIMEOUT_MS, heartbeatMs = options.heartbeatMs ?? SYNC_RUNTIME_HEARTBEAT_MS;
  if (!taskIdentity(operationId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SYNC_RUNTIME_TIMEOUT_MS || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > SYNC_RUNTIME_HEARTBEAT_MS ||
    options.attemptId !== undefined && !taskIdentity(options.attemptId) || options.checkpoint !== undefined && typeof options.checkpoint !== "function" ||
    typeof ports?.http?.fetch !== "function" || typeof ports?.clock?.nowEpochMs !== "function" || typeof ports?.clock?.nowMonotonicMs !== "function" || typeof ports?.telemetry?.record !== "function") throw new TypeError("Invalid reference task DELETE runner options");
  options.signal?.throwIfAborted(); const attemptId = options.attemptId ?? randomUUID(), claimed = await store.claimDelete(operationId, attemptId);
  if (!claimed) return { status: "unclaimed" as const, operationId, attemptId };
  const claim = Object.freeze(structuredClone(claimed));
  if (claim.endpointProfile !== REFERENCE_TASK_DELETE_PROFILE || claim.binding.kind !== "task" || claim.binding.provider !== "google" || claim.binding.action !== "delete") {
    await store.finish(claim, "hold", { code: "reference-task-delete-profile-unavailable" }); return { status: "hold" as const, operationId, attemptId, code: "reference-task-delete-profile-unavailable" };
  }
  const prior = claim.receipt.provider;
  const priorProvider: RuntimeProviderFact = prior.kind === "accepted" ? { kind: "accepted", validator: null } : prior.kind === "rejected" ? { kind: "rejected", error: prior.error } : prior.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: RuntimeTaskDeleteNativeFacts, signal?: AbortSignal, required = true) => {
    const accepted = await hostCall(() => store.recordDeleteEvidence(claim, facts, signal));
    if (!accepted && required) throw new SyncRuntimeHostError({ code: "reference-task-delete-evidence-authority-changed", outcome: "unconfirmed" }); if (accepted) recorded = JSON.stringify(facts);
  };
  const result = await runClaimedGoogleTaskDelete({ operationId, attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration), taskListId: claim.locator.taskListId, taskId: claim.locator.taskId },
    collectionIdentity: "native", acceptedEtag: claim.acceptedEtag, recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
    priorAcceptedStatus: claim.deleteResponse.acceptedStatus, priorResponseAbsenceStatus: claim.deleteResponse.responseAbsenceStatus,
  }, {
    async prepare(signal) { await options.checkpoint?.("claim"); signal.throwIfAborted(); return hostCall(() => store.prepareDelete(claim, signal)); },
    renew: signal => hostCall(() => store.renew(claim, signal)),
    accountSession: { open: (_connection, signal) => hostCall(() => store.getDeleteSession(claim, signal)) },
    async beforeMutation(_request, signal) { if (!await hostCall(() => store.markDeleteDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "reference-task-delete-authority-changed", outcome: "not-written" }); },
    recordEvidence: record,
    async ack(evidence, signal) {
      if (evidence.kind !== "exact-absence") throw new SyncRuntimeHostError({ code: "reference-task-delete-exact-absence-required", outcome: "not-written" });
      return await hostCall(() => store.completeDelete(claim, { kind: "exact-absence", source: evidence.source, read: evidence.read }, signal)) ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      if (JSON.stringify(outcome.facts) !== recorded) await record(outcome.facts, undefined, false);
      const delay = outcome.retryAfterMs, retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: outcome.error.code.replace(/^runtime-/, "reference-"), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID,
    checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_TASK_DELETE_POLICY, { signal: options.signal, timeoutMs, heartbeatMs });
  return { status: result.status, operationId, attemptId, ...(result.error ? { code: result.error.code.replace(/^runtime-/, "reference-") } : {}) };
}
