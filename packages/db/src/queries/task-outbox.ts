import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { TaskSchema, ForbiddenError, type Task } from "@musubi/types";
import { db } from "..";
import { externalCalendars, externalTasks, taskOutbox, tasks } from "../schema";
import type { DbTransaction } from "./calendars";

export type TaskOutboxRow = typeof taskOutbox.$inferSelect;
export type TaskOutboxIntent = Omit<typeof taskOutbox.$inferInsert,
  "revision" | "createdAt" | "updatedAt" | "predecessorID" | "attempts" | "attemptedAt" | "leaseToken" | "leaseUntil" | "nextAttemptAt" | "uncertain" | "resultRef" | "remoteSnapshot">;
export type TaskPreparedDestination = Pick<TaskOutboxRow,
  "calendarID" | "externalCalendarLinkID" | "provider" | "userID" | "accountID" | "externalCalendarID" | "providerAccessRevision"> & {
    providerProjection?: NonNullable<TaskOutboxRow["payload"]["providerProjection"]>;
  };
export type TaskDeliveryAction = { calendarID: string; action: TaskOutboxRow["action"] };
export const TASK_OUTBOX_LEASE_MS = 120_000;

export class TaskSourceChangedError extends Error {
  constructor() { super("The task destination changed. Refresh before retrying; no changes were saved."); }
}

/** A receipt without either response evidence or uncertainty is proven to have
 * no effect. Only a changed source/privacy capture permits superseding it. */
export function staleNotWrittenTaskOutbox(capture: { providerAccessRevision: number; retiredGeneration?: number }) {
  return sql`(${taskOutbox.status} in ('blocked', 'not-written', 'retry')
      or (${taskOutbox.status} = 'pending' and ${taskOutbox.attempts} = 0)) and ${taskOutbox.uncertain} = false
    and ${taskOutbox.resultRef} is null and ${taskOutbox.remoteSnapshot} is null
    and (${taskOutbox.providerAccessRevision} <> ${capture.providerAccessRevision}
      or ${taskOutbox.retiredGeneration} <> ${capture.retiredGeneration ?? 0})`;
}

/** Capture addresses under canonical/source admission locks, before removing a
 * link or mapping. The preflight proof is invalidated by every source change. */
