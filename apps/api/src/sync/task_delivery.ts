import { TaskSchema } from "@musubi/types";
import { claimTaskOutbox, getTaskOutbox, getTaskOutboxPredecessorEvidence, renewTaskOutboxLease, assertTaskOutboxDeliverySource, setTaskOutboxProjection, finishTaskOutbox, acceptTaskOutboxDelivery, type TaskOutboxRow } from "@musubi/db";
import type { CalendarAdapter, ExternalTaskRef, TaskProjection } from "./adapter";
import { diffTaskProjection, jsonTaskProjection, sameTaskProjection, ProviderTaskWriteError } from "./task_write";

type AdapterFor = (provider: string) => CalendarAdapter | null;
type Projection = NonNullable<TaskOutboxRow["payload"]["providerProjection"]>;

/** Revalidate the captured source and privacy generation immediately before
 * dispatch. The lifecycle fence is never held across a network request. */
async function admitted(row: TaskOutboxRow, allowDeletedTask = false) {
  return assertTaskOutboxDeliverySource(row, allowDeletedTask);
}

function achieved(current: TaskProjection, patch: TaskProjection) {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
}

/** Request and scheduler share this exact executor. A committed claim precedes
 * HTTP, and an expired/ambiguous CREATE can only be observed, never replayed. */
