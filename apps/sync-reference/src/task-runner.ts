import { randomUUID } from "node:crypto";
import { runClaimedGoogleTaskUpdate, SYNC_RUNTIME_TIMEOUT_MS, SYNC_RUNTIME_HEARTBEAT_MS, SyncRuntimeHostError,
  type GoogleTaskUpdatePolicy, type GoogleTaskRuntimeProviderPorts, type RuntimeProviderFact, type RuntimeTaskNativeFacts, type RuntimeCheckpoint } from "@musubi/sync-runtime";
import { jsonEqual } from "./admission.js";
import { ReferenceHoldError } from "./model.js";
import { REFERENCE_TASK_UPDATE_PROFILE, taskIdentity } from "./task-admission.js";
import type { ReferenceTaskStore } from "./task-store.js";
export const REFERENCE_TASK_UPDATE_POLICY: GoogleTaskUpdatePolicy = Object.freeze({ nativeProfile: "strict-reference", readback: "full-target", ambiguousRecovery: "within-attempt" });
export type ReferenceTaskRunnerStore = Pick<ReferenceTaskStore, "claim" | "prepare" | "renew" | "getSession" | "markDispatch" | "recordEvidence" | "completeUpdate" | "finish">;
export interface ReferenceTaskRunnerOptions {
  signal?: AbortSignal; attemptId?: string; deadlineMs?: number; heartbeatMs?: number;
  checkpoint?(phase: RuntimeCheckpoint | "claim"): void | Promise<void>;
}
async function hostCall<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof ReferenceHoldError) throw new SyncRuntimeHostError({ code: error.code, outcome: "not-written" }); throw error;
  }
}
/** One already-claimed Task attempt; no event fallback, alternate queue or HTTP in SQL. */
export async function deliverReferenceTaskUpdate(store: ReferenceTaskRunnerStore, operationId: string, ports: GoogleTaskRuntimeProviderPorts, options: ReferenceTaskRunnerOptions = {}) {
  const deadlineMs = options.deadlineMs ?? SYNC_RUNTIME_TIMEOUT_MS, heartbeatMs = options.heartbeatMs ?? SYNC_RUNTIME_HEARTBEAT_MS;
  if (!taskIdentity(operationId) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > SYNC_RUNTIME_TIMEOUT_MS ||
    !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > SYNC_RUNTIME_HEARTBEAT_MS || options.attemptId !== undefined && !taskIdentity(options.attemptId) ||
    options.checkpoint !== undefined && typeof options.checkpoint !== "function" || typeof ports?.http?.fetch !== "function" ||
    typeof ports?.clock?.nowEpochMs !== "function" || typeof ports?.clock?.nowMonotonicMs !== "function" || typeof ports?.telemetry?.record !== "function") throw new TypeError("Invalid reference task runner options");
  options.signal?.throwIfAborted();
  const attemptId = options.attemptId ?? randomUUID(), claimed = await store.claim(operationId, attemptId, options.signal);
  if (!claimed) return { status: "unclaimed" as const, operationId, attemptId };
  const claim = Object.freeze(structuredClone(claimed));
  if (claim.endpointProfile !== REFERENCE_TASK_UPDATE_PROFILE || claim.binding.kind !== "task" || claim.binding.provider !== "google" || claim.binding.action !== "update") {
    await store.finish(claim, "hold", { code: "reference-task-profile-unavailable" });
    return { status: "hold" as const, operationId, attemptId, code: "reference-task-profile-unavailable" };
  }
  const prior = claim.receipt.provider;
  const priorProvider: RuntimeProviderFact = prior.kind === "accepted" ? { kind: "accepted", validator: prior.validator?.kind === "etag" ? prior.validator.value : null } :
    prior.kind === "rejected" ? { kind: "rejected", error: prior.error } : prior.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: RuntimeTaskNativeFacts, signal?: AbortSignal, required = true) => {
    const accepted = await hostCall(() => store.recordEvidence(claim, facts, signal));
    if (!accepted && required) throw new SyncRuntimeHostError({ code: "reference-task-evidence-authority-changed", outcome: "unconfirmed" });
    if (accepted) recorded = JSON.stringify(facts);
  };
  const result = await runClaimedGoogleTaskUpdate({ operationId, attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration), taskListId: claim.locator.taskListId, taskId: claim.locator.taskId },
    collectionIdentity: "native", acceptedEtag: claim.acceptedEtag, recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider, priorAcceptedStatus: claim.acceptedStatus,
  }, {
    async prepare(signal) { await options.checkpoint?.("claim"); signal.throwIfAborted(); return hostCall(() => store.prepare(claim, signal)); },
    async prepareProjection(input, signal) {
      const prepared = await hostCall(() => store.prepare(claim, signal));
      if (!jsonEqual(input.target, prepared.saved.projection) || !jsonEqual(input.baseline, prepared.saved.baseline) || input.saved && !jsonEqual(input.saved, prepared.saved))
        throw new SyncRuntimeHostError({ code: "reference-task-saved-projection-changed", outcome: "not-written" });
      return prepared.saved;
    },
    renew: signal => hostCall(() => store.renew(claim, signal)),
    accountSession: { open: (_connection, signal) => hostCall(() => store.getSession(claim, signal)) },
    async beforeMutation(_request, signal) { if (!await hostCall(() => store.markDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "reference-task-authority-changed", outcome: "not-written" }); },
    recordEvidence: record,
    async ack(evidence, signal) {
      return await hostCall(() => store.completeUpdate(claim, { validator: evidence.validator, projection: evidence.projection, read: evidence.read, saved: evidence.saved }, signal))
        ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      if (JSON.stringify(outcome.facts) !== recorded) await record(outcome.facts, undefined, false);
      const delay = outcome.retryAfterMs, retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: outcome.error.code.replace(/^runtime-/, "reference-"), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID,
    checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_TASK_UPDATE_POLICY, { signal: options.signal, timeoutMs: deadlineMs, heartbeatMs });
  return { status: result.status, operationId, attemptId, ...(result.error ? { code: result.error.code.replace(/^runtime-/, "reference-") } : {}) };
}
