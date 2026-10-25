import { TaskSchema } from "@musubi/types";
import { claimTaskOutbox, decodeTaskOutboxOperation, assertPinnedOutboxSource, getTaskOutbox, getTaskOutboxPredecessorEvidence, renewTaskOutboxLease, assertTaskOutboxDeliverySource, setTaskOutboxProjection, finishTaskOutbox, acceptTaskOutboxDelivery, type TaskOutboxRow } from "@musubi/db";
import type { CalendarAdapter, ExternalTaskRef, TaskProjection } from "./adapter";
import { createDeliveryAttempt, deliveryNextAttemptAt, validateDeliveryAttemptOptions, type DeliveryAttemptOptions } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";
import { ProviderEventWriteError } from "./event_write";
import { diffTaskProjection, jsonTaskProjection, sameTaskProjection, ProviderTaskWriteError } from "./task_write";
import { parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { deliverSharedGoogleTaskUpdate, usesSharedGoogleTaskUpdate } from "./google_shared_task_update_delivery";

type AdapterFor = (provider: string) => CalendarAdapter | null;
type Projection = NonNullable<TaskOutboxRow["payload"]["providerProjection"]>;

/** Revalidate the captured source and privacy generation immediately before
 * dispatch. The lifecycle fence is never held across a network request. */
async function admitted(row: TaskOutboxRow, allowDeletedTask = false, pinned = false) {
  return await assertTaskOutboxDeliverySource(row, allowDeletedTask) &&
    (!pinned || await assertPinnedOutboxSource(row, allowDeletedTask));
}

function achieved(current: TaskProjection, patch: TaskProjection) {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
}

/** Request and scheduler share this exact executor. A committed claim precedes
 * HTTP, and an expired/ambiguous CREATE can only be observed, never replayed. */
export async function deliverTaskOutbox(id: string, adapterFor: AdapterFor, options: DeliveryAttemptOptions = {}) {
  validateDeliveryAttemptOptions(options);
  const row = await claimTaskOutbox(id);
  if (!row?.leaseToken) return undefined;
  const token = row.leaseToken;
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
  if (pinned && row.provider === "google" && row.action === "update" && row.externalTaskID) {
    const adapter = adapterFor(row.provider);
    if (usesSharedGoogleTaskUpdate(pinned, adapter))
      return deliverSharedGoogleTaskUpdate(row, pinned, adapter!.googleTaskUpdateV1!, options);
  }
  let dispatched = false;
  let resultRef: ExternalTaskRef | undefined;
  let acknowledgementProjection: TaskProjection | undefined;
  let mutationAccepted = false;
  const attempt = createDeliveryAttempt(() => renewTaskOutboxLease(row.id, token), options);
  const signal = attempt.signal;
  let acknowledgementExpectedRef: Readonly<{ externalTaskId: string | null; etag: string | null; icalUid: string | null }> | undefined;
  const acknowledge = async (evidence: Parameters<typeof acceptTaskOutboxDelivery>[2], deletionRef?: ExternalTaskRef) => {
    signal.throwIfAborted();
    if (evidence) {
      resultRef = { ...evidence.ref };
      acknowledgementProjection = jsonTaskProjection(evidence.projection);
    } else if (deletionRef) resultRef = { ...deletionRef };
    const accepted = await acceptTaskOutboxDelivery(row, token, evidence, deletionRef, signal, acknowledgementExpectedRef);
    // A false ACK can mean a stale lease or a mapping race, not a loss of ACL.
    // A committed ACK remains authoritative even if the signal then expires.
    if (!accepted) throw new ProviderTaskWriteError("task-write-failed",
      row.reconciling || dispatched || mutationAccepted ? "unconfirmed" : "not-written");
  };
  const mark = async () => {
    signal.throwIfAborted();
    if (!await renewTaskOutboxLease(row.id, token) || !await admitted(row, false, !!pinned)) throw new ProviderTaskWriteError("task-source-read-only");
    signal.throwIfAborted();
    dispatched = true;
  };
  try {
    return await attempt.run(() => withProviderCallMetrics(row.provider, "task", async () => {
      if (!await admitted(row, true, !!pinned)) {
        await finishTaskOutbox(row.id, token, "blocked", "task-source-changed", { uncertain: row.reconciling });
        return getTaskOutbox(row.id);
      }
      const canDispatch = await admitted(row, false, !!pinned);
      if (!canDispatch && !row.reconciling) {
        await finishTaskOutbox(row.id, token, "not-needed", null, { uncertain: false });
        return getTaskOutbox(row.id);
      }
      const adapter = adapterFor(row.provider);
      if (!adapter || (!pinned && !adapter.projectTask) || !adapter.readTask || !adapter.assertTaskWrite || !adapter.pushTaskCreate || !adapter.pushTaskUpdate || !adapter.pushTaskDelete) throw new ProviderTaskWriteError("task-projection-unavailable");
      const task = TaskSchema.parse(row.payload.task);
      const secondary = row.calendarID !== (task.originCalendarID ?? task.calendarID);
      if (secondary && row.action !== "delete" && task.recurrence) throw new ProviderTaskWriteError("task-recurrence-projection-unsupported");
      const predecessor = await getTaskOutboxPredecessorEvidence(row);
      const expected = predecessor.ref;
      acknowledgementExpectedRef = Object.freeze({ externalTaskId: expected.externalTaskId ?? null,
        etag: expected.etag ?? null, icalUid: expected.icalUid ?? null });
      let ref: ExternalTaskRef | undefined = expected.externalTaskId ? { ...expected, externalTaskId: expected.externalTaskId } : undefined;
      let saved: Projection | undefined = row.payload.dispatchProjection;
      const target = pinned ? pinned.admittedProjection.data : saved?.projection ?? jsonTaskProjection(adapter.projectTask!(task));
      if (pinned && saved && !sameTaskProjection(saved.projection, target)) throw new ProviderTaskWriteError("task-projection-unavailable");
      // Preflight reports are diagnostic previews. A temporary network or OAuth
      // failure must be rechecked after recovery, not frozen as a perpetual error.
      if (saved?.errorCode) throw new ProviderTaskWriteError(saved.errorCode as ProviderTaskWriteError["code"]);

      if (row.action === "create" && row.reconciling) {
        // CalDAV has a deterministic URL+UID. Other APIs have no documented
        // client-generated task ID, so only a captured response address is safe.
        ref = row.resultRef ?? (row.provider === "caldav" ? { externalTaskId: `${row.externalCalendarID.replace(/\/?$/, "/")}${task.id}.ics`, icalUid: task.id } : undefined);
        if (!ref) throw new ProviderTaskWriteError("task-create-unconfirmed", "unconfirmed");
        const observed = await adapter.readTask(row.userID, row.accountID, row.externalCalendarID, ref, signal);
        if (!observed || !sameTaskProjection(observed.projection, target)) throw new ProviderTaskWriteError("task-create-unconfirmed", "unconfirmed");
        signal.throwIfAborted();
        await acknowledge(observed);
        return getTaskOutbox(row.id);
      }

      const current = ref ? await adapter.readTask(row.userID, row.accountID, row.externalCalendarID, ref, signal) : null;
      if (row.action === "delete" && !current) {
        signal.throwIfAborted();
        await acknowledge(null, ref);
        return getTaskOutbox(row.id);
      }
      if (row.action !== "create" && !ref) throw new ProviderTaskWriteError("task-version-unavailable");
      if (row.action === "update" && !current) throw new ProviderTaskWriteError("task-provider-conflict");
      if (!saved) {
        let baseline = row.payload.projectionBaseline ?? current?.projection ?? null;
        if (row.predecessorID) baseline = predecessor.projectionBaseline ?? baseline;
        saved = { version: 1, projection: target, baseline, patch: baseline ? diffTaskProjection(baseline, target) : target };
        if (!await setTaskOutboxProjection(row.id, token, saved)) throw new ProviderTaskWriteError("task-projection-unavailable");
      }
      if (row.action === "update" && row.reconciling && current && achieved(current.projection, saved.patch)) {
        signal.throwIfAborted();
        await acknowledge(current);
        return getTaskOutbox(row.id);
      }
      if (!canDispatch) {
        await finishTaskOutbox(row.id, token, "not-needed", null, { resultRef: current?.ref ?? row.resultRef, remoteSnapshot: current?.projection ?? null, uncertain: false });
        return getTaskOutbox(row.id);
      }
      // Never adopt a newer validator merely because the current read succeeded.
      // The native object must still match the captured accepted baseline.
      if (current && (current.ref.etag !== ref?.etag || saved.baseline && !sameTaskProjection(current.projection, saved.baseline))) throw new ProviderTaskWriteError("task-provider-conflict");
      signal.throwIfAborted();
      await adapter.assertTaskWrite(row.userID, row.accountID, row.externalCalendarID, { action: row.action, task, external: ref, projection: target, secondary, signal });
      if (row.action === "update" && !Object.keys(saved.patch).length && current) {
        signal.throwIfAborted();
        await acknowledge(current);
        return getTaskOutbox(row.id);
      }
      if (row.action === "create") resultRef = await adapter.pushTaskCreate(row.userID, row.accountID, row.externalCalendarID, task, mark, signal, nativePlan);
      else if (row.action === "delete") {
        await adapter.pushTaskDelete(row.userID, row.accountID, row.externalCalendarID, ref!.externalTaskId, { ...ref!, beforeMutation: mark }, signal);
        mutationAccepted = true;
        signal.throwIfAborted();
        await acknowledge(null, ref);
        return getTaskOutbox(row.id);
      } else {
        const result = await adapter.pushTaskUpdate(row.userID, row.accountID, row.externalCalendarID, ref!.externalTaskId, task, { ...ref!, beforeMutation: mark }, saved.patch, signal, nativePlan);
        resultRef = { ...ref!, ...result };
      }
      mutationAccepted = true;
      signal.throwIfAborted();
      const observed = await adapter.readTask(row.userID, row.accountID, row.externalCalendarID, resultRef, signal);
      if (!observed || !achieved(observed.projection, saved.patch)) throw new ProviderTaskWriteError("task-write-failed", "unconfirmed");
      signal.throwIfAborted();
      await acknowledge(observed);
      return getTaskOutbox(row.id);
    }));
  } catch (error) {
    // CalDAV preflight uses the common event HTTP validator. Preserve its
    // throttle hint without changing task delivery's persisted error codes.
    const providerError = error instanceof ProviderTaskWriteError ? error : error instanceof ProviderEventWriteError
      ? new ProviderTaskWriteError("task-write-failed", error.outcome, error.providerStatus, error.retryAfterMs) : undefined;
    const code = providerError?.code ?? "task-write-failed";
    const retryableStatus = providerError?.providerStatus === 429 || providerError?.providerStatus === 408 || (providerError?.providerStatus ?? 0) >= 500;
    const blocked = ["task-source-read-only", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-projection-unavailable"].includes(code);
    const resourceAuthFailure = providerError?.providerStatus === 401 && !dispatched;
    const definite = !!providerError && !retryableStatus && !resourceAuthFailure && (providerError.providerStatus != null && providerError.providerStatus < 500 || blocked || code === "task-provider-conflict");
    // A rejection of the dispatched mutation is proof of no write. A later
    // failed observation cannot revoke an already accepted mutation.
    const definiteRejection = !mutationAccepted && providerError?.outcome === "not-written" && providerError.providerStatus != null && providerError.providerStatus < 500;
    const uncertain = row.reconciling || providerError?.outcome === "unconfirmed" || dispatched && !definiteRejection;
    const status = uncertain ? "unconfirmed" : code === "task-provider-conflict" ? "conflict" : blocked ? "blocked" : definite ? "not-written" : "retry";
    await finishTaskOutbox(row.id, token, status, code, { uncertain, resultRef: resultRef ?? row.resultRef,
      ...(acknowledgementProjection === undefined ? {} : { remoteSnapshot: acknowledgementProjection }),
      nextAttemptAt: deliveryNextAttemptAt(row.attempts, providerError?.retryAfterMs) });
    return getTaskOutbox(row.id);
  } finally { attempt.dispose(); }
}
