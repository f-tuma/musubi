import { desc, eq, lt } from "drizzle-orm";
import { calendarInvites, db, NewCalendarInvite } from "..";
import { NotFoundError } from "@musubi/types";
import { UUID_RE } from "./calendars";


export async function createInvite(invite: NewCalendarInvite) {
  const [result] = await db
    .insert(calendarInvites)
    .values(invite)
    .onConflictDoNothing()
    .returning();

  return result;
}

export async function getCalendarInvites(calendarID: string) {
  return db
    .select().from(calendarInvites)
    .where(eq(calendarInvites.calendarID, calendarID))
    .orderBy(desc(calendarInvites.createdAt));
}

// Fetched before revoke so the handler can permission-check the invite's calendar.
export async function getInvite(inviteID: string) {
  if (!UUID_RE.test(inviteID)) throw new NotFoundError("Invite not found...");
  const [result] = await db
    .select().from(calendarInvites).where(eq(calendarInvites.id, inviteID));
  if (!result) throw new NotFoundError("Invite not found...");
  return result;
}

export async function deleteInvite(inviteID: string) {
  await db.delete(calendarInvites).where(eq(calendarInvites.id, inviteID));
}

// null expiresAt never matches lt() — permanent invites survive the sweep.
export async function deleteExpiredInvites() {
  await db.delete(calendarInvites).where(lt(calendarInvites.expiresAt, new Date()));
}
