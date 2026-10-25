import { GoogleTaskProviderError, type GoogleTaskProviderPorts } from "@musubi/provider-google";
import type { GoogleTaskDeleteProviderPorts } from "@musubi/provider-google";
import { getOAuthCredentials, hasOAuthTaskScope } from "@musubi/db";
import type { AcceptedEventUpdateContext } from "../adapter";
import { ProviderAuthError } from "../errors";
import { recordProviderHttpRequest } from "../provider_http_metrics";

/** Credentials, refresh CAS and the Tasks grant remain Musubi-owned. The
 * physical capture is rechecked on both sides of every materialization. */
export function googleTaskProviderPorts(userID: string, accountID: string,
  capture: Pick<AcceptedEventUpdateContext, "connectionId" | "connectionGeneration">,
  accessToken: (signal?: AbortSignal, rejectedAccessToken?: string) => Promise<string>,
): Omit<GoogleTaskProviderPorts, "beforeMutation" | "onAcceptedResponse"> {
  const current = async () => {
    const credentials = await getOAuthCredentials(userID, "google", accountID);
    if (!credentials || credentials.id !== capture.connectionId || credentials.syncReadGeneration !== capture.connectionGeneration ||
        credentials.syncStatus !== "active" || !credentials.refreshToken) throw new GoogleTaskProviderError("account-session-changed");
    return credentials;
  };
  const open = async (signal?: AbortSignal, rejected?: string) => {
    signal?.throwIfAborted(); await current(); signal?.throwIfAborted();
    const token = await accessToken(signal, rejected); signal?.throwIfAborted();
    const credentials = await current(); signal?.throwIfAborted();
    const taskWriteAllowed = await hasOAuthTaskScope(userID, "google", accountID); signal?.throwIfAborted();
    return { connectionId: credentials.id, connectionGeneration: String(credentials.syncReadGeneration), accessToken: token, taskWriteAllowed };
  };
  return {
    accountSession: {
      open: (_connection, signal) => open(signal),
      recoverRejectedRead: (_connection, rejected, signal) => open(signal, rejected),
      async onReadAuthenticationRejected() { throw new ProviderAuthError("google", "resource_401", undefined, false); },
    },
    http: { fetch: (url, init) => globalThis.fetch(url, init) },
    clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() },
    telemetry: { record: metric => recordProviderHttpRequest(metric.method, metric.status, metric.durationMs) },
  };
}

export function googleTaskDeleteProviderPorts(userID: string, accountID: string,
  capture: Pick<AcceptedEventUpdateContext, "connectionId" | "connectionGeneration">,
  accessToken: (signal?: AbortSignal, rejectedAccessToken?: string) => Promise<string>,
): Omit<GoogleTaskDeleteProviderPorts, "beforeMutation" | "onDeleteResponse"> {
  const { telemetry: _updateTelemetry, ...ports } = googleTaskProviderPorts(userID, accountID, capture, accessToken);
  return { ...ports, telemetry: { record: metric => recordProviderHttpRequest(metric.method, metric.status, metric.durationMs) } };
}
