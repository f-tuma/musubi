import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { BadRequestError, OutlookMoveResultSchema, type OutlookMoveRequest } from "@musubi/types";
import { db } from "..";
import { outlookMoves, externalEvents, eventOutbox } from "../schema";
import type { DbTransaction } from "./calendars";
import { readOrganizerSourceInTransaction } from "./provider-organizer";
import { graphMeetingContextInTransaction, lockGraphMeetingContext } from "./graph-meeting-cancel";
import { sameCaldavScopeContext as same } from "./caldav-series-scope";
import type { GraphOccurrenceContent } from "./graph-occurrence-content";
import type { GraphFamilyObservation } from "./graph-family";
import { outlookMoveTime, outlookMoveZone, sameOutlookMoveFamily, type OutlookMoveJournal } from "./outlook-move-plan";

export type OutlookMoveRow = typeof outlookMoves.$inferSelect;
function refuse(): never { throw new BadRequestError("This move is no longer available. Refresh the series and preview it again."); }
export function outlookMoveResult(row: OutlookMoveRow) {
  const { journal } = row;
  return OutlookMoveResultSchema.parse({ operationID: row.id, eventID: row.eventID, status: row.status,
    title: journal.initial.baseline.master.values.title, meeting: journal.initial.baseline.master.providerState.attendees.length > 0,
    timeZone: outlookMoveZone(journal.initial), expiresAt: row.expiresAt.toISOString(), offsetMinutes: journal.request.offsetMinutes,
    items: journal.items.map(({ operationID: _operation, nativeID: _native, ...item }) => item) });
}
async function assertReadable(tx: DbTransaction, actorID: string, row: OutlookMoveRow) {
  await lockGraphMeetingContext(tx, { actorID, calendarID: row.calendarID, eventID: row.eventID });
  const link = await readOrganizerSourceInTransaction(tx, actorID, row.calendarID, "microsoft");
  if (row.actorID !== actorID || link.id !== row.linkID || link.accountID !== row.journal.initial.identity.oauthAccountID || link.providerAccessRevision !== row.journal.initial.context.link.providerAccessRevision) refuse();
  const ids = row.journal.initial.context.mappings.map(m => m.eventID);
  const mappings = await tx.select().from(externalEvents).where(and(eq(externalEvents.calendarID, row.calendarID), inArray(externalEvents.eventID, ids)));
  if (mappings.length !== ids.length || mappings.some(m => m.provider !== "microsoft" || m.readRedactionRevision !== null || m.providerState?.isOrganizer !== true || (m.externalSeriesID ?? m.externalEventID) !== row.masterID)) refuse();
}
async function authorized(tx: DbTransaction, actorID: string, id: string, lock = false) {
  const [initial] = await tx.select().from(outlookMoves).where(and(eq(outlookMoves.id, id), eq(outlookMoves.actorID, actorID)));
  if (!initial) refuse();
  await assertReadable(tx, actorID, initial);
  // Re-read after the calendar fence: a child may have acknowledged while this
  // reader was waiting, or disconnect may have removed the journal entirely.
  const query = tx.select().from(outlookMoves).where(eq(outlookMoves.id, id));
  const [current] = await (lock ? query.for("update") : query);
  if (!current) refuse();
  return current;
}
export async function readOutlookMove(actorID: string, id: string) {
  return db.transaction(tx => authorized(tx, actorID, id));
}
export async function findOutlookMoveRequest(actorID: string, request: OutlookMoveRequest) {
  const [existing] = await db.select({ id: outlookMoves.id }).from(outlookMoves).where(eq(outlookMoves.id, request.operationID));
  if (!existing) return undefined;
  const row = await readOutlookMove(actorID, request.operationID);
  if (!same(row.journal.request, request)) refuse();
  return row;
}
export async function latestOutlookMove(actorID: string, eventID: string, calendarID: string) {
  return db.transaction(async tx => {
    await lockGraphMeetingContext(tx, { actorID, eventID, calendarID });
    const link = await readOrganizerSourceInTransaction(tx, actorID, calendarID, "microsoft");
    const [mapping] = await tx.select().from(externalEvents).where(and(eq(externalEvents.eventID, eventID), eq(externalEvents.calendarID, calendarID)));
    if (!mapping || mapping.readRedactionRevision !== null || mapping.providerState?.isOrganizer !== true) refuse();
    const [row] = await tx.select().from(outlookMoves).where(and(eq(outlookMoves.actorID, actorID), eq(outlookMoves.linkID, link.id),
      eq(outlookMoves.masterID, mapping.externalSeriesID ?? mapping.externalEventID),
      sql`(${outlookMoves.status} <> 'preview' or ${outlookMoves.expiresAt} > clock_timestamp())`)).orderBy(desc(sql`${outlookMoves.status} = 'running'`), desc(outlookMoves.updatedAt), desc(outlookMoves.createdAt)).limit(1);
    if (row) await assertReadable(tx, actorID, row);
    return row;
  });
}
export async function saveOutlookMovePreview(journal: OutlookMoveJournal) {
  return db.transaction(async tx => {
    const { context } = journal.initial;
    await lockGraphMeetingContext(tx, context.address);
    const [existing] = await tx.select().from(outlookMoves).where(eq(outlookMoves.id, journal.request.operationID));
    if (existing) {
      if (existing.actorID !== context.address.actorID || !same(existing.journal.request, journal.request)) refuse();
      await assertReadable(tx, context.address.actorID, existing);
      return existing;
    }
    if (!same(await graphMeetingContextInTransaction(tx, context.address), context)) refuse();
    const [row] = await tx.insert(outlookMoves).values({ id: journal.request.operationID, actorID: context.address.actorID,
      calendarID: context.address.calendarID, eventID: context.address.eventID, linkID: context.link.id, masterID: context.masterID,
      status: "preview", journal, expiresAt: new Date(Date.now() + 10 * 60_000) }).returning();
    return row!;
  });
}
export async function startOutlookMove(actorID: string, id: string) {
  return db.transaction(async tx => {
    const row = await authorized(tx, actorID, id, true);
    if (row.status !== "preview") return row;
    if (row.expiresAt <= new Date()) refuse();
    if (!same(await graphMeetingContextInTransaction(tx, row.journal.initial.context.address), row.journal.initial.context)) refuse();
    const [active] = await tx.select({ id: outlookMoves.id }).from(outlookMoves).where(and(eq(outlookMoves.linkID, row.linkID), eq(outlookMoves.masterID, row.masterID), eq(outlookMoves.status, "running"))).limit(1);
    if (active) throw new BadRequestError("Another move is still running for this series.");
    const [saved] = await tx.update(outlookMoves).set({ status: "running", updatedAt: new Date() }).where(eq(outlookMoves.id, id)).returning();
    return saved!;
  });
}
export async function claimOutlookMove(id: string) {
  return db.transaction(async tx => {
    const [candidate] = await tx.select({ id: outlookMoves.id }).from(outlookMoves).where(eq(outlookMoves.id, id)).for("update", { skipLocked: true });
    if (!candidate) return undefined;
    const [row] = await tx.update(outlookMoves).set({ updatedAt: sql`clock_timestamp()`, leaseToken: randomUUID(), leaseUntil: sql`clock_timestamp() + interval '90 seconds'` }).where(and(eq(outlookMoves.id, id), eq(outlookMoves.status, "running"), sql`${outlookMoves.nextAttemptAt} <= clock_timestamp()`, sql`(${outlookMoves.leaseUntil} is null or ${outlookMoves.leaseUntil} <= clock_timestamp())`)).returning();
    return row;
  });
}
export async function releaseOutlookMove(row: OutlookMoveRow) {
  await db.update(outlookMoves).set({ leaseToken: null, leaseUntil: null }).where(and(eq(outlookMoves.id, row.id), eq(outlookMoves.leaseToken, row.leaseToken!)));
}
export async function pendingOutlookMoves() {
  return db.select({ id: outlookMoves.id }).from(outlookMoves).where(and(eq(outlookMoves.status, "running"),
    sql`${outlookMoves.nextAttemptAt} <= clock_timestamp()`, sql`(${outlookMoves.leaseUntil} is null or ${outlookMoves.leaseUntil} <= clock_timestamp())`)).orderBy(outlookMoves.nextAttemptAt, outlookMoves.updatedAt, outlookMoves.id).limit(4);
}
/** Pre-dispatch control deferral never rewrites the first unfinished child or
 * turns a provider budget refusal into a permanent move stop. */
