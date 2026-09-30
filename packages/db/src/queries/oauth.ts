import { and, eq, isNull } from "drizzle-orm";
import { account, db } from "../index";
import type { GoogleCheck } from "@musubi/types";

// OAuth calendar-provider account status/tokens — operates on the Better Auth
// `account` table, not the sync tables. (Sync lives in queries/external.ts.)
// Provider-generic: google and microsoft share the exact same lifecycle
// (linked → active → reconnect_required → relinked).

// Kept for callers that only need to identify calendar-provider grants.
export const CALENDAR_SCOPE: Record<string, string> = {
  google: "https://www.googleapis.com/auth/calendar.events",
  microsoft: "Calendars.ReadWrite",
};

// Calendar eligibility is independent of the optional Tasks grant.
export const TASK_SCOPE: Record<string, string> = {
  google: "https://www.googleapis.com/auth/tasks",
  microsoft: "Tasks.ReadWrite",
};

export function hasProviderSyncScopes(provider: string, scope = "") {
  return Boolean(CALENDAR_SCOPE[provider] && scope.split(/[\s,]+/).includes(CALENDAR_SCOPE[provider]));
}

export function hasProviderTaskScope(provider: string, scope = "") {
  return Boolean(TASK_SCOPE[provider] && scope.split(/[\s,]+/).includes(TASK_SCOPE[provider]));
}

export async function hasOAuthTaskScope(userID: string, provider: string, accountID: string) {
  const credentials = await getOAuthCredentials(userID, provider, accountID);
  return hasProviderTaskScope(provider, credentials?.scope ?? "");
}

export async function oauthConnectionCheck(userID: string, provider: string): Promise<GoogleCheck> {
  const [row] = await db.select()
    .from(account)
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, provider),
    ));

  const isLinked = !!row;
  const calendarConnected = row?.syncStatus === "active" && !!row.refreshToken &&
    hasProviderSyncScopes(provider, row.scope ?? "");

  return { isLinked, calendarConnected }
}

// account ids of the user's accounts that granted calendar access — used by
// the adapters' listAccounts (one row per connected account).
export async function getOAuthAccountIDs(userID: string, provider: string, accountID?: string): Promise<string[]> {
  const rows = await db.select({
    accountId: account.accountId,
    scope: account.scope,
    refreshToken: account.refreshToken,
    syncStatus: account.syncStatus,
    syncErrorCode: account.syncErrorCode,
  })
    .from(account)
    .where(and(eq(account.userId, userID), eq(account.providerId, provider),
      accountID === undefined ? undefined : eq(account.accountId, accountID)));
  // Require a refresh token too — same bar as oauthConnectionCheck's
  // `calendarConnected`. Permanently revoked accounts stay excluded, while an
  // insufficient-scope status self-heals when the stored grant is actually full.
  const accountIDs: string[] = [];
  const statusUpdates: Promise<unknown>[] = [];
  for (const row of rows) {
    if (!row.refreshToken) continue;
    const hasScopes = hasProviderSyncScopes(provider, row.scope ?? "");
    if (row.syncStatus === "active") {
      if (hasScopes) accountIDs.push(row.accountId);
      else {
        statusUpdates.push(markOAuthAccountReconnectRequired(
          userID,
          provider,
          row.accountId,
          "insufficient_scope",
        ));
      }
      continue;
    }
    if (
      hasScopes &&
      row.syncStatus === "reconnect_required" &&
      row.syncErrorCode === "insufficient_scope"
    ) {
      accountIDs.push(row.accountId);
      statusUpdates.push(markOAuthAccountActive(userID, provider, row.accountId));
    }
  }
  await Promise.all(statusUpdates);
  return accountIDs;
}

export async function getOAuthCredentials(userID: string, provider: string, accountID: string) {
  const [row] = await db.select({
    id: account.id,
    scope: account.scope,
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

type OAuthCredentialSnapshot = NonNullable<Awaited<ReturnType<typeof getOAuthCredentials>>>;

// Refresh HTTP runs without a row lock. Compare the exact grant it used before
// saving its result: a disconnect, relink or another process's refresh wins.
function unchangedOAuthCredentials(expected?: OAuthCredentialSnapshot) {
  if (!expected) return undefined;
  return and(
    eq(account.id, expected.id),
    expected.accessToken === null ? isNull(account.accessToken) : eq(account.accessToken, expected.accessToken),
    expected.refreshToken === null ? isNull(account.refreshToken) : eq(account.refreshToken, expected.refreshToken),
    expected.accessTokenExpiresAt === null ? isNull(account.accessTokenExpiresAt) : eq(account.accessTokenExpiresAt, expected.accessTokenExpiresAt),
    expected.scope === null ? isNull(account.scope) : eq(account.scope, expected.scope),
    eq(account.syncStatus, expected.syncStatus),
  );
}

export async function updateOAuthTokens(
  userID: string,
  provider: string,
  accountID: string,
  tokens: { accessToken: string; accessTokenExpiresAt: Date; refreshToken?: string; scope?: string },
  expected?: OAuthCredentialSnapshot,
) {
  const rows = await db.update(account)
    .set({
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, provider),
      eq(account.accountId, accountID),
      unchangedOAuthCredentials(expected),
    ))
    .returning({ id: account.id })
    .catch(() => { throw new Error("OAuth credential update failed"); });
  return rows.length > 0;
}

export async function markOAuthAccountReconnectRequired(
  userID: string,
  provider: string,
  accountID: string,
  errorCode: string,
  errorSubtype?: string,
  expected?: OAuthCredentialSnapshot,
) {
  const rows = await db.update(account)
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
      unchangedOAuthCredentials(expected),
    ))
    .returning({ id: account.id })
    .catch(() => { throw new Error("OAuth account status update failed"); });
  return rows.length > 0;
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

// Provider-wide legacy cleanup. Do not use this for an account-specific
// disconnect; it intentionally clears every matching account for the user.
export async function cleanProviderOAuthTokens(userID: string, provider: string) {
  await db.update(account).set({
    refreshToken: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
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

// Account-scoped fallback for the modern disconnect flow. Better Auth may
// refuse to unlink a login's last account; in that case calendar sync must stop
// without clearing credentials for sibling accounts of the same provider.
export async function cleanOAuthAccountTokens(
  userID: string,
  provider: string,
  accountID: string,
) {
  await db.update(account).set({
    refreshToken: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    syncStatus: "active",
    syncErrorCode: null,
    syncErrorSubtype: null,
    syncDisabledAt: null,
  })
    .where(and(
      eq(account.userId, userID),
      eq(account.providerId, provider),
      eq(account.accountId, accountID),
    ));
}
