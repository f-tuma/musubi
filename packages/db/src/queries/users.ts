import { eq } from "drizzle-orm";
import { db, user, userAvatars } from "..";
import { config } from "@musubi/config";
import { ForbiddenError } from "@musubi/types";



// DEV ONLY

export async function resetUsers() {
  if (config.api.environment !== "dev") {
    throw new ForbiddenError("This action is not possible in your environment...");
  } else {
    const [result] = await db.delete(user).returning();
    return result;
  }
}

// Upsert the avatar bytes; caller is responsible for size/type validation.
export async function setUserAvatar(userID: string, data: Buffer, mimeType: string) {
  await db.insert(userAvatars)
    .values({ id: userID, data, mimeType })
    .onConflictDoUpdate({ target: userAvatars.id, set: { data, mimeType, updatedAt: new Date() } });
}

export async function getUserAvatar(userID: string) {
  const [row] = await db.select().from(userAvatars).where(eq(userAvatars.id, userID));
  return row ?? null;
}
