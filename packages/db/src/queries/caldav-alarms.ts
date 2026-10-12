import { caldavAlarmScope } from "@musubi/calendar";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { CaldavAlarmEditSchema, EventSchema, EventWriteError, type CaldavAlarmEdit, type Event, type ProviderEventState, type ResolveEventDeliveryRequest } from "@musubi/types";
import { db } from "..";
import { caldavAccounts, calendarEvents, calendarMembers, events, eventOutbox, externalCalendars, externalEvents, externalEventTombstones } from "../schema";
import type { DbTransaction } from "./calendars";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import { lockExternalEventIdentity } from "./event-outbox-deletions";
import { eventOutboxCreatedAt } from "./event-outbox";
import { sameCaldavScopeContext as same } from "./caldav-series-scope";
import { assertEventDeliveryDestination } from "./event-delivery-retry";

export type CaldavAlarmRef = { externalEventId: string; etag: string; icalUid: string };
export type CaldavAlarmContext = {
  event: Event;
  link: { id: string; calendarID: string; accountID: string; externalCalendarID: string; userID: string };
  mapping: { id: string; ref: CaldavAlarmRef; state: ProviderEventState | null };
};
/** Complete private native evidence, never part of an API/notification DTO. */
export type CaldavAlarmIntent = { context: CaldavAlarmContext; request: CaldavAlarmEdit; before: string; after: string; desiredState: ProviderEventState };
const strong = (value: unknown): value is string => typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const refuse = () => new EventWriteError("event-write", "unsupported", "CalDAV alarm evidence changed. Refresh before saving.");
export function caldavAlarmVersion(context: CaldavAlarmContext, before: string) {
  return createHash("sha256").update(JSON.stringify([context.link.id, context.mapping.id, context.mapping.ref.externalEventId, context.mapping.ref.etag, context.mapping.ref.icalUid, context.event.revision, before])).digest("hex");
}
export async function readCaldavAlarmContext(tx: DbTransaction, actorID: string, eventID: string, ownOperationID?: string, lock = false): Promise<CaldavAlarmContext> {
  const [initial] = await tx.select({ calendarID: events.originCalendarID }).from(events).where(eq(events.id, eventID));
  if (!initial?.calendarID) throw refuse();
  if (lock) await lockCalendarLifecycle(tx, [initial.calendarID], "shared");
  const sourceQuery = tx.select().from(externalCalendars).where(and(eq(externalCalendars.calendarID, initial.calendarID), eq(externalCalendars.provider, "caldav"), eq(externalCalendars.userID, actorID), eq(externalCalendars.disabled, false), eq(externalCalendars.supportsEvents, true)));
  const sources = await sourceQuery;
  if (sources.length !== 1) throw refuse();
  const link = sources[0];
  const accountQuery = tx.select({ id: caldavAccounts.id }).from(caldavAccounts).where(and(eq(caldavAccounts.id, link.accountID), eq(caldavAccounts.userID, actorID)));
  const [account] = lock ? await accountQuery.for("share") : await accountQuery;
  if (!account) throw refuse();
  const initialMaps = await tx.select().from(externalEvents).where(eq(externalEvents.eventID, eventID));
  if (initialMaps.length !== 1) throw refuse();
  const initialMap = initialMaps[0];
  if (lock) await lockExternalEventIdentity(tx, link.id, initialMap.externalEventID);
  const eventQuery = tx.select().from(events).where(eq(events.id, eventID));
  const [row] = lock ? await eventQuery.for("update") : await eventQuery;
  const links = await tx.select({ calendarID: calendarEvents.calendarID }).from(calendarEvents).where(eq(calendarEvents.eventID, eventID));
  if (!row || row.deletedAt || row.creatorID !== actorID || row.originCalendarID !== initial.calendarID || links.length !== 1 || links[0].calendarID !== initial.calendarID || row.seriesID || row.originalStart || row.isCanceled || !["zoned", "all-day"].includes(row.timeModel?.kind ?? "")) throw refuse();
  const event = EventSchema.parse({ ...row, calendars: links.map(item => item.calendarID) });
  caldavAlarmScope(event);
  // Include retired definitions: a removed mapping is not proof that this has
  // always been a master-only family. Scope writers lock this same master first.
  const childQuery = tx.select({ id: events.id }).from(events).where(eq(events.seriesID, eventID));
  const children = lock ? await childQuery.for("update") : await childQuery;
  if (children.length) throw refuse();
  const grantQuery = tx.select().from(calendarMembers).where(and(eq(calendarMembers.calendarID, initial.calendarID), eq(calendarMembers.userID, actorID)));
  const [grant] = lock ? await grantQuery.for("share") : await grantQuery;
  const [currentLink] = lock ? await sourceQuery.for("share") : sources;
  if (!grant || !["owner", "editor"].includes(grant.role) || !currentLink || !same(currentLink, link)) throw refuse();
  const mappingQuery = tx.select().from(externalEvents).where(eq(externalEvents.eventID, eventID));
  const maps = lock ? await mappingQuery.for("update") : initialMaps;
  const mapping = maps[0];
  if (maps.length !== 1 || !same(mapping, initialMap) || mapping.provider !== "caldav" || mapping.calendarID !== link.calendarID || mapping.externalCalendarID !== link.externalCalendarID || mapping.externalSeriesID || mapping.originalStart || !mapping.icalUid || !strong(mapping.etag)) throw refuse();
  const resourceMaps = await tx.select({ id: externalEvents.id }).from(externalEvents).where(and(eq(externalEvents.calendarID, link.calendarID!), eq(externalEvents.provider, "caldav"), or(eq(externalEvents.externalEventID, mapping.externalEventID), eq(externalEvents.externalSeriesID, mapping.externalEventID))));
  if (resourceMaps.length !== 1 || resourceMaps[0].id !== mapping.id) throw refuse();
  const pending = await tx.select().from(eventOutbox).where(and(eq(eventOutbox.eventID, eventID), sql`${eventOutbox.status} not in ('completed', 'not-needed')`));
  const own = pending.find(operation => operation.id === ownOperationID), replaced = own?.payload.resolution?.replacedOperationIDs ?? [];
  if (pending.some(operation => operation.id !== ownOperationID && !(replaced.includes(operation.id) && operation.status === "cancelled" && operation.errorCode === "superseded-by-resolution" && operation.userID === actorID && operation.externalCalendarLinkID === link.id && operation.payload.caldavAlarm))) throw refuse();
  const [deleted] = await tx.select({ id: externalEventTombstones.id }).from(externalEventTombstones).where(and(eq(externalEventTombstones.externalCalendarLinkID, link.id), eq(externalEventTombstones.externalEventID, mapping.externalEventID)));
  if (deleted) throw refuse();
  return { event, link: { id: link.id, calendarID: initial.calendarID, userID: actorID, accountID: link.accountID, externalCalendarID: link.externalCalendarID }, mapping: { id: mapping.id, ref: { externalEventId: mapping.externalEventID, etag: mapping.etag, icalUid: mapping.icalUid }, state: mapping.providerState } };
}
export async function getCaldavAlarmContext(actorID: string, eventID: string) {
  return db.transaction(tx => readCaldavAlarmContext(tx, actorID, eventID), { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function getCaldavAlarmReplay(actorID: string, eventID: string, request: CaldavAlarmEdit) {
  const [row] = await db.select().from(eventOutbox).where(and(eq(eventOutbox.actorID, actorID), eq(eventOutbox.mutationID, request.operationID)));
  if (!row) return;
  await db.transaction(tx => assertEventDeliveryDestination(tx, row, actorID));
  if (row.eventID !== eventID || !same(row.payload.caldavAlarm?.request, request)) throw refuse();
  return { operationID: row.id, replayed: true, status: row.status };
}
export async function commitCaldavAlarm(intent: CaldavAlarmIntent) {
  const { context, request } = intent;
  CaldavAlarmEditSchema.parse(request);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["musubi:event-mutation", context.link.userID, request.operationID])}, 0))`);
    const [replay] = await tx.select().from(eventOutbox).where(and(eq(eventOutbox.actorID, context.link.userID), eq(eventOutbox.mutationID, request.operationID)));
    if (replay) {
      await assertEventDeliveryDestination(tx, replay, context.link.userID, true);
      if (replay.eventID !== context.event.id || !same(replay.payload.caldavAlarm?.request, request)) throw refuse();
      return { operationID: replay.id, replayed: true, status: replay.status };
    }
    const current = await readCaldavAlarmContext(tx, context.link.userID, context.event.id, undefined, true);
    if (request.scope !== caldavAlarmScope(current.event) || !same(current, context) || request.expectedRevision !== current.event.revision || request.expectedStateVersion !== caldavAlarmVersion(context, intent.before)) throw refuse();
    const id = randomUUID();
    await insertAlarm(tx, id, intent, request.operationID);
    return { operationID: id, replayed: false, status: "pending" as const };
  });
}
async function insertAlarm(tx: DbTransaction, id: string, intent: CaldavAlarmIntent, mutationID: string, resolution?: NonNullable<typeof eventOutbox.$inferSelect["payload"]["resolution"]>) {
  const { context } = intent;
  try { await tx.insert(eventOutbox).values({ id, createdAt: eventOutboxCreatedAt(context.event.id, context.link.id), actorID: context.link.userID, mutationID, position: 0,
    eventID: context.event.id, revision: context.event.revision!, calendarID: context.link.calendarID, externalCalendarLinkID: context.link.id, provider: "caldav", userID: context.link.userID, accountID: context.link.accountID, externalCalendarID: context.link.externalCalendarID,
    externalEventID: context.mapping.ref.externalEventId, expectedEtag: context.mapping.ref.etag, icalUid: context.mapping.ref.icalUid, action: "update", payload: { event: context.event, caldavAlarm: intent, ...(resolution ? { resolution } : {}) } });
  } catch { throw new Error("CalDAV alarm persistence failed; transaction was rolled back."); }
}
export async function readCaldavAlarmResolution(tx: DbTransaction, actorID: string, operationID: string, lock = false, attempting = false) {
  const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, operationID));
  const intent = address?.payload.caldavAlarm;
  if (!address || !intent || address.payload.reminderEdit || address.payload.reminderInstance || address.payload.rsvp || address.payload.caldavSplit || address.payload.caldavSeries || address.payload.caldavSeriesDeletion || address.payload.googleOccurrence || address.payload.graphSeriesCreate || address.userID !== actorID || address.actorID !== actorID || address.provider !== "caldav" || address.action !== "update" || address.position !== 0 || !(attempting ? address.status === "attempting" : ["conflict", "blocked", "unconfirmed"].includes(address.status))) throw refuse();
  const context = await readCaldavAlarmContext(tx, actorID, address.eventID, address.id, lock);
  if (intent.request.scope !== caldavAlarmScope(context.event) || !same(context, intent.context) || !same(address.payload.event, context.event) || address.revision !== context.event.revision || address.expectedEtag !== context.mapping.ref.etag || address.externalEventID !== context.mapping.ref.externalEventId || address.icalUid !== context.mapping.ref.icalUid || address.externalCalendarLinkID !== context.link.id || address.accountID !== context.link.accountID || address.calendarID !== context.link.calendarID || address.externalCalendarID !== context.link.externalCalendarID || intent.request.expectedRevision !== context.event.revision || intent.request.expectedStateVersion !== caldavAlarmVersion(context, intent.before)) throw refuse();
  const [latest] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(and(eq(eventOutbox.eventID, address.eventID), eq(eventOutbox.externalCalendarLinkID, context.link.id))).orderBy(desc(eventOutbox.revision), desc(eventOutbox.createdAt), desc(eventOutbox.position), desc(eventOutbox.id)).limit(1);
  if (latest?.id !== address.id) throw refuse();
  if (lock) {
    const [locked] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, address.id)).for("update");
    if (!same(locked, address)) throw refuse();
  }
  return { row: address, intent };
}
export type CaldavAlarmResolution = Awaited<ReturnType<typeof readCaldavAlarmResolution>>;
export async function replaceCaldavAlarm(tx: DbTransaction, actorID: string, before: CaldavAlarmResolution, next: CaldavAlarmIntent, request: ResolveEventDeliveryRequest) {
  const current = await readCaldavAlarmResolution(tx, actorID, before.row.id, true);
  if (next.request.scope !== before.intent.request.scope || next.request.scope !== caldavAlarmScope(next.context.event) || !same(current, before) || !same(next.context.event, before.intent.context.event) || !same(next.context.link, before.intent.context.link) || next.context.mapping.id !== before.intent.context.mapping.id || next.context.mapping.ref.externalEventId !== before.intent.context.mapping.ref.externalEventId || next.context.mapping.ref.icalUid !== before.intent.context.mapping.ref.icalUid || !strong(next.context.mapping.ref.etag) || !same(next.request.alarms, before.intent.request.alarms) || next.request.expectedStateVersion !== caldavAlarmVersion(next.context, next.before) || request.expectedReminderStateVersion !== next.request.expectedStateVersion || request.expectedLocalRevision !== before.row.revision || request.expectedLatestOperationId !== before.row.id || !request.expectedRemoteExists || request.expectedRemoteEtag !== next.context.mapping.ref.etag || request.expectedScopeResolution || request.expectedMasterRevision !== undefined || request.expectedRsvpBaselineVersion !== undefined) throw refuse();
  const replaced = [...new Set([before.row.id, ...(before.row.payload.resolution?.replacedOperationIDs ?? [])])];
  try { await tx.update(externalEvents).set({ etag: next.context.mapping.ref.etag, providerState: next.context.mapping.state, providerStateObservedAt: new Date() }).where(eq(externalEvents.id, next.context.mapping.id)); } catch { throw new Error("CalDAV alarm persistence failed; transaction was rolled back."); }
  await tx.update(eventOutbox).set({ status: "cancelled", errorCode: "superseded-by-resolution", leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(inArray(eventOutbox.id, replaced));
  const id = randomUUID(), intent = { ...next, request: { ...next.request, operationID: request.mutationId } };
  await insertAlarm(tx, id, intent, request.mutationId, { operationID: before.row.id, replacedOperationIDs: replaced, expectedLocalRevision: request.expectedLocalRevision, expectedLatestOperationID: request.expectedLatestOperationId, expectedRemoteExists: true, expectedRemoteEtag: request.expectedRemoteEtag, expectedReminderStateVersion: request.expectedReminderStateVersion });
  return id;
}
class LeaseLost extends Error {}
export async function confirmCaldavAlarm(id: string, token: string, result?: { ref: CaldavAlarmRef; state: ProviderEventState }) {
  try {
    return await db.transaction(async tx => {
      const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, id));
      if (!address?.payload.caldavAlarm) return false;
      await lockCalendarLifecycle(tx, [address.calendarID], "exclusive");
      const { row, intent } = await readCaldavAlarmResolution(tx, address.userID, id, true, true);
      const lease = and(eq(eventOutbox.id, id), eq(eventOutbox.status, "attempting"), eq(eventOutbox.leaseToken, token), sql`${eventOutbox.leaseUntil} > clock_timestamp()`);
      const [leased] = await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(lease);
      if (!leased || row.remoteSnapshot && !row.remoteSnapshot.isEcho) return false;
      if (!result) return true;
      if (!strong(result.ref.etag) || result.ref.externalEventId !== intent.context.mapping.ref.externalEventId || result.ref.icalUid !== intent.context.mapping.ref.icalUid || !same(result.state, intent.desiredState)) return false;
      try { await tx.update(externalEvents).set({ etag: result.ref.etag, providerState: result.state, providerStateObservedAt: new Date() }).where(eq(externalEvents.id, intent.context.mapping.id)); } catch { throw new Error("CalDAV alarm persistence failed; transaction was rolled back."); }
      const [completed] = await tx.update(eventOutbox).set({ status: "completed", resultRef: result.ref, errorCode: null, uncertain: false, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(lease).returning({ id: eventOutbox.id });
      if (!completed) throw new LeaseLost();
      const replaced = row.payload.resolution?.replacedOperationIDs ?? [];
      if (replaced.length) await tx.update(eventOutbox).set({ status: "not-needed", updatedAt: new Date() }).where(and(inArray(eventOutbox.id, replaced), eq(eventOutbox.eventID, row.eventID), eq(eventOutbox.externalCalendarLinkID, row.externalCalendarLinkID), eq(eventOutbox.status, "cancelled"), eq(eventOutbox.errorCode, "superseded-by-resolution")));
      await tx.update(externalCalendars).set({ cursor: null, readCoverage: null, providerAccessRevision: sql`${externalCalendars.providerAccessRevision} + 1`, sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`, checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1` }).where(eq(externalCalendars.id, row.externalCalendarLinkID));
      return true;
    });
  } catch (error) { if (error instanceof LeaseLost || error instanceof EventWriteError) return false; throw error; }
}

/** Stop only an unresolved private alarm intent. No provider mutation or invented
 * success receipt; the immutable payload stays available for historical audit. */
export async function discardCaldavAlarm(actorID: string, eventID: string, operationID: string, expectedRevision: number) {
  return db.transaction(async tx => {
    const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, operationID));
    if (!address?.payload.caldavAlarm || address.eventID !== eventID || address.actorID !== actorID || address.provider !== "caldav") throw refuse();
    await lockCalendarLifecycle(tx, [address.calendarID], "exclusive");
    await lockExternalEventIdentity(tx, address.externalCalendarLinkID, address.externalEventID!);
    await assertEventDeliveryDestination(tx, address, actorID, true);
    const [account] = await tx.select({ id: caldavAccounts.id }).from(caldavAccounts).where(and(eq(caldavAccounts.id, address.accountID), eq(caldavAccounts.userID, actorID))).for("share");
    if (!account) throw refuse();
    const [event] = await tx.select().from(events).where(eq(events.id, eventID)).for("update");
    const [row] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)).for("update");
    if (!row || !same(row, address)) throw refuse();
    // Same discarded receipt replay has no mutation, including after later edits.
    if (row.status === "not-needed" && row.errorCode === "alarm-discarded") return;
    if (!event || event.deletedAt || event.creatorID !== actorID || event.originCalendarID !== row.calendarID || event.revision !== expectedRevision || !["conflict", "blocked", "unconfirmed"].includes(row.status) || row.leaseToken || row.leaseUntil) throw refuse();
    const [mapping] = await tx.select().from(externalEvents).where(and(eq(externalEvents.id, row.payload.caldavAlarm!.context.mapping.id), eq(externalEvents.eventID, eventID), eq(externalEvents.calendarID, row.calendarID), eq(externalEvents.provider, "caldav"), eq(externalEvents.externalCalendarID, row.externalCalendarID), eq(externalEvents.externalEventID, row.externalEventID!), eq(externalEvents.icalUid, row.icalUid!))).for("update");
    if (!mapping) throw refuse();
    // Only the selected intent and its already superseded alarm ancestors stop.
    // Newer content intents retain their payload, status and predecessor identity.
    const ancestors = row.payload.resolution?.replacedOperationIDs ?? [];
    if (ancestors.length) await tx.update(eventOutbox).set({ status: "not-needed", errorCode: "alarm-discarded", updatedAt: new Date() }).where(and(inArray(eventOutbox.id, ancestors), eq(eventOutbox.userID, actorID), eq(eventOutbox.eventID, eventID), eq(eventOutbox.externalCalendarLinkID, row.externalCalendarLinkID), eq(eventOutbox.status, "cancelled"), eq(eventOutbox.errorCode, "superseded-by-resolution"), sql`${eventOutbox.payload}->'caldavAlarm' is not null`));
    await tx.update(eventOutbox).set({ status: "not-needed", errorCode: "alarm-discarded", updatedAt: new Date() }).where(eq(eventOutbox.id, row.id));
    await tx.update(externalCalendars).set({ cursor: null, readCoverage: null, providerAccessRevision: sql`${externalCalendars.providerAccessRevision} + 1`, sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`, checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1` }).where(eq(externalCalendars.id, row.externalCalendarLinkID));
  });
}
