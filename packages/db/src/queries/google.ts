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
  const calendarConnected = google?.syncStatus === "active" && !!google.refreshToken &&
    (google.scope ?? "").includes("https://www.googleapis.com/auth/calendar");

  return { isLinked, calendarConnected }
}

// account ids of the user's Google accounts that granted calendar access —
// used by the Google adapter's listAccounts (one row per connected account).
export async function getGoogleAccountIDs(userID: string): Promise<string[]> {
  const rows = await db.select({
    accountId: account.accountId,
    scope: account.scope,
    refreshToken: account.refreshToken,
    syncStatus: account.syncStatus,
  })
    .from(account)
    .where(and(eq(account.userId, userID), eq(account.providerId, "google")));
  // Require a refresh token too — same bar as googleCheck's `calendarConnected`.
  // Without it the sync can never mint an access token. reconnect_required is
  // also excluded so a permanently revoked token is logged only once.
  return rows
    .filter((r) => r.syncStatus === "active" && !!r.refreshToken && (r.scope ?? "").includes("https://www.googleapis.com/auth/calendar"))
    .map((r) => r.accountId);
}

export async function getGoogleOAuthCredentials(userID: string, accountID: string) {
  const [google] = await db.select({
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
    syncStatus: account.syncStatus,
    syncErrorCode: account.syncErrorCode,
    syncErrorSubtype: account.syncErrorSubtype,
  })
    .from(account)
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
      eq(account.accountId, accountID),
    ));

  return google;
}

export async function updateGoogleOAuthTokens(
  userID: string,
  accountID: string,
  tokens: { accessToken: string; accessTokenExpiresAt: Date; refreshToken?: string },
) {
  await db.update(account)
    .set({
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
      eq(account.accountId, accountID),
    ));
}

export async function markGoogleAccountReconnectRequired(
  userID: string,
  accountID: string,
  errorCode: string,
  errorSubtype?: string,
) {
  await db.update(account)
    .set({
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      syncStatus: "reconnect_required",
      syncErrorCode: errorCode,
      syncErrorSubtype: errorSubtype ?? null,
      syncDisabledAt: new Date(),
    })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
      eq(account.accountId, accountID),
    ));
}

// Better Auth calls this after a successful OAuth relink updates the account.
export async function markGoogleAccountActive(userID: string, accountID: string) {
  await db.update(account)
    .set({ syncStatus: "active", syncErrorCode: null, syncErrorSubtype: null, syncDisabledAt: null })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
      eq(account.accountId, accountID),
    ));
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
    syncStatus: "active",
    syncErrorCode: null,
    syncErrorSubtype: null,
    syncDisabledAt: null,
  })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, "google"),
    ));
}
