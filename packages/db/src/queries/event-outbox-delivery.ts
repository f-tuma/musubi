import { assertPinnedOutboxSourceInTransaction } from "./operation-admission";
import { decodeEventOutboxOperation } from "./outbox-operation";
import { matchesRsvpEventProjection } from "./event-outbox-projection";
import { hasCaldavRsvpBoundary, providerRsvpBaselineVersion } from "./provider-rsvp";
import { matchesProviderReminderInstanceState } from "./provider-reminder-instance";
import { readGraphRsvpOccurrence } from "./graph-rsvp-occurrence";
import { readProviderRsvpInstance } from "./provider-rsvp-instance";
import { isDeepStrictEqual } from "node:util";
import { providerStateVersion } from "./provider-reminders";
import { CaldavRsvpDeliverySchema, EventSchema, ProviderEventStateSchema, microsoftRsvpTargetDesiredState, matchesMicrosoftRsvpTargetState, type MicrosoftRsvpConfirmation, providerRsvpDesiredState, caldavRsvpDesiredState, type CaldavRsvpConfirmation } from "@musubi/types";
import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { db } from "..";
import {
  calendarEvents,
  calendarMembers,
  eventOutbox,
  events,
  externalCalendars,
  externalEvents,
  externalEventTombstones,
} from "../schema";
import { lockUserLifecycle, lockCalendarLifecycle } from "./calendar-lifecycle";
import type { EventOutboxRow } from "./event-outbox";
import type { DbTransaction } from "./calendars";
import { lockExternalEventIdentity } from "./event-outbox-deletions";

export type EventDeliveryRef = NonNullable<EventOutboxRow["resultRef"]>;
class DeliveryLeaseExpired extends Error {}

export async function getEventOutboxRow(id: string) {
  const [row] = await db
    .select()
    .from(eventOutbox)
    .where(eq(eventOutbox.id, id));
  return row;
}

/** Only our completed predecessor may advance the captured target version. */
export async function getEventOutboxExpectedRef(
  row: EventOutboxRow,
): Promise<EventDeliveryRef | null> {
  const predecessor = row.predecessorID
    ? await getEventOutboxRow(row.predecessorID)
    : undefined;
  if (
    predecessor?.resultRef &&
    ["completed", "not-needed"].includes(predecessor.status) &&
    predecessor.externalCalendarLinkID === row.externalCalendarLinkID &&
    predecessor.eventID === row.eventID &&
    predecessor.calendarID === row.calendarID &&
    (!row.externalEventID ||
      row.expectedEtag === predecessor.expectedEtag ||
      row.expectedEtag === predecessor.resultRef.etag) &&
    (!row.externalEventID ||
      row.externalEventID === predecessor.resultRef.externalEventId)
  )
    return predecessor.resultRef;
  return row.externalEventID
    ? {
        externalEventId: row.externalEventID,
        etag: row.expectedEtag,
        icalUid: row.icalUid,
      }
    : null;
}

async function settle(
  tx: DbTransaction,
  row: EventOutboxRow,
  status: EventOutboxRow["status"],
  errorCode: string | null,
  resultRef: EventDeliveryRef | null,
) {
  const [saved] = await tx
    .update(eventOutbox)
    .set({
      status,
      errorCode,
      resultRef,
      remoteSnapshot: row.remoteSnapshot,
      leaseToken: null,
      leaseUntil: null,
      uncertain: status === "unconfirmed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(eventOutbox.id, row.id),
        eq(eventOutbox.leaseToken, row.leaseToken!),
        sql`${eventOutbox.leaseUntil} > clock_timestamp()`,
      ),
    )
    .returning();
  if (!saved) throw new DeliveryLeaseExpired(); // Roll back mapping changes too.
  return saved;
}