export async function prepareTaskOutboxInTransaction(
  tx: DbTransaction,
  task: Task,
  actions: readonly TaskDeliveryAction[],
  identity: { actorID: string; mutationID: string },
  prepared?: readonly TaskPreparedDestination[],
  allowUnavailable = false,
): Promise<TaskOutboxIntent[]> {
  const intents: TaskOutboxIntent[] = [];
  for (const { calendarID, action } of actions) {
    const [source] = await tx.select().from(externalCalendars)
      .where(eq(externalCalendars.calendarID, calendarID)).for("share");
    if (!source) {
      if (prepared?.some((p) => p.calendarID === calendarID)) throw new TaskSourceChangedError();
      continue;
    }
    const unavailable = source.disabled || !source.supportsTasks || source.providerAccessRole?.startsWith("caldav:read=no;");
    if (unavailable && !allowUnavailable && action !== "delete") {
      throw new ForbiddenError("This task destination is unavailable.");
    }
    if (prepared && !prepared.some((p) => p.calendarID === calendarID &&
      p.externalCalendarLinkID === source.id && p.provider === source.provider &&
      p.userID === source.userID && p.accountID === source.accountID &&
      p.externalCalendarID === source.externalCalendarID &&
      p.providerAccessRevision === source.providerAccessRevision)) throw new TaskSourceChangedError();
    const maps = await tx.select().from(externalTasks).where(and(
      eq(externalTasks.taskID, task.id), eq(externalTasks.calendarID, calendarID),
      eq(externalTasks.provider, source.provider),
      eq(externalTasks.externalCalendarID, source.externalCalendarID),
      sql`(${externalTasks.externalCalendarLinkID} = ${source.id} or ${externalTasks.externalCalendarLinkID} is null)`,
      sql`(${externalTasks.accountID} = ${source.accountID} or ${externalTasks.accountID} is null)`,
    )).for("update");
    if (maps.length > 1) throw new TaskSourceChangedError();
    const mapping = maps[0];
    const pending = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(
      eq(taskOutbox.taskID, task.id), eq(taskOutbox.externalCalendarLinkID, source.id),
      eq(taskOutbox.action, "create"), sql`${taskOutbox.status} not in ('completed', 'not-needed', 'cancelled')`,
      sql`not (${staleNotWrittenTaskOutbox({ providerAccessRevision: source.providerAccessRevision, retiredGeneration: task.providerReadRetiredGeneration ?? 0 })})`,
    )).limit(1);
    // A local delete may precede acknowledgement of an earlier CREATE. Retain
    // that successor even without a mapping; the worker resolves its address.
    if (action === "delete" && !mapping && !pending.length) continue;
    const effectiveAction = action === "update" && !mapping && !pending.length ? "create" : action;
    const proof = prepared?.find((p) => p.calendarID === calendarID);
    intents.push({
      id: randomUUID(), ...identity, position: intents.length,
      taskID: task.id, calendarID, externalCalendarLinkID: source.id,
      provider: source.provider, userID: source.userID, accountID: source.accountID,
      externalCalendarID: source.externalCalendarID,
      externalTaskID: mapping?.externalTaskID ?? null, expectedEtag: mapping?.etag ?? null,
      icalUid: mapping?.icalUid ?? null, providerAccessRevision: source.providerAccessRevision,
      retiredGeneration: task.providerReadRetiredGeneration ?? 0,
      action: effectiveAction,
      ...(unavailable ? { status: "blocked" as const, errorCode: "task-source-read-only" } : {}),
      payload: { task, projectionBaseline: mapping?.projectionBaseline ?? null,
        ...(proof?.providerProjection ? { providerProjection: proof.providerProjection } : {}) },
    });
  }
  return intents;
}

/** Append only after the canonical CAS, in the same transaction. Evidence has
 * no task/calendar FK and therefore survives global/home deletion. */
export async function appendTaskOutbox(tx: DbTransaction, task: Task, intents: readonly TaskOutboxIntent[]) {
  for (const intent of intents) {
    if (intent.taskID !== task.id) throw new Error("Task outbox identity does not match.");
    // Fresh source/privacy admission can supersede a stale operation only when
    // it has explicit no-write evidence. Retain uncertain/observed effects and
    // their causal barrier; cancellation never masquerades as remote delivery.
    await tx.update(taskOutbox).set({ status: "cancelled", errorCode: "superseded-source-generation", updatedAt: new Date() })
      .where(and(eq(taskOutbox.taskID, task.id), eq(taskOutbox.externalCalendarLinkID, intent.externalCalendarLinkID),
        staleNotWrittenTaskOutbox({ providerAccessRevision: intent.providerAccessRevision, retiredGeneration: intent.retiredGeneration ?? 0 })));
    const [predecessor] = await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(and(
      eq(taskOutbox.taskID, task.id), eq(taskOutbox.externalCalendarLinkID, intent.externalCalendarLinkID),
      sql`${taskOutbox.status} not in ('not-needed', 'cancelled')`,
    )).orderBy(desc(taskOutbox.revision), desc(taskOutbox.createdAt), desc(taskOutbox.position)).limit(1);
    let inserted: { id: string } | undefined;
    try {
      [inserted] = await tx.insert(taskOutbox).values({
        ...intent, revision: task.revision!, predecessorID: predecessor?.id ?? null,
        createdAt: sql`greatest(clock_timestamp(), coalesce((select max(created_at) + interval '1 microsecond' from task_outbox where task_id = ${task.id} and external_calendar_link_id = ${intent.externalCalendarLinkID}), clock_timestamp()))`,
        payload: { ...intent.payload, task },
      }).onConflictDoNothing().returning({ id: taskOutbox.id });
    } catch {
      // Driver errors include private bound task JSON. Expose only safe context.
      throw new Error("Task delivery persistence failed; local mutation was rolled back.");
    }
    if (!inserted) throw new Error("Task delivery identity is already committed. Reconcile before retrying.");
  }
}

