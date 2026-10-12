import { decodeEventOutboxOperation } from "./outbox-operation";
import { confirmCaldavSplitFuture } from "./caldav-split-future";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { EventSchema, EventWriteError, can } from "@musubi/types";
import { db } from "..";
import { events, calendarEvents, calendarMembers, externalCalendars, externalEvents, externalEventTombstones, eventOutbox } from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { lockExternalEventIdentity } from "./event-outbox-deletions";
import { caldavSeriesContext, sameCaldavScopeContext } from "./caldav-series-scope";
import { caldavSplitAfter, caldavSplitCreationAddresses } from "./caldav-split";

type Ref = { externalEventId: string; etag?: string | null; icalUid?: string | null };
const strong = (value: unknown): value is string => typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
class LeaseLost extends Error {}

/** Phase-specific short transaction; no provider IO. A source ACK releases the
 * old family, while the new family remains owned by its dependent create row. */
export async function confirmCaldavSplitOutbox(id: string, token: string, result?: Ref): Promise<boolean> {
  const [candidate] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, id));
  if (candidate && decodeEventOutboxOperation(candidate).kind === "blocked") return false;
  if (candidate?.payload.caldavSplit?.futureRecovery) return confirmCaldavSplitFuture(id, token, result);
  try {
    return await db.transaction(async tx => {
      const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, id));
      if (address && decodeEventOutboxOperation(address).kind === "blocked") return false;
      const journal = address?.payload.caldavSplit;
      if (!address || !journal || address.payload.caldavSeries || address.payload.caldavSeriesDeletion || address.payload.googleOccurrence || address.payload.rsvp || address.payload.reminderEdit) return false;
      const { prepared, after, sourceOperationID, creationOperationID } = journal;
      const formatPair = await tx.select().from(eventOutbox).where(inArray(eventOutbox.id, [sourceOperationID, creationOperationID]));
      if (formatPair.some(row => decodeEventOutboxOperation(row).kind === "blocked")) return false;
      const { context, split } = prepared;
      try { if (!sameCaldavScopeContext(caldavSplitAfter(prepared), after)) return false; } catch { return false; }
      const sourcePhase = id === sourceOperationID;
      if (!sourcePhase && id !== creationOperationID) return false;
      const expectedEvent = sourcePhase ? after.source : after.head;
      const expectedRef = sourcePhase ? split.source.baseline.ref : split.creation.ref;
      if (sourceOperationID === creationOperationID) return false;
      if (address.eventID !== expectedEvent.id || address.action !== (sourcePhase ? "update" : "create") || address.position !== (sourcePhase ? 0 : 1) ||
          address.provider !== "caldav" || address.userID !== context.link.userID || address.actorID !== address.userID ||
          address.calendarID !== context.link.calendarID || address.accountID !== context.link.accountID || address.externalCalendarLinkID !== context.link.id || address.externalCalendarID !== context.link.externalCalendarID ||
          address.mutationID !== split.request.operationID || address.revision !== expectedEvent.revision ||
          !sameCaldavScopeContext(address.payload.event, expectedEvent) || address.externalEventID !== expectedRef.externalEventId || (address.expectedEtag ?? null) !== (expectedRef.etag ?? null) || address.icalUid !== expectedRef.icalUid) return false;
      await lockCalendarLifecycle(tx, [address.calendarID], "shared");
      // Unmapped child DELETE observations have their own address fence too.
      // Hold each one through mapping insertion so no tombstone can slip between
      // the final absence check and accepting a newly created component.
      const creationAddresses = caldavSplitCreationAddresses(split);
      const resources = [...new Set(sourcePhase ? [split.source.baseline.ref.externalEventId, ...creationAddresses] : creationAddresses)].sort();
      for (const resource of resources) await lockExternalEventIdentity(tx, context.link.id, resource);
      const roots = sourcePhase ? [after.source.id, after.head.id].sort() : [after.head.id];
      const rootRows = await tx.select().from(events).where(inArray(events.id, roots)).orderBy(events.id).for("update");
      const children = await tx.select().from(events).where(inArray(events.seriesID, roots)).orderBy(events.id).for("update");
      const expected = sourcePhase ? [after.source, ...after.retained, after.head, ...after.moved] : [after.head, ...after.moved];
      const ids = expected.map(event => event.id);
      const pending = await tx.select().from(eventOutbox).where(and(inArray(eventOutbox.eventID, ids), sql`${eventOutbox.status} not in ('completed', 'not-needed')`));
      const replaced = new Set(address.payload.resolution?.replacedOperationIDs ?? []);
      const replacedRows = replaced.size ? await tx.select().from(eventOutbox).where(inArray(eventOutbox.id, [...replaced])) : [];
      if (replacedRows.some(row => decodeEventOutboxOperation(row).kind === "blocked")) return false;
      if (pending.some(row => decodeEventOutboxOperation(row).kind === "blocked")) return false;
      const links = await tx.select().from(calendarEvents).where(inArray(calendarEvents.eventID, ids));
      const actual = [...rootRows, ...children].filter(event => !event.deletedAt);
      if (actual.length !== expected.length || expected.some(event => {
        const current = actual.find(item => item.id === event.id);
        return !current || !sameCaldavScopeContext(EventSchema.parse({ ...current, calendars: links.filter(link => link.eventID === current.id).map(link => link.calendarID).sort() }), event);
      })) return false;
      // New-family tombstones never existed in the frozen split plan.
      if (children.some(child => child.seriesID === after.head.id && child.deletedAt)) return false;
      const [grant] = await tx.select().from(calendarMembers).where(and(eq(calendarMembers.calendarID, address.calendarID), eq(calendarMembers.userID, address.userID))).for("share");
      const [link] = await tx.select().from(externalCalendars).where(eq(externalCalendars.id, context.link.id)).for("share");
      if (!grant || !can(grant.role, "editEvents") || !link || link.provider !== "caldav" || link.userID !== address.userID || link.accountID !== address.accountID || link.calendarID !== address.calendarID || link.externalCalendarID !== address.externalCalendarID || link.disabled || !link.supportsEvents) return false;
      const newIDs = [after.head.id, ...after.moved.map(item => item.id)];
      const newMaps = await tx.select().from(externalEvents).where(or(inArray(externalEvents.eventID, newIDs), and(eq(externalEvents.provider, "caldav"), eq(externalEvents.calendarID, address.calendarID), or(eq(externalEvents.externalEventID, split.creation.ref.externalEventId), eq(externalEvents.externalSeriesID, split.creation.ref.externalEventId))))).for("update");
      if (sourcePhase) {
        let current;
        // Canonical rows were checked above. These snapshots describe the
        // still-accepted native identities, including future definitions that
        // have already moved locally but not yet been removed remotely.
        try { current = await caldavSeriesContext(tx, address.userID, context.master, context.children, sourceOperationID); }
        catch (error) { if (error instanceof EventWriteError) return false; throw error; }
        if (!sameCaldavScopeContext(current, context) || newMaps.some(item => !context.mappings.some(old => sameCaldavScopeContext(old, { id: item.id, provider: item.provider, eventID: item.eventID, calendarID: item.calendarID, externalCalendarID: item.externalCalendarID, externalEventID: item.externalEventID, icalUid: item.icalUid, externalSeriesID: item.externalSeriesID, originalStart: item.originalStart, etag: item.etag })))) return false;
      } else if (newMaps.length) return false;
      if (pending.some(item => item.id !== sourceOperationID && item.id !== creationOperationID && !(replaced.has(item.id) && item.status === "cancelled" && item.errorCode === "superseded-by-resolution" && item.userID === address.userID && item.externalCalendarLinkID === address.externalCalendarLinkID && item.payload.caldavSplit?.after.source.id === after.source.id && item.payload.caldavSplit.after.head.id === after.head.id))) return false;
      const pair = await tx.select().from(eventOutbox).where(inArray(eventOutbox.id, [sourceOperationID, creationOperationID])).orderBy(eventOutbox.id).for("update");
      if (pair.some(row => decodeEventOutboxOperation(row).kind === "blocked")) return false;
      const source = pair.find(item => item.id === sourceOperationID), creation = pair.find(item => item.id === creationOperationID);
      const row = pair.find(item => item.id === id);
      if (!source || !creation || !row || pair.length !== 2 || creation.predecessorID !== source.id || !sameCaldavScopeContext(source.payload.caldavSplit, journal) || !sameCaldavScopeContext(creation.payload.caldavSplit, journal) || !sameCaldavScopeContext(source.payload.resolution, creation.payload.resolution) || row.leaseToken !== token || row.status !== "attempting" || row.remoteSnapshot && !row.remoteSnapshot.isEcho) return false;
      for (const [operation, event, ref, action, position] of [[source, after.source, split.source.baseline.ref, "update", 0], [creation, after.head, split.creation.ref, "create", 1]] as const) {
        if (operation.eventID !== event.id || operation.revision !== event.revision || operation.action !== action || operation.position !== position ||
            operation.userID !== context.link.userID || operation.actorID !== operation.userID || operation.provider !== "caldav" ||
            operation.calendarID !== context.link.calendarID || operation.externalCalendarLinkID !== context.link.id || operation.externalCalendarID !== context.link.externalCalendarID || operation.accountID !== context.link.accountID || operation.mutationID !== split.request.operationID ||
            operation.externalEventID !== ref.externalEventId || (operation.expectedEtag ?? null) !== (ref.etag ?? null) || operation.icalUid !== ref.icalUid || !sameCaldavScopeContext(operation.payload.event, event) ||
            operation.payload.caldavSeries || operation.payload.caldavSeriesDeletion || operation.payload.googleOccurrence || operation.payload.rsvp || operation.payload.reminderEdit) return false;
      }
      if (!sourcePhase && (source.status !== "completed" || source.resultRef?.externalEventId !== split.source.baseline.ref.externalEventId || source.resultRef.icalUid !== split.source.baseline.ref.icalUid || !strong(source.resultRef.etag))) return false;
      if (sourcePhase && creation.status !== "pending") return false;
      const addresses = resources;
      const tombstones = await tx.select({ id: externalEventTombstones.id }).from(externalEventTombstones).where(and(eq(externalEventTombstones.externalCalendarLinkID, link.id), inArray(externalEventTombstones.externalEventID, addresses))).limit(1);
      if (tombstones.length) return false;
      const [leased] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.id, id), eq(eventOutbox.leaseToken, token), sql`${eventOutbox.leaseUntil} > clock_timestamp()`));
      if (!leased) return false;
      if (!result) return true;
      if (result.externalEventId !== expectedRef.externalEventId || result.icalUid !== expectedRef.icalUid || !strong(result.etag)) return false;
      if (sourcePhase) {
        const movedIDs = new Set(after.moved.map(child => child.id));
        const removed = context.mappings.filter(item => movedIDs.has(item.eventID));
        if (removed.length) await tx.delete(externalEvents).where(inArray(externalEvents.id, removed.map(item => item.id)));
        await tx.update(externalEvents).set({ etag: result.etag }).where(inArray(externalEvents.id, context.mappings.filter(item => !movedIDs.has(item.eventID)).map(item => item.id)));
      } else {
        for (const event of [after.head, ...after.moved]) await tx.insert(externalEvents).values({ provider: "caldav", eventID: event.id, calendarID: address.calendarID, externalCalendarID: address.externalCalendarID,
          externalEventID: event.id === after.head.id ? result.externalEventId : result.externalEventId + "#musubi-original=" + encodeURIComponent(JSON.stringify(event.originalStart)),
          externalSeriesID: event.id === after.head.id ? null : result.externalEventId, originalStart: event.originalStart ?? null, etag: result.etag, icalUid: result.icalUid,
        });
      }
      const [completed] = await tx.update(eventOutbox).set({ status: "completed", errorCode: null, resultRef: result, uncertain: false, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(eventOutbox.id, id), eq(eventOutbox.leaseToken, token), sql`${eventOutbox.leaseUntil} > clock_timestamp()`)).returning({ id: eventOutbox.id });
      if (!completed) throw new LeaseLost();
      if (replaced.size) await tx.update(eventOutbox).set({ status: "not-needed", updatedAt: new Date() }).where(and(inArray(eventOutbox.id, [...replaced]), eq(eventOutbox.userID, address.userID), eq(eventOutbox.externalCalendarLinkID, address.externalCalendarLinkID), eq(eventOutbox.eventID, sourcePhase ? after.source.id : after.head.id), eq(eventOutbox.status, "cancelled"), eq(eventOutbox.errorCode, "superseded-by-resolution")));
      return true;
    });
  } catch (error) { if (error instanceof LeaseLost) return false; throw error; }
}
