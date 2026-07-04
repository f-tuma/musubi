import { and, eq, gte, isNotNull, lte, or } from "drizzle-orm";
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

export async function getUsersEvents(userID: string, from?: Date, to?: Date) {
  // Flat join (drizzle can't filter a to-one nested relation). Window: one-off
  // events overlapping [from, to]; recurring masters always (they expand
  // client-side, so their master start may be far in the past).
  const windowed = from !== undefined && to !== undefined;

  return db
    .select({ event: events, calendarID: calendarEvents.calendarID })
    .from(calendarMembers)
    .innerJoin(calendarEvents, eq(calendarEvents.calendarID, calendarMembers.calendarID))
    .innerJoin(events, eq(events.id, calendarEvents.eventID))
    .where(and(
      eq(calendarMembers.userID, userID),
      windowed
        ? or(isNotNull(events.recurrence), and(lte(events.start, to!), gte(events.end, from!)))
        : undefined,
    ));
}

export async function removeEvent(eventID: string) {
  const [result] = await db.delete(events).where(eq(events.id, eventID)).returning();

  return result;
}

