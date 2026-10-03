import { randomUUID } from "node:crypto";
import { and, asc, DrizzleQueryError, eq, inArray, isNull, sql, type SQLWrapper } from "drizzle-orm";
import { calendarSupportsTaskLinks, can, ForbiddenError, type TaskContentPatch } from "@musubi/types";
import { db } from "..";
import { calendarMembers, calendarTasks, externalCalendars, externalTasks, taskMutations, tasks, type NewTask, type TaskForkMutationRequest } from "../schema";
import { lockCalendarLifecycle, lockUserLifecycle } from "./calendar-lifecycle";
import type { DbTransaction } from "./calendars";
import { appendTaskOutbox, prepareTaskOutboxInTransaction, taskOutboxSnapshot,
  type TaskDeliveryAction, type TaskPreparedDestination } from "./task-outbox";

export type TaskMutation = Pick<NewTask,
  "calendarID" | "title" | "description" | "status" | "start" | "due" | "isAllDay" |
  "completedAt" | "percentComplete" | "priority" | "recurrence" | "relatedTo" | "url">;
export type TaskSnapshot = typeof tasks.$inferSelect & { calendars: string[] };
export type TaskWriteOptions = {
  actorID: string;
  expectedRevision: number;
  mutationID: string;
  expectedProviderReadRetiredGeneration?: number;
  preparedDestinations?: readonly TaskPreparedDestination[];
};
export type TaskCreateOptions = Omit<TaskWriteOptions, "expectedRevision">;

export class DuplicateTaskMutationError extends Error {
  constructor() { super("This save request has already been resolved. Refresh before trying again."); }
}

async function taskWriteTransaction<T>(write: (tx: DbTransaction) => Promise<T>): Promise<T> {
  try { return await db.transaction(write); }
  catch (error) {
    if (error instanceof DrizzleQueryError)
      throw new Error("Task persistence failed; local mutation was rolled back.");
    throw error;
  }
}

const contentFields = ["title", "description", "status", "start", "due", "isAllDay",
  "completedAt", "percentComplete", "priority", "recurrence", "relatedTo", "url"] as const;

export function taskContentPatch(values: Partial<TaskMutation>): TaskContentPatch {
  const patch: TaskContentPatch = {};
  for (const field of contentFields) if (values[field] !== undefined) Object.assign(patch, { [field]: values[field] });
  return patch;
}

export async function getTask(id: string) {
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt)));
  return task ?? null;
}

/** One statement snapshot; server-only membership list includes tombstones. */
export async function getTaskSnapshot(id: string): Promise<TaskSnapshot | null> {
  return readTaskSnapshot(db, id);
}
export async function getTaskSnapshotInTransaction(tx: DbTransaction, id: string): Promise<TaskSnapshot | null> {
  return readTaskSnapshot(tx, id);
}
async function readTaskSnapshot(executor: typeof db | DbTransaction, id: string): Promise<TaskSnapshot | null> {
  const row = await executor.query.tasks.findFirst({ where: eq(tasks.id, id), with: { calendarTasks: true } });
  if (!row) return null;
  const { calendarTasks: links, ...task } = row;
  return { ...task, calendars: links.map((link) => link.calendarID).sort() };
}

export async function getTaskCalendars(id: string) {
  const rows = await db.select({ calendarID: calendarTasks.calendarID }).from(calendarTasks)
    .where(eq(calendarTasks.taskID, id)).orderBy(asc(calendarTasks.calendarID));
  return rows.map((r) => r.calendarID);
}

export async function getTaskOrigin(id: string) {
  const [row] = await db.select({ originCalendarID: tasks.originCalendarID, creatorID: tasks.creatorID })
    .from(tasks).where(eq(tasks.id, id));
  return row;
}

/** The same source-aware read grant is used by task DTOs, receipts and titles.
 * A viewer grant permits reading; a retired/disabled projection does not. */
