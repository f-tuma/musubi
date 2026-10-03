import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "@musubi/config";
import {
  BadRequestError, ForbiddenError, NotFoundError, calendarSupportsTaskLinks, TaskCreateSchema, TaskDeleteRequestSchema,
  TASK_FORK_NOT_COMMITTED_CODE, TaskLinkRequestSchema, TaskPatchRequestSchema, TaskSchema, TaskUpdateSchema,
  type Task, type TaskContentPatch, type TaskCreate, type TaskUpdate,
} from "@musubi/types";
import {
  createTask, DuplicateTaskMutationError, forkTask, getTaskForkReplay, getCalendarMembers, getExternalLinkForCalendar, getTaskDeliveryStatus,
  getTaskMutationOutboxIDs, getTaskSnapshot, getUserTask, getUserTasks, linkTask, rejectTaskFork, removeTask,
  taskOutboxSnapshot, unlinkTask, updateTask, type TaskMutation, type TaskSnapshot,
} from "@musubi/db";
import { assertCan } from "../permissions";
import { requireUUID } from "../request_validation";
import { deliverTaskOutbox, prepareTaskWrites } from "../sync/engine";
import { notifyCalendarMembers } from "./stream";

function normalizeCompletion<T extends TaskCreate | TaskUpdate>(task: T): T {
  return task.status === "completed" ? { ...task, completedAt: task.completedAt ?? new Date(), percentComplete: 100 } : task;
}
function toMutation(task: TaskCreate | TaskUpdate): TaskMutation {
  return { calendarID: task.calendarID, title: task.title, description: task.description ?? null,
    status: task.status, start: task.start ?? null, due: task.due ?? null, isAllDay: task.isAllDay,
    completedAt: task.completedAt ?? null, percentComplete: task.percentComplete, priority: task.priority,
    recurrence: task.recurrence ?? null, relatedTo: task.relatedTo ?? null, url: task.url ?? null };
}
export function parseTaskCreateBody(body: unknown) {
  try {
    const task = normalizeCompletion(TaskCreateSchema.parse(body));
    return { ...task, id: requireUUID(task.id, "task.id"), calendarID: requireUUID(task.calendarID, "task.calendarID") };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError("Request is missing valid task data...");
  }
}
// Draft parser retained for existing forms. HTTP writes additionally require
// revision; a full DTO can never change memberships or home.
export function parseTaskUpdateBody(body: unknown) {
  try {
    const task = normalizeCompletion(TaskUpdateSchema.parse(body));
    return { ...task, calendarID: requireUUID(task.calendarID, "task.calendarID") };
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError("Request is missing valid task data...");
  }
}
export function parseTaskPatchBody(body: unknown) {
  const parsed = TaskPatchRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestError("A task patch and its current expectedRevision are required.");
  return parsed.data;
}
export function normalizeTaskPatch(existing: Task, patch: TaskContentPatch): TaskContentPatch {
  if (patch.status === "completed" || existing.status === "completed" && patch.status === undefined)
    return { ...patch, completedAt: patch.completedAt ?? existing.completedAt ?? new Date(), percentComplete: 100 };
  if (patch.status !== undefined && existing.status === "completed")
    return { ...patch, completedAt: null, percentComplete: patch.percentComplete === undefined || patch.percentComplete === 100 ? 0 : patch.percentComplete };
  return patch;
}
function taskIdentity(req: Request, fallback: string = randomUUID()) {
  const supplied = req.get("Idempotency-Key");
  return { actorID: req.user!.id, mutationID: supplied === undefined ? fallback : requireUUID(supplied, "Idempotency-Key") };
}
type VisibleTask = NonNullable<Awaited<ReturnType<typeof getUserTask>>>;
export function taskResponse(task: VisibleTask): Task {
  return TaskSchema.parse({ ...task, calendarID: task.originCalendarID ?? task.calendarID ?? task.calendars[0], calendarIDs: task.calendars,
    capabilities: { edit: task.canEdit, delete: task.canDelete, link: task.canShareContent, fork: task.canShareContent,
      unlinkCalendarIDs: task.editableCalendarIDs.filter((id) => id !== task.originCalendarID) } });
}
async function visibleSnapshot(req: Request, taskID: string) {
  const visible = await getUserTask(req.user!.id, taskID);
  if (!visible) throw new NotFoundError("Task not found.");
  const snapshot = await getTaskSnapshot(taskID);
  if (!snapshot || snapshot.deletedAt) throw new NotFoundError("Task not found.");
  return { visible, snapshot };
}
async function assertTaskCapableCalendar(calendarID: string) {
  const link = await getExternalLinkForCalendar(calendarID);
  if (link && (!link.supportsTasks || link.disabled)) throw new BadRequestError("This calendar does not support task writes.");
}
function changed(res: Response) {
  return res.status(409).json({ error: "The task or its source access changed. Refresh before saving; your changes have not been saved.", code: "task-source-changed", localCommitted: false });
}
/** No text or private memberships in the frame. Current authorized reads
 * determine what a recipient may see, including after unlink/deletion. */
