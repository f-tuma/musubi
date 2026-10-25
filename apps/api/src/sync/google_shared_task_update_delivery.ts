import { randomUUID } from "node:crypto";
import {
  assertPinnedOutboxSource, assertTaskOutboxDeliverySource, getTaskOutboxPredecessorEvidence,
  setTaskOutboxProjection, renewTaskOutboxLease, acceptTaskOutboxDelivery, finishTaskOutbox, getTaskOutbox,
  type TaskOutboxRow,
} from "@musubi/db";
import { TaskSchema, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import { diffGoogleTaskProjection, type GoogleTaskProjection, type GoogleTaskUpdateBody } from "@musubi/provider-google";
import {
  runClaimedGoogleTaskUpdate, supportsGoogleTaskUpdateEnvelope, SyncRuntimeHostError,
  type GoogleTaskUpdatePolicy, type RuntimeTaskNativeFacts, type RuntimeTaskFinishOutcome, type RuntimeAttemptOptions,
} from "@musubi/sync-runtime";
import type { CalendarAdapter, ExternalTaskRef, GoogleTaskUpdateV1Bridge, TaskProjection } from "./adapter";
import { jsonTaskProjection } from "./task_write";
import { deliveryNextAttemptAt } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";

const MUSUBI_TASK_POLICY: GoogleTaskUpdatePolicy = Object.freeze({
  nativeProfile: "existing-google", readback: "saved-patch", ambiguousRecovery: "deferred",
});
const taskError = (code: string) => new SyncRuntimeHostError({ code, outcome: "not-written" });

export function usesSharedGoogleTaskUpdate(envelope: SyncOperationEnvelope, adapter: CalendarAdapter | null): boolean {
  return typeof adapter?.googleTaskUpdateV1 === "function" && supportsGoogleTaskUpdateEnvelope(envelope);
}

/** The claim, canonical/home authority, predecessor history and atomic ACK stay
 * in this host. The shared runner never reads the Musubi database. */
export async function deliverSharedGoogleTaskUpdate(row: TaskOutboxRow & { reconciling: boolean }, envelope: SyncOperationEnvelope,
  factory: NonNullable<CalendarAdapter["googleTaskUpdateV1"]>, options: RuntimeAttemptOptions = {}) {
  const token = row.leaseToken!;
  const capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
  let bridge: GoogleTaskUpdateV1Bridge | undefined;
  const native = () => bridge ??= factory(row.userID, row.accountID, capture);
  let expectedRef: Readonly<{ externalTaskId: string | null; etag: string | null; icalUid: string | null }> | undefined;
  let resultRef: ExternalTaskRef | null = row.resultRef;
  let remoteSnapshot: TaskProjection | undefined;
  let persisted = row.payload.dispatchProjection;
  let initialBaseline: TaskProjection | null = null;
  let canDispatch = false;
  const admitted = async (allowDeleted: boolean, signal: AbortSignal) => {
    signal.throwIfAborted();
    const allowed = await assertTaskOutboxDeliverySource(row, allowDeleted) && await assertPinnedOutboxSource(row, allowDeleted);
    signal.throwIfAborted(); return allowed;
  };
  const record = (facts: RuntimeTaskNativeFacts) => {
    // Raw accepted HTTP status is attempt-local here. Existing durable task
    // uncertainty remains the restart representation; a null tag is no proof.
    if (facts.provider.kind === "accepted" && facts.provider.validator)
      resultRef = { externalTaskId: row.externalTaskID!, etag: facts.provider.validator, icalUid: null };
    if (facts.remote.kind === "confirmed") {
      const observed = native().normalizeObservation(facts.remote.read);
      if (observed) { resultRef = { ...observed.ref }; remoteSnapshot = jsonTaskProjection(observed.projection); }
    }
  };
  const finish = async (outcome: RuntimeTaskFinishOutcome) => {
    record(outcome.facts);
    const info = outcome.error;
    if (info.code === "task-not-needed") {
      const observed = outcome.facts.remote.kind === "unobserved" ? null : native().normalizeObservation(outcome.facts.remote.read);
      await finishTaskOutbox(row.id, token, "not-needed", null, { uncertain: false,
        ...(observed ? { resultRef: observed.ref, remoteSnapshot: observed.projection } : {}) });
      return;
    }
    const code = info.code === "runtime-ack-authority-changed" || info.code === "runtime-attempt-aborted" ? "task-write-failed" :
      info.code === "account-session-changed" ? "task-source-read-only" :
      info.code.startsWith("operation-") || info.code === "runtime-task-plan-unavailable" ? "task-projection-unavailable" :
      ["task-provider-conflict", "task-version-unavailable", "task-write-failed", "task-conditional-write-unsupported",
        "task-recurrence-projection-unsupported", "task-source-read-only", "task-create-unconfirmed", "task-projection-unavailable", "task-source-changed"].includes(info.code)
        ? info.code : "task-write-failed";
    const blocked = ["task-source-read-only", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-projection-unavailable", "task-source-changed"].includes(code);
    const retryableStatus = info.providerStatus === 429 || info.providerStatus === 408 || (info.providerStatus ?? 0) >= 500;
    const resourceAuthFailure = info.providerStatus === 401 && !outcome.facts.possibleDispatch;
    const definite = !retryableStatus && !resourceAuthFailure && (info.providerStatus != null && info.providerStatus < 500 || blocked || code === "task-provider-conflict");
    const accepted = outcome.facts.provider.kind === "accepted";
    const definiteRejection = !accepted && info.outcome === "not-written" && info.providerStatus != null && info.providerStatus < 500;
    const uncertain = row.reconciling || outcome.facts.possibleDispatch && !definiteRejection;
    const status = uncertain ? "unconfirmed" : code === "task-provider-conflict" ? "conflict" : blocked ? "blocked" : definite ? "not-written" : "retry";
    await finishTaskOutbox(row.id, token, status, code, { uncertain, resultRef: resultRef ?? row.resultRef,
      ...(remoteSnapshot === undefined ? {} : { remoteSnapshot }), nextAttemptAt: deliveryNextAttemptAt(row.attempts, info.retryAfterMs) });
  };
  await withProviderCallMetrics(row.provider, "task", () => runClaimedGoogleTaskUpdate({
    operationId: row.id, attemptId: token, payload: row.payload,
    binding: { kind: "task", action: "update", operationId: row.id, commandId: row.mutationID, hostObjectId: row.taskID,
      provider: row.provider, connectionId: row.accountID, collectionId: row.externalCalendarID, resourceId: row.externalTaskID,
      acceptedRevision: row.revision, predecessorOperationId: row.predecessorID,
      sourceEpoch: { sourceId: capture.sourceId, generation: capture.writeGeneration }, privacyEpoch: capture.privacyEpoch },
    nativeTarget: { connectionId: capture.connectionId, connectionGeneration: String(capture.connectionGeneration),
      taskListId: row.externalCalendarID.slice("musubi-google-task-list:".length), taskId: row.externalTaskID! },
    collectionIdentity: "musubi-google-task-list", acceptedEtag: row.expectedEtag,
    recovery: { required: row.reconciling, possibleDispatch: row.reconciling },
    priorProvider: row.reconciling ? { kind: "uncertain" } : { kind: "not-dispatched" },
  }, {
    async prepare(signal) {
      if (!await admitted(true, signal)) throw new SyncRuntimeHostError({ code: "task-source-changed", outcome: "not-written" });
      canDispatch = await admitted(false, signal);
      if (!canDispatch && !row.reconciling) throw new SyncRuntimeHostError({ code: "task-not-needed", outcome: "not-written" });
      const task = TaskSchema.parse(row.payload.task);
      if (task.recurrence) throw taskError("task-recurrence-projection-unsupported");
      const predecessor = await getTaskOutboxPredecessorEvidence(row); signal.throwIfAborted();
      expectedRef = Object.freeze({ externalTaskId: predecessor.ref.externalTaskId ?? null, etag: predecessor.ref.etag ?? null, icalUid: predecessor.ref.icalUid ?? null });
      if (expectedRef.externalTaskId !== row.externalTaskID) throw taskError("task-projection-unavailable");
      if (persisted?.errorCode) throw taskError(persisted.errorCode);
      initialBaseline = persisted?.baseline ?? (row.predecessorID ? predecessor.projectionBaseline : null) ?? row.payload.projectionBaseline ?? null;
      return { acceptedEtag: expectedRef.etag, baseline: initialBaseline, dispatchAllowed: canDispatch,
        ...(persisted ? { saved: { projection: persisted.projection, baseline: persisted.baseline, patch: persisted.patch } } : {}) };
    },
    async prepareProjection(input, signal) {
      signal.throwIfAborted();
      if (!persisted) {
        persisted = { version: 1, projection: input.target, baseline: input.baseline,
          patch: diffGoogleTaskProjection(input.baseline, input.target) };
        if (!await setTaskOutboxProjection(row.id, token, persisted)) throw taskError("task-projection-unavailable");
        signal.throwIfAborted();
      }
      return { projection: persisted.projection as GoogleTaskProjection, baseline: persisted.baseline!, patch: persisted.patch as GoogleTaskUpdateBody };
    },
    renew: signal => { signal.throwIfAborted(); return renewTaskOutboxLease(row.id, token); },
    accountSession: {
      open: (connection, signal) => native().ports.accountSession.open(connection, signal),
      recoverRejectedRead: (connection, rejected, signal) => native().ports.accountSession.recoverRejectedRead!(connection, rejected, signal),
      onReadAuthenticationRejected: signal => native().ports.accountSession.onReadAuthenticationRejected!(signal),
    },
    async beforeMutation(_request, signal) {
      signal.throwIfAborted();
      if (!await renewTaskOutboxLease(row.id, token) || !await admitted(false, signal)) throw taskError("task-source-read-only");
      signal.throwIfAborted();
    },
    async recordEvidence(facts, signal) { signal.throwIfAborted(); record(facts); },
    async ack(evidence, signal) {
      signal.throwIfAborted(); record(evidence.facts);
      const observed = native().normalizeObservation(evidence.read);
      if (!observed) return { kind: "authority-rejected" };
      const accepted = await acceptTaskOutboxDelivery(row, token, observed, undefined, signal, expectedRef);
      return { kind: accepted ? "acknowledged" : "authority-rejected" };
    },
    finish, observationId: randomUUID,
  }, {
    http: { fetch: (url, init) => native().ports.http.fetch(url, init) },
    clock: { nowEpochMs: () => native().ports.clock.nowEpochMs(), nowMonotonicMs: () => native().ports.clock.nowMonotonicMs() },
    telemetry: { record: metric => native().ports.telemetry.record(metric) },
  }, MUSUBI_TASK_POLICY, options));
  return getTaskOutbox(row.id);
}
