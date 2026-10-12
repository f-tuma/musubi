import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { can, EventSchema, EventWriteError, type ResolveEventDeliveryRequest } from "@musubi/types";
import { db } from "..";
import { calendarEvents, calendarMembers, events, eventOutbox, externalCalendars, externalEvents, externalEventTombstones } from "../schema";
import type { DbTransaction } from "./calendars";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { lockExternalEventIdentity } from "./event-outbox-deletions";
import { eventOutboxCreatedAt } from "./event-outbox";
import { caldavSplitAfter, caldavSplitCreationAddresses, type CaldavSplitJournal } from "./caldav-split";
import { decodeEventOutboxOperation } from "./outbox-operation";
import { sameCaldavScopeContext as same } from "./caldav-series-scope";

type Ref = { externalEventId: string; etag?: string | null; icalUid?: string | null };
const strong = (value: unknown): value is string => typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
function refuse(): never { throw new EventWriteError("event-write", "unsupported", "The future series changed. Load a fresh comparison before confirming."); }

/** Complete future-only proof. Earlier-family edits after source ACK are valid.
 * Read-only previews take no locks; commits/workers pass lock=true. */
export async function readCaldavSplitFuture(tx: DbTransaction, userID: string, operationID: string, lock = false, attempting = false) {
  const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, operationID));
  if (address && decodeEventOutboxOperation(address).kind === "blocked") refuse();
  const journal = address?.payload.caldavSplit;
  if (!address || !journal || journal.creationOperationID !== operationID || address.userID !== userID || address.actorID !== userID ||
      !(attempting ? address.status === "attempting" : ["conflict", "blocked", "unconfirmed"].includes(address.status)) || attempting && address.remoteSnapshot && !address.remoteSnapshot.isEcho) refuse();
  const { prepared, after, futureRecovery } = journal, { split, context } = prepared;
  if (!same(caldavSplitAfter(prepared), after)) refuse();
  if (address.resultRef && (!strong(address.resultRef.etag) || address.resultRef.externalEventId !== split.creation.ref.externalEventId || address.resultRef.icalUid !== split.creation.ref.icalUid)) refuse();
  const originalID = futureRecovery?.originalCreationOperationID ?? operationID;
  const originalJournal: CaldavSplitJournal = { prepared, after, sourceOperationID: journal.sourceOperationID, creationOperationID: originalID };
  const ids = [after.head.id, ...after.moved.map(child => child.id)];
  const addresses = caldavSplitCreationAddresses(split);
  if (lock) {
    for (const resource of [...new Set(addresses)].sort()) await lockExternalEventIdentity(tx, context.link.id, resource);
    await tx.select({ id: events.id }).from(events).where(eq(events.id, after.head.id)).for("update");
    await tx.select({ id: events.id }).from(events).where(eq(events.seriesID, after.head.id)).orderBy(events.id).for("update");
    await tx.select({ id: externalEvents.id }).from(externalEvents).where(inArray(externalEvents.eventID, ids)).orderBy(externalEvents.eventID, externalEvents.id).for("update");
  }
  const replaced = address.payload.resolution?.replacedOperationIDs ?? [];
  const pairIDs = [...new Set([journal.sourceOperationID, originalID, operationID, ...replaced])];
  const pairQuery = tx.select().from(eventOutbox).where(inArray(eventOutbox.id, pairIDs)).orderBy(eventOutbox.id);
  const rows = lock ? await pairQuery.for("update") : await pairQuery;
  if (rows.some(row => decodeEventOutboxOperation(row).kind === "blocked")) refuse();
  const source = rows.find(row => row.id === journal.sourceOperationID), original = rows.find(row => row.id === originalID), creation = rows.find(row => row.id === operationID);
  if (!source || !original || !creation || !same(address, creation) || source.status !== "completed" || !source.resultRef || !strong(source.resultRef.etag) ||
      source.resultRef.externalEventId !== split.source.baseline.ref.externalEventId || source.resultRef.icalUid !== split.source.baseline.ref.icalUid ||
      !same(source.payload.caldavSplit, originalJournal) || !same(original.payload.caldavSplit, originalJournal) || !same(source.payload.resolution, original.payload.resolution)) refuse();
  for (const [row, event, ref, action, position, mutation] of [
    [source, after.source, split.source.baseline.ref, "update", 0, split.request.operationID],
    [original, after.head, split.creation.ref, "create", 1, split.request.operationID],
    [creation, after.head, split.creation.ref, "create", futureRecovery ? 0 : 1, futureRecovery?.mutationID ?? split.request.operationID],
  ] as const) {
    if (row.eventID !== event.id || row.revision !== event.revision || row.action !== action || row.position !== position || row.mutationID !== mutation ||
        row.userID !== userID || row.actorID !== userID || row.provider !== "caldav" || row.calendarID !== context.link.calendarID || row.accountID !== context.link.accountID || row.externalCalendarLinkID !== context.link.id || row.externalCalendarID !== context.link.externalCalendarID ||
        row.externalEventID !== ref.externalEventId || (row.expectedEtag ?? null) !== (ref.etag ?? null) || row.icalUid !== ref.icalUid || !same(row.payload.event, event) ||
        row.payload.caldavSeries || row.payload.caldavSeriesDeletion || row.payload.googleOccurrence || row.payload.rsvp || row.payload.reminderEdit || row.payload.reminderInstance || row.payload.graphSeriesCreate) refuse();
  }
  if (original.predecessorID !== source.id || creation.predecessorID !== source.id || futureRecovery && (!creation.payload.resolution || !replaced.includes(originalID))) refuse();
  const [latest] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, after.head.id), eq(eventOutbox.externalCalendarLinkID, context.link.id))).orderBy(desc(eventOutbox.revision), desc(eventOutbox.createdAt), desc(eventOutbox.position), desc(eventOutbox.id)).limit(1);
  if (latest?.id !== creation.id) refuse();
  const family = await tx.select().from(events).where(or(eq(events.id, after.head.id), eq(events.seriesID, after.head.id)));
  const links = await tx.select().from(calendarEvents).where(inArray(calendarEvents.eventID, ids));
  const expected = [after.head, ...after.moved];
  if (family.length !== expected.length || expected.some(event => {
    const current = family.find(item => item.id === event.id);
    return !current || current.deletedAt || !same(EventSchema.parse({ ...current, calendars: links.filter(link => link.eventID === current.id).map(link => link.calendarID).sort() }), event);
  })) refuse();
  const grantQuery = tx.select().from(calendarMembers).where(and(eq(calendarMembers.calendarID, address.calendarID), eq(calendarMembers.userID, userID)));
  const linkQuery = tx.select().from(externalCalendars).where(eq(externalCalendars.id, context.link.id));
  const [grant] = lock ? await grantQuery.for("share") : await grantQuery;
  const [link] = lock ? await linkQuery.for("share") : await linkQuery;
  if (!grant || !can(grant.role, "editEvents") || !link || link.disabled || !link.supportsEvents || link.provider !== "caldav" || link.userID !== userID || link.calendarID !== address.calendarID || link.accountID !== address.accountID || link.externalCalendarID !== address.externalCalendarID) refuse();
  const maps = await tx.select({ id: externalEvents.id }).from(externalEvents).where(or(inArray(externalEvents.eventID, ids), and(eq(externalEvents.calendarID, address.calendarID), eq(externalEvents.provider, "caldav"), or(inArray(externalEvents.externalEventID, addresses), eq(externalEvents.externalSeriesID, split.creation.ref.externalEventId)))));
  if (maps.length) refuse();
  const pending = await tx.select().from(eventOutbox).where(and(inArray(eventOutbox.eventID, ids), sql`${eventOutbox.status} not in ('completed', 'not-needed')`));
  if (pending.some(row => decodeEventOutboxOperation(row).kind === "blocked")) refuse();
  if (pending.some(row => row.id !== creation.id && !(replaced.includes(row.id) && row.status === "cancelled" && row.errorCode === "superseded-by-resolution" && row.userID === userID && row.externalCalendarLinkID === context.link.id && row.eventID === after.head.id && row.payload.caldavSplit && same(row.payload.caldavSplit.after, after) && same(row.payload.caldavSplit.prepared.split.creation.ref, split.creation.ref)))) refuse();
  const tombstones = await tx.select({ id: externalEventTombstones.id }).from(externalEventTombstones).where(and(eq(externalEventTombstones.externalCalendarLinkID, context.link.id), inArray(externalEventTombstones.externalEventID, addresses))).limit(1);
  if (tombstones.length) refuse();
  return { source, creation, journal };
}
export type CaldavSplitFutureSnapshot = Awaited<ReturnType<typeof readCaldavSplitFuture>>;

