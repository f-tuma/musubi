export class ProviderAuthError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    readonly subtype: string | undefined,
    readonly reconnectRequired: boolean,
  ) {
    super(`${provider} OAuth token refresh failed: ${subtype ?? code}`);
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
