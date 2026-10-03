export class ProviderAuthError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    readonly subtype: string | undefined,
    readonly reconnectRequired: boolean,
  ) {
    super(code === "resource_401"
      ? `${provider} API authentication failed: ${code}`
      : `${provider} OAuth token refresh failed: ${subtype ?? code}`);
    this.name = "ProviderAuthError";
  }
}

export function providerAuthErrorFields(error: unknown) {
  if (!(error instanceof ProviderAuthError)) return {};
  return {
    oauthErrorCode: error.code,
    ...(error.subtype ? { oauthErrorSubtype: error.subtype } : {}),
    reconnectRequired: error.reconnectRequired,
  };
}

// Network blips the 3-minute poll already retries on its own: DNS failures,
// dropped sockets, provider 5xx/429/408. Codes come off undici's `cause` chain
// (`TypeError: fetch failed` says nothing by itself).
const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Both our adapters and tsdav stringify the provider's status into the message
// ("Outlook 503: Service Unavailable", "Collection query failed: 500 …"), so
// there is no status field to read — and federation_origin reports a failed
// lookup as "Could not resolve host.".
const TRANSIENT_MESSAGE = /(?:^|\D)(?:408|429|5\d\d)(?:\D|$)|^Could not resolve /;

/**
 * Is this failure the provider's or the network's, rather than ours?
 *
 * Such a failure is expected traffic for a poller talking to three third-party
 * APIs, so it is logged at warn and watched as a rate. `error` stays for what
 * needs a human: a revoked grant, or a bug in Musubi.
 */
export function isTransientSyncError(error: unknown): boolean {
  if (error instanceof ProviderAuthError) return !error.reconnectRequired;

  for (
    let cursor: unknown = error;
    cursor instanceof Error;
    cursor = (cursor as { cause?: unknown }).cause
  ) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    if (cursor.name === "SocketError") return true;
    if (TRANSIENT_MESSAGE.test(cursor.message)) return true;
  }
  return false;
}

// Only permission denial and retryable resource failures are optional. In
// particular, OAuth refresh failures and resource 401s must reach the account
// fault boundary rather than masquerading as unavailable Tasks data.
export class TaskScopeMissingError extends Error {
  constructor() { super("Tasks permission has not been granted"); }
}

export function isOptionalTaskError(error: unknown): boolean {
  if (error instanceof ProviderAuthError) return false;
  return error instanceof TaskScopeMissingError ||
    (error instanceof Error && /^(Google(?: Tasks)?|Outlook) 403\b/.test(error.message)) ||
    isTransientSyncError(error);
}