export function taskReadableMembership(userID: string, taskID: SQLWrapper | string,
  calendarID?: SQLWrapper | string) {
  return sql`exists (select 1 from calendar_tasks task_read_link
    join calendar_members task_read_member on task_read_member.calendar_id = task_read_link.calendar_id
      and task_read_member.user_id = ${userID}
    left join external_calendars task_read_source on task_read_source.calendar_id = task_read_link.calendar_id
    where task_read_link.task_id = ${taskID}
      ${calendarID === undefined ? sql`` : sql`and task_read_link.calendar_id = ${calendarID}`}
      and (task_read_source.id is null or (task_read_source.disabled = false and task_read_source.supports_tasks = true
        and coalesce(task_read_source.provider_access_role, '') not like 'caldav:read=no;%')))`;
}

export function taskCalendarReadAllowed(calendarID: SQLWrapper | string) {
  return sql`not exists (select 1 from external_calendars task_read_source
    where task_read_source.calendar_id = ${calendarID} and (task_read_source.disabled = true
      or task_read_source.supports_tasks = false
      or coalesce(task_read_source.provider_access_role, '') like 'caldav:read=no;%'))`;
}

/** A privacy counter never gives permission to serialize a redacted snapshot.
 * The home must be rehydrated by a fresh authorized native observation first. */
export function taskHomeRehydrated(taskID: SQLWrapper | string) {
  return sql`exists (select 1 from tasks task_home
    where task_home.id = ${taskID} and (coalesce(task_home.provider_read_retired_generation, 0) = 0
      or exists (select 1 from external_tasks task_home_map
        join external_calendars task_home_source on task_home_source.id = task_home_map.external_calendar_link_id
          and task_home_source.calendar_id = task_home.origin_calendar_id
          and task_home_source.account_id = task_home_map.account_id
          and task_home_source.provider = task_home_map.provider
          and task_home_source.external_calendar_id = task_home_map.external_calendar_id
          and task_home_source.provider_access_revision = task_home_map.provider_access_revision
        where task_home_map.task_id = task_home.id and task_home_map.calendar_id = task_home.origin_calendar_id
          and task_home_map.etag is not null and task_home_map.projection_baseline is not null
          and task_home_source.disabled = false and task_home_source.supports_tasks = true
          and coalesce(task_home_source.provider_access_role, '') not like 'caldav:read=no;%')))`;
}

async function userTaskRows(userID: string, id?: string) {
  const rows = await db.select({ task: tasks, calendarID: calendarTasks.calendarID, role: calendarMembers.role,
    homeRole: sql<string | null>`(select role from calendar_members home_member where home_member.user_id = ${userID} and home_member.calendar_id = ${tasks.originCalendarID})`,
    homeReadable: taskCalendarReadAllowed(tasks.originCalendarID).mapWith(Boolean),
    homeRehydrated: taskHomeRehydrated(tasks.id).mapWith(Boolean),
  }).from(tasks).innerJoin(calendarTasks, eq(calendarTasks.taskID, tasks.id))
    .innerJoin(calendarMembers, and(eq(calendarMembers.calendarID, calendarTasks.calendarID), eq(calendarMembers.userID, userID)))
    .where(and(isNull(tasks.deletedAt), taskCalendarReadAllowed(calendarTasks.calendarID), id ? eq(tasks.id, id) : undefined)).orderBy(asc(tasks.id), asc(calendarTasks.calendarID));
  const result = new Map<string, TaskSnapshot & { canEdit: boolean; canDelete: boolean; canShareContent: boolean; editableCalendarIDs: string[] }>();
  for (const row of rows) {
    const current = result.get(row.task.id);
    if (current) {
      current.calendars.push(row.calendarID);
      if (can(row.role, "editTasks")) current.editableCalendarIDs.push(row.calendarID);
    } else result.set(row.task.id, { ...row.task, calendars: [row.calendarID],
      canEdit: Boolean(row.task.originCalendarID) && row.homeReadable && row.homeRehydrated && can(row.homeRole, "editTasks"),
      canDelete: Boolean(row.task.originCalendarID) && can(row.homeRole, "editTasks"),
      canShareContent: row.homeRehydrated,
      editableCalendarIDs: can(row.role, "editTasks") ? [row.calendarID] : [],
    });
  }
  return [...result.values()];
}
export async function getUserTask(userID: string, id: string) { return (await userTaskRows(userID, id))[0] ?? null; }
export async function getUserTasks(userID: string) { return userTaskRows(userID); }

