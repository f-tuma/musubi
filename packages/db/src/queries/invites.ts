import { lt } from "drizzle-orm";
import { calendarInvites, db, NewCalendarInvite } from "..";


export async function createInvite(invite: NewCalendarInvite) {
  const [result] = await db
    .insert(calendarInvites)
    .values(invite)
    .onConflictDoNothing()
    .returning();

  return result;
}

export async function deleteExpiredInvites() {
  await db.delete(calendarInvites).where(lt(calendarInvites.expiresAt, new Date()));
}
