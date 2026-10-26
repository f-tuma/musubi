import { randomUUID } from "node:crypto";
import { assertPinnedOutboxSource, assertTaskOutboxDeliverySource, getTaskOutboxPredecessorEvidence, setTaskOutboxProjection,
  renewTaskOutboxLease, acceptTaskOutboxDelivery, finishTaskOutbox, getTaskOutbox, prepareTaskOutboxPredecessorResolution,
  assertTaskOutboxPredecessorResolution, setTaskOutboxCausalProjection, TaskOutboxPredecessorError, type TaskOutboxRow } from "@musubi/db";
import { TaskSchema, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import { diffGoogleTaskProjection, type GoogleTaskProjection, type GoogleTaskUpdateBody } from "@musubi/provider-google";
import { runClaimedGoogleTaskDelete, supportsGoogleTaskDeleteEnvelope, SyncRuntimeHostError,
  type GoogleTaskDeletePolicy, type RuntimeTaskDeleteNativeFacts, type RuntimeTaskDeleteFinishOutcome, type RuntimeAttemptOptions,
  type GoogleTaskPredecessorResolution } from "@musubi/sync-runtime";
import type { CalendarAdapter, ExternalTaskRef, GoogleTaskDeleteV1Bridge } from "./adapter";
import { deliveryNextAttemptAt } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";

const MUSUBI_TASK_DELETE_POLICY: GoogleTaskDeletePolicy = Object.freeze({ nativeProfile: "existing-google", completion: "provider-response",
  ambiguousRecovery: "deferred", knownResponseRecovery: "conditional-retry" });
const taskError = (code: string) => new SyncRuntimeHostError({ code, outcome: "not-written" });
export function usesSharedGoogleTaskDelete(envelope: SyncOperationEnvelope, adapter: CalendarAdapter | null): boolean {
  return typeof adapter?.googleTaskDeleteV1 === "function" && supportsGoogleTaskDeleteEnvelope(envelope);
}

/** The existing claim and hardened DELETE ACK retain home/secondary authority.
 * A successful native response does not fabricate a GET absence observation. */
export async function deliverSharedGoogleTaskDelete(row: TaskOutboxRow & { reconciling: boolean }, _envelope: SyncOperationEnvelope,
  factory: NonNullable<CalendarAdapter["googleTaskDeleteV1"]>, options: RuntimeAttemptOptions = {}) {
  const token = row.leaseToken!, capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
  let bridge: GoogleTaskDeleteV1Bridge | undefined;
  const native = () => bridge ??= factory(row.userID, row.accountID, capture);
  let expectedRef: Readonly<{ externalTaskId: string | null; etag: string | null; icalUid: string | null }> | undefined;
  let resultRef: ExternalTaskRef | null = row.resultRef, persisted = row.payload.dispatchProjection;
  let predecessorAddress: GoogleTaskPredecessorResolution | undefined;
  // Existing executor sets mutationAccepted when pushTaskDelete returns even
  // if its final GET found absence. Preserve that coarse host settlement flag
  // separately from the kernel's truthful no-dispatch/native response facts.
  let deleteReturned = false;
  const admitted = async (allowDeleted: boolean, signal: AbortSignal) => {
    signal.throwIfAborted(); const allowed = await assertTaskOutboxDeliverySource(row, allowDeleted) && await assertPinnedOutboxSource(row, allowDeleted);
    signal.throwIfAborted(); return allowed;
  };
  const record = (facts: RuntimeTaskDeleteNativeFacts) => {
    if (facts.writerResult || facts.provider.kind === "accepted" || facts.remote.kind === "absent" && facts.remote.source === "writer-read") deleteReturned = true;
  };
  const finish = async (outcome: RuntimeTaskDeleteFinishOutcome) => {
    record(outcome.facts); const info = outcome.error;
    if (info.code === "task-not-needed") {
      const observed = outcome.facts.remote.kind === "conflict" ? native().normalizeObservation(outcome.facts.remote.read) : null;
      await finishTaskOutbox(row.id, token, "not-needed", null, { uncertain: false,
        ...(observed ? { resultRef: observed.ref, remoteSnapshot: observed.projection } : {}) }); return;
    }
    const code = info.code === "runtime-ack-authority-changed" || info.code === "runtime-attempt-aborted" ? "task-write-failed" :
      info.code === "account-session-changed" ? "task-source-read-only" : info.code.startsWith("operation-") || info.code === "runtime-task-plan-unavailable" ? "task-projection-unavailable" :
      ["task-provider-conflict", "task-version-unavailable", "task-write-failed", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported",
        "task-source-read-only", "task-create-unconfirmed", "task-projection-unavailable", "task-source-changed"].includes(info.code) ? info.code : "task-write-failed";
    const blocked = ["task-source-read-only", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-projection-unavailable", "task-source-changed"].includes(code);
    const retryableStatus = info.providerStatus === 429 || info.providerStatus === 408 || (info.providerStatus ?? 0) >= 500;
    const resourceAuthFailure = info.providerStatus === 401 && !outcome.facts.possibleDispatch;
    const definite = !retryableStatus && !resourceAuthFailure && (info.providerStatus != null && info.providerStatus < 500 || blocked || code === "task-provider-conflict");
    const definiteRejection = !deleteReturned && info.outcome === "not-written" && info.providerStatus != null && info.providerStatus < 500;
    const uncertain = row.reconciling || deleteReturned || outcome.facts.possibleDispatch && !definiteRejection;
    await finishTaskOutbox(row.id, token, uncertain ? "unconfirmed" : code === "task-provider-conflict" ? "conflict" : blocked ? "blocked" : definite ? "not-written" : "retry", code,
      { uncertain, resultRef: resultRef ?? row.resultRef, nextAttemptAt: deliveryNextAttemptAt(row.attempts, info.retryAfterMs) });
  };
  await withProviderCallMetrics(row.provider, "task", () => runClaimedGoogleTaskDelete({
    operationId: row.id, attemptId: token, payload: row.payload,
    binding: { kind: "task", action: "delete", operationId: row.id, commandId: row.mutationID, hostObjectId: row.taskID,
      provider: row.provider, connectionId: row.accountID, collectionId: row.externalCalendarID, resourceId: row.externalTaskID,
      acceptedRevision: row.revision, predecessorOperationId: row.predecessorID, sourceEpoch: { sourceId: capture.sourceId, generation: capture.writeGeneration }, privacyEpoch: capture.privacyEpoch },
    nativeTarget: { connectionId: capture.connectionId, connectionGeneration: String(capture.connectionGeneration), taskListId: row.externalCalendarID.slice("musubi-google-task-list:".length), taskId: row.externalTaskID! },
    collectionIdentity: "musubi-google-task-list", acceptedEtag: row.expectedEtag,
    recovery: { required: row.reconciling, possibleDispatch: row.reconciling }, priorProvider: row.reconciling ? { kind: "uncertain" } : { kind: "not-dispatched" },
  }, {
    async prepare(signal) {
      if (!await admitted(true, signal)) throw taskError("task-source-changed");
      const canDispatch = await admitted(false, signal);
      if (!canDispatch && !row.reconciling) throw taskError("task-not-needed");
      TaskSchema.parse(row.payload.task); // Preserve the existing host-payload validation before any native read.
      if (row.externalTaskID === null) {
        try {
          const prepared = await prepareTaskOutboxPredecessorResolution(row, token, signal);
          predecessorAddress = prepared.predecessorAddress;
          expectedRef = Object.freeze(prepared.expectedRef ?? { externalTaskId: null, etag: null, icalUid: null });
          persisted = prepared.saved;
          return { acceptedEtag: predecessorAddress.kind === "predecessor-task-reference" ? predecessorAddress.validator : null,
            baseline: prepared.projectionBaseline, dispatchAllowed: canDispatch, predecessorAddress,
            ...(persisted ? { saved: { projection: persisted.projection, baseline: persisted.baseline, patch: persisted.patch } } : {}) };
        } catch (error) { if (error instanceof TaskOutboxPredecessorError) throw taskError("task-projection-unavailable"); throw error; }
      }
      const predecessor = await getTaskOutboxPredecessorEvidence(row); signal.throwIfAborted();
      expectedRef = Object.freeze({ externalTaskId: predecessor.ref.externalTaskId ?? null, etag: predecessor.ref.etag ?? null, icalUid: predecessor.ref.icalUid ?? null });
      if (expectedRef.externalTaskId !== row.externalTaskID) throw taskError("task-projection-unavailable");
      if (persisted?.errorCode) throw taskError(persisted.errorCode);
      const originalBaseline = persisted?.baseline ?? (row.predecessorID ? predecessor.projectionBaseline : null) ?? row.payload.projectionBaseline ?? null;
      return { acceptedEtag: expectedRef.etag, baseline: originalBaseline, dispatchAllowed: canDispatch,
        ...(persisted ? { saved: { projection: persisted.projection, baseline: persisted.baseline, patch: persisted.patch } } : {}) };
    },
    async prepareProjection(input, signal) {
      signal.throwIfAborted();
      if (predecessorAddress) {
        try {
          persisted = await setTaskOutboxCausalProjection(row, token, predecessorAddress, persisted ?? { version: 1, projection: input.target,
            baseline: input.baseline, patch: diffGoogleTaskProjection(input.baseline, input.target) }, signal);
          return { projection: persisted.projection as GoogleTaskProjection, baseline: persisted.baseline!, patch: persisted.patch as GoogleTaskUpdateBody };
        } catch (error) { if (error instanceof TaskOutboxPredecessorError) throw taskError("task-projection-unavailable"); throw error; }
      }
      if (!persisted) {
        persisted = { version: 1, projection: input.target, baseline: input.baseline, patch: diffGoogleTaskProjection(input.baseline, input.target) };
        if (!await setTaskOutboxProjection(row.id, token, persisted)) throw taskError("task-projection-unavailable"); signal.throwIfAborted();
      }
      return { projection: persisted.projection as GoogleTaskProjection, baseline: persisted.baseline!, patch: persisted.patch as GoogleTaskUpdateBody };
    },
    renew: signal => { signal.throwIfAborted(); return renewTaskOutboxLease(row.id, token); },
    accountSession: { open: (connection, signal) => native().ports.accountSession.open(connection, signal),
      recoverRejectedRead: (connection, rejected, signal) => native().ports.accountSession.recoverRejectedRead!(connection, rejected, signal),
      onReadAuthenticationRejected: signal => native().ports.accountSession.onReadAuthenticationRejected!(signal) },
    async beforeMutation(_request, signal) {
      signal.throwIfAborted(); if (!await renewTaskOutboxLease(row.id, token) || !await admitted(false, signal)) throw taskError("task-source-read-only"); signal.throwIfAborted();
      if (predecessorAddress && !await assertTaskOutboxPredecessorResolution(row, token, predecessorAddress, signal)) throw taskError("task-projection-unavailable");
    },
    async recordEvidence(facts, signal) { signal.throwIfAborted(); record(facts); },
    async ack(evidence, signal) {
      signal.throwIfAborted(); record(evidence.facts);
      if (evidence.kind === "predecessor-no-resource") {
        if (predecessorAddress?.kind !== "predecessor-no-task") return { kind: "authority-rejected" };
        const accepted = await acceptTaskOutboxDelivery(row, token, null, undefined, signal, expectedRef, predecessorAddress);
        return { kind: accepted ? "acknowledged" : "authority-rejected" };
      }
      const deletionRef = expectedRef?.externalTaskId ? { ...expectedRef, externalTaskId: expectedRef.externalTaskId } : undefined;
      if (!deletionRef) return { kind: "authority-rejected" };
      resultRef = { ...deletionRef };
      const accepted = await acceptTaskOutboxDelivery(row, token, null, deletionRef, signal, expectedRef, predecessorAddress);
      return { kind: accepted ? "acknowledged" : "authority-rejected" };
    },
    finish, observationId: randomUUID,
  }, {
    http: { fetch: (url, init) => native().ports.http.fetch(url, init) },
    clock: { nowEpochMs: () => native().ports.clock.nowEpochMs(), nowMonotonicMs: () => native().ports.clock.nowMonotonicMs() },
    telemetry: { record: metric => native().ports.telemetry.record(metric) },
  }, MUSUBI_TASK_DELETE_POLICY, options));
  return getTaskOutbox(row.id);
}
