import { randomUUID } from "node:crypto";
import { runClaimedGoogleTaskCreate, SYNC_RUNTIME_TIMEOUT_MS, SYNC_RUNTIME_HEARTBEAT_MS, SyncRuntimeHostError,
  type GoogleTaskCreatePolicy, type GoogleTaskCreateRuntimeProviderPorts, type RuntimeProviderFact, type RuntimeTaskCreateNativeFacts } from "@musubi/sync-runtime";
import { ReferenceHoldError } from "./model.js";
import { taskIdentity } from "./task-admission.js";
import { REFERENCE_TASK_CREATE_PROFILE } from "./task-create-admission.js";
import type { ReferenceTaskRunnerOptions } from "./task-runner.js";
import type { ReferenceTaskStore } from "./task-store.js";

export const REFERENCE_TASK_CREATE_POLICY: GoogleTaskCreatePolicy = Object.freeze({ nativeProfile: "strict-reference", readback: "full-target", ambiguousRecovery: "within-attempt" });
export type ReferenceTaskCreateRunnerStore = Pick<ReferenceTaskStore, "claimCreate" | "prepareCreate" | "renew" | "getCreateSession" | "markCreateDispatch" | "recordCreateEvidence" | "completeCreate" | "finish">;
async function hostCall<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { if (error instanceof ReferenceHoldError) throw new SyncRuntimeHostError({ code: error.code, outcome: "not-written" }); throw error; }
}
/** One new native task. A sticky possible dispatch never authorizes another POST. */
export async function deliverReferenceTaskCreate(store: ReferenceTaskCreateRunnerStore, operationId: string, ports: GoogleTaskCreateRuntimeProviderPorts, options: ReferenceTaskRunnerOptions = {}) {
  const timeoutMs = options.deadlineMs ?? SYNC_RUNTIME_TIMEOUT_MS, heartbeatMs = options.heartbeatMs ?? SYNC_RUNTIME_HEARTBEAT_MS;
  if (!taskIdentity(operationId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SYNC_RUNTIME_TIMEOUT_MS || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > SYNC_RUNTIME_HEARTBEAT_MS ||
    options.attemptId !== undefined && !taskIdentity(options.attemptId) || options.checkpoint !== undefined && typeof options.checkpoint !== "function" ||
    typeof ports?.http?.fetch !== "function" || typeof ports?.clock?.nowEpochMs !== "function" || typeof ports?.clock?.nowMonotonicMs !== "function" || typeof ports?.telemetry?.record !== "function") throw new TypeError("Invalid reference task CREATE runner options");
  options.signal?.throwIfAborted();
  const attemptId = options.attemptId ?? randomUUID(), claimed = await store.claimCreate(operationId, attemptId, options.signal);
  if (!claimed) return { status: "unclaimed" as const, operationId, attemptId };
  const claim = Object.freeze(structuredClone(claimed));
  if (claim.endpointProfile !== REFERENCE_TASK_CREATE_PROFILE || claim.binding.kind !== "task" || claim.binding.provider !== "google" || claim.binding.action !== "create") {
    await store.finish(claim, "hold", { code: "reference-task-create-profile-unavailable" }); return { status: "hold" as const, operationId, attemptId, code: "reference-task-create-profile-unavailable" };
  }
  const prior = claim.receipt.provider;
  const priorProvider: RuntimeProviderFact = prior.kind === "accepted" ? { kind: "accepted", validator: null } : prior.kind === "rejected" ? { kind: "rejected", error: prior.error } : prior.kind === "uncertain" || claim.recovery ? { kind: "uncertain" } : { kind: "not-dispatched" };
  let recorded: string | undefined;
  const record = async (facts: RuntimeTaskCreateNativeFacts, signal?: AbortSignal, required = true) => {
    const accepted = await hostCall(() => store.recordCreateEvidence(claim, facts, signal));
    if (!accepted && required) throw new SyncRuntimeHostError({ code: "reference-task-create-evidence-authority-changed", outcome: "unconfirmed" });
    if (accepted) recorded = JSON.stringify(facts);
  };
  const result = await runClaimedGoogleTaskCreate({ operationId, attemptId, payload: claim.payload, binding: claim.binding,
    nativeTarget: { connectionId: claim.locator.connectionId, connectionGeneration: String(claim.capture.connectionGeneration), taskListId: claim.locator.taskListId },
    collectionIdentity: "native", recovery: { required: claim.recovery, possibleDispatch: claim.recovery }, priorProvider,
    priorAcceptedStatus: claim.createResponse.acceptedStatus, priorResponseAddress: claim.createResponse.responseAddress,
  }, {
    async prepare(signal) { await options.checkpoint?.("claim"); signal.throwIfAborted(); return hostCall(() => store.prepareCreate(claim, signal)); },
    renew: signal => hostCall(() => store.renew(claim, signal)),
    accountSession: { open: (_connection, signal) => hostCall(() => store.getCreateSession(claim, signal)) },
    async beforeMutation(_request, signal) { if (!await hostCall(() => store.markCreateDispatch(claim, signal))) throw new SyncRuntimeHostError({ code: "reference-task-create-authority-changed", outcome: "not-written" }); },
    recordEvidence: record,
    async ack(evidence, signal) {
      return await hostCall(() => store.completeCreate(claim, { kind: evidence.kind, taskId: evidence.taskId, validator: evidence.validator, projection: evidence.projection, read: evidence.read }, signal)) ? { kind: "acknowledged" } : { kind: "authority-rejected" };
    },
    async finish(outcome) {
      if (JSON.stringify(outcome.facts) !== recorded) await record(outcome.facts, undefined, false);
      const delay = outcome.retryAfterMs, retryAfterMs = delay === undefined ? undefined : delay > Number.MAX_SAFE_INTEGER ? Infinity : Math.ceil(delay);
      await store.finish(claim, outcome.status, { code: outcome.error.code.replace(/^runtime-/, "reference-"), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    },
    observationId: randomUUID,
    checkpoint: phase => options.checkpoint?.(phase),
  }, ports, REFERENCE_TASK_CREATE_POLICY, { signal: options.signal, timeoutMs, heartbeatMs });
  return { status: result.status, operationId, attemptId, ...(result.error ? { code: result.error.code.replace(/^runtime-/, "reference-") } : {}) };
}
