import { and, eq } from "drizzle-orm";
import { account, db } from "../index"

export async function googleCheck(userID: string) {
  const [google] = await db.select()
    .from(account)
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
    ));

  const isLinked = !!google;
  const calendarConnected = !!google?.refreshToken &&
    (google.scope ?? "").includes("https://www.googleapis.com/auth/calendar");

  return { isLinked, calendarConnected }
}
