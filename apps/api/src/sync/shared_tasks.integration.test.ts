import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TaskSchema, type Task } from "@musubi/types";
import { calendarMembers, calendars, calendarTasks, db, externalCalendars, externalTasks, tasks, taskOutbox, user, upsertExternalTask, deleteExternalTask, getExternalTask, getUserTask, updateTask, appendTaskOutbox, prepareTaskOutboxInTransaction, type TaskOutboxRow } from "@musubi/db";
import type { CalendarAdapter, TaskReadEvidence } from "./adapter";
import { deliverTaskOutbox } from "./task_delivery";
import { toGoogleTask } from "./adapters/google";
import { caldavAdapter, toVtodo, vtodoToFields } from "./adapters/caldav";
import { canonicalTaskProjection } from "./task_write";
import type { TaskProjection } from "./adapter";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "This fixture uses only a disposable test database");
  const owner = `task-projection-${randomUUID()}`, reader = `task-reader-${randomUUID()}`;
  const home = randomUUID(), target = randomUUID(), accountHome = randomUUID(), accountTarget = randomUUID();
  const collection = "musubi-google-task-list:same-external-list";
  await db.insert(user).values([{ id: owner, name: "Task owner", email: `${owner}@example.test` }, { id: reader, name: "Task reader", email: `${reader}@example.test` }]);
  await db.insert(calendars).values([{ id: home, creatorID: owner, name: "Home", color: "#B3A48A" }, { id: target, creatorID: reader, name: "Target", color: "#B3A48A" }]);
  await db.insert(calendarMembers).values([{ calendarID: home, userID: owner, role: "owner" }, { calendarID: target, userID: reader, role: "owner" }]);
  const sources = await db.insert(externalCalendars).values([{ calendarID: home, provider: "google", userID: owner, accountID: accountHome, externalCalendarID: collection, supportsEvents: false, supportsTasks: true }, { calendarID: target, provider: "google", userID: reader, accountID: accountTarget, externalCalendarID: collection, supportsEvents: false, supportsTasks: true }]).returning();
  const source = (calendarID: string) => sources.find(value => value.calendarID === calendarID)!;
  const scope = (calendarID: string) => ({ sourceID: source(calendarID).id, accountID: source(calendarID).accountID, providerAccessRevision: 0 });
  const native = new Map<string, TaskReadEvidence>();
  const key = (accountID: string, id: string) => `${accountID}:${id}`;
  let serial = 0, creates = 0, deletes = 0;
  let beforeReturn: (() => Promise<void>) | undefined;
  let loseCreateResponse = false;
  let preflightFailure = false;
  let projectTask: (task: Task) => TaskProjection = toGoogleTask;
  let nativeProjectTask: (task: Task) => TaskProjection = toGoogleTask;
  const adapter = {
    projectTask: (task: Task) => projectTask(task),
    async assertTaskWrite() { if (preflightFailure) throw new Error("Fixture temporary OAuth failure"); },
    async readTask(_u: string, a: string, _c: string, ref: { externalTaskId: string }) { return native.get(key(a, ref.externalTaskId)) ?? null; },
    async pushTaskCreate(_u: string, a: string, _c: string, task: Task, mark?: () => Promise<void>) {
      await mark?.(); creates++;
      const ref = { externalTaskId: `copy-${task.id}`, etag: `"version-${++serial}"` };
      native.set(key(a, ref.externalTaskId), { ref, projection: nativeProjectTask(task) });
      await beforeReturn?.();
      if (loseCreateResponse) throw new Error("Fixture lost the accepted response");
      return ref;
    },
    async pushTaskUpdate(_u: string, a: string, _c: string, id: string, _task: Task, ref: { beforeMutation?: () => Promise<void> }, patch: Record<string, unknown>) {
      await ref.beforeMutation?.();
      const current = native.get(key(a, id))!;
      const updated = { externalTaskId: id, etag: `"version-${++serial}"` };
      const wire = nativeProjectTask(_task);
      const written = Object.fromEntries(Object.keys(patch).map(field => [field, wire[field]]));
      native.set(key(a, id), { ref: updated, projection: { ...current.projection, ...written } });
      await beforeReturn?.();
      return updated;
    },
    async pushTaskDelete(_u: string, a: string, _c: string, id: string, ref: { beforeMutation?: () => Promise<void> }) { await ref.beforeMutation?.(); deletes++; native.delete(key(a, id)); },
  } as unknown as CalendarAdapter;
  const adapterFor = () => adapter;
  const readTask = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const addTask = async (title = "Canonical task") => {
    const [row] = await db.insert(tasks).values({ id: randomUUID(), creatorID: owner, calendarID: home, originCalendarID: home, title, status: "in-process", due: new Date("2026-10-01T14:45:00Z"), priority: 2 }).returning();
    await db.insert(calendarTasks).values([{ taskID: row.id, calendarID: home }, { taskID: row.id, calendarID: target }]);
    return TaskSchema.parse({ ...row, calendarIDs: [home, target] });
  };
  const addMapping = async (task: Task, calendarID: string, id: string, tag: string) => {
    const selected = source(calendarID);
    const projection = toGoogleTask(task);
    native.set(key(selected.accountID, id), { ref: { externalTaskId: id, etag: tag }, projection });
    await db.insert(externalTasks).values({ provider: "google", taskID: task.id, calendarID, externalCalendarID: collection, externalTaskID: id, etag: tag, accountID: selected.accountID, externalCalendarLinkID: selected.id, projectionBaseline: projection });
  };
  const addIntent = async (task: Task, calendarID: string, action: TaskOutboxRow["action"], ref?: { externalTaskId: string; etag?: string | null }, predecessorID?: string) => {
    const selected = source(calendarID), id = randomUUID();
    await db.insert(taskOutbox).values({ id, actorID: owner, mutationID: randomUUID(), position: 0, taskID: task.id, revision: task.revision ?? 1, predecessorID, calendarID, externalCalendarLinkID: selected.id, provider: selected.provider, userID: selected.userID, accountID: selected.accountID, externalCalendarID: collection, externalTaskID: ref?.externalTaskId ?? null, expectedEtag: ref?.etag ?? null, providerAccessRevision: selected.providerAccessRevision, retiredGeneration: task.providerReadRetiredGeneration ?? 0, action, payload: { task } });
    return id;
  };
  const observed = (title: string) => ({ title, description: null, status: "needs-action" as const, start: null, due: new Date("2026-10-01T00:00:00Z"), isAllDay: true, completedAt: null, percentComplete: 0, priority: 0, recurrence: null, relatedTo: null, sequence: 0, url: null });
  try {
    const shared = await addTask();
    await addMapping(shared, home, "same-remote-id", '"home-v1"');
    await addMapping(shared, target, "same-remote-id", '"secondary-v1"');
    assert.equal((await getExternalTask("google", shared.id, collection, home, scope(home)))?.etag, '"home-v1"');
    assert.equal((await getExternalTask("google", shared.id, collection, target, scope(target)))?.etag, '"secondary-v1"');
    await assert.rejects(getExternalTask("google", shared.id, collection), /Ambiguous/);
    await upsertExternalTask("google", reader, target, collection, "same-remote-id", { ...observed("Foreign secondary edit"), status: "completed" }, '"secondary-v2"', null, undefined, scope(target), { ...toGoogleTask(shared), title: "Foreign secondary edit", status: "completed" });
    assert.equal((await readTask(shared.id)).title, shared.title);
    assert.equal((await readTask(shared.id)).status, "in-process");
    await deleteExternalTask("google", target, "same-remote-id", undefined, scope(target));
    assert.equal((await readTask(shared.id)).deletedAt, null, "Removing a secondary native copy cannot globally delete the task");
    await upsertExternalTask("google", owner, home, collection, "same-remote-id", observed("Home edit"), '"home-v2"', null, undefined, scope(home), { ...toGoogleTask(shared), title: "Home edit" });
    const edited = await readTask(shared.id);
    assert.equal(edited.title, "Home edit");
    assert.equal(edited.status, "in-process", "A lossy unchanged status cannot overwrite canonical progress");
    assert.equal(edited.due!.toISOString(), "2026-10-01T14:45:00.000Z");
    assert.equal(edited.priority, 2);
    assert.equal((await db.select().from(taskOutbox).where(and(eq(taskOutbox.taskID, shared.id), eq(taskOutbox.calendarID, target)))).length, 1, "Home pull commits a secondary fanout intent atomically");

    const uncertain = await addTask("Uncertain create");
    const uncertainID = await addIntent(uncertain, target, "create");
    loseCreateResponse = true;
    assert.equal((await deliverTaskOutbox(uncertainID, adapterFor))?.status, "unconfirmed");
    const count = creates;
    await db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, uncertainID));
    assert.equal((await deliverTaskOutbox(uncertainID, adapterFor))?.status, "unconfirmed");
    assert.equal(creates, count, "An unknown Google CREATE is never blindly replayed");
    assert.equal(await upsertExternalTask("google", reader, target, collection, `copy-${uncertain.id}`, observed("Unmapped accepted copy"), '"unknown-v1"', null, undefined, scope(target), toGoogleTask(uncertain)), false);
    await db.update(taskOutbox).set({ status: "cancelled" }).where(eq(taskOutbox.id, uncertainID));
    loseCreateResponse = false;

    const detached = await addTask("Detach while creating");
    const createID = await addIntent(detached, target, "create");
    beforeReturn = () => db.delete(calendarTasks).where(and(eq(calendarTasks.taskID, detached.id), eq(calendarTasks.calendarID, target))).then(() => undefined);
    const concurrent = await Promise.all([deliverTaskOutbox(createID, adapterFor), deliverTaskOutbox(createID, adapterFor)]);
    assert.equal(concurrent.filter(value => value?.status === "completed").length, 1);
    beforeReturn = undefined;
    assert.equal((await db.select().from(externalTasks).where(eq(externalTasks.taskID, detached.id))).length, 0, "Late ACK stores evidence without resurrecting the attachment");
    const deleteID = await addIntent(detached, target, "delete", undefined, createID);
    assert.equal((await deliverTaskOutbox(deleteID, adapterFor))?.status, "completed");
    assert.ok(deletes);
    const taskCount = (await db.select().from(tasks).where(eq(tasks.creatorID, owner))).length;
    assert.equal(await upsertExternalTask("google", reader, target, collection, `copy-${detached.id}`, observed("Late deleted copy"), '"late-v1"', null, undefined, scope(target), toGoogleTask(detached)), false);
    assert.equal((await db.select().from(tasks).where(eq(tasks.creatorID, owner))).length, taskCount);

    const globallyDeleted = await addTask("Global deletion");
    await addMapping(globallyDeleted, home, "global-remote", '"global-v1"');
    await db.update(tasks).set({ deletedAt: new Date(), revision: 2 }).where(eq(tasks.id, globallyDeleted.id));
    const globalDeleteID = await addIntent({ ...globallyDeleted, revision: 2 }, home, "delete", { externalTaskId: "global-remote", etag: '"global-v1"' });
    assert.equal(await upsertExternalTask("google", owner, home, collection, "global-remote", observed("Must not revive"), '"global-late"', null, undefined, scope(home), toGoogleTask(globallyDeleted)), false);
    assert.ok((await readTask(globallyDeleted.id)).deletedAt);
    assert.equal((await deliverTaskOutbox(globalDeleteID, adapterFor))?.status, "completed");
    assert.equal(await upsertExternalTask("google", owner, home, collection, "global-remote", observed("No new canonical identity"), '"global-late"', null, undefined, scope(home), toGoogleTask(globallyDeleted)), false);

    const ordered = await addTask("Before local write");
    await addMapping(ordered, home, "ordered-remote", '"ordered-v1"');
    const readStartedAt = new Date();
    await db.update(tasks).set({ title: "Committed local write", revision: 2 }).where(eq(tasks.id, ordered.id));
    const updateID = await addIntent({ ...ordered, title: "Committed local write", revision: 2 }, home, "update", { externalTaskId: "ordered-remote", etag: '"ordered-v1"' });
    assert.equal((await deliverTaskOutbox(updateID, adapterFor))?.status, "completed");
    assert.equal(await upsertExternalTask("google", owner, home, collection, "ordered-remote", observed("Before local write"), '"ordered-v1"', null, undefined, { ...scope(home), readStartedAt }, toGoogleTask(ordered)), false);
    assert.equal((await readTask(ordered.id)).title, "Committed local write", "A pull begun before ACK cannot roll the canonical task back");

    const superseded = await addTask("Remote baseline");
    await addMapping(superseded, home, "superseded-remote", '"superseded-v1"');
    await db.update(tasks).set({ title: "Accepted inflight write", revision: 2 }).where(eq(tasks.id, superseded.id));
    const inflightID = await addIntent({ ...superseded, title: "Accepted inflight write", revision: 2 }, home, "update", { externalTaskId: "superseded-remote", etag: '"superseded-v1"' });
    let skippedID = "", supersededDeleteID = "";
    beforeReturn = async () => {
      const skipped = { ...superseded, title: "Never dispatched local revision", revision: 3 };
      skippedID = await addIntent(skipped, home, "update", { externalTaskId: "superseded-remote", etag: '"superseded-v1"' }, inflightID);
      await db.update(tasks).set({ title: skipped.title, revision: 4, deletedAt: new Date() }).where(eq(tasks.id, superseded.id));
      supersededDeleteID = await addIntent({ ...skipped, revision: 4 }, home, "delete", { externalTaskId: "superseded-remote", etag: '"superseded-v1"' }, skippedID);
    };
    assert.equal((await deliverTaskOutbox(inflightID, adapterFor))?.status, "completed");
    beforeReturn = undefined;
    assert.equal((await deliverTaskOutbox(skippedID, adapterFor))?.status, "not-needed");
    assert.equal((await deliverTaskOutbox(supersededDeleteID, adapterFor))?.status, "completed", "Delete adopts the last accepted address and baseline across skipped revisions");
    assert.equal(native.has(key(accountHome, "superseded-remote")), false);

    const retired = await addTask("Private queued content");
    const retiredID = await addIntent(retired, target, "create");
    beforeReturn = () => db.update(tasks).set({ title: "Private task", description: null, providerReadRetiredGeneration: 1, revision: 2 }).where(eq(tasks.id, retired.id)).then(() => undefined);
    assert.equal((await deliverTaskOutbox(retiredID, adapterFor))?.status, "blocked");
    assert.equal((await db.select().from(externalTasks).where(eq(externalTasks.taskID, retired.id))).length, 0, "A late accepted response cannot restore a retired private mirror");
    beforeReturn = undefined;

    const transient = await addTask("Recover OAuth");
    const transientID = await addIntent(transient, target, "create");
    await db.update(taskOutbox).set({ payload: { task: transient, providerProjection: { version: 1, projection: {}, patch: {}, baseline: null, errorCode: "task-write-failed" } } }).where(eq(taskOutbox.id, transientID));
    preflightFailure = true;
    assert.equal((await deliverTaskOutbox(transientID, adapterFor))?.status, "retry");
    preflightFailure = false;
    await db.update(taskOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(taskOutbox.id, transientID));
    assert.equal((await deliverTaskOutbox(transientID, adapterFor))?.status, "completed", "A transient preflight report cannot freeze a recovered source forever");

    const obsolete = await addTask("Obsolete uncertain admission");
    const obsoleteID = await addIntent(obsolete, target, "create");
    loseCreateResponse = true;
    assert.equal((await deliverTaskOutbox(obsoleteID, adapterFor))?.status, "unconfirmed");
    loseCreateResponse = false;
    await db.update(tasks).set({ providerReadRetiredGeneration: 1, revision: 2 }).where(eq(tasks.id, obsolete.id));
    assert.equal(await upsertExternalTask("google", reader, target, collection, "restored-unrelated-task", observed("New task after read restoration"), '"restored-v1"', null, undefined, scope(target), { ...toGoogleTask(obsolete), title: "New task after read restoration" }), true, "An obsolete privacy generation cannot block the entire restored task list");
    assert.equal((await db.select().from(taskOutbox).where(eq(taskOutbox.id, obsoleteID)))[0]!.uncertain, true, "The old unknown effect remains visible rather than being silently cancelled");

    const restored = await addTask("Recover retired source");
    const staleID = await addIntent(restored, target, "create");
    await db.update(externalCalendars).set({ disabled: true, providerAccessRevision: 1 }).where(eq(externalCalendars.id, source(target).id));
    const blocked = await deliverTaskOutbox(staleID, adapterFor);
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.uncertain, false);
    await db.update(externalCalendars).set({ disabled: false, providerAccessRevision: 2 }).where(eq(externalCalendars.id, source(target).id));
    source(target).providerAccessRevision = 2;
    await db.update(tasks).set({ providerReadRetiredGeneration: 1, revision: 2 }).where(eq(tasks.id, restored.id));
    const currentRestored = TaskSchema.parse({ ...await readTask(restored.id), calendarIDs: [home, target] });
    const fresh = await db.transaction(async tx => {
      const intents = await prepareTaskOutboxInTransaction(tx, currentRestored, [{ calendarID: target, action: "update" }], { actorID: owner, mutationID: randomUUID() });
      assert.equal(intents[0]?.action, "create", "Restoring an uncreated copy prepares CREATE after a proven-not-written stale admission");
      await appendTaskOutbox(tx, currentRestored, intents);
      return intents[0]!.id!;
    });
    assert.equal((await deliverTaskOutbox(fresh, adapterFor))?.status, "completed", "A proven-not-written stale predecessor cannot stop fresh delivery after restoration");

    const homeRetired = await addTask("Home before privacy retirement");
    await addMapping(homeRetired, home, "rehydrate-home", '"home-before-retirement"');
    await db.update(externalCalendars).set({ disabled: true, providerAccessRevision: 1 }).where(eq(externalCalendars.id, source(home).id));
    await db.update(tasks).set({ title: "Private task", description: null, providerReadRetiredGeneration: 1, revision: 2 }).where(eq(tasks.id, homeRetired.id));
    await db.update(externalTasks).set({ etag: null, projectionBaseline: null }).where(eq(externalTasks.taskID, homeRetired.id));
    await db.update(externalCalendars).set({ disabled: false, providerAccessRevision: 2 }).where(eq(externalCalendars.id, source(home).id));
    assert.equal((await getUserTask(owner, homeRetired.id))?.canEdit, false, "A restored grant alone cannot publish the private placeholder");
    await assert.rejects(upsertExternalTask("google", owner, home, collection, "rehydrate-home", observed("Rejected stale pull"), '"home-restored"', null, undefined, scope(home), toGoogleTask(homeRetired)), /source access changed/);
    await assert.rejects(updateTask(homeRetired.id, { title: "Must not serialize the placeholder" }, { actorID: owner, mutationID: randomUUID(), expectedRevision: 2, expectedProviderReadRetiredGeneration: 1 }), /Refresh the task home/);
    assert.equal((await readTask(homeRetired.id)).title, "Private task");
    const restoredHomeScope = { ...scope(home), providerAccessRevision: 2 };
    assert.equal(await upsertExternalTask("google", owner, home, collection, "rehydrate-home", observed("Authorized native restoration"), '"home-restored"', null, undefined, restoredHomeScope, { ...toGoogleTask(homeRetired), title: "Authorized native restoration" }), true);
    const rehydrated = await getUserTask(owner, homeRetired.id);
    assert.equal(rehydrated?.canEdit, true);
    assert.equal(rehydrated?.title, "Authorized native restoration");
    assert.ok(await updateTask(homeRetired.id, { title: "Edit after authorized restoration" }, { actorID: owner, mutationID: randomUUID(), expectedRevision: rehydrated!.revision, expectedProviderReadRetiredGeneration: 1 }), "Fresh native home evidence re-enables authorized writes");

    await db.update(externalCalendars).set({ provider: "caldav" }).where(eq(externalCalendars.id, source(home).id));
    source(home).provider = "caldav";
    source(home).providerAccessRevision = 2;
    projectTask = caldavAdapter.projectTask!;
    nativeProjectTask = task => canonicalTaskProjection(vtodoToFields(toVtodo(task)));
    const caldavCompletion = await addTask("VTODO completion precision");
    const caldavCreateID = await addIntent(caldavCompletion, home, "create");
    const createdVtodo = await deliverTaskOutbox(caldavCreateID, adapterFor);
    assert.equal(createdVtodo?.status, "completed");
    const completionTime = new Date("2026-09-30T15:54:02.972Z");
    await db.update(tasks).set({ status: "completed", completedAt: completionTime, percentComplete: 100, revision: 2, sequence: 1 }).where(eq(tasks.id, caldavCompletion.id));
    const completedVtodo = TaskSchema.parse({ ...await readTask(caldavCompletion.id), calendarIDs: [home, target] });
    const completionID = await addIntent(completedVtodo, home, "update", createdVtodo!.resultRef!, caldavCreateID);
    assert.equal((await deliverTaskOutbox(completionID, adapterFor))?.status, "completed", "A successful second-precision VTODO completion must not remain unconfirmed");
    assert.equal((await readTask(caldavCompletion.id)).completedAt?.toISOString(), completionTime.toISOString());
    await db.update(tasks).set({ revision: 3, deletedAt: new Date() }).where(eq(tasks.id, caldavCompletion.id));
    const completedDeleteID = await addIntent({ ...completedVtodo, revision: 3 }, home, "delete", createdVtodo!.resultRef!, completionID);
    assert.equal((await deliverTaskOutbox(completedDeleteID, adapterFor))?.status, "completed", "Native deletion follows the acknowledged completion projection");
    assert.equal(native.has(key(accountHome, createdVtodo!.resultRef!.externalTaskId)), false);
    console.log("Shared task origin authority, scoped projections, durable delivery, unknown CREATE, deletion/read races and privacy ACK fences: OK");
  } finally {
    await db.delete(user).where(eq(user.id, owner));
    await db.delete(user).where(eq(user.id, reader));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
