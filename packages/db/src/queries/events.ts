import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "..";
import { NewEvent, calendarEvents, calendarMembers, eventUsers, events } from "../schema";


export async function createEvent(event: NewEvent, calendars: string[]) {
  const [result] = await db
    .insert(events)
    .values(event)
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

export async function getEvent(id: string) {
  const [result] = await db
    .select()
    .from(events)
    .where(eq(events.id, id));
  return result;
}

export async function updateEvent(event: NewEvent) {
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