export async function replaceCaldavSplitFuture(tx: DbTransaction, userID: string, before: CaldavSplitFutureSnapshot, remote: Ref | null, request: ResolveEventDeliveryRequest) {
  const current = await readCaldavSplitFuture(tx, userID, before.creation.id, true);
  const { creation, journal } = current, { after, prepared } = journal;
  if (!same(current, before) || request.expectedLocalRevision !== after.head.revision || request.expectedLatestOperationId !== creation.id || request.expectedRemoteExists !== !!remote || request.expectedRemoteEtag !== (remote?.etag ?? null) ||
      remote && (!strong(remote.etag) || remote.externalEventId !== prepared.split.creation.ref.externalEventId || remote.icalUid !== prepared.split.creation.ref.icalUid) ||
      request.expectedMasterRevision !== undefined || request.expectedRsvpBaselineVersion !== undefined || request.expectedReminderStateVersion !== undefined ||
      !same(request.expectedScopeResolution, { kind: "following-create", originalStart: prepared.split.request.originalStart, newSeriesId: after.head.id })) refuse();
  const id = randomUUID();
  // Source ancestry stays completed/not-needed. Only future rows are superseded.
  const ancestors = (creation.payload.resolution?.replacedOperationIDs ?? []).filter(ancestor => ancestor !== journal.sourceOperationID);
  const rows = ancestors.length ? await tx.select().from(eventOutbox).where(inArray(eventOutbox.id, ancestors)) : [];
  if (rows.some(row => decodeEventOutboxOperation(row).kind === "blocked")) refuse();
  const replaced = [...new Set([creation.id, ...rows.filter(row => row.eventID === after.head.id).map(row => row.id)])];
  const next: CaldavSplitJournal = { ...journal, creationOperationID: id, futureRecovery: { originalCreationOperationID: journal.futureRecovery?.originalCreationOperationID ?? creation.id, mutationID: request.mutationId } };
  await tx.update(eventOutbox).set({ status: "cancelled", errorCode: "superseded-by-resolution", leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(inArray(eventOutbox.id, replaced), eq(eventOutbox.eventID, after.head.id)));
  await tx.insert(eventOutbox).values({ id, createdAt: eventOutboxCreatedAt(after.head.id, creation.externalCalendarLinkID), actorID: userID, mutationID: request.mutationId, position: 0,
    eventID: after.head.id, revision: after.head.revision!, predecessorID: journal.sourceOperationID, calendarID: creation.calendarID, externalCalendarLinkID: creation.externalCalendarLinkID,
    provider: "caldav", userID, accountID: creation.accountID, externalCalendarID: creation.externalCalendarID, externalEventID: creation.externalEventID, expectedEtag: creation.expectedEtag, icalUid: creation.icalUid,
    action: "create", uncertain: creation.uncertain, payload: { event: after.head, caldavSplit: next, resolution: { operationID: creation.id, replacedOperationIDs: replaced, expectedLocalRevision: request.expectedLocalRevision, expectedLatestOperationID: request.expectedLatestOperationId, expectedRemoteExists: request.expectedRemoteExists, expectedRemoteEtag: request.expectedRemoteEtag, expectedScopeResolution: request.expectedScopeResolution } },
  });
  return id;
}

class LeaseLost extends Error {}
export async function confirmCaldavSplitFuture(id: string, token: string, result?: Ref): Promise<boolean> {
  try {
    return await db.transaction(async tx => {
      const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, id));
      if (address && decodeEventOutboxOperation(address).kind === "blocked") return false;
      if (!address?.payload.caldavSplit?.futureRecovery) return false;
      await lockCalendarLifecycle(tx, [address.calendarID], "shared");
      const { creation, journal } = await readCaldavSplitFuture(tx, address.userID, id, true, true);
      const lease = and(eq(eventOutbox.id, id), eq(eventOutbox.leaseToken, token), eq(eventOutbox.status, "attempting"), sql`${eventOutbox.leaseUntil} > clock_timestamp()`);
      const [leased] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(lease);
      if (!leased) return false;
      if (!result) return true;
      const ref = journal.prepared.split.creation.ref;
      if (result.externalEventId !== ref.externalEventId || result.icalUid !== ref.icalUid || !strong(result.etag)) return false;
      for (const event of [journal.after.head, ...journal.after.moved]) await tx.insert(externalEvents).values({ provider: "caldav", eventID: event.id, calendarID: creation.calendarID, externalCalendarID: creation.externalCalendarID,
        externalEventID: event.id === journal.after.head.id ? result.externalEventId : result.externalEventId + "#musubi-original=" + encodeURIComponent(JSON.stringify(event.originalStart)), externalSeriesID: event.id === journal.after.head.id ? null : result.externalEventId, originalStart: event.originalStart ?? null, etag: result.etag, icalUid: result.icalUid });
      const [completed] = await tx.update(eventOutbox).set({ status: "completed", errorCode: null, resultRef: result, uncertain: false, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(lease).returning({ id: eventOutbox.id });
      if (!completed) throw new LeaseLost();
      const replaced = creation.payload.resolution!.replacedOperationIDs;
      if (replaced.length) await tx.update(eventOutbox).set({ status: "not-needed", updatedAt: new Date() }).where(and(inArray(eventOutbox.id, replaced), eq(eventOutbox.eventID, journal.after.head.id), eq(eventOutbox.userID, creation.userID), eq(eventOutbox.externalCalendarLinkID, creation.externalCalendarLinkID), eq(eventOutbox.status, "cancelled"), eq(eventOutbox.errorCode, "superseded-by-resolution")));
      return true;
    });
  } catch (error) { if (error instanceof LeaseLost || error instanceof EventWriteError) return false; throw error; }
}
