import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
  NotFoundError,
  isSyncOperationBlockCode,
  type EventDelivery,
  type EventDeliveryTarget,
} from "@musubi/types";
import { db } from "..";
import {
  calendars,
  calendarEvents,
  calendarMembers,
  events,
  eventOutbox,
  externalCalendars,
} from "../schema";
import { unresolvedEventOutbox } from "./event-outbox";

function deliveryIssue(
  status: EventDeliveryTarget["status"],
  code: string | null,
): EventDeliveryTarget["issue"] {
  if (["unknown", "completed", "not-needed"].includes(status)) return null;
  if (status === "conflict") return "conflict";
  if (isSyncOperationBlockCode(code)) return "recovery-unavailable";
  if (code === "provider-reconnect-required") return "reconnect-required";
  if (code === "provider-write-denied") return "write-denied";
  if (code === "provider-write-unsupported") return "write-unsupported";
  if (code === "provider-permission-unknown") return "permission-unknown";
  if (code === "destination-disconnected") return "destination-unavailable";
  if (
    code === "create-recovery-unavailable" ||
    code === "create-outcome-unknown"
  )
    return "recovery-unavailable";
  if (status === "unconfirmed") return "unconfirmed";
  return ["blocked", "not-written", "retry"].includes(status)
    ? "delivery-failed"
    : null;
}

/** Authorization and receipts share one snapshot. Select only display metadata:
 * event payloads, remote snapshots, account IDs and resource addresses stay in DB.
 * Former destination owners may read their own retained deletion receipts; being
 * an event collaborator never grants access to other private destinations. */
