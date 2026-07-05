import { eq } from "drizzle-orm";
import { db, user, userAvatars } from "..";
import { config } from "@musubi/config";
import { ForbiddenError, NotFoundError } from "@musubi/types";



export async function getUserFromEmail(email: string) {
  const [result] = await db.select().from(user).where(eq(user.email, email));

  if (!result) throw new NotFoundError(`User with email "${email}" not found...`);

  return result.name;
}



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