async function notifyTask(actorID: string, task: TaskSnapshot, type: "task_created" | "task_updated" | "task_removed", previous: string[] = []) {
  const members = await Promise.all([...new Set([...previous, ...task.calendars])].map(getCalendarMembers));
  const audience = [...new Set([actorID, ...members.flatMap(rows => rows.map(member => member.userID))])];
  const payload = { id: task.id, revision: task.revision, actorID };
  switch (type) {
    case "task_created": notifyCalendarMembers(audience, "task_created", payload); break;
    case "task_updated": notifyCalendarMembers(audience, "task_updated", payload); break;
    case "task_removed": notifyCalendarMembers(audience, "task_removed", payload); break;
  }
}
function afterTaskCommit(identity: ReturnType<typeof taskIdentity>, task: TaskSnapshot,
  type: "task_created" | "task_updated" | "task_removed", previous: string[] = []) {
  // Wakeup failure cannot turn a saved local task into an apparent failed save.
  void notifyTask(identity.actorID, task, type, previous).catch(() => logger.warn("tasks.notification.failed", { taskID: task.id }));
  void getTaskMutationOutboxIDs(identity.actorID, identity.mutationID).then(ids => Promise.all(ids.map(({ id }) => deliverTaskOutbox(id))))
    .catch(() => logger.warn("tasks.delivery.wakeup_failed", { taskID: task.id }));
}
async function mutationResponse(req: Request, task: Pick<TaskSnapshot, "id">) {
  const visible = await getUserTask(req.user!.id, task.id).catch(() => null);
  // Permissions may change after commit: never return an unfiltered snapshot.
  const response = { task: visible ? taskResponse(visible) : null, localCommitted: true as const };
  try { return { ...response, delivery: await getTaskDeliveryStatus(req.user!.id, task.id) }; }
  catch { return response; }
}
export async function handlerGetTasks(req: Request, res: Response) {
  res.json({ tasks: (await getUserTasks(req.user!.id)).map(taskResponse) });
}
export async function handlerGetTask(req: Request, res: Response) {
  const task = await getUserTask(req.user!.id, requireUUID(req.params.taskId, "taskId"));
  if (!task) throw new NotFoundError("Task not found.");
  res.json(taskResponse(task));
}
export async function handlerCreateTask(req: Request, res: Response) {
  const input = parseTaskCreateBody(req.body), identity = taskIdentity(req, input.id);
  await assertCan(identity.actorID, input.calendarID, "editTasks");
  await assertTaskCapableCalendar(input.calendarID);
  const preparedDestinations = await prepareTaskWrites(TaskSchema.parse({ ...input, creatorID: identity.actorID,
    originCalendarID: input.calendarID, calendarIDs: [input.calendarID], revision: 1 }), [{ calendarID: input.calendarID, action: "create" }]);
  const task = await createTask({ ...toMutation(input), id: input.id, creatorID: identity.actorID }, { ...identity, preparedDestinations });
  afterTaskCommit(identity, task, "task_created");
  res.status(201).json(await mutationResponse(req, task));
}
export async function handlerUpdateTask(req: Request, res: Response) {
  const taskID = requireUUID(req.params.taskId, "taskId");
  const { visible, snapshot } = await visibleSnapshot(req, taskID);
  if (!visible.canEdit) throw new ForbiddenError("Only the task home permits changing shared content.");
  let request;
  if (req.method === "PUT") {
    const input = parseTaskUpdateBody(req.body);
    if (input.calendarID !== snapshot.originCalendarID) throw new BadRequestError("Use task link or fork to change calendar membership.");
    const { calendarID: _calendarID, ...content } = toMutation(input);
    request = parseTaskPatchBody({ patch: content, expectedRevision: input.expectedRevision,
      expectedProviderReadRetiredGeneration: input.expectedProviderReadRetiredGeneration });
  } else request = parseTaskPatchBody(req.body);
  if (snapshot.revision !== request.expectedRevision) return changed(res);
  const patch = normalizeTaskPatch(taskOutboxSnapshot(snapshot, snapshot.calendars), request.patch);
  const next = taskOutboxSnapshot({ ...snapshot, ...patch, revision: snapshot.revision + 1, sequence: snapshot.sequence + 1 }, snapshot.calendars);
  const identity = taskIdentity(req);
  const preparedDestinations = await prepareTaskWrites(next, snapshot.calendars.map(calendarID => ({ calendarID, action: "update" })));
  const task = await updateTask(taskID, patch, { ...identity, expectedRevision: request.expectedRevision,
    expectedProviderReadRetiredGeneration: request.expectedProviderReadRetiredGeneration, preparedDestinations });
  if (!task) return changed(res);
  afterTaskCommit(identity, task, "task_updated");
  res.json(await mutationResponse(req, task));
}
async function shareTask(req: Request, res: Response, fork: boolean) {
  const parsed = TaskLinkRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError("A destination and current expectedRevision are required.");
  const input = parsed.data, taskID = requireUUID(req.params.taskId, "taskId"), identity = taskIdentity(req);
  const reconcileFork = async () => {
    if (!fork) return false;
    const previous = await getTaskForkReplay(taskID, input.calendarID, { ...identity,
      expectedRevision: input.expectedRevision,
      expectedProviderReadRetiredGeneration: input.expectedProviderReadRetiredGeneration });
    if (!previous) return false;
    if (previous.kind === "not-committed") {
      res.status(409).json({ error: "The task or its source access changed. Refresh before copying; no copy was saved.",
        code: TASK_FORK_NOT_COMMITTED_CODE, localCommitted: false });
      return true;
    }
    // The saved identity is not a read grant. The response uses only current
    // copy permissions, even if the source changed or access was revoked.
    res.status(201).json(await mutationResponse(req, { id: previous.taskID }));
    return true;
  };
  const rejectFork = async () => {
    try {
      await rejectTaskFork(taskID, input.calendarID, { ...identity, expectedRevision: input.expectedRevision,
        expectedProviderReadRetiredGeneration: input.expectedProviderReadRetiredGeneration });
    } catch (error) {
      if (!(error instanceof DuplicateTaskMutationError)) throw error;
    }
    return reconcileFork();
  };
  if (await reconcileFork()) return;
  const { visible, snapshot } = await visibleSnapshot(req, taskID);
  if (!visible.canShareContent) throw new ForbiddenError("Refresh the task home before sharing its content.");
  if (snapshot.revision !== input.expectedRevision) {
    if (fork && await rejectFork()) return;
    return changed(res);
  }
  await assertCan(identity.actorID, input.calendarID, "editTasks");
  await assertTaskCapableCalendar(input.calendarID);
  if (!fork) {
    const destination = await getExternalLinkForCalendar(input.calendarID);
    if (!calendarSupportsTaskLinks({ provider: destination?.provider, supportsTasks: destination?.supportsTasks }))
      throw new ForbiddenError("This calendar cannot maintain a live task link. Make an independent copy instead. No changes were saved.");
  }
  const id = fork ? randomUUID() : taskID;
  const projection = fork ? TaskSchema.parse({ ...taskOutboxSnapshot(snapshot, [input.calendarID]), id, creatorID: identity.actorID,
    calendarID: input.calendarID, originCalendarID: input.calendarID, calendarIDs: [input.calendarID], revision: 1,
    sequence: 0, providerReadRetiredGeneration: undefined })
    : taskOutboxSnapshot(snapshot, [...new Set([...snapshot.calendars, input.calendarID])]);
  const preparedDestinations = await prepareTaskWrites(projection,
    !fork && snapshot.calendars.includes(input.calendarID) ? [] : [{ calendarID: input.calendarID, action: "create" }]);
  const options = { ...identity, expectedRevision: input.expectedRevision,
    expectedProviderReadRetiredGeneration: input.expectedProviderReadRetiredGeneration, preparedDestinations };
  let task;
  try {
    task = fork ? await forkTask(taskID, { id, calendarID: input.calendarID }, options) : await linkTask(taskID, input.calendarID, options);
  } catch (error) {
    // Transactions serialize the mutation key. If another request committed
    // while preflight was running, recover its result without another write.
    if (error instanceof DuplicateTaskMutationError && await reconcileFork()) return;
    throw error;
  }
  if (!task) {
    if (fork && await rejectFork()) return;
    return changed(res);
  }
  afterTaskCommit(identity, task, fork ? "task_created" : "task_updated", fork ? [] : snapshot.calendars);
  res.status(fork ? 201 : 200).json(await mutationResponse(req, task));
}
export async function handlerLinkTask(req: Request, res: Response) { return shareTask(req, res, false); }
export async function handlerForkTask(req: Request, res: Response) { return shareTask(req, res, true); }
export async function handlerRemoveTask(req: Request, res: Response) {
  const parsed = TaskDeleteRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError("The current expectedRevision is required.");
  const input = parsed.data, taskID = requireUUID(req.params.taskId, "taskId"), identity = taskIdentity(req);
  const { visible, snapshot } = await visibleSnapshot(req, taskID);
  if (snapshot.revision !== input.expectedRevision) return changed(res);
  if (input.unlinkCalendarID) await assertCan(identity.actorID, input.unlinkCalendarID, "editTasks");
  else if (!visible.canDelete) throw new ForbiddenError("Only the task home permits deleting the shared task.");
  const actions = (input.unlinkCalendarID ? [input.unlinkCalendarID] : snapshot.calendars).map(calendarID => ({ calendarID, action: "delete" as const }));
  const preparedDestinations = await prepareTaskWrites(taskOutboxSnapshot(snapshot, snapshot.calendars), actions);
  const options = { ...identity, expectedRevision: input.expectedRevision,
    expectedProviderReadRetiredGeneration: input.expectedProviderReadRetiredGeneration, preparedDestinations };
  const task = input.unlinkCalendarID ? await unlinkTask(taskID, input.unlinkCalendarID, options) : await removeTask(taskID, options);
  if (!task) return changed(res);
  afterTaskCommit(identity, task, task.deletedAt ? "task_removed" : "task_updated", snapshot.calendars);
  res.json({ ...await mutationResponse(req, task), id: task.id, revision: task.revision, removed: Boolean(task.deletedAt) });
}