export async function getEventDeliveryStatus(
  userID: string,
  eventID: string,
): Promise<EventDelivery> {
  return db.transaction(
    async (tx) => {
      const membership = sql`exists (select 1 from ${calendarMembers}
      where ${calendarMembers.calendarID} = ${calendarEvents.calendarID}
      and ${calendarMembers.userID} = ${userID})`;
      const [visibleEvent] = await tx
        .select({ revision: events.revision })
        .from(events)
        .where(
          and(
            eq(events.id, eventID),
            sql`exists (
        select 1 from ${calendarEvents} where ${calendarEvents.eventID} = ${events.id} and ${membership}
      )`,
          ),
        );

      const currentTargets = await tx
        .select({
          targetId: externalCalendars.id,
          calendarId: calendars.id,
          calendarName: calendars.name,
          provider: externalCalendars.provider,
          owned: sql<boolean>`${externalCalendars.userID} = ${userID}`,
        })
        .from(calendarEvents)
        .innerJoin(calendars, eq(calendars.id, calendarEvents.calendarID))
        .innerJoin(
          externalCalendars,
          eq(externalCalendars.calendarID, calendars.id),
        )
        .where(
          and(
            eq(calendarEvents.eventID, eventID),
            membership,
            eq(externalCalendars.disabled, false),
          ),
        );

      const currentDestination = and(
        eq(externalCalendars.id, eventOutbox.externalCalendarLinkID),
        eq(externalCalendars.calendarID, eventOutbox.calendarID),
        eq(externalCalendars.provider, eventOutbox.provider),
        eq(externalCalendars.userID, eventOutbox.userID),
        eq(externalCalendars.accountID, eventOutbox.accountID),
        eq(
          externalCalendars.externalCalendarID,
          eventOutbox.externalCalendarID,
        ),
        eq(externalCalendars.disabled, false),
      );
      const visibleReceipt = and(
        eq(eventOutbox.eventID, eventID),
        or(
          eq(eventOutbox.userID, userID),
          sql`(${externalCalendars.id} is not null and exists (
        select 1 from ${calendarEvents} where ${calendarEvents.eventID} = ${eventOutbox.eventID}
        and ${calendarEvents.calendarID} = ${eventOutbox.calendarID} and ${membership}
      ))`,
        ),
      );
      const fields = {
        targetId: eventOutbox.externalCalendarLinkID,
        calendarId: eventOutbox.calendarID,
        // A historical receipt must not reveal a replacement owner's calendar name.
        calendarName: sql<
          string | null
        >`case when ${externalCalendars.id} is not null then ${calendars.name} else null end`,
        provider: eventOutbox.provider,
        connected: sql<boolean>`${externalCalendars.id} is not null`,
        owned: sql<boolean>`${eventOutbox.userID} = ${userID}`,
        operationId: eventOutbox.id,
        action: eventOutbox.action,
        status: eventOutbox.status,
        revision: eventOutbox.revision,
        updatedAt: eventOutbox.updatedAt,
        nextAttemptAt: eventOutbox.nextAttemptAt,
        errorCode: eventOutbox.errorCode,
        graphCreateCheck: sql<boolean>`${eventOutbox.provider} = 'microsoft' and ${eventOutbox.action} = 'create' and ${eventOutbox.actorID} = ${userID} and ${eventOutbox.uncertain} and ${eventOutbox.payload}->'graphSeriesCreate'->'version' = '1'::jsonb`,
        caldavRsvp: sql<boolean>`${eventOutbox.provider} = 'caldav' and ${eventOutbox.payload}->'rsvp'->'request'->>'provider' = 'caldav'`,
        caldavCheckOnly: sql<boolean>`${eventOutbox.payload}->'rsvp'->'caldavDelivery' is null or ${eventOutbox.payload}->'rsvp'->'caldavDelivery'->>'startedAt' is not null`,
        graphRsvp: sql<boolean>`${eventOutbox.payload}->'rsvp'->'request'->>'provider' = 'microsoft'`,
        graphDispatched: sql<boolean>`${eventOutbox.payload}->'rsvp'->'graphDispatch' is not null`,
        graphAccepted: sql<boolean>`${eventOutbox.payload}->'rsvp'->'graphDispatch'->>'acceptedAt' is not null`,
        organizer: sql<boolean>`(${eventOutbox.payload}->'organizer' is not null or ${eventOutbox.payload}->'graphMeetingCancellation' is not null or ${eventOutbox.payload}->'graphOccurrenceContent' is not null)`,
        organizerDispatched: sql<boolean>`(${eventOutbox.payload}->'organizer'->'dispatch' is not null or ${eventOutbox.payload}->'graphMeetingCancellation'->'dispatch' is not null or ${eventOutbox.payload}->'graphOccurrenceContent'->'dispatch' is not null)`,
        organizerAccepted: sql<boolean>`(${eventOutbox.payload}->'organizer'->'dispatch'->'acceptedAt' is not null or ${eventOutbox.payload}->'graphMeetingCancellation'->'dispatch'->'acceptedAt' is not null or ${eventOutbox.payload}->'graphOccurrenceContent'->'dispatch'->'acceptedAt' is not null)`,
        alarm: sql<boolean>`${eventOutbox.payload}->'caldavAlarm' is not null`,
      };
      const receipts = (unresolved: boolean) =>
        tx
          .selectDistinctOn([eventOutbox.externalCalendarLinkID], fields)
          .from(eventOutbox)
          .leftJoin(externalCalendars, currentDestination)
          .leftJoin(calendars, eq(calendars.id, externalCalendars.calendarID))
          .where(
            and(
              visibleReceipt,
              unresolved ? unresolvedEventOutbox() : undefined,
            ),
          )
          .orderBy(
            eventOutbox.externalCalendarLinkID,
            ...(unresolved
              ? [
                  asc(eventOutbox.revision),
                  asc(eventOutbox.createdAt),
                  asc(eventOutbox.position),
                  asc(eventOutbox.id),
                ]
              : [
                  desc(eventOutbox.revision),
                  desc(eventOutbox.createdAt),
                  desc(eventOutbox.position),
                  desc(eventOutbox.id),
                ]),
          );
      const latest = await receipts(false);
      if (!visibleEvent && !latest.length)
        throw new NotFoundError("Event not found.");
      const blockers = new Map(
        (await receipts(true)).map((row) => [row.targetId, row]),
      );
      const targets = new Map<string, EventDeliveryTarget>(
        currentTargets.map((row) => [
          row.targetId,
          {
            ...row,
            connected: true,
            operationId: null,
            action: null,
            status: "unknown",
            revision: null,
            latestRevision: null,
            updatedAt: null,
            retryAt: null,
            issue: null,
          },
        ]),
      );
      for (const last of latest) {
        const first = blockers.get(last.targetId) ?? last;
        const { nextAttemptAt, errorCode, alarm, caldavRsvp, caldavCheckOnly, graphCreateCheck, graphRsvp, graphDispatched, graphAccepted, organizer, organizerDispatched, organizerAccepted, ...display } = first;
        targets.set(first.targetId, {
          ...display,
          ...(caldavRsvp ? { caldavRsvpPhase: ["completed", "not-needed"].includes(first.status) ? "observed" as const : caldavCheckOnly ? "check-only" as const : "queued" as const } : {}),
          ...(graphCreateCheck && first.owned && first.connected ? { graphCreateCheck: true as const } : {}),
          ...(graphRsvp ? { graphRsvpPhase: (["completed", "not-needed"].includes(first.status) ? "observed" : errorCode === "graph-rsvp-copy-absent" ? "absent" : graphAccepted ? "accepted" : graphDispatched ? "dispatched" : "queued") as NonNullable<EventDeliveryTarget["graphRsvpPhase"]> } : {}),
          ...(organizer ? { organizerPhase: first.status === "not-needed" ? "unchanged" as const : first.status === "completed" ? "observed" as const : errorCode === "organizer-copy-absent" ? "absent" as const : organizerAccepted ? "accepted" as const : organizerDispatched ? "dispatched" as const : "queued" as const } : {}),
          ...(first.status === "not-needed" && errorCode === "adopted-provider-version" ? { graphCreateAdopted: true as const } : {}),
          ...(alarm && first.status === "not-needed" && errorCode === "alarm-discarded" ? { alarmDiscarded: true as const } : {}),
          ...(alarm && first.owned && first.connected && visibleEvent && ["conflict", "blocked", "unconfirmed"].includes(first.status) ? { alarmDiscardRevision: visibleEvent.revision } : {}),
          latestRevision: last.revision,
          issue: deliveryIssue(first.status, errorCode),
          retryAt: ["pending", "retry", "unconfirmed"].includes(first.status)
            ? nextAttemptAt
            : null,
        });
      }
      return {
        eventId: eventID,
        localRevision: visibleEvent?.revision ?? null,
        targets: [...targets.values()].sort(
          (a, b) =>
            a.calendarId.localeCompare(b.calendarId) ||
            a.targetId.localeCompare(b.targetId),
        ),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
