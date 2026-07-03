import { lt } from "drizzle-orm";
import { db, session } from "..";


export async function deleteExpiredSessions() {
  await db.delete(session).where(lt(session.expiresAt, new Date()));
}
