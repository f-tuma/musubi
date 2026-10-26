import { createSdkBudgetHttp, rawProviderFetch, reserveProviderMutation } from "../provider_budget";
import { createGooglePersonalEventProvider, GoogleProviderError, type GooglePersonalUpdate, type GoogleProviderPorts } from "@musubi/provider-google";
import { getOAuthCredentials, hasProviderSyncScopes } from "@musubi/db";
import { EventWriteError } from "@musubi/types";
import type { NativeWritePlanV1 } from "@musubi/sync-codec";
import type { AcceptedEventUpdateContext } from "../adapter";
import { ProviderEventWriteError, requireEventEtag } from "../event_write";
import { pinnedJsonBodyV1 } from "../pinned_write";
import { recordProviderHttpRequest } from "../provider_http_metrics";

/** Native ports remain owned by the registered adapter, including its token
 * resolver. A shared runner supplies the final mutation/lease fence separately. */
export function googlePersonalProviderPorts(
  userID: string,
  accountID: string,
  accepted: Pick<AcceptedEventUpdateContext, "connectionId" | "connectionGeneration">,
  accessToken: (signal?: AbortSignal) => Promise<string>,
): Omit<GoogleProviderPorts, "beforeMutation"> {
  const currentCredentials = async () => {
    const credentials = await getOAuthCredentials(userID, "google", accountID);
    if (!credentials || credentials.id !== accepted.connectionId ||
        credentials.syncReadGeneration !== accepted.connectionGeneration ||
        credentials.syncStatus !== "active" || !credentials.refreshToken)
      throw new GoogleProviderError("account-session-changed");
    return credentials;
  };
  return {
    accountSession: { async open(_connection, signal) {
      signal?.throwIfAborted();
      await currentCredentials();
      const token = await accessToken(signal);
      signal?.throwIfAborted();
      // Refresh can narrow scope, revoke or reconnect a grant while suspended.
      const credentials = await currentCredentials();
      return { connectionId: credentials.id, connectionGeneration: String(credentials.syncReadGeneration),
        accessToken: token, eventWriteAllowed: credentials.scope == null ? undefined : hasProviderSyncScopes("google", credentials.scope) };
    } },
    // The module records each leaf dispatch through its explicit telemetry port.
    // Wrapping this in observedProviderFetch would count every request twice.
    http: { ...createSdkBudgetHttp("google", userID, accountID, accepted), fetch: rawProviderFetch },
    clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() },
    telemetry: { record: metric => recordProviderHttpRequest(metric.method, metric.status, metric.durationMs) },
  };
}

/** Musubi owns credential storage, authority and cancellation; the provider
 * receives only a native target and the immutable accepted JSON properties. */
export function googlePersonalEventBridge(
  userID: string,
  accountID: string,
  calendarId: string,
  eventId: string,
  accepted: AcceptedEventUpdateContext,
  accessToken: (signal?: AbortSignal) => Promise<string>,
) {
  const target = { connectionId: accepted.connectionId,
    connectionGeneration: String(accepted.connectionGeneration), calendarId, eventId };
  const provider = createGooglePersonalEventProvider({
    ...googlePersonalProviderPorts(userID, accountID, accepted, accessToken),
    beforeMutation: () => reserveProviderMutation({ url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, method: "PATCH" }, () => accepted.beforeMutation()),
  });
  const input = (plan: NativeWritePlanV1, etag: unknown): GooglePersonalUpdate => ({
    target, acceptedEtag: requireEventEtag(etag), body: pinnedJsonBodyV1(plan),
    operationId: accepted.operationId, attemptId: accepted.attemptId, serializer: accepted.serializer,
  });
  async function bridgeOutcome<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (!(error instanceof GoogleProviderError)) throw error;
      if (error.code === "account-session-changed") throw new EventWriteError("event-write", "unknown");
      if (error.code === "capability-evidence") throw new EventWriteError(error.capability ?? "event-write", error.evidence ?? "unknown");
      throw new ProviderEventWriteError(error.code, error.outcome, error.providerStatus, error.retryAfterMs);
    }
  }
  return {
    preflight: (plan: NativeWritePlanV1, etag: unknown, signal?: AbortSignal) => bridgeOutcome(() => provider.preflightUpdate(input(plan, etag), signal)),
    update: (plan: NativeWritePlanV1, etag: unknown, signal?: AbortSignal) => bridgeOutcome(() => provider.update(input(plan, etag), signal)),
    read: (signal?: AbortSignal) => bridgeOutcome(() => provider.readEvent(target, signal)),
  };
}
