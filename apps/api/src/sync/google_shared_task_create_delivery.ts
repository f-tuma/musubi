import { reserveProviderMutation } from "./provider_budget";
import { randomUUID } from "node:crypto";
import {
  assertPinnedOutboxSource, assertTaskOutboxDeliverySource, getTaskOutboxPredecessorEvidence,
  setTaskOutboxProjection, renewTaskOutboxLease, acceptTaskOutboxDelivery, finishTaskOutbox, getTaskOutbox,
  type TaskOutboxRow,
} from "@musubi/db";
import { TaskSchema, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import { strongGoogleEtag, type GoogleTaskProjection, type GoogleTaskUpdateBody } from "@musubi/provider-google";
import {
  runClaimedGoogleTaskCreate, supportsGoogleTaskCreateEnvelope, SyncRuntimeHostError,
  type GoogleTaskCreatePolicy, type RuntimeTaskCreateNativeFacts, type RuntimeTaskCreateFinishOutcome, type RuntimeAttemptOptions,
} from "@musubi/sync-runtime";
import type { CalendarAdapter, ExternalTaskRef, GoogleTaskCreateV1Bridge, TaskProjection } from "./adapter";
import { diffTaskProjection, jsonTaskProjection } from "./task_write";
import { deliveryNextAttemptAt } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";

const MUSUBI_TASK_CREATE_POLICY: GoogleTaskCreatePolicy = Object.freeze({
  nativeProfile: "existing-google", readback: "saved-patch", ambiguousRecovery: "deferred",
});
const taskError = (code: string) => new SyncRuntimeHostError({ code, outcome: "not-written" });

export function usesSharedGoogleTaskCreate(envelope: SyncOperationEnvelope, adapter: CalendarAdapter | null): boolean {
  return typeof adapter?.googleTaskCreateV1 === "function" && supportsGoogleTaskCreateEnvelope(envelope);
}

/** Standalone CREATE only. The immutable admitted locator stays unaddressed;
 * the existing host persists a returned address only after the whole legacy
 * writer has returned ID + strong ETag. Raw acceptance and an earlier candidate
 * remain attempt facts: this extraction does not close that historical gap. */
export async function deliverSharedGoogleTaskCreate(row: TaskOutboxRow & { reconciling: boolean }, _envelope: SyncOperationEnvelope,
  factory: NonNullable<CalendarAdapter["googleTaskCreateV1"]>, options: RuntimeAttemptOptions = {}) {
  const token = row.leaseToken!, capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
  let bridge: GoogleTaskCreateV1Bridge | undefined;
  const native = () => bridge ??= factory(row.userID, row.accountID, capture);
  let expectedRef: Readonly<{ externalTaskId: string | null; etag: string | null; icalUid: string | null }> | undefined;
  let resultRef: ExternalTaskRef | null = row.resultRef, remoteSnapshot: TaskProjection | undefined;
  let persisted = row.payload.dispatchProjection, initialBaseline: TaskProjection | null = null;
  let createReturned = false;
  const admitted = async (allowDeleted: boolean, signal: AbortSignal) => {
    signal.throwIfAborted();
    const allowed = await assertTaskOutboxDeliverySource(row, allowDeleted) && await assertPinnedOutboxSource(row, allowDeleted);
    signal.throwIfAborted(); return allowed;
  };
  const record = (facts: RuntimeTaskCreateNativeFacts) => {
    if (facts.writerResult) {
      createReturned = true;
      resultRef = { externalTaskId: facts.writerResult.taskId, etag: facts.writerResult.etag, icalUid: null };
    }
    if (facts.remote.kind === "confirmed") {
      const observed = native().normalizeObservation(facts.remote.read);
      if (observed) { resultRef = { ...observed.ref }; remoteSnapshot = jsonTaskProjection(observed.projection); }
    }
  };
  const finish = async (outcome: RuntimeTaskCreateFinishOutcome) => {
    record(outcome.facts);
    const info = outcome.error;
    if (info.deferral) {
      const uncertain = row.reconciling || outcome.facts.possibleDispatch || outcome.facts.provider.kind === "accepted" || outcome.facts.provider.kind === "uncertain";
      await finishTaskOutbox(row.id, token, uncertain ? "unconfirmed" : "retry", "provider-budget-deferred", {
        uncertain, nextAttemptAt: new Date(info.deferral.retryAtMs), ...(resultRef ? { resultRef } : {}),

      });
      return;
    }
    if (info.code === "task-not-needed") {
      await finishTaskOutbox(row.id, token, "not-needed", null, { uncertain: false });
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
    // Preserve the legacy writer-return boundary, independently of the more
    // precise raw acceptance/address facts supplied by the shared provider.
    const definiteRejection = !createReturned && info.outcome === "not-written" && info.providerStatus != null && info.providerStatus < 500;
    const uncertain = row.reconciling || createReturned || outcome.facts.possibleDispatch && !definiteRejection;
    const status = uncertain ? "unconfirmed" : code === "task-provider-conflict" ? "conflict" : blocked ? "blocked" : definite ? "not-written" : "retry";
    await finishTaskOutbox(row.id, token, status, code, { uncertain, resultRef: resultRef ?? row.resultRef,
      ...(remoteSnapshot === undefined ? {} : { remoteSnapshot }), nextAttemptAt: deliveryNextAttemptAt(row.attempts, info.retryAfterMs) });
  };
  await withProviderCallMetrics(row.provider, "task", () => runClaimedGoogleTaskCreate({
    operationId: row.id, attemptId: token, payload: row.payload,
    binding: { kind: "task", action: "create", operationId: row.id, commandId: row.mutationID, hostObjectId: row.taskID,
      provider: row.provider, connectionId: row.accountID, collectionId: row.externalCalendarID, resourceId: row.externalTaskID,
      acceptedRevision: row.revision, predecessorOperationId: row.predecessorID,
      sourceEpoch: { sourceId: capture.sourceId, generation: capture.writeGeneration }, privacyEpoch: capture.privacyEpoch },
    nativeTarget: { connectionId: capture.connectionId, connectionGeneration: String(capture.connectionGeneration),
      taskListId: row.externalCalendarID.slice("musubi-google-task-list:".length) },
    collectionIdentity: "musubi-google-task-list", recovery: { required: row.reconciling, possibleDispatch: row.reconciling },
    priorProvider: row.reconciling ? { kind: "uncertain" } : { kind: "not-dispatched" },
    ...(row.reconciling && row.resultRef ? { priorResponseAddress: { taskId: row.resultRef.externalTaskId,
      validator: strongGoogleEtag(row.resultRef.etag) } } : {}),
  }, {
    async prepare(signal) {
      if (!await admitted(true, signal)) throw taskError("task-source-changed");
      const canDispatch = await admitted(false, signal);
      if (!canDispatch && !row.reconciling) throw taskError("task-not-needed");
      const task = TaskSchema.parse(row.payload.task);
      if (task.recurrence) throw taskError("task-recurrence-projection-unsupported");
      const predecessor = await getTaskOutboxPredecessorEvidence(row); signal.throwIfAborted();
      expectedRef = Object.freeze({ externalTaskId: predecessor.ref.externalTaskId ?? null,
        etag: predecessor.ref.etag ?? null, icalUid: predecessor.ref.icalUid ?? null });
      if (expectedRef.externalTaskId !== null) throw taskError("task-projection-unavailable");
      if (persisted?.errorCode) throw taskError(persisted.errorCode);
      initialBaseline = persisted?.baseline ?? (row.predecessorID ? predecessor.projectionBaseline : null) ?? row.payload.projectionBaseline ?? null;
      return { dispatchAllowed: canDispatch, ...(persisted ? { saved: { projection: persisted.projection as GoogleTaskProjection,
        baseline: persisted.baseline, patch: persisted.patch as GoogleTaskUpdateBody } } : {}) };
    },
    async prepareProjection(input, signal) {
      signal.throwIfAborted();
      if (!persisted) {
        persisted = { version: 1, projection: input.target, baseline: initialBaseline,
          patch: initialBaseline ? diffTaskProjection(initialBaseline, input.target) : input.target };
        if (!await setTaskOutboxProjection(row.id, token, persisted)) throw taskError("task-projection-unavailable");
        signal.throwIfAborted();
      }
      return { projection: persisted.projection as GoogleTaskProjection, baseline: persisted.baseline, patch: persisted.patch as GoogleTaskUpdateBody };
    },
    renew: signal => { signal.throwIfAborted(); return renewTaskOutboxLease(row.id, token); },
    accountSession: {
      open: (connection, signal) => native().ports.accountSession.open(connection, signal),
      recoverRejectedRead: (connection, rejected, signal) => native().ports.accountSession.recoverRejectedRead!(connection, rejected, signal),
      onReadAuthenticationRejected: signal => native().ports.accountSession.onReadAuthenticationRejected!(signal),
    },
    async beforeMutation(_request, signal) {
      return reserveProviderMutation({ url: `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(_request.target.taskListId)}/tasks`, method: "POST" }, async () => {
      signal.throwIfAborted();
      if (!await renewTaskOutboxLease(row.id, token) || !await admitted(false, signal)) throw taskError("task-source-read-only");
      signal.throwIfAborted();

      });
    },
    async recordEvidence(facts, signal) { record(facts); signal.throwIfAborted(); },
    async ack(evidence, signal) {
      signal.throwIfAborted(); record(evidence.facts);
      const observed = native().normalizeObservation(evidence.read);
      if (!observed) return { kind: "authority-rejected" };
      const accepted = await acceptTaskOutboxDelivery(row, token, observed, undefined, signal, expectedRef);
      return { kind: accepted ? "acknowledged" : "authority-rejected" };
    },
    finish, observationId: randomUUID,
  }, {
    http: { fetch: (url, init) => native().ports.http.fetch(url, init),
      dispatch: (request, send) => native().ports.http.dispatch?.(request, send) ?? send(),
      isDispatchDeferred: error => native().ports.http.isDispatchDeferred?.(error) ?? false },
    clock: { nowEpochMs: () => native().ports.clock.nowEpochMs(), nowMonotonicMs: () => native().ports.clock.nowMonotonicMs() },
    telemetry: { record: metric => native().ports.telemetry.record(metric) },
  }, MUSUBI_TASK_CREATE_POLICY, options));
  return getTaskOutbox(row.id);
}
