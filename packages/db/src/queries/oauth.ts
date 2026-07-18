import { and, eq } from "drizzle-orm";
import { account, db } from "../index";
import { GoogleCheck } from "@musubi/types";

// OAuth calendar-provider account status/tokens — operates on the Better Auth
// `account` table, not the sync tables. (Sync lives in queries/external.ts.)
// Provider-generic: google and microsoft share the exact same lifecycle
// (linked → active → reconnect_required → relinked).

// The scope that marks an account as calendar-connected, per provider.
export const CALENDAR_SCOPE: Record<string, string> = {
  google: "https://www.googleapis.com/auth/calendar",
  microsoft: "Calendars.ReadWrite",
};

export async function oauthConnectionCheck(userID: string, provider: string): Promise<GoogleCheck> {
  const [row] = await db.select()
    .from(account)
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, provider),
    ));

  const isLinked = !!row;
  const calendarConnected = row?.syncStatus === "active" && !!row.refreshToken &&
    (row.scope ?? "").includes(CALENDAR_SCOPE[provider] ?? "");

  return { isLinked, calendarConnected }
}

// account ids of the user's accounts that granted calendar access — used by
// the adapters' listAccounts (one row per connected account).
export async function getOAuthAccountIDs(userID: string, provider: string): Promise<string[]> {
  const rows = await db.select({
    accountId: account.accountId,
    scope: account.scope,
    refreshToken: account.refreshToken,
    syncStatus: account.syncStatus,
  })
    .from(account)
    .where(and(eq(account.userId, userID), eq(account.providerId, provider)));
  // Require a refresh token too — same bar as oauthConnectionCheck's
  // `calendarConnected`. Without it the sync can never mint an access token.
  // reconnect_required is also excluded so a permanently revoked token is
  // logged only once.
  return rows
    .filter((r) => r.syncStatus === "active" && !!r.refreshToken && (r.scope ?? "").includes(CALENDAR_SCOPE[provider] ?? ""))
    .map((r) => r.accountId);
}

export async function getOAuthCredentials(userID: string, provider: string, accountID: string) {
  const [row] = await db.select({
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
      eq(account.providerId, provider),
      eq(account.accountId, accountID),
    ));

  return row;
}

export async function updateOAuthTokens(
  userID: string,
  provider: string,
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
      eq(account.providerId, provider),
      eq(account.accountId, accountID),
    ));
}

export async function markOAuthAccountReconnectRequired(
  userID: string,
  provider: string,
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
      eq(account.providerId, provider),
      eq(account.accountId, accountID),
    ));
}

// Better Auth calls this after a successful OAuth relink updates the account.
export async function markOAuthAccountActive(userID: string, provider: string, accountID: string) {
  await db.update(account)
    .set({ syncStatus: "active", syncErrorCode: null, syncErrorSubtype: null, syncDisabledAt: null })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, provider),
      eq(account.accountId, accountID),
    ));
}

export async function getOAuthRefreshToken(userID: string, provider: string) {
  const [row] = await db.select()
    .from(account)
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, provider),
    ));

  return row?.refreshToken;
}

export async function cleanUsersOAuthTokens(userID: string, provider: string) {
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
      eq(account.providerId, provider),
    ));
}
