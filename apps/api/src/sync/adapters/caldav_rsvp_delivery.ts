import { isDeepStrictEqual } from "node:util";
import { config } from "@musubi/config";
import { EventWriteError } from "@musubi/types";
import { createGuardedCaldavFetch } from "../caldav_client";
import { readCaldavSchedulingProof } from "../caldav_scheduling";
import { assertEventWriteResponse, assertProviderEventMutationResponse, requireEventEtag, ProviderEventWriteError } from "../event_write";
import { caldavSeriesResourceURL, sameCaldavResource } from "./caldav_series";
import { prepareCaldavRsvp, caldavRsvpResourceHash, type CaldavRsvpEvidence, type CaldavRsvpMode } from "./caldav_rsvp";
import { providerDeferral, reserveProviderMutation } from "../provider_budget";
const fetch = createGuardedCaldavFetch();
function enabled(compatibility = false) { if (!config.api.providerRsvpEditsEnabled || compatibility && !config.api.icloudRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported"); }
async function eligible(eligibility?: () => Promise<boolean>): Promise<boolean> {
  enabled();
  const allowed = config.api.icloudRsvpEditsEnabled && !!eligibility && await eligibility();
  enabled();
  return !!allowed && config.api.icloudRsvpEditsEnabled;
}
function resourceMode(scheduleTag: string | null, compatibility: boolean, mode?: "strict" | "icloud-oneoff-attendee"): CaldavRsvpMode {
  if (compatibility) {
    if (scheduleTag !== null) throw new ProviderEventWriteError("provider-conflict");
    return { mode: "icloud-oneoff-attendee", scheduleTag: null };
  }
  return { ...(mode === "strict" ? { mode } : {}), scheduleTag: requireEventEtag(scheduleTag) };
}
export async function readCaldavRsvpResource(id: string, authorization: string, signal?: AbortSignal, allowMissingScheduleTag = false) {
  const response = await fetch(id, { redirect: "error", signal, headers: { authorization, accept: "text/calendar", "cache-control": "no-cache" } });
  assertEventWriteResponse(response);
  if (response.status !== 200 || response.headers.has("content-range")) throw new ProviderEventWriteError("provider-write-failed");
  return { data: new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer()), etag: requireEventEtag(response.headers.get("etag")), scheduleTag: allowMissingScheduleTag && !response.headers.has("schedule-tag") ? null : requireEventEtag(response.headers.get("schedule-tag")) };
}
export async function readCaldavRsvp(collection: string, ref: { id: string; etag: string; uid: string }, authorization: string, response: CaldavRsvpEvidence["response"], signal?: AbortSignal, eligibility?: () => Promise<boolean>): Promise<CaldavRsvpEvidence> {
  enabled(); caldavSeriesResourceURL(collection, ref.id);
  const allowIcloud = await eligible(eligibility);
  const proof = await readCaldavSchedulingProof(collection, ref.id, authorization, signal, "reply", allowIcloud);
  const compatibility = proof.compatibility === "icloud-oneoff-attendee";
  const current = await readCaldavRsvpResource(ref.id, authorization, signal, compatibility);
  enabled(compatibility);
  if (current.etag !== ref.etag) throw new ProviderEventWriteError("provider-conflict");
  return prepareCaldavRsvp(current.data, { ...ref, ...resourceMode(current.scheduleTag, compatibility) }, proof, response);
}
export async function deliverCaldavRsvp(collection: string, saved: CaldavRsvpEvidence, authorization: string, signal?: AbortSignal, beforeWrite?: () => Promise<void>, readOnly = false, eligibility?: () => Promise<boolean>) {
  enabled();
  // Reconstruct all private bytes/hashes after JSON persistence; caller input
  // cannot widen an RSVP into an unrelated content or attendee edit.
  const evidence = prepareCaldavRsvp(saved.before, saved, saved.proof, saved.response);
  if (!isDeepStrictEqual(evidence, saved)) throw new ProviderEventWriteError("provider-conflict");
  caldavSeriesResourceURL(collection, evidence.id);
  const compatibility = evidence.mode === "icloud-oneoff-attendee";
  const allowIcloud = await eligible(eligibility);
  if (compatibility && !allowIcloud) throw new EventWriteError("event-write", "unsupported");
  const proof = await readCaldavSchedulingProof(collection, evidence.id, authorization, signal, "reply", compatibility && allowIcloud);
  if (!isDeepStrictEqual(proof, evidence.proof)) throw new ProviderEventWriteError("provider-conflict");
  const result = (current: Awaited<ReturnType<typeof readCaldavRsvpResource>>, recovered: boolean) => {
    enabled(compatibility);
    const observed = prepareCaldavRsvp(current.data, { id: evidence.id, etag: current.etag, uid: evidence.uid, ...resourceMode(current.scheduleTag, compatibility, evidence.mode) }, proof, evidence.response);
    if (observed.before !== observed.after || observed.selfAddress !== evidence.selfAddress || caldavRsvpResourceHash(current.data) !== evidence.desiredResourceHash) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
    return { etag: current.etag, recovered, notificationDelivery: "unknown" as const, confirmation: { resourceHash: evidence.desiredResourceHash, ...resourceMode(current.scheduleTag, compatibility, evidence.mode), selfAddress: evidence.selfAddress } };
  };
  let current: Awaited<ReturnType<typeof readCaldavRsvpResource>>;
  try {
    current = await readCaldavRsvpResource(evidence.id, authorization, signal, compatibility);
    if (caldavRsvpResourceHash(current.data) === evidence.desiredResourceHash) return result(current, true);
  } catch (error) {
    if (providerDeferral(error)) throw error;
    if (!readOnly) throw error;
    throw new ProviderEventWriteError("caldav-rsvp-response-unconfirmed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined, error instanceof ProviderEventWriteError ? error.retryAfterMs : undefined);
  }
  // A previous dispatch may have reached the provider even when its resource
  // still reads as the baseline. Only a complete desired readback can settle it.
  if (readOnly) throw new ProviderEventWriteError("caldav-rsvp-response-unconfirmed", "unconfirmed");
  if (current.etag !== evidence.etag || current.scheduleTag !== evidence.scheduleTag || !sameCaldavResource(current.data, evidence.before)) throw new ProviderEventWriteError("provider-conflict");
  await reserveProviderMutation({ url: new URL(evidence.id).href, method: "PUT" }, async () => { await beforeWrite?.(); }); signal?.throwIfAborted(); enabled();
  if (compatibility && !await eligible(eligibility)) throw new EventWriteError("event-write", "unsupported");
  signal?.throwIfAborted(); enabled();
  let accepted = false;
  try {
    const response = await fetch(evidence.id, { method: "PUT", redirect: "error", signal, headers: { authorization, "content-type": "text/calendar; charset=utf-8", "if-match": evidence.etag }, body: evidence.after });
    assertProviderEventMutationResponse(response); accepted = true;
    return result(await readCaldavRsvpResource(evidence.id, authorization, signal, compatibility), false);
  } catch (error) {
    if (providerDeferral(error)) throw error;
    if (!accepted && error instanceof ProviderEventWriteError && error.providerStatus !== undefined) throw error;
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error instanceof ProviderEventWriteError ? error.providerStatus : undefined);
  }
}
