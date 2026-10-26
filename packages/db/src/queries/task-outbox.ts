import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { admitTaskOperationInTransaction } from "./operation-admission";
import { assertPinnedOutboxSourceInTransaction } from "./operation-admission";
import { decodeTaskOutboxOperation } from "./outbox-operation";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { retireKnownUnwrittenOutboxInTransaction } from "./outbox-causal-retirement";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { TaskSchema, ForbiddenError, SyncOperationCaptureSchema, type Task } from "@musubi/types";
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
export class TaskOutboxPredecessorError extends Error {
  constructor() { super("Task delivery predecessor evidence does not match its captured source."); }
}

/** A receipt without either response evidence or uncertainty is proven to have
 * no effect. This legacy-only shortcut requires a changed source/privacy
 * capture. Present envelopes use known-format retirement and retain unknowns. */
export function staleNotWrittenTaskOutbox(capture: { providerAccessRevision: number; retiredGeneration?: number }) {
  return sql`not (${taskOutbox.payload} ? 'operationEnvelope') and (${taskOutbox.status} in ('blocked', 'not-written', 'retry')
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
    await retireKnownUnwrittenOutboxInTransaction(tx, { ...source, calendarID, externalCalendarLinkID: source.id }, {
      kind: "task", id: task.id, privacyEpoch: `task:${task.providerReadRetiredGeneration ?? 0}`,
    });
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
    await retireKnownUnwrittenOutboxInTransaction(tx, intent, {
      kind: "task", id: task.id, privacyEpoch: `task:${intent.retiredGeneration ?? 0}`,
    });
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
    const payload = await admitTaskOperationInTransaction(tx, task, intent, predecessor?.id ?? null);
    let inserted: { id: string } | undefined;
    try {
      [inserted] = await tx.insert(taskOutbox).values({
        ...intent, revision: task.revision!, predecessorID: predecessor?.id ?? null,
        createdAt: sql`greatest(clock_timestamp(), coalesce((select max(created_at) + interval '1 microsecond' from task_outbox where task_id = ${task.id} and external_calendar_link_id = ${intent.externalCalendarLinkID}), clock_timestamp()))`,
        payload,
      }).onConflictDoNothing().returning({ id: taskOutbox.id });
    } catch {
      // Driver errors include private bound task JSON. Expose only safe context.
      throw new Error("Task delivery persistence failed; local mutation was rolled back.");
    }
    if (!inserted) throw new Error("Task delivery identity is already committed. Reconcile before retrying.");
  }
}

/** Ordering eligibility without timing, also reused for future wake hints. */
export function schedulableTaskOutbox() {
  return sql`${taskOutbox.status} in ('pending','retry','unconfirmed','attempting')
  and (${taskOutbox.predecessorID} is null or exists (
    select 1 from task_outbox predecessor where predecessor.id = ${taskOutbox.predecessorID}
      and predecessor.status in ('completed', 'not-needed')
  ))`;
}
/** Shared by claims and monitoring: waiting predecessors/active leases are not due. */
export function eligibleTaskOutbox() {
  return sql`${schedulableTaskOutbox()} and ${taskOutbox.nextAttemptAt} <= clock_timestamp()
    and (${taskOutbox.status} <> 'attempting' or ${taskOutbox.leaseUntil} is null or ${taskOutbox.leaseUntil} <= clock_timestamp())`;
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
async function resolveTaskOutboxPredecessorEvidence(row: TaskOutboxRow, read: (id: string) => Promise<TaskOutboxRow | undefined>) {
  let predecessorID = row.predecessorID, matchingPredecessorSource = true;
  let originalMappingBaseline: Record<string, unknown> | null | undefined;
  const lineage: TaskOutboxRow[] = [];
  let evidence: TaskOutboxRow | undefined;
  const visited = new Set<string>([row.id]);
  const current = decodeTaskOutboxOperation(row);
  if (current.kind === "blocked") throw new TaskOutboxPredecessorError();
  const capture = (value: TaskOutboxRow) => {
    if (!Object.prototype.hasOwnProperty.call(value.payload, "operationCapture")) return undefined;
    const parsed = SyncOperationCaptureSchema.safeParse(value.payload.operationCapture);
    if (!parsed.success) throw new TaskOutboxPredecessorError();
    return parsed.data;
  };
  const captured = capture(row);
  while (predecessorID) {
    if (visited.has(predecessorID)) throw new TaskOutboxPredecessorError();
    visited.add(predecessorID);
    const previous = await read(predecessorID);
    if (!previous || !["completed", "not-needed"].includes(previous.status)) throw new TaskOutboxPredecessorError();
    matchingPredecessorSource &&= previous.taskID === row.taskID && previous.calendarID === row.calendarID &&
      previous.externalCalendarLinkID === row.externalCalendarLinkID && previous.provider === row.provider && previous.userID === row.userID &&
      previous.accountID === row.accountID && previous.externalCalendarID === row.externalCalendarID &&
      previous.providerAccessRevision === row.providerAccessRevision && previous.retiredGeneration === row.retiredGeneration;
    // ACK refusal is too late to protect a foreign native task. Every caller,
    // including the legacy dispatcher, must reject a broken scope before it
    // receives any ancestor address or projection.
    if (!matchingPredecessorSource) throw new TaskOutboxPredecessorError();
    const ancestor = decodeTaskOutboxOperation(previous);
    if (ancestor.kind === "blocked") throw new TaskOutboxPredecessorError();
    // Transitional v0 rows can retain a real capture even without an envelope.
    // Validate every present capture; an absent legacy capture stays absent.
    const prior = capture(previous);
    if (captured && prior && !isDeepStrictEqual(captured, prior)) throw new TaskOutboxPredecessorError();
    lineage.push(previous);
    if (!evidence && matchingPredecessorSource && previous.externalTaskID === row.externalTaskID && previous.expectedEtag === row.expectedEtag &&
        previous.icalUid === row.icalUid) {
      if (Object.prototype.hasOwnProperty.call(previous.payload, "projectionBaseline")) originalMappingBaseline = previous.payload.projectionBaseline ?? null;
      else if (previous.payload.dispatchProjection) originalMappingBaseline = previous.payload.dispatchProjection.baseline;
    }
    if (!evidence && previous.resultRef) evidence = previous;
    predecessorID = previous.predecessorID;
  }
  if (evidence) return { ref: evidence.resultRef!, projectionBaseline: evidence.remoteSnapshot, hasPredecessorEvidence: true,
    matchingPredecessorSource, originalMappingBaseline, lineage, evidenceOperationId: evidence.id, noTask: false };
  const terminal = lineage[lineage.length - 1];
  return { ref: { externalTaskId: row.externalTaskID, etag: row.expectedEtag, icalUid: row.icalUid },
    projectionBaseline: row.payload.projectionBaseline ?? null, hasPredecessorEvidence: false, matchingPredecessorSource: false, originalMappingBaseline, lineage,
    evidenceOperationId: terminal?.id ?? null,
    noTask: !!terminal && predecessorID === null && terminal.action === "create" && terminal.status === "not-needed" &&
      lineage.every(previous => !previous.uncertain && previous.externalTaskID === null && previous.expectedEtag === null && previous.icalUid === null &&
        previous.resultRef === null && previous.remoteSnapshot === null) };
}
export async function getTaskOutboxPredecessorEvidence(row: TaskOutboxRow) {
  const snapshot = structuredClone(row);
  const { ref, projectionBaseline, hasPredecessorEvidence, noTask } = await resolveTaskOutboxPredecessorEvidence(snapshot, getTaskOutbox);
  if (snapshot.predecessorID && snapshot.externalTaskID === null && !hasPredecessorEvidence && !noTask) throw new TaskOutboxPredecessorError();
  return { ref, projectionBaseline };
}
/** ACK uses the same paired predecessor rule inside its own transaction. The
 * witness permits only a captured original mapping left behind by a detached
 * or deleted canonical task, never an unrelated/newer inbound version. */
export async function getTaskOutboxPredecessorEvidenceInTransaction(tx: DbTransaction, row: TaskOutboxRow) {
  return resolveTaskOutboxPredecessorEvidence(row, async id =>
    (await tx.select().from(taskOutbox).where(eq(taskOutbox.id, id)))[0]);
}

/** Resolve a successor's address from proven evidence, never a new CREATE. */
export async function getTaskOutboxExpectedRef(row: TaskOutboxRow) {
  return (await getTaskOutboxPredecessorEvidence(row)).ref;
}

type TaskPredecessorRef = { externalTaskId: string; etag: string | null; icalUid: string | null };
/** DB-owned evidence. Structurally matches the shared runtime union without a
 * DB-to-runtime/provider dependency or exposed ancestor DTOs. */
export type TaskOutboxPredecessorResolution = {
  operationId: string; attemptId: string; predecessorOperationId: string; evidenceOperationId: string; witness: string;
} & ({ kind: "predecessor-task-reference"; taskId: string; validator: string | null; projectionBaseline: Readonly<Record<string, unknown>> | null } |
  { kind: "predecessor-no-task" });
interface TaskPredecessorBasis {
  version: 1; kind: TaskOutboxPredecessorResolution["kind"]; operationId: string; predecessorOperationId: string;
  evidenceOperationId: string; witness: string; ref: TaskPredecessorRef | null; projectionBaseline: Record<string, unknown> | null;
  historyProfile: "captured-v1" | "legacy-compatible";
}
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function semanticHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest("hex");
}
function semanticTaskRow(row: TaskOutboxRow, ancestor: boolean) {
  const field = (key: keyof TaskOutboxRow["payload"]) => Object.prototype.hasOwnProperty.call(row.payload, key) ? [true, row.payload[key]] : [false];
  return { id: row.id, actorID: row.actorID, mutationID: row.mutationID, position: row.position, createdAt: row.createdAt,
    taskID: row.taskID, revision: row.revision, predecessorID: row.predecessorID, calendarID: row.calendarID,
    externalCalendarLinkID: row.externalCalendarLinkID, provider: row.provider, userID: row.userID, accountID: row.accountID,
    externalCalendarID: row.externalCalendarID, externalTaskID: row.externalTaskID, expectedEtag: row.expectedEtag, icalUid: row.icalUid,
    providerAccessRevision: row.providerAccessRevision, retiredGeneration: row.retiredGeneration, action: row.action,
    task: field("task"), capture: field("operationCapture"), envelope: field("operationEnvelope"), projectionBaseline: field("projectionBaseline"), providerProjection: field("providerProjection"),
    ...(ancestor ? { dispatchProjection: field("dispatchProjection"), dispatchResolution: field("dispatchResolution"),
      dispatchProjectionWitness: field("dispatchProjectionWitness"), status: row.status, uncertain: row.uncertain, resultRef: row.resultRef, remoteSnapshot: row.remoteSnapshot } : {}) };
}
function publicTaskResolution(basis: TaskPredecessorBasis, token: string): TaskOutboxPredecessorResolution {
  const common = { operationId: basis.operationId, attemptId: token, predecessorOperationId: basis.predecessorOperationId,
    evidenceOperationId: basis.evidenceOperationId, witness: basis.witness };
  if (basis.kind === "predecessor-no-task") return { ...common, kind: basis.kind };
  const tag = basis.ref!.etag;
  // A weak/missing historical native tag is retained in the private pair. It
  // supplies no conditional authority but must not block DELETE GET absence.
  const validator = typeof tag === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(tag) ? tag : null;
  return { ...common, kind: basis.kind, taskId: basis.ref!.externalTaskId, validator, projectionBaseline: jsonCopy(basis.projectionBaseline) };
}
async function taskPredecessorBasis(tx: DbTransaction, row: TaskOutboxRow, signal?: AbortSignal): Promise<TaskPredecessorBasis> {
  if (row.provider !== "google" || row.externalTaskID !== null || !row.predecessorID || !["update", "delete"].includes(row.action)) throw new TaskOutboxPredecessorError();
  const decoded = decodeTaskOutboxOperation(row); if (decoded.kind !== "pinned-v1" || decoded.envelope.serializer.id !== "google-task") throw new TaskOutboxPredecessorError();
  const predecessor = await resolveTaskOutboxPredecessorEvidence(row, async id => {
    signal?.throwIfAborted(); const [previous] = await tx.select().from(taskOutbox).where(eq(taskOutbox.id, id)).for("share"); signal?.throwIfAborted(); return previous;
  });
  if (!predecessor.evidenceOperationId || !predecessor.hasPredecessorEvidence && !predecessor.noTask) throw new TaskOutboxPredecessorError();
  let ref: TaskPredecessorRef | null = null;
  if (predecessor.hasPredecessorEvidence) {
    const value = predecessor.ref;
    if (typeof value.externalTaskId !== "string" || !value.externalTaskId || value.etag != null && typeof value.etag !== "string" || value.icalUid != null && typeof value.icalUid !== "string") throw new TaskOutboxPredecessorError();
    ref = { externalTaskId: value.externalTaskId, etag: value.etag ?? null, icalUid: value.icalUid ?? null };
  }
  const projectionBaseline = predecessor.hasPredecessorEvidence ? predecessor.projectionBaseline : null;
  if (projectionBaseline !== null && (typeof projectionBaseline !== "object" || Array.isArray(projectionBaseline))) throw new TaskOutboxPredecessorError();
  return { version: 1, kind: ref ? "predecessor-task-reference" : "predecessor-no-task", operationId: row.id, predecessorOperationId: row.predecessorID,
    evidenceOperationId: predecessor.evidenceOperationId, ref, projectionBaseline: jsonCopy(projectionBaseline),
    witness: semanticHash([semanticTaskRow(row, false), ...predecessor.lineage.map(previous => semanticTaskRow(previous, true))]),
    historyProfile: predecessor.lineage.every(previous => decodeTaskOutboxOperation(previous).kind === "pinned-v1") ? "captured-v1" : "legacy-compatible" };
}
function validTaskCausalProjection(row: TaskOutboxRow, basis: TaskPredecessorBasis, requireWitness: boolean) {
  const saved = row.payload.dispatchProjection;
  if (!saved) return row.payload.dispatchProjectionWitness === undefined;
  if (basis.projectionBaseline !== null && !isDeepStrictEqual(saved.baseline, basis.projectionBaseline)) return false;
  const witness = semanticHash([basis.witness, saved]);
  return row.payload.dispatchProjectionWitness === undefined ? !requireWitness : row.payload.dispatchProjectionWitness === witness;
}
function taskPreparationSidecars(row: TaskOutboxRow) {
  return (["dispatchProjection", "dispatchResolution", "dispatchProjectionWitness"] as const).map(key =>
    Object.prototype.hasOwnProperty.call(row.payload, key) ? [true, row.payload[key]] : [false]);
}
async function withTaskCausalClaim<T>(claimed: TaskOutboxRow, token: string, signal: AbortSignal | undefined, body: (tx: DbTransaction, row: TaskOutboxRow) => Promise<T>, preparation?: ReturnType<typeof taskPreparationSidecars>): Promise<T> {
  const id = claimed.id, original = semanticTaskRow(claimed, false);
  const sameAdmission = (current: TaskOutboxRow) => isDeepStrictEqual(semanticTaskRow(current, false), original) &&
    (preparation === undefined || isDeepStrictEqual(taskPreparationSidecars(current), preparation));
  signal?.throwIfAborted();
  return db.transaction(async tx => {
    const [address] = await tx.select().from(taskOutbox).where(eq(taskOutbox.id, id));
    // A fresh lookup cannot redefine the admission already decoded by the
    // runtime, or redirect its locks to a newly substituted calendar/task.
    if (!address || !sameAdmission(address)) throw new TaskOutboxPredecessorError();
    await lockCalendarLifecycle(tx, [address.calendarID], "shared");
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, address.taskID)).for("update");
    const [row] = await tx.select().from(taskOutbox).where(taskOutboxLeaseGuard(id, token)).for("update"); signal?.throwIfAborted();
    if (!row || !sameAdmission(row) ||
        !await assertTaskOutboxSourceInTransaction(tx, row, { allowDeletedTask: true }) || !await assertPinnedOutboxSourceInTransaction(tx, row, true)) throw new TaskOutboxPredecessorError();
    const result = await body(tx, row); signal?.throwIfAborted();
    if (!(await tx.select({ id: taskOutbox.id }).from(taskOutbox).where(taskOutboxLeaseGuard(id, token))).length) throw new TaskOutboxPredecessorError();
    return result;
  });
}
/** First preparation binds every preexisting sidecar to the original claim,
 * including absence. It runs once per claimed runtime attempt: callers reuse
 * its returned proof for projection/assertion, rather than refreshing an old
 * claim DTO after this attempt's progress. Fresh retry claims remain supported.
 * Leases/attempt IDs never enter the immutable basis. */
export async function prepareTaskOutboxPredecessorResolution(row: TaskOutboxRow, token: string, signal?: AbortSignal) {
  const claimed = structuredClone(row), id = claimed.id;
  return withTaskCausalClaim(claimed, token, signal, async (tx, current) => {
    const basis = await taskPredecessorBasis(tx, current, signal), stored = current.payload.dispatchResolution;
    if (stored !== undefined && !isDeepStrictEqual(stored, basis) || !validTaskCausalProjection(current, basis, stored !== undefined)) throw new TaskOutboxPredecessorError();
    if (stored === undefined) {
      const payload = { ...current.payload, dispatchResolution: basis, ...(current.payload.dispatchProjection ? {
        dispatchProjectionWitness: semanticHash([basis.witness, current.payload.dispatchProjection]) } : {}) };
      await tx.update(taskOutbox).set({ payload }).where(taskOutboxLeaseGuard(id, token));
    }
    return { predecessorAddress: publicTaskResolution(basis, token), expectedRef: jsonCopy(basis.ref), projectionBaseline: jsonCopy(basis.projectionBaseline),
      saved: current.payload.dispatchProjection, historyProfile: basis.historyProfile };
  }, taskPreparationSidecars(claimed));
}
export async function assertTaskOutboxPredecessorResolutionInTransaction(tx: DbTransaction, row: TaskOutboxRow, token: string,
  supplied?: TaskOutboxPredecessorResolution, signal?: AbortSignal) {
  try {
    const basis = await taskPredecessorBasis(tx, row, signal);
    return isDeepStrictEqual(row.payload.dispatchResolution, basis) && validTaskCausalProjection(row, basis, true) &&
      (supplied === undefined || isDeepStrictEqual(supplied, publicTaskResolution(basis, token)));
  } catch (error) { signal?.throwIfAborted(); if (error instanceof TaskOutboxPredecessorError) return false; throw error; }
}
export async function assertTaskOutboxPredecessorResolution(row: TaskOutboxRow, token: string, supplied: TaskOutboxPredecessorResolution, signal?: AbortSignal) {
  const claimed = structuredClone(row), proof = jsonCopy(supplied);
  return withTaskCausalClaim(claimed, token, signal, (tx, current) => assertTaskOutboxPredecessorResolutionInTransaction(tx, current, token, proof, signal));
}
/** Bind the existing write-once mask to the same immutable causal basis. A NULL
 * historical baseline may use the first native read under the existing profile;
 * after persistence neither that baseline nor its mask can be silently changed. */
export async function setTaskOutboxCausalProjection(row: TaskOutboxRow, token: string, supplied: TaskOutboxPredecessorResolution,
  projection: NonNullable<TaskOutboxRow["payload"]["dispatchProjection"]>, signal?: AbortSignal) {
  const claimed = structuredClone(row), id = claimed.id, proof = jsonCopy(supplied), saved = jsonCopy(projection);
  return withTaskCausalClaim(claimed, token, signal, async (tx, current) => {
    if (!await assertTaskOutboxPredecessorResolutionInTransaction(tx, current, token, proof, signal)) throw new TaskOutboxPredecessorError();
    const basis = current.payload.dispatchResolution as TaskPredecessorBasis;
    if (current.payload.dispatchProjection) {
      if (!isDeepStrictEqual(current.payload.dispatchProjection, saved)) throw new TaskOutboxPredecessorError();
      return jsonCopy(current.payload.dispatchProjection);
    }
    if (basis.projectionBaseline !== null && !isDeepStrictEqual(saved.baseline, basis.projectionBaseline)) throw new TaskOutboxPredecessorError();
    const payload = { ...current.payload, dispatchProjection: saved, dispatchProjectionWitness: semanticHash([basis.witness, saved]) };
    if (decodeTaskOutboxOperation({ ...current, payload }).kind !== "pinned-v1") throw new TaskOutboxPredecessorError();
    await tx.update(taskOutbox).set({ payload }).where(taskOutboxLeaseGuard(id, token));
    return saved;
  });
}

export function taskOutboxSnapshot(task: typeof tasks.$inferSelect, calendars: string[]) {
  return TaskSchema.parse({ ...task, calendarID: task.originCalendarID ?? task.calendarID ?? calendars[0] ?? "", calendarIDs: calendars });
}
