import { eq } from "drizzle-orm";
import { db, NewSettings, userSettings } from "..";


export async function getUserSettings(userID: string) {
  let [result] = await db.select().from(userSettings).where(eq(userSettings.id, userID));

  if (!result) {
    [result] = await db.insert(userSettings).values({ id: userID }).returning();
  }

  return result;
}

export async function saveUserSettings(userID: string, settings: NewSettings) {
  const [updated] = await db.update(userSettings).set(settings).where(eq(userSettings.id, userID)).returning();
  if (updated) return updated;

  // No row yet (settings can be saved before any GET materialized it, e.g. the
  // last onboarding step). Create it instead of 404ing.
  const [inserted] = await db.insert(userSettings).values({ ...settings, id: userID }).returning();
  return inserted;
}
