import { and, eq, inArray } from "drizzle-orm";
import {
  calendarEvents,
  calendarMembers,
  calendars,
  db,
  events,
  externalCalendars,
  externalEvents,
} from "..";

// Column values written to the `events` row for a synced event.
type EventValues = {
  title: string;
  color: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  description: string | null;
  location: string | null;
  organizer: string;
  recurrence: string | null;
  url: string | null;
};

// --- calendars ---

export async function getUserExternalCalendars(provider: string, userID: string, accountID: string) {
  return db
    .select({
      calendarID: externalCalendars.calendarID,
      externalCalendarID: externalCalendars.externalCalendarID,
      cursor: externalCalendars.cursor,
      calColor: calendars.color,
    })
    .from(externalCalendars)
    .innerJoin(calendars, eq(externalCalendars.calendarID, calendars.id))
    .where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID),
    ));
}

export async function doesExternalCalIDExist(provider: string, accountID: string, externalCalendarID: string) {
  const [res] = await db
    .select()
    .from(externalCalendars)
    .where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.accountID, accountID),
      eq(externalCalendars.externalCalendarID, externalCalendarID),
    ));
  return !!res;
}

export async function importExternalCalendar(
  provider: string,
  userID: string,
  accountID: string,
  accountLabel: string,
  cal: { externalId: string; name: string; color: string },
) {
  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(calendars)
      .values({ creatorID: userID, name: cal.name, color: cal.color })
      .returning();
    await tx.insert(externalCalendars).values({
      provider,
      userID,
      accountID,
      accountLabel,
      calendarID: created.id,
      externalCalendarID: cal.externalId,
      cursor: null,
    });
    await tx.insert(calendarMembers).values({ userID, calendarID: created.id, role: "owner" });
  });
}

// Keep the account label fresh across all of an account's calendars.
export async function setAccountLabel(provider: string, userID: string, accountID: string, accountLabel: string) {
  await db.update(externalCalendars)
    .set({ accountLabel })
    .where(and(
      eq(externalCalendars.provider, provider),
      eq(externalCalendars.userID, userID),
      eq(externalCalendars.accountID, accountID),
    ));
}

export async function setCursor(calendarID: string, cursor: string | null) {
  await db.update(externalCalendars).set({ cursor }).where(eq(externalCalendars.calendarID, calendarID));
}

// For push: given a Musubi calendar, which provider/external calendar/user backs it.
export async function getExternalLinkForCalendar(calendarID: string) {
  const [res] = await db
    .select({
      provider: externalCalendars.provider,
      externalCalendarID: externalCalendars.externalCalendarID,
      userID: externalCalendars.userID,
      accountID: externalCalendars.accountID,
      accountLabel: externalCalendars.accountLabel,
    })
    .from(externalCalendars)
    .where(eq(externalCalendars.calendarID, calendarID));
  return res ?? null;
}

// --- events ---

export async function clearCalendarEvents(calendarID: string) {
  // Soft-delete (tombstone) so the delta tells clients to drop them, and keep
  // the external_events mapping — a following upsert revives still-present events
  // with the SAME id (no churn); genuinely-gone ones stay tombstoned.
  await db.update(events).set({ deletedAt: new Date() }).where(inArray(events.id,
    db.select({ id: calendarEvents.eventID }).from(calendarEvents).where(eq(calendarEvents.calendarID, calendarID))));
}

// Link an event into calendars (calendar_events rows). Caller guarantees these are
// new links (the "added" diff), so no conflict handling needed.
export async function linkEventToCalendars(eventID: string, calendarIDs: string[]) {
  if (calendarIDs.length === 0) return;
  await db.insert(calendarEvents).values(calendarIDs.map(c => ({ eventID, calendarID: c })));
  await touchEvent(eventID);
}

// Delta sync filters on events.updatedAt, so link/unlink must bump the event row —
// otherwise offline members never learn the event's calendar membership changed.
async function touchEvent(eventID: string) {
  await db.update(events).set({ updatedAt: new Date() }).where(eq(events.id, eventID));
}

// Unlink an event from calendars: drop the calendar_events rows AND any external
// mapping for those calendars, so re-adding later pushes a fresh external event
// instead of updating a stale (possibly deleted) one.
export async function unlinkEventFromCalendars(eventID: string, calendarIDs: string[]) {
  if (calendarIDs.length === 0) return;
  await db.delete(calendarEvents)
    .where(and(eq(calendarEvents.eventID, eventID), inArray(calendarEvents.calendarID, calendarIDs)));

  const extCals = await db.select({ ext: externalCalendars.externalCalendarID })
    .from(externalCalendars).where(inArray(externalCalendars.calendarID, calendarIDs));
  const extIDs = extCals.map(e => e.ext);
  if (extIDs.length) {
    await db.delete(externalEvents)
      .where(and(eq(externalEvents.eventID, eventID), inArray(externalEvents.externalCalendarID, extIDs)));
  }
  await touchEvent(eventID);
}

export async function upsertExternalEvent(
  provider: string,
  userID: string,
  calendarID: string,
  externalCalendarID: string,
  externalEventID: string,
  values: EventValues,
  etag: string | null = null,
) {
  await db.transaction(async (tx) => {
    const [map] = await tx
      .select({ eventID: externalEvents.eventID })
      .from(externalEvents)
      .where(and(
        eq(externalEvents.provider, provider),
        eq(externalEvents.externalCalendarID, externalCalendarID),
        eq(externalEvents.externalEventID, externalEventID),
      ));

    if (map) {
      // revive if it was tombstoned by a reset's clearCalendarEvents
      await tx.update(events).set({ ...values, deletedAt: null }).where(eq(events.id, map.eventID));
      await tx.update(externalEvents).set({ etag }).where(eq(externalEvents.eventID, map.eventID));
    } else {
      const [ev] = await tx
        .insert(events)
        .values({ id: crypto.randomUUID(), ...values, creatorID: userID })
        .returning();
      await tx.insert(calendarEvents).values({ eventID: ev.id, calendarID });
      await tx.insert(externalEvents).values({ provider, eventID: ev.id, externalCalendarID, externalEventID, etag });
    }
  });
}

export async function deleteExternalEvent(provider: string, externalCalendarID: string, externalEventID: string) {
  await db.delete(events).where(inArray(events.id,
    db.select({ id: externalEvents.eventID }).from(externalEvents).where(and(
      eq(externalEvents.provider, provider),
      eq(externalEvents.externalCalendarID, externalCalendarID),
      eq(externalEvents.externalEventID, externalEventID),
    ))));
}

// For push update/delete: find the external id of an already-synced Musubi event.
export async function getExternalEventID(provider: string, eventID: string, externalCalendarID: string) {
  const [res] = await db
    .select({ externalEventID: externalEvents.externalEventID })
    .from(externalEvents)
    .where(and(
      eq(externalEvents.provider, provider),
      eq(externalEvents.eventID, eventID),
      eq(externalEvents.externalCalendarID, externalCalendarID),
    ));
  return res?.externalEventID ?? null;
}

// For push create: store the mapping after the provider returns the new id.
export async function importExternalEvent(
  provider: string,
  eventID: string,
  externalCalendarID: string,
  externalEventID: string,
  etag: string | null = null,
) {
  await db.insert(externalEvents).values({ provider, eventID, externalCalendarID, externalEventID, etag });
}
