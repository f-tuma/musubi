import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { EventSchema, EventWriteError, type ResolveEventDeliveryRequest } from "@musubi/types";
import { events, calendarEvents, externalEvents, eventOutbox, externalEventTombstones } from "../schema";
import type { DbTransaction } from "./calendars";
import { caldavSeriesContext, sameCaldavScopeContext } from "./caldav-series-scope";
import { caldavSplitAfter, caldavSplitCreationAddresses, type CaldavSplitPrepared, type CaldavSplitJournal } from "./caldav-split";
import { eventOutboxCreatedAt, type EventOutboxRow } from "./event-outbox";
import { decodeEventOutboxOperation } from "./outbox-operation";
import { lockExternalEventIdentity } from "./event-outbox-deletions";

function refuse(): never { throw new EventWriteError("event-write", "unsupported", "The split changed. Load a fresh comparison before confirming."); }

/** Read-only complete pair proof. The committing caller additionally holds all
 * lifecycle/resource/family/mapping/pair locks before repeating this read. */
export async function readCaldavSplitResolution(tx: DbTransaction, userID: string, operationID: string) {
  const [source] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, operationID));
  if (source && decodeEventOutboxOperation(source).kind === "blocked") refuse();
  const journal = source?.payload.caldavSplit;
  if (!source || !journal || source.userID !== userID || source.actorID !== userID || operationID !== journal.sourceOperationID ||
      !["conflict", "blocked", "unconfirmed"].includes(source.status) || source.resultRef) refuse();
  const { context, split } = journal.prepared, { after } = journal;
  if (!sameCaldavScopeContext(caldavSplitAfter(journal.prepared), after)) refuse();
  const [creation] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, journal.creationOperationID));
  if (creation && decodeEventOutboxOperation(creation).kind === "blocked") refuse();
  if (!creation || creation.predecessorID !== source.id || creation.status !== "pending" || creation.attempts !== 0 || creation.uncertain || creation.resultRef || creation.remoteSnapshot ||
      !sameCaldavScopeContext(creation.payload.caldavSplit, journal) || !sameCaldavScopeContext(source.payload.resolution, creation.payload.resolution)) refuse();
  for (const [row, event, ref, action, position] of [[source, after.source, split.source.baseline.ref, "update", 0], [creation, after.head, split.creation.ref, "create", 1]] as const) {
    if (row.eventID !== event.id || row.revision !== event.revision || row.action !== action || row.position !== position ||
        row.userID !== userID || row.actorID !== userID || row.provider !== "caldav" || row.calendarID !== context.link.calendarID ||
        row.externalCalendarLinkID !== context.link.id || row.externalCalendarID !== context.link.externalCalendarID || row.accountID !== context.link.accountID || row.mutationID !== split.request.operationID ||
        row.externalEventID !== ref.externalEventId || (row.expectedEtag ?? null) !== (ref.etag ?? null) || row.icalUid !== ref.icalUid || !sameCaldavScopeContext(row.payload.event, event) ||
        row.payload.caldavSeries || row.payload.caldavSeriesDeletion || row.payload.googleOccurrence || row.payload.rsvp || row.payload.reminderEdit) refuse();
    const [latest] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, event.id), eq(eventOutbox.externalCalendarLinkID, row.externalCalendarLinkID)))
      .orderBy(desc(eventOutbox.revision), desc(eventOutbox.createdAt), desc(eventOutbox.position), desc(eventOutbox.id)).limit(1);
    if (latest?.id !== row.id) refuse();
  }
  const expected = [after.source, ...after.retained, after.head, ...after.moved], ids = expected.map(item => item.id), roots = [after.source.id, after.head.id];
  const replaced = new Set(source.payload.resolution?.replacedOperationIDs ?? []);
  const pending = await tx.select().from(eventOutbox).where(and(inArray(eventOutbox.eventID, ids), sql`${eventOutbox.status} not in ('completed', 'not-needed')`));
  const ancestors = replaced.size ? await tx.select().from(eventOutbox).where(inArray(eventOutbox.id, [...replaced])) : [];
  if ([...pending, ...ancestors].some(row => decodeEventOutboxOperation(row).kind === "blocked")) refuse();
  const family = await tx.select().from(events).where(or(inArray(events.id, roots), inArray(events.seriesID, roots)));
  const links = await tx.select().from(calendarEvents).where(inArray(calendarEvents.eventID, ids));
  const active = family.filter(item => !item.deletedAt);
  if (active.length !== expected.length || family.some(item => item.seriesID === after.head.id && item.deletedAt) || expected.some(event => {
    const current = active.find(item => item.id === event.id);
    return !current || !sameCaldavScopeContext(EventSchema.parse({ ...current, calendars: links.filter(link => link.eventID === current.id).map(link => link.calendarID).sort() }), event);
  })) refuse();
  const accepted = await caldavSeriesContext(tx, userID, context.master, context.children, source.id, true);
  if (!sameCaldavScopeContext(accepted, context)) refuse();
  const maps = await tx.select().from(externalEvents).where(or(inArray(externalEvents.eventID, ids), and(eq(externalEvents.calendarID, source.calendarID), eq(externalEvents.provider, "caldav"),
    or(eq(externalEvents.externalEventID, split.creation.ref.externalEventId), eq(externalEvents.externalSeriesID, split.creation.ref.externalEventId)))));
  if (maps.length !== context.mappings.length || maps.some(item => !context.mappings.some(old => old.id === item.id))) refuse();
  if (pending.some(row => row.id !== source.id && row.id !== creation.id && !(replaced.has(row.id) && row.status === "cancelled" && row.errorCode === "superseded-by-resolution" && row.userID === userID && row.externalCalendarLinkID === source.externalCalendarLinkID &&
      row.payload.caldavSplit?.after.source.id === after.source.id && row.payload.caldavSplit.after.head.id === after.head.id))) refuse();
  const resources = [split.source.baseline.ref.externalEventId, ...caldavSplitCreationAddresses(split)];
  const tombstones = await tx.select({ id: externalEventTombstones.id }).from(externalEventTombstones).where(and(eq(externalEventTombstones.externalCalendarLinkID, context.link.id), inArray(externalEventTombstones.externalEventID, resources))).limit(1);
  if (tombstones.length) refuse();
  return { source, creation, journal, mapping: maps.find(item => item.eventID === source.eventID)! };
}
export type CaldavSplitResolutionSnapshot = Awaited<ReturnType<typeof readCaldavSplitResolution>>;

