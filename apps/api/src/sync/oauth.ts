import {
  getOAuthCredentials,
  markOAuthAccountReconnectRequired,
  updateOAuthTokens,
} from "@musubi/db";
import { ProviderAuthError } from "./errors";

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

export async function getOAuthAccessToken(
  provider: string,
  userID: string,
  accountId: string,
  cfg: TokenEndpointConfig,
): Promise<string> {
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

  const expiresAt = credentials.accessTokenExpiresAt?.getTime();
  if (credentials.accessToken && expiresAt && expiresAt - Date.now() >= 5_000) {
    return credentials.accessToken;
  }

  if (!credentials.refreshToken) {
    await markOAuthAccountReconnectRequired(userID, provider, accountId, "missing_refresh_token");
    throw new ProviderAuthError(provider, "missing_refresh_token", undefined, true);
  }

  let response: Response;
  try {
    response = await fetch(cfg.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
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
    // invalid_grant = revoked/expired consent, permanent until the user
    // re-authorizes. Everything else (network, 5xx, bad client config) stays
    // retryable and does NOT disable the account.
    const reconnectRequired = code === "invalid_grant";
    if (reconnectRequired) {
      await markOAuthAccountReconnectRequired(userID, provider, accountId, code, subtype);
    }
    throw new ProviderAuthError(provider, code, subtype, reconnectRequired);
  }

  if (!payload.access_token) {
    throw new ProviderAuthError(provider, "invalid_token_response", undefined, false);
  }

  const accessTokenExpiresAt = new Date(Date.now() + validExpiresIn(payload.expires_in) * 1_000);
  // Persist a rotated refresh token when the provider sends one — Microsoft
  // rotates it on every refresh, Google only occasionally.
  await updateOAuthTokens(userID, provider, accountId, {
    accessToken: payload.access_token,
    accessTokenExpiresAt,
    refreshToken: payload.refresh_token,
  });
  return payload.access_token;
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
