import { googleRsvpDeliveryPolicy, CaldavRsvpDeliverySchema, OrganizerDispatchSchema, ProviderOrganizerRequestSchema } from "@musubi/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { GraphRsvpDispatchSchema, ProviderRsvpEditSchema, NotFoundError } from "@musubi/types";
import { db } from "..";
import {
  calendars,
  calendarMembers,
  events,
  eventOutbox,
  externalCalendars,
} from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";
import type { DbTransaction } from "./calendars";
import type { EventOutboxRow } from "./event-outbox";

export class EventDeliveryRetryError extends Error {
  constructor(
    readonly code:
      | "delivery-destination-unavailable"
      | "delivery-conflict-unresolved"
      | "delivery-predecessor-unresolved",
  ) {
    super(
      "Delivery cannot be retried in its current state. Refresh its status.",
    );
    this.name = "EventDeliveryRetryError";
  }
}

/** Shared action authorization; display receipt ownership alone is insufficient. */
export async function assertEventDeliveryDestination(
  tx: DbTransaction,
  row: EventOutboxRow,
  userID: string,
  lock = false,
) {
  const query = tx
    .select({ id: externalCalendars.id })
    .from(externalCalendars)
    .innerJoin(calendars, eq(calendars.id, externalCalendars.calendarID))
    .innerJoin(
      calendarMembers,
      and(
        eq(calendarMembers.calendarID, calendars.id),
        eq(calendarMembers.userID, userID),
      ),
    )
    .where(
      and(
        eq(externalCalendars.id, row.externalCalendarLinkID),
        eq(externalCalendars.calendarID, row.calendarID),
        eq(externalCalendars.userID, userID),
        eq(calendars.creatorID, userID),
        eq(externalCalendars.provider, row.provider),
        eq(externalCalendars.accountID, row.accountID),
        eq(externalCalendars.externalCalendarID, row.externalCalendarID),
        eq(externalCalendars.disabled, false),
        eq(externalCalendars.supportsEvents, true),
        inArray(calendarMembers.role, ["owner", "editor"]),
      ),
    );
  // Read-only preview transactions cannot lock. Mutating callers hold the
  // grant through admission so a concurrent downgrade cannot slip past it.
  const [destination] = lock ? await query.for("share", { of: [calendarMembers, externalCalendars] }) : await query;
  if (!destination || row.userID !== userID)
    throw new EventDeliveryRetryError("delivery-destination-unavailable");
}

/** Re-admit the exact committed intent, without changing its payload, accepted
 * remote version, uncertainty or provider identity. No provider call in this tx. */
export async function requestEventDeliveryRetry(
  userID: string,
  eventID: string,
  operationID: string,
) {
  return db.transaction(async (tx) => {
    const owned = and(
      eq(eventOutbox.id, operationID),
      eq(eventOutbox.eventID, eventID),
      eq(eventOutbox.userID, userID),
    );
    const [address] = await tx
      .select({ calendarID: eventOutbox.calendarID })
      .from(eventOutbox)
      .where(owned);
    if (!address) throw new NotFoundError("Delivery operation not found.");
    await lockCalendarLifecycle(tx, [address.calendarID], "shared");
    await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventID))
      .for("update");
    const [row] = await tx
      .select()
      .from(eventOutbox)
      .where(owned)
      .for("update");
    if (!row) throw new NotFoundError("Delivery operation not found.");
    await assertEventDeliveryDestination(tx, row, userID, true);
    if (row.status === "cancelled")
      throw new EventDeliveryRetryError("delivery-destination-unavailable");
    const graphRequest = ProviderRsvpEditSchema.safeParse(row.payload.rsvp?.request);
    const caldavPolicy = CaldavRsvpDeliverySchema.safeParse(row.payload.rsvp?.caldavDelivery);
    const caldavCheck = row.provider === "caldav" && row.action === "update" && row.actorID === userID && graphRequest.success && graphRequest.data.provider === "caldav" &&
      (row.payload.rsvp?.caldavDelivery === undefined || caldavPolicy.success && caldavPolicy.data.startedAt !== undefined);
    let googleCheck = false;
    if (row.provider === "google" && row.action === "update" && row.actorID === userID && graphRequest.success && graphRequest.data.provider === "google") {
      // Requeue the original intent only for observation. Legacy markerless
      // intents also stay read-only; retry never synthesizes fresh permission.
      try { googleCheck = googleRsvpDeliveryPolicy(row.payload.rsvp).observeOnly; } catch { /* Malformed private policy grants no bypass. */ }
    }
    const graphCheck = row.provider === "microsoft" && row.action === "update" && row.actorID === userID && graphRequest.success && graphRequest.data.provider === "microsoft" && GraphRsvpDispatchSchema.safeParse(row.payload.rsvp?.graphDispatch).success;
    // A dispatched Graph response can only be observed again. Keep its original
    // conflict snapshot and permanent marker; this never authorizes another POST.
    const graphCreateCheck = row.provider === "microsoft" && row.action === "create" && row.actorID === userID && row.uncertain && row.payload.graphSeriesCreate?.version === 1;
    const graphContentCheck = row.provider === "microsoft" && row.action === "update" && row.actorID === userID && !!row.payload.graphOccurrenceContent?.dispatch?.startedAt;
    const graphMeetingCheck = row.provider === "microsoft" && row.action === "delete" && row.actorID === userID && !!row.payload.graphMeetingCancellation?.dispatch?.startedAt;
    const organizerCheck = ["google", "caldav", "microsoft"].includes(row.provider) && row.payload.organizer?.request.provider === row.provider && row.payload.organizer?.dispatch?.kind === `${row.provider}-organizer-dispatch` && row.actorID === userID && ProviderOrganizerRequestSchema.safeParse(row.payload.organizer?.request).success && OrganizerDispatchSchema.safeParse(row.payload.organizer?.dispatch).success;
    if (!googleCheck && !caldavCheck && !graphCheck && !organizerCheck && !graphMeetingCheck && !graphContentCheck && !graphCreateCheck && (
      row.status === "conflict" ||
      (row.remoteSnapshot && !row.remoteSnapshot.isEcho)
    ))
      throw new EventDeliveryRetryError("delivery-conflict-unresolved");
    if (["completed", "not-needed", "attempting"].includes(row.status))
      return row.id;
    if (row.predecessorID) {
      const [previous] = await tx
        .select({ status: eventOutbox.status })
        .from(eventOutbox)
        .where(eq(eventOutbox.id, row.predecessorID));
      if (!previous || !["completed", "not-needed"].includes(previous.status))
        throw new EventDeliveryRetryError("delivery-predecessor-unresolved");
    }
    await tx
      .update(eventOutbox)
      .set({
        status:
          googleCheck || caldavCheck || graphCheck || organizerCheck || graphMeetingCheck || graphContentCheck || graphCreateCheck || row.uncertain || row.status === "unconfirmed"
            ? "unconfirmed"
            : "retry",
        uncertain: googleCheck || caldavCheck || graphCheck || organizerCheck || graphMeetingCheck || graphContentCheck || graphCreateCheck || row.uncertain || row.status === "unconfirmed",
        updatedAt: new Date(),
        // A manual click must not shorten a provider's persisted Retry-After.
        nextAttemptAt: sql`greatest(${eventOutbox.nextAttemptAt}, clock_timestamp())`,
      })
      .where(eq(eventOutbox.id, row.id));
    return row.id;
  });
}
