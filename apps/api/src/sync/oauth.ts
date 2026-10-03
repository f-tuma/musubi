import {
  getOAuthCredentials,
  markOAuthAccountReconnectRequired,
  updateOAuthTokens,
} from "@musubi/db";
import { ProviderAuthError } from "./errors";
import { decryptToken, encryptToken } from "../tokenCrypto";
import { createHash } from "node:crypto";

// Shared OAuth access-token minting for adapter API calls (google, microsoft).
// Refreshes expired access tokens directly against the provider's token
// endpoint so the safe machine-readable OAuth error codes are retained —
// Better Auth's generic getAccessToken error discards them. Tokens and error
// descriptions are never logged.

type TokenEndpointConfig = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  // extra body params some providers require on refresh (microsoft: scope)
  extraParams?: Record<string, string>;
  // response field carrying the machine-readable sub-error
  // (google: error_subtype, microsoft: suberror)
  subtypeKey?: string;
};

type AccessTokenOptions = {
  // A resource GET can reject a token before our stored expiry. Refresh only
  // that rejected token; a newer stored token is already the recovery result.
  rejectedAccessToken?: string;
};

const refreshes = new Map<string, Promise<string>>();

export async function getOAuthAccessToken(
  provider: string,
  userID: string,
  accountId: string,
  cfg: TokenEndpointConfig,
  options: AccessTokenOptions = {},
): Promise<string> {
  const credentials = await readActiveCredentials(provider, userID, accountId);
  const token = await usableAccessToken(credentials, options);
  if (token) return token;

  // A new grant must not wait on a refresh of the old one, whose result can be
  // unsuitable for the newer caller's rejected token. Keys never expose tokens.
  const key = createHash("sha256").update(JSON.stringify([
    provider, userID, accountId, credentials.id, credentials.accessToken,
    credentials.refreshToken, credentials.scope, credentials.accessTokenExpiresAt,
  ])).digest("hex");
  const pending = refreshes.get(key);
  if (pending) return pending;
  const refresh = refreshOAuthAccessToken(provider, userID, accountId, cfg, options);
  refreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshes.get(key) === refresh) refreshes.delete(key);
  }
}

async function readActiveCredentials(provider: string, userID: string, accountId: string) {
  const credentials = await getOAuthCredentials(userID, provider, accountId);
  if (!credentials) {
    throw new ProviderAuthError(provider, "account_not_found", undefined, false);
  }
  if (credentials.syncStatus === "reconnect_required") {
    throw new ProviderAuthError(
      provider,
      credentials.syncErrorCode ?? "reconnect_required",
      credentials.syncErrorSubtype ?? undefined,
      true,
    );
  }
  return credentials;
}

async function usableAccessToken(
  credentials: Awaited<ReturnType<typeof readActiveCredentials>>,
  options: AccessTokenOptions,
) {
  const expiresAt = credentials.accessTokenExpiresAt?.getTime();
  if (!credentials.accessToken || !expiresAt || expiresAt - Date.now() < 5_000) return null;
  const accessToken = await decryptToken(credentials.accessToken);
  return accessToken === options.rejectedAccessToken ? null : accessToken;
}

async function refreshOAuthAccessToken(
  provider: string,
  userID: string,
  accountId: string,
  cfg: TokenEndpointConfig,
  options: AccessTokenOptions,
): Promise<string> {
  // A failed compare-and-swap means the grant changed while HTTP was in flight.
  // Re-read once; never return or revoke credentials from the obsolete grant.
  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await readActiveCredentials(provider, userID, accountId);
    const currentToken = await usableAccessToken(credentials, options);
    if (currentToken) return currentToken;

    if (!credentials.refreshToken) {
      if (attempt > 0) throw new ProviderAuthError(provider, "credentials_changed", undefined, false);
      const saved = await markOAuthAccountReconnectRequired(userID, provider, accountId, "missing_refresh_token", undefined, credentials);
      if (!saved) continue;
      throw new ProviderAuthError(provider, "missing_refresh_token", undefined, true);
    }
    const refreshToken = await decryptToken(credentials.refreshToken);
    let response: Response;
    try {
      response = await fetch(cfg.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          ...cfg.extraParams,
        }),
      });
    } catch {
      throw new ProviderAuthError(provider, "token_endpoint_unreachable", undefined, false);
    }

    const payload = await response.json().catch(() => ({})) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: unknown;
      [key: string]: unknown;
    };

    if (!response.ok) {
      const code = safeOAuthCode(payload.error) ?? `http_${response.status}`;
      const subtype = safeOAuthCode(cfg.subtypeKey ? payload[cfg.subtypeKey] : undefined);
      // Only invalid_grant proves revoked/expired consent. A resource 401 or
      // transient token endpoint failure must not erase a working refresh grant.
      const reconnectRequired = code === "invalid_grant";
      if (reconnectRequired) {
        const saved = await markOAuthAccountReconnectRequired(userID, provider, accountId, code, subtype, credentials);
        if (!saved) continue;
      }
      throw new ProviderAuthError(provider, code, subtype, reconnectRequired);
    }

    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new ProviderAuthError(provider, "invalid_token_response", undefined, false);
    }

    const saved = await updateOAuthTokens(userID, provider, accountId, {
      accessToken: await encryptToken(payload.access_token),
      accessTokenExpiresAt: new Date(Date.now() + validExpiresIn(payload.expires_in) * 1_000),
      refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token ? await encryptToken(payload.refresh_token) : undefined,
      // An explicit returned scope is authoritative; an omitted scope is unchanged.
      scope: typeof payload.scope === "string" ? payload.scope.split(/[\s,]+/).filter(Boolean).join(",") : undefined,
    }, credentials);
    if (saved) return payload.access_token;
  }
  throw new ProviderAuthError(provider, "credentials_changed", undefined, false);
}

// Best-effort revocation of a Google grant, called on disconnect before local
// credentials are dropped. Google's revoke endpoint drops the whole grant when
// given the refresh token. Never throws (a failed revoke must not block the
// local disconnect) and never logs the token — URLSearchParams encodes it so a
// token with url-unsafe characters is handled correctly.
export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    // network/endpoint failure — caller still removes local credentials
  }
}

function safeOAuthCode(value: unknown) {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined;
}

function validExpiresIn(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 3_600;
}
