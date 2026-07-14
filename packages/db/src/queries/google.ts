import { and, eq } from "drizzle-orm";
import { account, db } from "../index";
import { GoogleCheck } from "@musubi/types";

// Google OAuth account connection status/revoke — operates on the Better Auth
// `account` table, not the sync tables. (Sync lives in queries/external.ts.)

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

// account ids of the user's Google accounts that granted calendar access —
// used by the Google adapter's listAccounts (one row per connected account).
export async function getGoogleAccountIDs(userID: string): Promise<string[]> {
  const rows = await db.select({ accountId: account.accountId, scope: account.scope, refreshToken: account.refreshToken })
    .from(account)
    .where(and(eq(account.userId, userID), eq(account.providerId, "google")));
  // Require a refresh token too — same bar as googleCheck's `calendarConnected`.
  // Without it the sync can never mint an access token, so syncing the account
  // only spams FAILED_TO_GET_ACCESS_TOKEN every interval.
  return rows
    .filter((r) => !!r.refreshToken && (r.scope ?? "").includes("https://www.googleapis.com/auth/calendar"))
    .map((r) => r.accountId);
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
