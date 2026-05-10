import { eq } from "drizzle-orm";
import { db, user } from "..";
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
