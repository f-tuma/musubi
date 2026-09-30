import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { NotFoundError, type TaskDelivery, type TaskDeliveryInbox, type TaskDeliveryTarget } from "@musubi/types";
import { db } from "..";
import { calendars, calendarMembers, externalCalendars, taskOutbox, tasks } from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { assertTaskOutboxSourceInTransaction } from "./task-outbox";
import { taskReadableMembership } from "./tasks";

const unresolved = () => sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`;

function deliveryIssue(status: TaskDeliveryTarget["status"], code: string | null, uncertain = false): TaskDeliveryTarget["issue"] {
  if (uncertain) return "unconfirmed";
  if (["completed", "not-needed", "pending", "attempting"].includes(status)) return null;
  if (status === "conflict" || code === "task-provider-conflict") return "conflict";
  if (status === "unconfirmed") return "unconfirmed";
  if (code?.includes("reconnect")) return "reconnect-required";
  if (code === "task-source-read-only" || code === "provider-write-denied") return "write-denied";
  if (code === "task-conditional-write-unsupported" || code === "task-recurrence-projection-unsupported") return "write-unsupported";
  if (code === "task-version-unavailable") return "permission-unknown";
  if (status === "cancelled" || code === "destination-unavailable" || code === "destination-disconnected") return "destination-unavailable";
  if (code === "task-projection-unavailable") return "recovery-unavailable";
  return "delivery-failed";
}

/** One authorized snapshot. Only current readable links expose shared receipts;
 * a connection owner may retain their own unlink/delete evidence. Remote IDs,
 * accepted payloads and provider error details never enter this DTO. */
export async function getTaskDeliveryStatus(userID: string, taskID: string): Promise<TaskDelivery> {
  return db.transaction(async (tx) => {
    const visible = taskReadableMembership(userID, tasks.id);
    const [task] = await tx.select({ revision: tasks.revision }).from(tasks)
      .where(and(eq(tasks.id, taskID), isNull(tasks.deletedAt), visible));
    const currentSource = and(eq(externalCalendars.id, taskOutbox.externalCalendarLinkID),
      eq(externalCalendars.calendarID, taskOutbox.calendarID), eq(externalCalendars.provider, taskOutbox.provider),
      eq(externalCalendars.userID, taskOutbox.userID), eq(externalCalendars.accountID, taskOutbox.accountID),
      eq(externalCalendars.externalCalendarID, taskOutbox.externalCalendarID), eq(externalCalendars.disabled, false));
    const receipts = (blockers: boolean) => tx.selectDistinctOn([taskOutbox.externalCalendarLinkID], {
      targetID: taskOutbox.externalCalendarLinkID, operationId: taskOutbox.id,
      calendarId: taskOutbox.calendarID,
      calendarName: sql<string | null>`case when ${externalCalendars.id} is not null and ${taskReadableMembership(userID, taskOutbox.taskID, taskOutbox.calendarID)}
        then ${calendars.name} else null end`,
      provider: taskOutbox.provider, action: taskOutbox.action, status: taskOutbox.status,
      revision: taskOutbox.revision, owned: sql<boolean>`${taskOutbox.userID} = ${userID}`,
      updatedAt: taskOutbox.updatedAt, errorCode: taskOutbox.errorCode, uncertain: taskOutbox.uncertain,
    }).from(taskOutbox).leftJoin(externalCalendars, currentSource)
      .leftJoin(calendars, eq(calendars.id, externalCalendars.calendarID))
      .where(and(eq(taskOutbox.taskID, taskID), or(eq(taskOutbox.userID, userID), and(
        sql`${externalCalendars.id} is not null`, taskReadableMembership(userID, taskOutbox.taskID, taskOutbox.calendarID),
        sql`exists (select 1 from tasks current_task where current_task.id = ${taskOutbox.taskID} and current_task.deleted_at is null)`)),
        blockers ? unresolved() : undefined))
      .orderBy(taskOutbox.externalCalendarLinkID, ...(blockers
        ? [asc(taskOutbox.revision), asc(taskOutbox.createdAt), asc(taskOutbox.position), asc(taskOutbox.id)]
        : [desc(taskOutbox.revision), desc(taskOutbox.createdAt), desc(taskOutbox.position), desc(taskOutbox.id)]));
    const latest = await receipts(false);
    if (!task && !latest.length) throw new NotFoundError("Task not found.");
    const blockers = new Map((await receipts(true)).map((row) => [row.targetID, row]));
    return { taskId: taskID, localRevision: task?.revision ?? null,
      targets: latest.map((last) => {
        const { targetID: _targetID, errorCode, uncertain, ...display } = blockers.get(last.targetID) ?? last;
        return { ...display, issue: deliveryIssue(display.status, errorCode, uncertain) };
      }).sort((a, b) => a.calendarId.localeCompare(b.calendarId)) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** UUID keyset pagination is stable across retry timestamps. Titles are resolved
 * from current authorization, never from retained private delivery snapshots. */
export async function getTaskDeliveryInbox(userID: string, cursor?: string): Promise<TaskDeliveryInbox> {
  const pageSize = 25;
  const rows = await db.selectDistinctOn([taskOutbox.taskID], {
    taskId: taskOutbox.taskID,
    savedTitle: sql<string>`coalesce((select current_task.title from tasks current_task
      where current_task.id = task_outbox.task_id and current_task.deleted_at is null
      and ${taskReadableMembership(userID, sql`current_task.id`)}), 'Task')`,
  }).from(taskOutbox).where(and(eq(taskOutbox.userID, userID), cursor ? gt(taskOutbox.taskID, cursor) : undefined,
    or(unresolved(), and(eq(taskOutbox.status, "cancelled"), sql`not exists (
      select 1 from task_outbox newer where newer.task_id = task_outbox.task_id
        and newer.external_calendar_link_id = task_outbox.external_calendar_link_id
        and (newer.revision, newer.created_at, newer.position, newer.id) >
          (task_outbox.revision, task_outbox.created_at, task_outbox.position, task_outbox.id))`))))
    .orderBy(taskOutbox.taskID, desc(taskOutbox.revision), desc(taskOutbox.createdAt), asc(taskOutbox.id)).limit(pageSize + 1);
  const items = rows.slice(0, pageSize);
  return { items, nextCursor: rows.length > pageSize ? items[items.length - 1].taskId : null };
}

export class TaskDeliveryRetryError extends Error {
  readonly code = "task-delivery-retry-unavailable";
  constructor() { super("Delivery cannot be retried in its current state. Refresh its status."); }
}

/** Re-admit only a proven not-written operation. In particular an uncertain
 * CREATE can never be turned into a second remote task by clicking Retry. */
export async function requestTaskDeliveryRetry(userID: string, taskID: string, operationID: string) {
  return db.transaction(async (tx) => {
    const owned = and(eq(taskOutbox.id, operationID), eq(taskOutbox.taskID, taskID), eq(taskOutbox.userID, userID));
    const [address] = await tx.select({ calendarID: taskOutbox.calendarID }).from(taskOutbox).where(owned);
    if (!address) throw new NotFoundError("Delivery operation not found.");
    await lockCalendarLifecycle(tx, [address.calendarID], "shared");
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskID)).for("update");
    const [row] = await tx.select().from(taskOutbox).where(owned).for("update");
    if (!row) throw new NotFoundError("Delivery operation not found.");
    const [member] = await tx.select({ id: calendarMembers.userID }).from(calendarMembers)
      .where(and(eq(calendarMembers.calendarID, row.calendarID), eq(calendarMembers.userID, userID),
        inArray(calendarMembers.role, ["owner", "editor"]))).for("share");
    if (!member || !await assertTaskOutboxSourceInTransaction(tx, row) || row.uncertain || row.remoteSnapshot ||
      !["not-written", "blocked", "retry"].includes(row.status) ||
      ["task-conditional-write-unsupported", "task-recurrence-projection-unsupported", "task-provider-conflict"].includes(row.errorCode ?? ""))
      throw new TaskDeliveryRetryError();
    if (row.predecessorID) {
      const [previous] = await tx.select({ status: taskOutbox.status }).from(taskOutbox).where(eq(taskOutbox.id, row.predecessorID));
      if (!previous || !["completed", "not-needed"].includes(previous.status)) throw new TaskDeliveryRetryError();
    }
    await tx.update(taskOutbox).set({ status: "retry", updatedAt: new Date(),
      nextAttemptAt: sql`greatest(${taskOutbox.nextAttemptAt}, clock_timestamp())` }).where(eq(taskOutbox.id, operationID));
    return operationID;
  });
}
