import { withDeliveryBudgetScope, providerDeferral } from "./provider_budget";
import { currentSyncWorkParking } from "./work_coordinator";
import * as budgetPersistence from "@musubi/db";
import { TaskSchema } from "@musubi/types";
import { claimTaskOutbox, decodeTaskOutboxOperation, assertPinnedOutboxSource, getTaskOutbox, getTaskOutboxPredecessorEvidence, renewTaskOutboxLease, assertTaskOutboxDeliverySource, setTaskOutboxProjection, finishTaskOutbox, acceptTaskOutboxDelivery, TaskOutboxPredecessorError, type TaskOutboxRow } from "@musubi/db";
import type { CalendarAdapter } from "./adapter";
import { deliveryNextAttemptAt, validateDeliveryAttemptOptions, type DeliveryAttemptOptions } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";
import { ProviderEventWriteError } from "./event_write";
import { jsonTaskProjection, sameTaskProjection, ProviderTaskWriteError } from "./task_write";
import { parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { runClaimedTaskCompatibility, type TaskCompatibilityFinish, type TaskCompatibilityProfile } from "@musubi/sync-runtime";
import { deliverSharedGoogleTaskUpdate, usesSharedGoogleTaskUpdate } from "./google_shared_task_update_delivery";
import { deliverSharedGoogleTaskDelete, usesSharedGoogleTaskDelete } from "./google_shared_task_delete_delivery";
import { deliverSharedGoogleTaskCreate, usesSharedGoogleTaskCreate } from "./google_shared_task_create_delivery";

type AdapterFor = (provider: string) => CalendarAdapter | null;

/** Revalidate the captured source and privacy generation immediately before
 * dispatch. The lifecycle fence is never held across a network request. */
async function admitted(row: TaskOutboxRow, allowDeletedTask = false, pinned = false) {
  return await assertTaskOutboxDeliverySource(row, allowDeletedTask) &&
    (!pinned || await assertPinnedOutboxSource(row, allowDeletedTask));
}

/** Request and scheduler share this exact executor. A committed claim precedes
 * HTTP, and an expired/ambiguous CREATE can only be observed, never replayed. */
export async function deliverTaskOutbox(id: string, adapterFor: AdapterFor, options: DeliveryAttemptOptions = {}) {
  validateDeliveryAttemptOptions(options);
  const row = await claimTaskOutbox(id);
  if (!row?.leaseToken) return undefined;
  const token = row.leaseToken;
  return withDeliveryBudgetScope(row.provider, row.userID, row.accountID, { operationId: row.id, attemptId: token,
    sourceIncarnationKey: JSON.stringify([row.externalCalendarLinkID, row.providerAccessRevision]) }, async () => {
  const decoded = decodeTaskOutboxOperation(row);
  if (decoded.kind === "blocked") {
    await finishTaskOutbox(row.id, token, "blocked", decoded.code, { uncertain: row.reconciling });
    return getTaskOutbox(row.id);
  }
  const pinned = decoded.kind === "pinned-v1" ? decoded.envelope : undefined;
  const nativePlan = pinned ? parseNativeWritePlanV1(pinned.serializer, row.action, "task", pinned.nativePlan.data) : undefined;
  if (pinned && !nativePlan) {
    await finishTaskOutbox(row.id, token, "blocked", "delivery-serializer-unavailable", { uncertain: row.reconciling });
    return getTaskOutbox(row.id);
  }
  if (pinned && !await assertPinnedOutboxSource(row, true)) {
    await finishTaskOutbox(row.id, token, "blocked", "delivery-source-changed", { uncertain: row.reconciling });
    return getTaskOutbox(row.id);
  }
  if (pinned && row.provider === "google" && row.action === "create") {
    const adapter = adapterFor(row.provider);
    if (usesSharedGoogleTaskCreate(pinned, adapter))
      return deliverSharedGoogleTaskCreate(row, pinned, adapter!.googleTaskCreateV1!, options);
  }
  if (pinned && row.provider === "google" && row.action === "update") {
    const adapter = adapterFor(row.provider);
    if (usesSharedGoogleTaskUpdate(pinned, adapter))
      return deliverSharedGoogleTaskUpdate(row, pinned, adapter!.googleTaskUpdateV1!, options);
  }
  if (pinned && row.provider === "google" && row.action === "delete") {
    const adapter = adapterFor(row.provider);
    if (usesSharedGoogleTaskDelete(pinned, adapter))
      return deliverSharedGoogleTaskDelete(row, pinned, adapter!.googleTaskDeleteV1!, options);
  }
  // These profiles retain the existing API writers. They are deliberately not
  // provider-package portability or proof of To Do conditionality.
  let adapter: CalendarAdapter | null = null;
  const native = () => adapter!;
  const classifyError = (error: unknown) => error instanceof TaskOutboxPredecessorError
    ? new ProviderTaskWriteError("task-provider-conflict") : error instanceof ProviderTaskWriteError ? error : error instanceof ProviderEventWriteError
      ? new ProviderTaskWriteError("task-write-failed", error.outcome, error.providerStatus, error.retryAfterMs) : undefined;
  const finish = async (outcome: TaskCompatibilityFinish) => {
    if (outcome.kind === "failed") {
      const deferral = providerDeferral(outcome.cause);
      if (deferral) {
        const uncertain = row.reconciling || outcome.facts.possibleDispatch || outcome.facts.writerFulfilled;
        await finishTaskOutbox(row.id, token, uncertain ? "unconfirmed" : "retry", "provider-budget-deferred", {
          uncertain, nextAttemptAt: new Date(deferral.retryAtMs), resultRef: outcome.facts.resultRef ?? row.resultRef,
          ...(outcome.facts.acknowledgementProjection === undefined ? {} : { remoteSnapshot: outcome.facts.acknowledgementProjection }),
        });
        return;
      }
    }
    if (outcome.kind === "blocked") {
      await finishTaskOutbox(row.id, token, "blocked", outcome.code, { uncertain: row.reconciling });
      return;
    }
    if (outcome.kind === "not-needed") {
      await finishTaskOutbox(row.id, token, "not-needed", null, { uncertain: false,
        ...("current" in outcome ? { resultRef: outcome.current?.ref ?? row.resultRef, remoteSnapshot: outcome.current?.projection ?? null } : {}) });
      return;
    }
    const providerError = outcome.error, facts = outcome.facts;
    const code = providerError?.code ?? "task-write-failed";
    const retryableStatus = providerError?.providerStatus === 429 || providerError?.providerStatus === 408 || (providerError?.providerStatus ?? 0) >= 500;
    const blocked = ["task-source-read-only", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-projection-unavailable"].includes(code);
    const resourceAuthFailure = providerError?.providerStatus === 401 && !facts.possibleDispatch;
    const definite = !!providerError && !retryableStatus && !resourceAuthFailure && (providerError.providerStatus != null && providerError.providerStatus < 500 || blocked || code === "task-provider-conflict");
    // Preserve the historical complete-writer-return boundary independently of
    // dispatch. A void DELETE may have returned after observing native absence.
    const definiteRejection = !facts.writerFulfilled && providerError?.outcome === "not-written" && providerError.providerStatus != null && providerError.providerStatus < 500;
    const uncertain = row.reconciling || providerError?.outcome === "unconfirmed" || facts.possibleDispatch && !definiteRejection;
    const status = uncertain ? "unconfirmed" : code === "task-provider-conflict" ? "conflict" : blocked ? "blocked" : definite ? "not-written" : "retry";
    await finishTaskOutbox(row.id, token, status, code, { uncertain, resultRef: facts.resultRef ?? row.resultRef,
      ...(facts.acknowledgementProjection === undefined ? {} : { remoteSnapshot: facts.acknowledgementProjection }),
      nextAttemptAt: deliveryNextAttemptAt(row.attempts, providerError?.retryAfterMs) });
  };
  await withProviderCallMetrics(row.provider, "task", () => runClaimedTaskCompatibility({
    operationId: row.id, attemptId: token, action: row.action, reconciling: row.reconciling, priorResultRef: row.resultRef,
  }, {
    async prepare(signal) {
      if (!await admitted(row, true, !!pinned)) return { kind: "blocked", code: "task-source-changed" };
      const canDispatch = await admitted(row, false, !!pinned);
      if (!canDispatch && !row.reconciling) return { kind: "not-needed" };
      adapter = adapterFor(row.provider);
      if (!adapter || (!pinned && !adapter.projectTask) || !adapter.readTask || !adapter.assertTaskWrite || !adapter.pushTaskCreate || !adapter.pushTaskUpdate || !adapter.pushTaskDelete) throw new ProviderTaskWriteError("task-projection-unavailable");
      const task = TaskSchema.parse(row.payload.task);
      const secondary = row.calendarID !== (task.originCalendarID ?? task.calendarID);
      if (secondary && row.action !== "delete" && task.recurrence) throw new ProviderTaskWriteError("task-recurrence-projection-unsupported");
      const predecessor = await getTaskOutboxPredecessorEvidence(row);
      const expected = Object.freeze({ externalTaskId: predecessor.ref.externalTaskId ?? null,
        etag: predecessor.ref.etag ?? null, icalUid: predecessor.ref.icalUid ?? null });
      const saved = row.payload.dispatchProjection;
      const target = pinned ? pinned.admittedProjection.data : saved?.projection ?? jsonTaskProjection(adapter.projectTask!(task));
      if (pinned && saved && !sameTaskProjection(saved.projection, target)) throw new ProviderTaskWriteError("task-projection-unavailable");
      // Preview failures are rechecked by the existing adapters; an explicitly
      // saved dispatch error remains a durable refusal as before.
      if (saved?.errorCode) throw new ProviderTaskWriteError(saved.errorCode as ProviderTaskWriteError["code"]);
      const profile: TaskCompatibilityProfile = Object.freeze({ kind: "host-only",
        family: row.provider === "google" ? row.action === "create" && row.predecessorID ? "google-predecessor-create" : "google-task" :
          row.provider === "microsoft" ? secondary ? "todo-secondary-refusal" : "todo-home" : row.provider === "caldav" ? "vtodo-resource" : "retained-provider",
        representation: pinned ? "pinned-v1" : "retained-v0" });
      // The original envelope/NULL address stays unchanged. Only deterministic
      // DAV task UUID resources or a fully returned response address recover CREATE.
      const recoveryRef = row.resultRef ?? (row.provider === "caldav" ? {
        externalTaskId: `${row.externalCalendarID.replace(/\/?$/, "/")}${task.id}.ics`, icalUid: task.id,
      } : undefined);
      signal.throwIfAborted();
      return { kind: "ready", decoded, profile, task, authority: secondary ? "secondary" : "home", dispatchAllowed: canDispatch,
        paired: { ref: expected, projectionBaseline: predecessor.projectionBaseline, hasPredecessor: !!row.predecessorID },
        projectionBaseline: row.payload.projectionBaseline ?? null, target, ...(saved ? { saved } : {}),
        recovery: { kind: row.provider === "caldav" ? "task-uuid-resource" : "response-address-only", ...(recoveryRef ? { ref: recoveryRef } : {}) } };
    },
    saveProjection: saved => setTaskOutboxProjection(row.id, token, saved),
    renew: signal => { signal.throwIfAborted(); return renewTaskOutboxLease(row.id, token); },
    beforeMutation: async signal => {
      signal.throwIfAborted();
      return await renewTaskOutboxLease(row.id, token) && await admitted(row, false, !!pinned);
    },
    ack: (evidence, deletionRef, expected, signal) => acceptTaskOutboxDelivery(row, token, evidence, deletionRef, signal, expected),
    classifyError,
    finish,
  }, {
    read: (ref, signal) => native().readTask!(row.userID, row.accountID, row.externalCalendarID, ref, signal),
    preflight: (request, signal) => native().assertTaskWrite!(row.userID, row.accountID, row.externalCalendarID, { ...request, signal }),
    create: (task, mark, signal) => native().pushTaskCreate!(row.userID, row.accountID, row.externalCalendarID, task, mark, signal, nativePlan),
    update: (task, ref, patch, mark, signal) => native().pushTaskUpdate!(row.userID, row.accountID, row.externalCalendarID,
      ref.externalTaskId, task, { ...ref, beforeMutation: mark }, patch, signal, nativePlan),
    delete: (ref, mark, signal) => native().pushTaskDelete!(row.userID, row.accountID, row.externalCalendarID,
      ref.externalTaskId, { ...ref, beforeMutation: mark }, signal),
  }, options));
  return getTaskOutbox(row.id);
  }, { park: currentSyncWorkParking() ? async (retryAtMs, signal) => {
    if (!await budgetPersistence.postponeTaskOutbox(row.id, token, retryAtMs)) throw new Error("Task work lease changed while parking.");
    await currentSyncWorkParking()!(retryAtMs, signal);
  } : undefined });
}
