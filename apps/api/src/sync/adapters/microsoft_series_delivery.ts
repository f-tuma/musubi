import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { graphSeriesFootprint } from "./microsoft_series_footprint";
import { config } from "@musubi/config";
import { EventWriteError, type Event } from "@musubi/types";
import type { CreatedEventEvidence, EventCreateIdentity } from "../adapter";
import { assertCompleteEventReadResponse, eventCreateOperationID } from "../event_create_identity";
import { assertEventWriteEvidence, assertProviderEventMutationResponse, ProviderEventWriteError } from "../event_write";
import { findGraphCreatedSeries, graphSeriesCreateBody } from "./microsoft_series_create";

function unconfirmed(error: unknown): ProviderEventWriteError {
  return new ProviderEventWriteError(error instanceof ProviderEventWriteError ? error.code : "provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined, error instanceof ProviderEventWriteError ? error.retryAfterMs : undefined);
}

/** Private native delivery candidate. Not composed into microsoftAdapter until
 * durable family ACK/import exists. The caller must own the OAuth write grant
 * and use beforeWrite to validate its durable attempt/lease before mutation. */
export async function createGraphSeries(
  accessToken: string,
  calendarID: string,
  event: Event,
  identity: EventCreateIdentity,
  state: { uncertain: boolean; beforeWrite: () => Promise<void> },
): Promise<CreatedEventEvidence & { recovered: boolean }> {
  if (!config.api.eventTimeEditsEnabled)
    throw new EventWriteError("event-write", "unsupported", "Outlook recurring creation is not enabled. No changes were saved.");
  const saved = structuredClone(event);
  const frozen = { operationID: eventCreateOperationID(identity), signal: identity.signal };
  graphSeriesFootprint(saved);
  const body = graphSeriesCreateBody(saved, frozen);
  const uncertain = state.uncertain, beforeWrite = state.beforeWrite;
  if (typeof uncertain !== "boolean" || typeof beforeWrite !== "function" || typeof calendarID !== "string" || !calendarID || calendarID.trim() !== calendarID || calendarID === "." || calendarID === "..")
    throw new ProviderEventWriteError("provider-write-failed");
  const calendar = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarID)}`;
  let recovered: CreatedEventEvidence | null;
  try {
    const permission = await fetch(`${calendar}?$select=canEdit`, { headers: { Authorization: `Bearer ${accessToken}`, "Cache-Control": "no-cache" }, redirect: "error", signal: frozen.signal });
    assertCompleteEventReadResponse(permission);
    assertEventWriteEvidence((await permission.json()).canEdit, "event-write");
    // A missing uncertain transaction is never evidence of no side effect.
    // Permission and read failures must not erase a previous uncertain POST.
    recovered = await findGraphCreatedSeries(accessToken, calendarID, saved, frozen);
  } catch (error) { throw uncertain ? unconfirmed(error) : error; }
  if (recovered) return { ...recovered, recovered: true };
  if (uncertain) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
  await beforeWrite();
  let returnedID: string | undefined;
  let mutationError: unknown;
  try {
    const response = await fetch(`${calendar}/events`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: frozen.signal,
    });
    assertProviderEventMutationResponse(response);
    const result = await response.json();
    if (typeof result?.id !== "string" || !result.id || result.id.trim() !== result.id)
      throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", response.status);
    returnedID = result.id;
  } catch (error) { mutationError = error; }
  if (mutationError instanceof ProviderEventWriteError && mutationError.outcome === "not-written") throw mutationError;
  // A successful HTTP status alone does not acknowledge the master or its
  // descendants. Re-read complete transaction identity and native evidence.
  let observed: CreatedEventEvidence | null;
  try { observed = await findGraphCreatedSeries(accessToken, calendarID, saved, frozen); }
  catch (error) { throw unconfirmed(error); }
  if (!observed) {
    if (mutationError instanceof ProviderEventWriteError) throw mutationError;
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
  }
  if (returnedID !== undefined && returnedID !== observed.ref.externalEventId)
    throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
  return { ...observed, recovered: mutationError !== undefined };
}