function eligibleTaskOutbox() {
  return sql`${taskOutbox.nextAttemptAt} <= clock_timestamp() and (
    ${taskOutbox.status} in ('pending', 'retry', 'unconfirmed') or
    (${taskOutbox.status} = 'attempting' and (${taskOutbox.leaseUntil} is null or ${taskOutbox.leaseUntil} <= clock_timestamp()))
  ) and (${taskOutbox.predecessorID} is null or exists (
    select 1 from task_outbox predecessor where predecessor.id = ${taskOutbox.predecessorID}
      and predecessor.status in ('completed', 'not-needed')
  ))`;
}

export async function getDueTaskOutboxIDs(limit = 50) {
  return db.select({ id: taskOutbox.id }).from(taskOutbox).where(eligibleTaskOutbox())
    .orderBy(asc(taskOutbox.nextAttemptAt), asc(taskOutbox.createdAt), asc(taskOutbox.id)).limit(limit);
}

export async function getTaskOutbox(id: string) {
  const [row] = await db.select().from(taskOutbox).where(eq(taskOutbox.id, id));
  return row;
}

export async function getTaskMutationOutboxIDs(actorID: string, mutationID: string) {
  return db.select({ id: taskOutbox.id }).from(taskOutbox)
    .where(and(eq(taskOutbox.actorID, actorID), eq(taskOutbox.mutationID, mutationID)))
    .orderBy(asc(taskOutbox.position));
}

/** Claim commits before HTTP. An expired attempt is uncertain, even if its
 * process died before receiving the provider response; CREATE must reconcile. */
