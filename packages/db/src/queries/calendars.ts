import { and, eq, inArray } from "drizzle-orm";
import { db } from "..";
import { calendarEvents, calendarInvites, calendarMembers, calendars, events, NewCalendar } from "../schema";
import { NotFoundError } from "@musubi/types";


export async function createCalendar(calendar: NewCalendar) {
  const [result] = await db
    .insert(calendars)
    .values(calendar)
    .onConflictDoNothing()
    .returning();
  await db.insert(calendarMembers).values({
    userID: result.creatorID,
    calendarID: result.id,
    role: "owner",
  })
  return result;
}

export async function getCalendarIDFromToken(token: string) {
  const [result] = await db
    .select().from(calendarInvites).where(eq(calendarInvites.id, token));

  if (!result) {
    throw new NotFoundError("Invite not found...");
  }



  return result.calendarID;
}

export async function getCalendar(id: string) {
  const [result] = await db
    .select()
    .from(calendars)
    .where(eq(calendars.id, id));

  if (!result) {
    throw new NotFoundError("Calendar not found...");
  }

  return result;
}

export async function removeCalendar(calendarID: string) {
  // Events HOMED here die with the calendar — including copies linked into
  // other calendars. Tombstone (not hard-delete) so other members' delta sync
  // drops them; must run BEFORE the calendar row goes, because the FK would
  // set originCalendarID to null and hide them from this query.
  await db.update(events)
    .set({ deletedAt: new Date() })
    .where(eq(events.originCalendarID, calendarID));

  const eIDs = await db.select({ eventID: calendarEvents.eventID }).from(calendarEvents).where(eq(calendarEvents.calendarID, calendarID));

  const [result] = await db.delete(calendars).where(eq(calendars.id, calendarID)).returning();

  const stillLinked = await db
    .select({ eventID: calendarEvents.eventID })
    .from(calendarEvents)
    .where(inArray(calendarEvents.eventID, eIDs.map(e => (e.eventID))))

  const orphanedEvents = eIDs.filter(candidate =>
    !stillLinked.some(linked => linked.eventID === candidate.eventID));

  if (orphanedEvents.length > 0) {
    await db.delete(events).where(inArray(events.id, orphanedEvents.map(e => (e.eventID))));
  }

  return result;
}

export async function updateCalendar(calendar: NewCalendar) {
  const [result] = await db
    .update(calendars)
    .set(calendar)
    .where(eq(calendars.id, calendar.id!)).returning();
  return result;
}

export async function getUsersCalendars(userID: string) {
  const result = await db.query.calendarMembers.findMany({
    where: eq(calendarMembers.userID, userID),
    with: {
      calendars: true,
    }
  });

  return result;
}

export async function getCalendarMembers(calendarID: string) {
  const result = await db.query.calendarMembers.findMany({
    where: eq(calendarMembers.calendarID, calendarID),
    with: {
      user: true,
    }
  });

  // Owner first everywhere members are shown; name as a stable tiebreaker.
  const rank: Record<string, number> = { owner: 0, editor: 1, viewer: 2 };
  result.sort((a, b) =>
    (rank[a.role] ?? 9) - (rank[b.role] ?? 9)
    || a.user.name.localeCompare(b.user.name)
  );

  return result;
}

export async function getCalendarEvents(calendarID: string) {
  const result = await db.query.calendarEvents.findMany({
    where: eq(calendarEvents.calendarID, calendarID),
    with: {
      events: true,
    }
  });

  return result;
}

// The user's role on a calendar (owner | editor | viewer), or null if not a member.
export async function getUserRoleForCalendar(userID: string, calendarID: string): Promise<string | null> {
  const [row] = await db
    .select({ role: calendarMembers.role })
    .from(calendarMembers)
    .where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID)));
  return row?.role ?? null;
}

export async function addCalendarMember(userID: string, calendarID: string) {
  const result = await db
    .insert(calendarMembers)
    .values({ userID, calendarID, role: "viewer" }) // new members start read-only
    .onConflictDoNothing()
    .returning();

  return result;
}

// Change a member's role. Owner is intentionally not assignable here (no accidental
// second owner / ownership transfer) — validated in the handler.
export async function setMemberRole(userID: string, calendarID: string, role: string) {
  const [result] = await db
    .update(calendarMembers)
    .set({ role })
    .where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID)))
    .returning();

  return result;
}

export async function removeCalendarMember(userID: string, calendarID: string) {
  const [result] = await db
    .delete(calendarMembers)
    .where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID)))
    .returning();

  return result
}