/** Called after lifecycle and mutation locks and the generic exact replay check. */
export async function replaceCaldavSplitResolution(tx: DbTransaction, userID: string, before: CaldavSplitResolutionSnapshot, prepared: CaldavSplitPrepared, request: ResolveEventDeliveryRequest) {
  const { source, creation, journal } = before;
  const { after } = journal, old = journal.prepared;
  for (const resource of [...new Set([old.split.source.baseline.ref.externalEventId, ...caldavSplitCreationAddresses(old.split)])].sort()) await lockExternalEventIdentity(tx, source.externalCalendarLinkID, resource);
  const roots = [after.source.id, after.head.id].sort();
  await tx.select({ id: events.id }).from(events).where(inArray(events.id, roots)).orderBy(events.id).for("update");
  await tx.select({ id: events.id }).from(events).where(inArray(events.seriesID, roots)).orderBy(events.id).for("update");
  await tx.select({ id: externalEvents.id }).from(externalEvents).where(inArray(externalEvents.eventID, [after.source, ...after.retained, after.head, ...after.moved].map(item => item.id))).orderBy(externalEvents.eventID, externalEvents.id).for("update");
  const replaced = [...new Set([source.id, creation.id, ...(source.payload.resolution?.replacedOperationIDs ?? [])])];
  await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(inArray(eventOutbox.id, replaced)).orderBy(eventOutbox.id).for("update");
  // Also take the membership/link share locks used by the specialized worker.
  await caldavSeriesContext(tx, userID, old.context.master, old.context.children, source.id);
  const current = await readCaldavSplitResolution(tx, userID, source.id);
  const ref = prepared.split.source.baseline.ref;
  if (typeof ref.etag !== "string" || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(ref.etag) || !sameCaldavScopeContext(current, before) || request.expectedLocalRevision !== after.source.revision || request.expectedLatestOperationId !== source.id ||
      !request.expectedRemoteExists || request.expectedRemoteEtag !== ref.etag || request.expectedMasterRevision !== undefined || request.expectedRsvpBaselineVersion !== undefined || request.expectedReminderStateVersion !== undefined ||
      !sameCaldavScopeContext(request.expectedScopeResolution, { kind: "following-update", originalStart: old.split.request.originalStart, newSeriesId: after.head.id }) ||
      !sameCaldavScopeContext(prepared.context, { ...old.context, mappings: old.context.mappings.map(item => ({ ...item, etag: ref.etag })) }) ||
      !sameCaldavScopeContext(prepared.split.source.baseline, { ...old.split.source.baseline, ref }) ||
      ref.externalEventId !== old.split.source.baseline.ref.externalEventId || ref.icalUid !== old.split.source.baseline.ref.icalUid ||
      !sameCaldavScopeContext(prepared.split.request, old.split.request) || !sameCaldavScopeContext(caldavSplitAfter(prepared), after)) refuse();
  const nextPrepared = { ...prepared, split: { ...prepared.split, request: { ...prepared.split.request, operationID: request.mutationId } } };
  if (!sameCaldavScopeContext(caldavSplitAfter(nextPrepared), after)) refuse();
  const next: CaldavSplitJournal = { prepared: nextPrepared, after, sourceOperationID: randomUUID(), creationOperationID: randomUUID() };
  await tx.update(externalEvents).set({ etag: ref.etag }).where(inArray(externalEvents.id, old.context.mappings.map(item => item.id)));
  await tx.update(eventOutbox).set({ status: "cancelled", errorCode: "superseded-by-resolution", leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(inArray(eventOutbox.id, replaced));
  const resolution: NonNullable<EventOutboxRow["payload"]["resolution"]> = { operationID: source.id, replacedOperationIDs: replaced, expectedLocalRevision: request.expectedLocalRevision, expectedLatestOperationID: request.expectedLatestOperationId, expectedRemoteExists: true, expectedRemoteEtag: request.expectedRemoteEtag, expectedScopeResolution: request.expectedScopeResolution };
  for (const [id, event, destination, action, position] of [[next.sourceOperationID, after.source, ref, "update", 0], [next.creationOperationID, after.head, nextPrepared.split.creation.ref, "create", 1]] as const) {
    await tx.insert(eventOutbox).values({ id, createdAt: eventOutboxCreatedAt(event.id, source.externalCalendarLinkID), actorID: userID, mutationID: request.mutationId, position,
      eventID: event.id, revision: event.revision!, predecessorID: position === 1 ? next.sourceOperationID : null, calendarID: source.calendarID, externalCalendarLinkID: source.externalCalendarLinkID,
      provider: "caldav", userID, accountID: source.accountID, externalCalendarID: source.externalCalendarID, externalEventID: destination.externalEventId, expectedEtag: destination.etag ?? null, icalUid: destination.icalUid,
      action, uncertain: position === 0, payload: { event, caldavSplit: next, resolution },
    });
  }
  return next.sourceOperationID;
}