export async function deferOutlookMove(row: OutlookMoveRow, retryAtMs: number) {
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253402300799999) throw new TypeError("Invalid move retry time.");
  return db.transaction(async tx => {
    await tx.select({ id: outlookMoves.id }).from(outlookMoves).where(eq(outlookMoves.id, row.id)).for("update");
    return (await tx.update(outlookMoves).set({ nextAttemptAt: sql`greatest(${outlookMoves.nextAttemptAt}, ${new Date(retryAtMs).toISOString()}::timestamptz)`,
      leaseToken: null, leaseUntil: null, updatedAt: sql`clock_timestamp()` }).where(and(eq(outlookMoves.id, row.id), eq(outlookMoves.status, "running"),
      eq(outlookMoves.leaseToken, row.leaseToken!), sql`${outlookMoves.leaseUntil}>clock_timestamp()`)).returning({ id: outlookMoves.id })).length === 1;
  });
}
export async function stopOutlookMove(row: OutlookMoveRow, eventID: string, uncertain = false) {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(outlookMoves).where(and(eq(outlookMoves.id, row.id), eq(outlookMoves.leaseToken, row.leaseToken!), sql`${outlookMoves.leaseUntil} > clock_timestamp()`)).for("update");
    if (!current || current.status !== "running") return;
    const items = current.journal.items.map(item => item.eventID === eventID && ["queued", "pending"].includes(item.status)
      ? { ...item, status: uncertain ? "unconfirmed" as const : "failed" as const }
      : item.status === "pending" ? { ...item, status: "not-started" as const } : item);
    await tx.update(outlookMoves).set({ status: "stopped", journal: { ...current.journal, items }, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(eq(outlookMoves.id, row.id));
  });
}
/** Called inside the same calendar transaction as the child outbox insert. */
export async function admitOutlookMoveChild(tx: DbTransaction, saved: GraphOccurrenceContent) {
  if (!saved.bulkMove) return;
  const [row] = await tx.select().from(outlookMoves).where(eq(outlookMoves.id, saved.bulkMove.operationID)).for("update");
  if (!row || row.status !== "running" || row.leaseToken !== saved.bulkMove.leaseToken || !row.leaseUntil || row.leaseUntil <= new Date() ||
      row.actorID !== saved.context.address.actorID || row.linkID !== saved.context.link.id || row.masterID !== saved.context.masterID ||
      !same(row.journal.initial.context.link, saved.context.link) || !same(row.journal.initial.identity, saved.identity) || !sameOutlookMoveFamily(row.journal.expected, saved.baseline)) refuse();
  const index = row.journal.items.findIndex(item => item.status !== "completed");
  const item = row.journal.items[index];
  if (!item || item.status !== "pending" || item.eventID !== saved.request.eventID || item.nativeID !== saved.targetID || item.operationID !== saved.request.operationID ||
      saved.request.scope !== "occurrence" || !same(saved.request.patch, { time: outlookMoveTime(item, outlookMoveZone(row.journal.initial)) })) refuse();
  const items = row.journal.items.map((n, i) => i === index ? { ...n, status: "queued" as const } : n);
  await tx.update(outlookMoves).set({ journal: { ...row.journal, expected: saved.baseline, items }, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(eq(outlookMoves.id, row.id));
}
/** Child acknowledgement and the next expected family commit atomically. */
export async function completeOutlookMoveChild(tx: DbTransaction, saved: GraphOccurrenceContent, observation: GraphFamilyObservation) {
  if (!saved.bulkMove) return;
  const [row] = await tx.select().from(outlookMoves).where(eq(outlookMoves.id, saved.bulkMove.operationID)).for("update");
  const item = row?.journal.items.find(i => i.operationID === saved.request.operationID);
  if (!row || !item || !["queued", "unconfirmed"].includes(item.status) || row.actorID !== saved.context.address.actorID || row.linkID !== saved.context.link.id ||
      !same(row.journal.expected, saved.baseline)) refuse();
  const items = row.journal.items.map(n => n.operationID === item.operationID ? { ...n, status: "completed" as const } : n);
  await tx.update(outlookMoves).set({ status: items.every(n => n.status === "completed") ? "completed" : row.status,
    journal: { ...row.journal, expected: observation, items }, updatedAt: new Date() }).where(eq(outlookMoves.id, row.id));
}
export async function outlookMoveChildStatus(id: string) {
  const [row] = await db.select({ status: eventOutbox.status, uncertain: eventOutbox.uncertain }).from(eventOutbox).where(eq(eventOutbox.id, id));
  return row;
}