export async function deliverTaskOutbox(id: string, adapterFor: AdapterFor) {
  const row = await claimTaskOutbox(id);
  if (!row?.leaseToken) return undefined;
  const token = row.leaseToken;
  let dispatched = false;
  let resultRef: ExternalTaskRef | undefined;
  let lostLease = false;
  const renewal = setInterval(() => { void renewTaskOutboxLease(row.id, token).then(ok => { if (!ok) lostLease = true; }).catch(() => { lostLease = true; }); }, 30_000);
  renewal.unref();
  const mark = async () => {
    if (lostLease || !await renewTaskOutboxLease(row.id, token) || !await admitted(row)) throw new ProviderTaskWriteError("task-source-read-only");
    dispatched = true;
  };
  try {
    if (!await admitted(row, true)) {
      await finishTaskOutbox(row.id, token, "blocked", "task-source-changed", { uncertain: row.reconciling });
      return getTaskOutbox(row.id);
    }
    const canDispatch = await admitted(row);
    if (!canDispatch && !row.reconciling) {
      await finishTaskOutbox(row.id, token, "not-needed", null, { uncertain: false });
      return getTaskOutbox(row.id);
    }
    const adapter = adapterFor(row.provider);
    if (!adapter?.projectTask || !adapter.readTask || !adapter.assertTaskWrite || !adapter.pushTaskCreate || !adapter.pushTaskUpdate || !adapter.pushTaskDelete) throw new ProviderTaskWriteError("task-projection-unavailable");
    const task = TaskSchema.parse(row.payload.task);
    const secondary = row.calendarID !== (task.originCalendarID ?? task.calendarID);
    if (secondary && row.action !== "delete" && task.recurrence) throw new ProviderTaskWriteError("task-recurrence-projection-unsupported");
    const predecessor = await getTaskOutboxPredecessorEvidence(row);
    const expected = predecessor.ref;
    let ref: ExternalTaskRef | undefined = expected.externalTaskId ? { ...expected, externalTaskId: expected.externalTaskId } : undefined;
    let saved: Projection | undefined = row.payload.dispatchProjection;
    const target = saved?.projection ?? jsonTaskProjection(adapter.projectTask(task));
    // Preflight reports are diagnostic previews. A temporary network or OAuth
    // failure must be rechecked after recovery, not frozen as a perpetual error.
    if (saved?.errorCode) throw new ProviderTaskWriteError(saved.errorCode as ProviderTaskWriteError["code"]);

    if (row.action === "create" && row.reconciling) {
      // CalDAV has a deterministic URL+UID. Other APIs have no documented
      // client-generated task ID, so only a captured response address is safe.
      ref = row.resultRef ?? (row.provider === "caldav" ? { externalTaskId: `${row.externalCalendarID.replace(/\/?$/, "/")}${task.id}.ics`, icalUid: task.id } : undefined);
      if (!ref) throw new ProviderTaskWriteError("task-create-unconfirmed", "unconfirmed");
      const observed = await adapter.readTask(row.userID, row.accountID, row.externalCalendarID, ref);
      if (!observed || !sameTaskProjection(observed.projection, target)) throw new ProviderTaskWriteError("task-create-unconfirmed", "unconfirmed");
      await acceptTaskOutboxDelivery(row, token, observed);
      return getTaskOutbox(row.id);
    }

    const current = ref ? await adapter.readTask(row.userID, row.accountID, row.externalCalendarID, ref) : null;
    if (row.action === "delete" && !current) {
      await acceptTaskOutboxDelivery(row, token, null, ref);
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
      await acceptTaskOutboxDelivery(row, token, current);
      return getTaskOutbox(row.id);
    }
    if (!canDispatch) {
      await finishTaskOutbox(row.id, token, "not-needed", null, { resultRef: current?.ref ?? row.resultRef, remoteSnapshot: current?.projection ?? null, uncertain: false });
      return getTaskOutbox(row.id);
    }
    // Never adopt a newer validator merely because the current read succeeded.
    // The native object must still match the captured accepted baseline.
    if (current && (current.ref.etag !== ref?.etag || saved.baseline && !sameTaskProjection(current.projection, saved.baseline))) throw new ProviderTaskWriteError("task-provider-conflict");
    await adapter.assertTaskWrite(row.userID, row.accountID, row.externalCalendarID, { action: row.action, task, external: ref, projection: target, secondary });
    if (row.action === "update" && !Object.keys(saved.patch).length && current) {
      await acceptTaskOutboxDelivery(row, token, current);
      return getTaskOutbox(row.id);
    }
    if (row.action === "create") resultRef = await adapter.pushTaskCreate(row.userID, row.accountID, row.externalCalendarID, task, mark);
    else if (row.action === "delete") {
      await adapter.pushTaskDelete(row.userID, row.accountID, row.externalCalendarID, ref!.externalTaskId, { ...ref!, beforeMutation: mark });
      await acceptTaskOutboxDelivery(row, token, null, ref);
      return getTaskOutbox(row.id);
    } else {
      const result = await adapter.pushTaskUpdate(row.userID, row.accountID, row.externalCalendarID, ref!.externalTaskId, task, { ...ref!, beforeMutation: mark }, saved.patch);
      resultRef = { ...ref!, ...result };
    }
    const observed = await adapter.readTask(row.userID, row.accountID, row.externalCalendarID, resultRef);
    if (!observed || !achieved(observed.projection, saved.patch)) throw new ProviderTaskWriteError("task-write-failed", "unconfirmed");
    await acceptTaskOutboxDelivery(row, token, observed);
    return getTaskOutbox(row.id);
  } catch (error) {
    const code = error instanceof ProviderTaskWriteError ? error.code : "task-write-failed";
    const definite = error instanceof ProviderTaskWriteError && (error.providerStatus != null && error.providerStatus < 500 || ["task-provider-conflict", "task-source-read-only", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-projection-unavailable"].includes(code));
    const definiteRejection = error instanceof ProviderTaskWriteError && error.providerStatus != null && error.providerStatus < 500;
    // A later permission failure or conflict does not prove that an earlier
    // interrupted request had no remote effect. Only observation can settle it.
    const uncertain = row.reconciling || error instanceof ProviderTaskWriteError && error.outcome === "unconfirmed" || dispatched && !definiteRejection;
    const status = uncertain ? "unconfirmed" : code === "task-provider-conflict" ? "conflict" : ["task-source-read-only", "task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-projection-unavailable"].includes(code) ? "blocked" : definite ? "not-written" : "retry";
    await finishTaskOutbox(row.id, token, status, code, { uncertain, resultRef: resultRef ?? row.resultRef, nextAttemptAt: new Date(Date.now() + 60_000) });
    return getTaskOutbox(row.id);
  } finally { clearInterval(renewal); }
}
