import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "..";
import { NewEvent, calendarEvents, calendarMembers, eventUsers, events } from "../schema";


export async function createEvent(event: NewEvent, calendars: string[]) {
  // Home calendar = where it's created (first picked). Edit-content is gated by
  // editEvents on this calendar; the other picked calendars are read-only shares.
  const [result] = await db
    .insert(events)
    .values({ ...event, originCalendarID: event.originCalendarID ?? calendars[0] })
    .onConflictDoNothing()
    .returning();
  await db.insert(eventUsers).values({
    userID: result.creatorID,
    eventID: result.id,
  })

  await db.insert(calendarEvents).values(calendars.map(c => (
    {
      calendarID: c,
      eventID: result.id,
    }
  )));

  return result;
}

// Who governs editing this event's shared content: its home calendar (+ creator
// as legacy fallback when origin is null). Used by assertCanEditEvent.
export async function getEventOrigin(eventID: string): Promise<{ originCalendarID: string | null; creatorID: string } | undefined> {
  const [row] = await db
    .select({ originCalendarID: events.originCalendarID, creatorID: events.creatorID })
    .from(events)
    .where(eq(events.id, eventID));
  return row;
}

// Calendars an event is currently linked to (from calendar_events). Used to diff
// against the incoming set on update → add/remove links + push to providers.
export async function getEventCalendars(eventID: string): Promise<string[]> {
  const rows = await db
    .select({ calendarID: calendarEvents.calendarID })
    .from(calendarEvents)
    .where(eq(calendarEvents.eventID, eventID));
  return rows.map(r => r.calendarID);
}

export async function getEvent(id: string) {
  const [result] = await db
    .select()
    .from(events)
    .where(eq(events.id, id));
  return result;
}

export async function updateEvent(event: Partial<NewEvent> & { id: string }) {
  const [result] = await db
    .update(events)
    .set(event)
    .where(eq(events.id, event.id!)).returning();
  return result;
}

export async function getUsersEvents(userID: string, since?: Date) {
  // Flat join (drizzle can't filter a to-one nested relation).
  //  - no `since`  → full active set (deletedAt IS NULL)
  //  - with `since` → delta: everything changed since, INCLUDING soft-deleted
  //    (so the client can drop them from its local cache)
  const changeFilter = since !== undefined
    ? gt(events.updatedAt, since)
    : isNull(events.deletedAt);

  return db
    .select({ event: events, calendarID: calendarEvents.calendarID })
    .from(calendarMembers)
    .innerJoin(calendarEvents, eq(calendarEvents.calendarID, calendarMembers.calendarID))
    .innerJoin(events, eq(events.id, calendarEvents.eventID))
    .where(and(eq(calendarMembers.userID, userID), changeFilter));
}

// Attendees: name + avatar only — no emails (an event can span calendars whose
// members aren't mutuals, so don't leak what the UI doesn't need).
export async function getEventAttendees(eventID: string) {
  const rows = await db.query.eventUsers.findMany({
    where: eq(eventUsers.eventID, eventID),
    with: { user: true },
  });
  rows.sort((a, b) => a.user.name.localeCompare(b.user.name));
  return rows.map(r => ({ id: r.user.id, name: r.user.name, image: r.user.image }));
}

// Idempotent join/leave — the unique (event, user) constraint absorbs retries.
export async function setAttendance(eventID: string, userID: string, attending: boolean) {
  if (attending) {
    await db.insert(eventUsers).values({ eventID, userID }).onConflictDoNothing();
  } else {
    await db.delete(eventUsers).where(and(eq(eventUsers.eventID, eventID), eq(eventUsers.userID, userID)));
  }
}

// Hard-delete tombstones older than `before` (cascades their calendarEvents +
// externalEvents mappings). Clients that haven't synced in that long won't see
// the removal, but that window is intentionally generous.
export async function purgeDeletedEvents(before: Date) {
  await db.delete(events).where(and(isNotNull(events.deletedAt), lt(events.deletedAt, before)));
}

export async function removeEvent(eventID: string) {
  // Soft-delete: keep the row as a tombstone so delta sync can tell clients to
  // drop it. Bumps updatedAt via $onUpdate → picked up by `since` queries.
  const [result] = await db.update(events)
    .set({ deletedAt: new Date() })
    .where(eq(events.id, eventID))
    .returning();

  return result;
}