/** Later local revisions require the same target's persisted successor chain. */
async function coversCurrentRevision(
  tx: DbTransaction,
  row: EventOutboxRow,
  revision: number | undefined,
) {
  let [latest] = await tx
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.eventID, row.eventID),
        eq(eventOutbox.calendarID, row.calendarID),
        eq(eventOutbox.externalCalendarLinkID, row.externalCalendarLinkID),
      ),
    )
    .orderBy(desc(eventOutbox.revision), desc(eventOutbox.createdAt), desc(eventOutbox.position), desc(eventOutbox.id))
    .limit(1);
  if (
    !latest ||
    (revision === undefined
      ? latest.action !== "delete"
      : latest.revision !== revision)
  )
    return false;
  const seen = new Set<string>();
  while (latest.id !== row.id) {
    if (
      seen.has(latest.id) ||
      seen.size >= 1000 ||
      !latest.predecessorID ||
      ["conflict", "blocked", "cancelled"].includes(latest.status)
    )
      return false;
    seen.add(latest.id);
    const [previous] = await tx
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.id, latest.predecessorID));
    if (
      !previous ||
      previous.eventID !== row.eventID ||
      previous.calendarID !== row.calendarID ||
      previous.externalCalendarLinkID !== row.externalCalendarLinkID
    )
      return false;
    latest = previous;
  }
  return true;
}

export async function hasEventOutboxRevisionCoverage(row: EventOutboxRow) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(events)
      .where(eq(events.id, row.eventID))
      .for("update");
    return (
      current?.revision === row.revision ||
      coversCurrentRevision(tx, row, current?.revision)
    );
  });
}

/** Acknowledgement and mapping acceptance are one transaction. Preserve lock
 * order lifecycle -> event -> mapping/outbox, and fence completion by live lease. */