export async function reserveTaskMutation(tx: DbTransaction, actorID: string, mutationID: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["musubi:task-mutation", actorID, mutationID.toLowerCase()])}, 0))`);
  const [existing] = await tx.select({ taskID: taskMutations.taskID }).from(taskMutations)
    .where(and(eq(taskMutations.actorID, actorID), eq(taskMutations.mutationID, mutationID))).limit(1);
  if (existing) throw new DuplicateTaskMutationError();
}
function taskForkMutationRequest(sourceTaskID: string, targetCalendarID: string,
  options: Pick<TaskWriteOptions, "expectedRevision" | "expectedProviderReadRetiredGeneration">): TaskForkMutationRequest {
  return { sourceTaskID: sourceTaskID.toLowerCase(), targetCalendarID: targetCalendarID.toLowerCase(),
    expectedRevision: options.expectedRevision,
    expectedProviderReadRetiredGeneration: options.expectedProviderReadRetiredGeneration ?? 0 };
}

/** Recover only the authenticated actor's exact fork result. No stored content
 * is replayed: callers must fetch a fresh authorized copy before serializing it.
 * A changed source revision cannot invalidate an already committed copy. */
export async function getTaskForkReplay(sourceTaskID: string, targetCalendarID: string,
  options: Pick<TaskWriteOptions, "actorID" | "mutationID" | "expectedRevision" | "expectedProviderReadRetiredGeneration">) {
  const [previous] = await db.select().from(taskMutations)
    .where(and(eq(taskMutations.actorID, options.actorID), eq(taskMutations.mutationID, options.mutationID))).limit(1);
  if (!previous) return null;
  const request = taskForkMutationRequest(sourceTaskID, targetCalendarID, options);
  if (previous.operation !== "fork" || !previous.forkRequest ||
    (Object.keys(request) as (keyof TaskForkMutationRequest)[]).some(key => previous.forkRequest![key] !== request[key]))
    throw new DuplicateTaskMutationError();
  if (previous.forkOutcome === "not-committed") return { kind: "not-committed" as const };
  if (previous.forkOutcome !== "committed") throw new DuplicateTaskMutationError();
  return { kind: "committed" as const, taskID: previous.taskID, revision: previous.revision };
}

async function recordTaskForkRejection(tx: DbTransaction, sourceTaskID: string, targetCalendarID: string, options: TaskWriteOptions) {
  await tx.insert(taskMutations).values({ actorID: options.actorID, mutationID: options.mutationID,
    taskID: sourceTaskID, revision: options.expectedRevision, operation: "fork", forkOutcome: "not-committed",
    forkRequest: taskForkMutationRequest(sourceTaskID, targetCalendarID, options) });
}

/** Permanently close an unused original fork key before certifying noncommit.
 * A delayed request with that key can never create a copy after this proof.
 * A concurrent commit wins the same mutation lock and is reconciled instead. */
export async function rejectTaskFork(sourceTaskID: string, targetCalendarID: string, options: TaskWriteOptions) {
  validateRevision(options.expectedRevision);
  return taskWriteTransaction(async tx => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    const before = await getTaskSnapshotInTransaction(tx, sourceTaskID);
    await lockCalendarLifecycle(tx, [...(before?.calendars ?? []), targetCalendarID], "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    await recordTaskForkRejection(tx, sourceTaskID, targetCalendarID, options);
  });
}

async function recordMutation(tx: DbTransaction, task: TaskSnapshot,
  options: Pick<TaskWriteOptions, "actorID" | "mutationID">, operation: typeof taskMutations.$inferInsert["operation"],
  forkRequest?: TaskForkMutationRequest) {
  await tx.insert(taskMutations).values({ actorID: options.actorID, mutationID: options.mutationID, taskID: task.id, revision: task.revision, operation, forkRequest, forkOutcome: forkRequest ? "committed" : undefined });
}

/** Permission rows remain share-locked through commit. Caller already holds
 * lifecycle fences followed by canonical row locks; target rights never grant
 * authority over home content or completion. */
async function memberRoles(tx: DbTransaction, actorID: string, calendarIDs: string[]) {
  if (!calendarIDs.length) return new Map<string, string>();
  const rows = await tx.select().from(calendarMembers).where(and(eq(calendarMembers.userID, actorID),
    inArray(calendarMembers.calendarID, [...new Set(calendarIDs)]))).orderBy(asc(calendarMembers.calendarID)).for("share");
  return new Map(rows.map((row) => [row.calendarID, row.role]));
}
async function assertTargetWrite(tx: DbTransaction, actorID: string, calendarID: string, allowUnavailable = false) {
  const roles = await memberRoles(tx, actorID, [calendarID]);
  if (!can(roles.get(calendarID), "editTasks")) throw new ForbiddenError("Task editing is not permitted on this calendar.");
  const [source] = await tx.select().from(externalCalendars).where(eq(externalCalendars.calendarID, calendarID)).for("share");
  if (!allowUnavailable && source && (source.disabled || !source.supportsTasks || source.providerAccessRole?.startsWith("caldav:read=no;")))
    throw new ForbiddenError("This calendar does not permit task writes.");
  return source;
}
async function assertVisible(tx: DbTransaction, actorID: string, task: TaskSnapshot) {
  const roles = await memberRoles(tx, actorID, task.calendars);
  const [visible] = await tx.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.id, task.id), taskReadableMembership(actorID, tasks.id)));
  if (!roles.size || !visible) throw new ForbiddenError("Task is not accessible.");
}
async function assertSourceRehydrated(tx: DbTransaction, task: TaskSnapshot) {
  const [restored] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, task.id), taskHomeRehydrated(tasks.id)));
  if (!restored) throw new ForbiddenError("Refresh the task home before sharing its content.");
}
async function assertHomeWrite(tx: DbTransaction, actorID: string, task: TaskSnapshot, allowUnavailable = false) {
  if (!task.originCalendarID) throw new ForbiddenError("The task home is unavailable.");
  await assertTargetWrite(tx, actorID, task.originCalendarID, allowUnavailable);
  if (!allowUnavailable) {
    const [restored] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, task.id), taskHomeRehydrated(tasks.id)));
    if (!restored) throw new ForbiddenError("Refresh the task home before changing its content.");
  }
}

function validateRevision(revision: number) {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("A positive expected task revision is required.");
}
async function lockedSnapshot(tx: DbTransaction, id: string): Promise<TaskSnapshot | null> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  if (!task) return null;
  const links = await tx.select().from(calendarTasks).where(eq(calendarTasks.taskID, id)).orderBy(asc(calendarTasks.calendarID));
  return { ...task, calendars: links.map((link) => link.calendarID) };
}
async function saveWithDelivery(tx: DbTransaction, task: TaskSnapshot, actions: TaskDeliveryAction[],
  options: Pick<TaskWriteOptions, "actorID" | "mutationID" | "preparedDestinations">,
  operation: typeof taskMutations.$inferInsert["operation"], forkRequest?: TaskForkMutationRequest) {
  const wire = taskOutboxSnapshot(task, task.calendars);
  const intents = await prepareTaskOutboxInTransaction(tx, wire, actions, options, options.preparedDestinations);
  await appendTaskOutbox(tx, wire, intents);
  await recordMutation(tx, task, { actorID: options.actorID, mutationID: options.mutationID }, operation, forkRequest);
  return task;
}

export async function createTaskInTransaction(tx: DbTransaction,
  values: TaskMutation & Pick<NewTask, "id" | "creatorID">) {
  if (!values.calendarID) throw new Error("A task home calendar is required.");
  const [task] = await tx.insert(tasks).values({
    ...taskContentPatch(values), id: values.id, creatorID: values.creatorID,
    title: values.title, calendarID: values.calendarID, originCalendarID: values.calendarID,
    revision: 1, providerReadRetiredGeneration: null,
  }).onConflictDoNothing({ target: tasks.id }).returning();
  if (!task) throw new DuplicateTaskMutationError();
  await tx.insert(calendarTasks).values({ taskID: task.id, calendarID: values.calendarID });
  return { ...task, calendars: [values.calendarID] };
}
export async function createTask(values: TaskMutation & Pick<NewTask, "id" | "creatorID">,
  options: TaskCreateOptions = { actorID: values.creatorID, mutationID: randomUUID() }) {
  if (!values.calendarID) throw new Error("A task home calendar is required.");
  if (values.creatorID !== options.actorID) throw new ForbiddenError("Task creator must match the authenticated actor.");
  return taskWriteTransaction(async (tx) => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    await lockCalendarLifecycle(tx, [values.calendarID!], "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    await assertTargetWrite(tx, options.actorID, values.calendarID!);
    const created = await createTaskInTransaction(tx, values);
    return saveWithDelivery(tx, created, [{ calendarID: values.calendarID!, action: "create" }], options, "create");
  });
}

/** Home identity and membership are changed only by dedicated operations. A
 * partial patch cannot accidentally reset links or carry another creator/rev. */
export async function updateTask(id: string, values: TaskContentPatch | TaskMutation, options: TaskWriteOptions): Promise<TaskSnapshot | null> {
  validateRevision(options.expectedRevision);
  return taskWriteTransaction(async (tx) => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    const before = await getTaskSnapshotInTransaction(tx, id);
    if (!before) return null;
    await lockCalendarLifecycle(tx, before.calendars, "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    const current = await lockedSnapshot(tx, id);
    if (!current || current.deletedAt || current.revision !== options.expectedRevision) return null;
    await assertHomeWrite(tx, options.actorID, current);
    if ((current.providerReadRetiredGeneration ?? 0) !== (options.expectedProviderReadRetiredGeneration ?? 0)) return null;
    const patch = taskContentPatch(values);
    const [task] = await tx.update(tasks).set({ ...patch, revision: current.revision + 1,
      sequence: sql`${tasks.sequence} + 1` }).where(and(eq(tasks.id, id), eq(tasks.revision, options.expectedRevision), isNull(tasks.deletedAt))).returning();
    if (!task) return null;
    return saveWithDelivery(tx, { ...task, calendars: current.calendars },
      current.calendars.map((calendarID) => ({ calendarID, action: "update" })), options, "update");
  });
}

export async function linkTask(id: string, calendarID: string, options: TaskWriteOptions): Promise<TaskSnapshot | null> {
  validateRevision(options.expectedRevision);
  return taskWriteTransaction(async (tx) => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    const before = await getTaskSnapshotInTransaction(tx, id);
    if (!before) return null;
    await lockCalendarLifecycle(tx, [...before.calendars, calendarID], "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    const current = await lockedSnapshot(tx, id);
    if (!current || current.deletedAt || current.revision !== options.expectedRevision) return null;
    await assertVisible(tx, options.actorID, current);
    await assertSourceRehydrated(tx, current);
    const target = await assertTargetWrite(tx, options.actorID, calendarID);
    if (!current.calendars.includes(calendarID) && !calendarSupportsTaskLinks({
      provider: target?.provider, supportsTasks: target?.supportsTasks ?? true,
    })) throw new ForbiddenError("This provider does not support live task links. Copy the task instead.");
    if ((current.providerReadRetiredGeneration ?? 0) !== (options.expectedProviderReadRetiredGeneration ?? 0)) return null;
    if (current.calendars.includes(calendarID)) {
      await recordMutation(tx, current, options, "link");
      return current;
    }
    await tx.insert(calendarTasks).values({ taskID: id, calendarID });
    const [task] = await tx.update(tasks).set({ revision: current.revision + 1 }).where(eq(tasks.id, id)).returning();
    return saveWithDelivery(tx, { ...task, calendars: [...current.calendars, calendarID].sort() }, [{ calendarID, action: "create" }], options, "link");
  });
}

export async function unlinkTask(id: string, calendarID: string, options: TaskWriteOptions): Promise<TaskSnapshot | null> {
  validateRevision(options.expectedRevision);
  return taskWriteTransaction(async (tx) => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    const before = await getTaskSnapshotInTransaction(tx, id);
    if (!before) return null;
    await lockCalendarLifecycle(tx, [...before.calendars, calendarID], "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    const current = await lockedSnapshot(tx, id);
    if (!current || current.deletedAt || current.revision !== options.expectedRevision) return null;
    await assertVisible(tx, options.actorID, current);
    await assertTargetWrite(tx, options.actorID, calendarID, true);
    if ((current.providerReadRetiredGeneration ?? 0) !== (options.expectedProviderReadRetiredGeneration ?? 0)) return null;
    if (calendarID === current.originCalendarID) throw new ForbiddenError("Delete the shared task through its home instead of unlinking home.");
    if (!current.calendars.includes(calendarID)) { await recordMutation(tx, current, options, "unlink"); return current; }
    const [task] = await tx.update(tasks).set({ revision: current.revision + 1 }).where(eq(tasks.id, id)).returning();
    // Capture and persist delete before removing mapping/link. Never erase the
    // address needed to undo a successful but not-yet-acknowledged CREATE.
    const result = await saveWithDelivery(tx, { ...task, calendars: current.calendars.filter((c) => c !== calendarID) }, [{ calendarID, action: "delete" }], options, "unlink");
    await tx.delete(calendarTasks).where(and(eq(calendarTasks.taskID, id), eq(calendarTasks.calendarID, calendarID)));
    await tx.delete(externalTasks).where(and(eq(externalTasks.taskID, id), eq(externalTasks.calendarID, calendarID)));
    return result;
  });
}

export async function forkTask(id: string, target: { id: string; calendarID: string }, options: TaskWriteOptions): Promise<TaskSnapshot | null> {
  validateRevision(options.expectedRevision);
  return taskWriteTransaction(async (tx) => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    const before = await getTaskSnapshotInTransaction(tx, id);
    if (!before) return null;
    await lockCalendarLifecycle(tx, [...before.calendars, target.calendarID], "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    const source = await lockedSnapshot(tx, id);
    if (!source || source.deletedAt || source.revision !== options.expectedRevision) {
      await recordTaskForkRejection(tx, id, target.calendarID, options);
      return null;
    }
    await assertVisible(tx, options.actorID, source);
    await assertSourceRehydrated(tx, source);
    await assertTargetWrite(tx, options.actorID, target.calendarID);
    if ((source.providerReadRetiredGeneration ?? 0) !== (options.expectedProviderReadRetiredGeneration ?? 0)) {
      await recordTaskForkRejection(tx, id, target.calendarID, options);
      return null;
    }
    const copy = await createTaskInTransaction(tx, { ...taskContentPatch(source), title: source.title,
      id: target.id, calendarID: target.calendarID, creatorID: options.actorID });
    return saveWithDelivery(tx, copy, [{ calendarID: target.calendarID, action: "create" }], options, "fork",
      taskForkMutationRequest(id, target.calendarID, options));
  });
}

export async function removeTask(id: string, options: TaskWriteOptions): Promise<TaskSnapshot | null> {
  validateRevision(options.expectedRevision);
  return taskWriteTransaction(async (tx) => {
    await lockUserLifecycle(tx, [options.actorID], "shared");
    const before = await getTaskSnapshotInTransaction(tx, id);
    if (!before) return null;
    await lockCalendarLifecycle(tx, before.calendars, "shared");
    await reserveTaskMutation(tx, options.actorID, options.mutationID);
    const current = await lockedSnapshot(tx, id);
    if (!current || current.deletedAt || current.revision !== options.expectedRevision) return null;
    await assertHomeWrite(tx, options.actorID, current, true);
    const [task] = await tx.update(tasks).set({ revision: current.revision + 1, deletedAt: new Date() }).where(eq(tasks.id, id)).returning();
    return saveWithDelivery(tx, { ...task, calendars: current.calendars },
      current.calendars.map((calendarID) => ({ calendarID, action: "delete" })), options, "delete");
  });
}
