import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "..";
import { calendarEvents, calendarInvites, calendarMembers, calendars, events, memberTokens, NewCalendar } from "../schema";
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

// Invite tokens are the calendar_invites uuid. Guard the shape first — a raw
// string against a uuid column is a Postgres error (500), not a miss (404).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCalendarIDFromToken(token: string) {
  if (!UUID_RE.test(token)) throw new NotFoundError("Invite not found...");

  const [result] = await db
    .select().from(calendarInvites)
    .where(and(
      eq(calendarInvites.id, token),
      // null expiresAt = never expires; expired rows also get purged hourly —
      // the gt() covers the window in between.
      or(isNull(calendarInvites.expiresAt), gt(calendarInvites.expiresAt, new Date())),
    ));

  if (!result) throw new NotFoundError("Invite not found...");
  if (result.maxUses !== null && result.uses >= result.maxUses) {
    throw new NotFoundError("Invite not found..."); // exhausted = gone, same as expired
  }

  return result.calendarID;
}

// Burn one use — call only after a NEW membership was actually created
// (re-joins by an existing member must not consume the invite).
export async function consumeInvite(token: string) {
  await db.update(calendarInvites)
    .set({ uses: sql`${calendarInvites.uses} + 1` })
    .where(eq(calendarInvites.id, token));
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
  return db.transaction(async (tx) => {
    const [result] = await tx
      .delete(calendarMembers)
      .where(and(eq(calendarMembers.userID, userID), eq(calendarMembers.calendarID, calendarID)))
      .returning();

    if (result) {
      const [remainingMembership] = await tx
        .select({ calendarID: calendarMembers.calendarID })
        .from(calendarMembers)
        .where(eq(calendarMembers.userID, userID))
        .limit(1);
      if (!remainingMembership) {
        await tx.delete(memberTokens).where(eq(memberTokens.userID, userID));
      }
    }

    return result;
  });
}