export async function completeEventOutbox(id: string, leaseToken: string, resultRef: EventDeliveryRef | null, expectedRef: EventDeliveryRef | null, observation?: EventOutboxRow["remoteSnapshot"], signal?: AbortSignal) {
  return completeEventOutboxInternal(id, leaseToken, resultRef, expectedRef, observation, "ordinary", undefined, undefined, signal);
}
export async function completeProviderRsvpOutbox(id: string, leaseToken: string, resultRef: EventDeliveryRef, expectedRef: EventDeliveryRef, observation: EventOutboxRow["remoteSnapshot"], caldavConfirmation?: CaldavRsvpConfirmation, graphConfirmation?: MicrosoftRsvpConfirmation) {
  return completeEventOutboxInternal(id, leaseToken, resultRef, expectedRef, observation, "rsvp", caldavConfirmation, graphConfirmation);
}
export async function completeProviderReminderInstanceOutbox(id: string, leaseToken: string, resultRef: EventDeliveryRef, expectedRef: EventDeliveryRef, observation: EventOutboxRow["remoteSnapshot"]) {
  return completeEventOutboxInternal(id, leaseToken, resultRef, expectedRef, observation, "reminder-instance");
}
async function completeEventOutboxInternal(
  id: string,
  leaseToken: string,
  resultRef: EventDeliveryRef | null,
  expectedRef: EventDeliveryRef | null,
  observation: EventOutboxRow["remoteSnapshot"] | undefined,
  confirmation: "ordinary" | "rsvp" | "reminder-instance",
  caldavConfirmation?: CaldavRsvpConfirmation, graphConfirmation?: MicrosoftRsvpConfirmation,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  try {
    return await db.transaction(async (tx) => {
      signal?.throwIfAborted();
      // Roll back every provisional write if cancellation happened during a
      // pool/row-lock wait. A COMMIT already sent remains the host authority.
      const result = await (async () => {
      const [address] = await tx
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.id, id));
      if (!address || address.payload.organizer || address.payload.caldavAlarm || address.payload.graphSeriesCreate || address.payload.graphSeriesDeletion || address.payload.graphMeetingCancellation || address.payload.graphOccurrenceContent || address.payload.caldavSplit || address.payload.caldavSeries || address.payload.caldavSeriesDeletion || !!address.payload.rsvp !== (confirmation === "rsvp") || !!address.payload.reminderInstance !== (confirmation === "reminder-instance")) return undefined;
      if (address.payload.rsvp?.request.provider === "caldav") await lockUserLifecycle(tx, [address.userID], "shared");
      await lockCalendarLifecycle(tx, [address.calendarID], "shared");
      const resource =
        resultRef ?? (address.action === "delete" ? expectedRef : null);
      if (resource)
        await lockExternalEventIdentity(
          tx,
          address.externalCalendarLinkID,
          resource.externalEventId,
        );
      const addressInstance = address.payload.rsvp?.instance ?? address.payload.reminderInstance?.instance;
      if (addressInstance)
        await tx.select({ id: events.id }).from(events).where(eq(events.id, addressInstance.seriesID)).for("update");
      if (address.payload.googleOccurrence)
        await tx.select({ id: events.id }).from(events).where(eq(events.id, address.payload.googleOccurrence.master.id)).for("update");
      const [current] = await tx
        .select()
        .from(events)
        .where(eq(events.id, address.eventID))
        .for("update");
      const [row] = await tx
        .select()
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.id, id),
            eq(eventOutbox.leaseToken, leaseToken),
            eq(eventOutbox.status, "attempting"),
            sql`${eventOutbox.leaseUntil} > clock_timestamp()`,
          ),
        )
        .for("update");
      signal?.throwIfAborted();
      if (!row) return undefined;
      const decoded = decodeEventOutboxOperation(row);
      if (decoded.kind === "blocked") return undefined;
      if (decoded.kind === "pinned-v1" && !await assertPinnedOutboxSourceInTransaction(tx, row, true)) {
        await tx.update(eventOutbox).set({ status: "blocked", errorCode: "operation-source-changed", uncertain: true,
          resultRef: resultRef ?? row.resultRef, ...(observation ? { remoteSnapshot: observation } : {}),
          leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(eq(eventOutbox.id, row.id));
        return undefined;
      }
      const settings = row.payload.rsvp ?? row.payload.reminderInstance;
      const sourceChanged = row.payload.reminderInstance ? "reminder-source-changed" : "rsvp-source-changed";
      if (settings) {
        const intent = settings;
        const caldav = row.payload.rsvp?.request.provider === "caldav";
        const graph = row.payload.rsvp?.request.provider === "microsoft";
        const graphSeries = row.payload.rsvp?.request.provider === "microsoft" && row.payload.rsvp.request.scope === "series";
        if (graphSeries && graphConfirmation?.seriesResponse !== (row.payload.rsvp!.request.response === "tentative" ? "tentativelyAccepted" : row.payload.rsvp!.request.response)) return settle(tx, row, "unconfirmed", "rsvp-confirmation-unavailable", resultRef);
        if (graph && (!isDeepStrictEqual(row.payload.rsvp!.graphOccurrence, intent.baseline.occurrence) ||
            !isDeepStrictEqual(row.payload.rsvp!.graphOccurrence, address.payload.rsvp?.graphOccurrence) ||
            (row.payload.rsvp!.request.provider === "microsoft" && !!row.payload.rsvp!.request.scope) !== !!row.payload.rsvp!.graphOccurrence ||
            (row.payload.rsvp!.request.provider === "microsoft" && row.payload.rsvp!.request.scope === "series") !== Array.isArray(intent.baseline.series)))
          return settle(tx, row, "unconfirmed", sourceChanged, resultRef);
        if (graph && (!config.api.providerRsvpEditsEnabled || !graphConfirmation || graphConfirmation.baselineHash !== providerRsvpBaselineVersion(intent.mappingID, intent.baseline) || graphConfirmation.observedResponse !== intent.desiredState.ownResponse || current?.seriesID || current?.originalStart || current?.recurrence || current?.isCanceled)) return settle(tx, row, "unconfirmed", "rsvp-confirmation-unavailable", resultRef);
        if (caldav && (!config.api.providerRsvpEditsEnabled || !caldavConfirmation || (caldavConfirmation.mode !== undefined && caldavConfirmation.mode !== "strict" && caldavConfirmation.mode !== "icloud-oneoff-attendee") || caldavConfirmation.resourceHash !== row.payload.rsvp!.baseline.desiredResourceHash || caldavConfirmation.selfAddress !== row.payload.rsvp!.baseline.selfAddress || !(await hasCaldavRsvpBoundary(row, row.payload.rsvp!.baseline, tx, true)) || (caldavConfirmation.mode ?? "strict") !== (row.payload.rsvp!.baseline.mode ?? "strict") || (caldavConfirmation.mode === "icloud-oneoff-attendee" ? caldavConfirmation.scheduleTag !== null || !CaldavRsvpDeliverySchema.safeParse(row.payload.rsvp!.caldavDelivery).success : typeof caldavConfirmation.scheduleTag !== "string" || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(caldavConfirmation.scheduleTag)) || current?.seriesID || current?.originalStart || current?.recurrence || current?.isCanceled)) return settle(tx, row, "unconfirmed", "rsvp-confirmation-unavailable", resultRef);
        if (!isDeepStrictEqual(intent.instance, addressInstance))
          return settle(tx, row, "unconfirmed", sourceChanged, resultRef);
        const [membership] = await tx.select({ role: calendarMembers.role }).from(calendarMembers).where(and(eq(calendarMembers.calendarID, row.calendarID), eq(calendarMembers.userID, row.actorID))).for("share");
        if (!membership || !["owner", "editor"].includes(membership.role) || row.actorID !== row.userID || row.provider !== (graph ? "microsoft" : caldav ? "caldav" : "google") || row.action !== "update" || !current || current.deletedAt || current.originCalendarID !== row.calendarID || current.revision !== row.revision)
          return settle(tx, row, "unconfirmed", sourceChanged, resultRef);
        if (!observation?.isEcho || observation.deleted || observation.externalEventId !== resultRef?.externalEventId || observation.etag !== resultRef?.etag || expectedRef?.externalEventId !== row.externalEventID || expectedRef?.etag !== row.expectedEtag || !(row.payload.reminderInstance ? matchesProviderReminderInstanceState(row.payload.reminderInstance, observation.providerState) : (graph ? matchesMicrosoftRsvpTargetState(intent.baselineState, observation.providerState, String(row.payload.rsvp!.baseline.selfAddress), row.payload.rsvp!.request.response, graphSeries) : isDeepStrictEqual(observation.providerState, intent.desiredState)) && isDeepStrictEqual(intent.desiredState, graph ? microsoftRsvpTargetDesiredState(intent.baselineState, String(row.payload.rsvp!.baseline.selfAddress), row.payload.rsvp!.request.response, graphSeries) : caldav ? caldavRsvpDesiredState(intent.baselineState, String(row.payload.rsvp!.baseline.selfAddress), row.payload.rsvp!.request.response) : providerRsvpDesiredState(intent.baselineState, row.externalCalendarID, row.payload.rsvp!.request.response))))
          return settle(tx, row, "unconfirmed", row.payload.reminderInstance ? "reminder-confirmation-unavailable" : "rsvp-confirmation-unavailable", resultRef);
      }
      const [target] = await tx
        .select()
        .from(externalCalendars)
        .where(
          and(
            eq(externalCalendars.id, row.externalCalendarLinkID),
            eq(externalCalendars.calendarID, row.calendarID),
            eq(externalCalendars.userID, row.userID),
            eq(externalCalendars.provider, row.provider),
            eq(externalCalendars.accountID, row.accountID),
            eq(externalCalendars.externalCalendarID, row.externalCalendarID),
            eq(externalCalendars.disabled, false),
            eq(externalCalendars.supportsEvents, true),
          ),
        );
      if (!target)
        return settle(
          tx,
          row,
          "cancelled",
          "destination-disconnected",
          resultRef,
        );
      if (row.payload.googleOccurrence) {
        const [master] = await tx.select({ revision: events.revision, deletedAt: events.deletedAt }).from(events).where(eq(events.id, row.payload.googleOccurrence.master.id));
        if (!master || master.deletedAt || master.revision !== row.payload.googleOccurrence.master.revision)
          return settle(tx, row, "unconfirmed", "local-master-revision-changed", resultRef);
      }
      // A projected RSVP echo is only a candidate. Native fields omitted by
      // the read DTO are proved by the worker's full GET at this exact ETag.
      // Never replace another pulled version just because the ACK clock is later.
      if (settings && row.remoteSnapshot && (row.remoteSnapshot.deleted || row.remoteSnapshot.externalEventId !== resultRef?.externalEventId || row.remoteSnapshot.etag !== resultRef?.etag)) {
        row.remoteSnapshot = { ...row.remoteSnapshot, isEcho: false };
        return settle(tx, row, "conflict", "provider-conflict", resultRef);
      }
      // A formerly unrecognized Graph response side effect may already be
      // retained as a conflict. Only this fully confirmed native version can
      // reconcile that exact content/time/state snapshot, never a different pull.
      if (row.payload.rsvp?.request.provider === "microsoft" && graphConfirmation && observation?.isEcho && row.remoteSnapshot && !row.remoteSnapshot.isEcho) {
        const snapshot = row.remoteSnapshot;
        const values = EventSchema.pick({ title: true, start: true, end: true, isAllDay: true, description: true, location: true, recurrence: true, timeModel: true, seriesID: true, originalStart: true, isCanceled: true }).partial({ isCanceled: true }).safeParse(snapshot.values);
        if (snapshot.icalUid === resultRef?.icalUid && observation.observedAt >= snapshot.observedAt &&
            isDeepStrictEqual(snapshot.providerState, observation.providerState) && values.success &&
            isDeepStrictEqual(values.data.timeModel, row.payload.rsvp.nativeTime) &&
            matchesRsvpEventProjection("microsoft", row.payload.event, { ...values.data, externalSeriesID: typeof snapshot.values?.externalSeriesID === "string" ? snapshot.values.externalSeriesID : undefined, description: values.data.description ?? null, location: values.data.location ?? null, recurrence: values.data.recurrence ?? null }, undefined, row.payload.rsvp.graphOccurrence)) row.remoteSnapshot = observation;
      }
      if (observation?.isEcho && observation.externalEventId === resultRef?.externalEventId &&
          (!row.remoteSnapshot || row.remoteSnapshot.isEcho && observation.observedAt >= row.remoteSnapshot.observedAt))
        row.remoteSnapshot = observation;
      if (row.remoteSnapshot && !row.remoteSnapshot.isEcho)
        return settle(tx, row, "conflict", "provider-conflict", resultRef);
      if (row.action !== "delete" && resultRef) {
        const [deleted] = await tx
          .select()
          .from(externalEventTombstones)
          .where(
            and(
              eq(
                externalEventTombstones.externalCalendarLinkID,
                row.externalCalendarLinkID,
              ),
              eq(
                externalEventTombstones.externalEventID,
                resultRef.externalEventId,
              ),
            ),
          );
        if (deleted) {
          row.remoteSnapshot = {
            externalEventId: resultRef.externalEventId,
            etag: null,
            deleted: true,
            observedAt: deleted.observedAt.toISOString(),
          };
          return settle(tx, row, "conflict", "provider-conflict", resultRef);
        }
      }
      if (
        row.action !== "delete" &&
        current?.revision !== row.revision &&
        !(await coversCurrentRevision(tx, row, current?.revision))
      )
        return settle(
          tx,
          row,
          "unconfirmed",
          "local-revision-changed",
          resultRef,
        );
      const [linked] = await tx
        .select({ id: calendarEvents.eventID })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.eventID, row.eventID),
            eq(calendarEvents.calendarID, row.calendarID),
          ),
        );
      if (
        row.action !== "delete" &&
        resultRef &&
        current &&
        !current.deletedAt &&
        linked
      ) {
        const mappings = await tx
          .select()
          .from(externalEvents)
          .where(
            and(
              eq(externalEvents.provider, row.provider),
              eq(externalEvents.calendarID, row.calendarID),
              eq(externalEvents.eventID, row.eventID),
            ),
          )
          .for("update");
        const [occupied] = await tx
          .select()
          .from(externalEvents)
          .where(
            and(
              eq(externalEvents.provider, row.provider),
              eq(externalEvents.calendarID, row.calendarID),
              eq(externalEvents.externalEventID, resultRef.externalEventId),
            ),
          );
        if (
          (occupied && occupied.eventID !== row.eventID) ||
          mappings.length > 1
        )
          return settle(
            tx,
            row,
            "conflict",
            "mapping-identity-changed",
            resultRef,
          );
        const mapping = mappings[0];
        if (settings && (!mapping || mapping.id !== settings.mappingID || providerStateVersion(mapping) !== settings.request.expectedStateVersion))
          return settle(tx, row, "conflict", "mapping-version-changed", resultRef);
        if (settings) {
          try {
            const instance = row.provider === "google" && current && mapping ? await readProviderRsvpInstance(tx, current, mapping, row.userID) : undefined;
            if (row.provider === "microsoft" && (!current || !mapping || mapping.icalUid !== row.icalUid || !isDeepStrictEqual(readGraphRsvpOccurrence(current, mapping, row.userID), row.payload.rsvp?.graphOccurrence))) return settle(tx, row, "unconfirmed", sourceChanged, resultRef);
            if (row.provider === "caldav" && (mapping?.externalSeriesID || mapping?.originalStart || mapping?.icalUid !== row.icalUid)) return settle(tx, row, "unconfirmed", sourceChanged, resultRef);
            if (!isDeepStrictEqual(instance, settings.instance))
              return settle(tx, row, "unconfirmed", sourceChanged, resultRef);
          } catch { return settle(tx, row, "unconfirmed", sourceChanged, resultRef); }
        }
        if (
          mapping &&
          (mapping.externalEventID !== resultRef.externalEventId ||
            (row.action === "update" &&
              (mapping.externalEventID !== expectedRef?.externalEventId ||
                mapping.etag !== (expectedRef?.etag ?? null))))
        )
          return settle(
            tx,
            row,
            "conflict",
            "mapping-version-changed",
            resultRef,
          );
        // This is the last observed personal state, not a projection of our
        // content write. Its observation may precede or follow the ACK version.
        const observedState = row.remoteSnapshot?.isEcho &&
          row.remoteSnapshot.externalEventId === resultRef.externalEventId &&
          !row.remoteSnapshot.deleted && row.remoteSnapshot.providerState
          ? ProviderEventStateSchema.parse(row.remoteSnapshot.providerState) : undefined;
        if (observedState && observedState.provider !== row.provider)
          throw new Error("Provider observation destination mismatch.");
        const observedAt = row.remoteSnapshot ? new Date(row.remoteSnapshot.observedAt) : null;
        const acceptState = observedState && observedAt && Number.isFinite(observedAt.getTime()) &&
          (!mapping?.providerStateObservedAt || observedAt > mapping.providerStateObservedAt);
        const metadata = {
          ...(acceptState ? { providerState: observedState, providerStateObservedAt: observedAt } : {}),
          etag: resultRef.etag ?? null,
          icalUid: resultRef.icalUid ?? mapping?.icalUid ?? null,
        };
        if (mapping)
          await tx
            .update(externalEvents)
            .set(metadata)
            .where(eq(externalEvents.id, mapping.id));
        else if (row.action === "create")
          await tx.insert(externalEvents).values({
            provider: row.provider,
            eventID: row.eventID,
            calendarID: row.calendarID,
            externalCalendarID: row.externalCalendarID,
            externalEventID: resultRef.externalEventId,
            ...metadata,
          });
        else
          return settle(
            tx,
            row,
            "conflict",
            "mapping-identity-changed",
            resultRef,
          );
      }
      if (row.action === "delete" && expectedRef) {
        const [mapping] = await tx
          .select()
          .from(externalEvents)
          .where(
            and(
              eq(externalEvents.provider, row.provider),
              eq(externalEvents.calendarID, row.calendarID),
              eq(externalEvents.eventID, row.eventID),
            ),
          )
          .for("update");
        if (mapping) {
          if (
            mapping.externalEventID !== expectedRef.externalEventId ||
            mapping.etag !== (expectedRef.etag ?? null)
          )
            return settle(
              tx,
              row,
              "conflict",
              "mapping-version-changed",
              resultRef,
            );
          await tx
            .delete(externalEvents)
            .where(eq(externalEvents.id, mapping.id));
        }
      }
      return settle(
        tx,
        row,
        resultRef || row.action === "delete" ? "completed" : "not-needed",
        null,
        resultRef,
      );
      })();
      signal?.throwIfAborted();
      return result;
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DeliveryLeaseExpired) return undefined;
    throw new Error("Event delivery acknowledgement could not be persisted.");
  }
}