export async function claimTaskOutbox(id: string) {
  return db.transaction(async (tx) => {
    const [previous] = await tx.select().from(taskOutbox)
      .where(and(eq(taskOutbox.id, id), eligibleTaskOutbox())).for("update", { skipLocked: true });
    if (!previous) return undefined;
    const [row] = await tx.update(taskOutbox).set({
      status: "attempting", attempts: sql`${taskOutbox.attempts} + 1`,
      attemptedAt: new Date(), updatedAt: new Date(), uncertain: true,
      leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '120 seconds'`,
    }).where(eq(taskOutbox.id, id)).returning();
    return { ...row, reconciling: previous.uncertain || previous.status === "attempting" || previous.status === "unconfirmed" };
  });
}

export function taskOutboxLeaseGuard(id: string, leaseToken: string) {
  return and(eq(taskOutbox.id, id), eq(taskOutbox.status, "attempting"),
    eq(taskOutbox.leaseToken, leaseToken), sql`${taskOutbox.leaseUntil} > clock_timestamp()`);
}

export async function renewTaskOutboxLease(id: string, leaseToken: string) {
  const rows = await db.update(taskOutbox).set({ leaseUntil: sql`clock_timestamp() + interval '120 seconds'` })
    .where(taskOutboxLeaseGuard(id, leaseToken)).returning({ id: taskOutbox.id });
  return rows.length === 1;
}

export async function setTaskOutboxProjection(id: string, leaseToken: string,
  projection: NonNullable<TaskOutboxRow["payload"]["providerProjection"]>) {
  const rows = await db.update(taskOutbox).set({
    payload: sql`jsonb_set(${taskOutbox.payload}, '{dispatchProjection}', ${JSON.stringify(projection)}::jsonb)`,
  }).where(and(taskOutboxLeaseGuard(id, leaseToken),
    sql`${taskOutbox.payload}->'dispatchProjection' is null`)).returning({ id: taskOutbox.id });
  return rows.length === 1;
}

type TaskOutboxFinishDetails = Pick<Partial<TaskOutboxRow>, "uncertain" | "nextAttemptAt" | "resultRef" | "remoteSnapshot">;
export async function finishTaskOutboxInTransaction(tx: DbTransaction, id: string, leaseToken: string,
  status: Exclude<TaskOutboxRow["status"], "pending" | "attempting">,
  errorCode: string | null = null, details: TaskOutboxFinishDetails = {}) {
  const rows = await tx.update(taskOutbox).set({
    status, errorCode, updatedAt: new Date(), leaseToken: null, leaseUntil: null,
    uncertain: status === "unconfirmed", ...details,
  }).where(taskOutboxLeaseGuard(id, leaseToken)).returning({ id: taskOutbox.id });
  return rows.length === 1;
}

export async function finishTaskOutbox(id: string, leaseToken: string,
  status: Exclude<TaskOutboxRow["status"], "pending" | "attempting">,
  errorCode: string | null = null, details: TaskOutboxFinishDetails = {}) {
  return db.transaction((tx) => finishTaskOutboxInTransaction(tx, id, leaseToken, status, errorCode, details));
}

/** Caller first holds calendar lifecycle then task row locks. Fresh source scope
 * and privacy generation are required both before dispatch and map ACK. Global
 * delete evidence may outlive the canonical row; other actions cannot. */
export async function assertTaskOutboxSourceInTransaction(tx: DbTransaction, row: TaskOutboxRow,
  { allowDeletedTask = false }: { allowDeletedTask?: boolean } = {}) {
  const [source] = await tx.select().from(externalCalendars).where(and(
    eq(externalCalendars.id, row.externalCalendarLinkID), eq(externalCalendars.calendarID, row.calendarID),
    eq(externalCalendars.provider, row.provider), eq(externalCalendars.userID, row.userID),
    eq(externalCalendars.accountID, row.accountID), eq(externalCalendars.externalCalendarID, row.externalCalendarID),
    eq(externalCalendars.providerAccessRevision, row.providerAccessRevision), eq(externalCalendars.disabled, false),
    eq(externalCalendars.supportsTasks, true),
  )).for("share");
  if (!source || source.providerAccessRole?.startsWith("caldav:read=no;")) return false;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, row.taskID));
  if (!task) return row.action === "delete" || allowDeletedTask;
  if ((task.providerReadRetiredGeneration ?? 0) !== row.retiredGeneration) return false;
  return allowDeletedTask || row.action === "delete" || task.deletedAt === null;
}

/** Pair the address/version and accepted projection from the same proven
 * operation. A skipped successor must not mix a fresh ETag with an old baseline. */
export async function getTaskOutboxPredecessorEvidence(row: TaskOutboxRow) {
  let predecessorID = row.predecessorID;
  const visited = new Set<string>([row.id]);
  while (predecessorID) {
    if (visited.has(predecessorID)) throw new Error("Task delivery predecessor cycle.");
    visited.add(predecessorID);
    const previous = await getTaskOutbox(predecessorID);
    if (!previous || !["completed", "not-needed"].includes(previous.status)) break;
    if (previous.resultRef) return { ref: previous.resultRef, projectionBaseline: previous.remoteSnapshot };
    predecessorID = previous.predecessorID;
  }
  return { ref: { externalTaskId: row.externalTaskID, etag: row.expectedEtag, icalUid: row.icalUid },
    projectionBaseline: row.payload.projectionBaseline ?? null };
}

/** Resolve a successor's address from proven evidence, never a new CREATE. */
export async function getTaskOutboxExpectedRef(row: TaskOutboxRow) {
  return (await getTaskOutboxPredecessorEvidence(row)).ref;
}

export function taskOutboxSnapshot(task: typeof tasks.$inferSelect, calendars: string[]) {
  return TaskSchema.parse({ ...task, calendarID: task.originCalendarID ?? task.calendarID ?? calendars[0] ?? "", calendarIDs: calendars });
}
