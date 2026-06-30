import { and, eq } from "drizzle-orm";
import { account, calendarMembers, calendars, db, googleCalendars, user } from "../index"
import { GoogleCheck } from "@musubi/types";

export async function googleCheck(userID: string): Promise<GoogleCheck> {
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

export async function getGoogleRefreshToken(userID: string) {
  const [google] = await db.select()
    .from(account)
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
    ));

  return google?.refreshToken;
}

export async function cleanUsersGoogleTokens(userID: string) {
  await db.update(account).set({
    refreshToken: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    scope: null,
  })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
    ));
}

export async function doesGoogleCalIDExistsForUser(userID: string, googleCalID: string) {
  const [res] = await db.select().from(googleCalendars).where(and(
    eq(googleCalendars.googleCalendarID, googleCalID),
    eq(googleCalendars.userID, userID)
  ))

  return !!res;
}

export async function importGoogleCalendar(userID: string, g: { id: string, summary: string, backgroundColor: string }) {
  await db.transaction(async (tx) => {
    const [cal] = await tx.insert(calendars)
      .values({ creatorID: userID, name: g.summary, color: g.backgroundColor }).returning();
    await tx.insert(googleCalendars)
      .values({ userID, calendarID: cal.id, googleCalendarID: g.id, syncToken: null });
    await tx.insert(calendarMembers).values({
      userID: cal.creatorID,
      calendarID: cal.id,
    })
  });
}
