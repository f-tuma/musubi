import { eq } from "drizzle-orm";
import { db, NewSettings, userSettings } from "..";
import { NotFoundError } from "@musubi/types";


export async function getUserSettings(userID: string) {
  let [result] = await db.select().from(userSettings).where(eq(userSettings.id, userID));

  if (!result) {
    [result] = await db.insert(userSettings).values({ id: userID }).returning();
  }

  return result;
}

export async function saveUserSettings(userID: string, settings: NewSettings) {
  const [result] = await db.update(userSettings).set(settings).where(eq(userSettings.id, userID)).returning();

  if (!result) {
    throw new NotFoundError("User settings not found...");
  }

  return result;
}
