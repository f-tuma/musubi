import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { requireSupportedSeriesZone } from "./microsoft_time_zone";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@musubi/config";
import { OrganizerAdmissionRejectedError } from "@musubi/types";
import { graphOccurrenceTimeChange } from "@musubi/db";
import { updateGraphSeriesContent } from "./microsoft_series_content";
import { graphOriginalStartFromUtc } from "./microsoft_time";
import { type MicrosoftOccurrenceContentRequest } from "@musubi/types";
import { assertGraphMeetingRequest, graphMeetingVersion, graphOccurrenceContentObserved, sameCaldavScopeContext as same, type GraphMeetingContext, type GraphOccurrenceContent } from "@musubi/db";
import { ProviderEventWriteError } from "../event_write";
import { graphOrganizerFamilySession, observeGraphOrganizerFamily } from "./microsoft_meeting_cancel";
import { microsoftMeetingContentEvidence, microsoftMeetingContentBody, matchesMeetingContent } from "./microsoft_organizer";

function fail(): never { throw new ProviderEventWriteError("provider-conflict"); }
const unknown = (): never => { throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); };

export async function observeGraphOccurrenceContent(token: string, context: GraphMeetingContext, signal?: AbortSignal) {
  const mapping = context.mappings.find(m => m.eventID === context.address.eventID);
  if (!mapping?.externalSeriesID || mapping.externalSeriesID !== context.masterID) fail();
  const family = await observeGraphOrganizerFamily(token, context, signal, true);
  const transport = await graphOrganizerFamilySession(token, context, signal, true);
  if (!same(family.identity, transport.identity)) fail();
  const native = microsoftMeetingContentEvidence(await transport.get(transport.path(mapping.externalEventID) + "?$select=*,originalStart"), transport.identity.selfAddress, context.masterID);
  const target = family.baseline.instances.find(n => n.externalID === mapping.externalEventID);
  if (!target || native.id !== target.externalID || native.iCalUId !== target.icalUid || native.etag !== target.etag || !same(graphOriginalStartFromUtc(String(native.originalStart), native.isAllDay), target.originalStart)) fail();
  await requireSupportedSeriesZone(transport, family.template, native);
  return { ...family, native, version: graphMeetingVersion({ context, baseline: family.baseline, identity: family.identity, native }) };
}

export async function prepareGraphOccurrenceContent(token: string, context: GraphMeetingContext, request: MicrosoftOccurrenceContentRequest, signal?: AbortSignal): Promise<GraphOccurrenceContent> {
  assertGraphMeetingRequest(context, request);
  const observed = await observeGraphOccurrenceContent(token, context, signal);
  if (observed.version !== request.expectedSeriesVersion) fail();
  const saved: GraphOccurrenceContent = { version: 1, context, request, baseline: observed.baseline, native: observed.native, identity: observed.identity, template: observed.template, targetID: observed.native.id };
  if (request.patch.time) {
    if (!config.api.eventTimeEditsEnabled) throw new OrganizerAdmissionRejectedError("Time editing is not available.");
    try { graphOccurrenceTimeChange(saved); }
    catch (error) { throw new OrganizerAdmissionRejectedError(error instanceof Error ? error.message : "Choose a time between neighbouring occurrences."); }
  }
  return saved;
}

/** Conditional PATCH only targets one native occurrence. Never re-send after a
 * possible dispatch: meeting updates may notify guests on every successful write. */
export async function updateGraphOccurrenceContent(token: string, saved: GraphOccurrenceContent, mark: () => Promise<void>, accepted: () => Promise<void>, signal?: AbortSignal) {
  if (saved.request.scope === "series") return updateGraphSeriesContent(token, saved, mark, accepted, signal);
  const transport = await graphOrganizerFamilySession(token, saved.context, signal, true);
  if (!same(transport.identity, saved.identity)) fail();
  const baseline = microsoftMeetingContentEvidence(saved.native, saved.identity.selfAddress, saved.context.masterID);
  const target = saved.baseline.instances.find(n => n.externalID === saved.targetID);
  if (!target || target.etag !== baseline.etag || target.icalUid !== baseline.iCalUId || saved.targetID !== baseline.id) fail();
  graphOccurrenceTimeChange(saved);
  if (saved.request.patch.time && !config.api.eventTimeEditsEnabled && !saved.dispatch) fail();
  if (saved.request.patch.time && !saved.dispatch) await requireSupportedSeriesZone(transport, saved.template, saved.native);
  const patch = microsoftMeetingContentBody(saved.request, saved.native);
  const read = async () => {
    const family = await transport.read(saved.template, saved.baseline.master.icalUid);
    const native = await transport.get(transport.path(saved.targetID) + "?$select=*,originalStart");
    return { family, native };
  };
  const matches = (value: Awaited<ReturnType<typeof read>>) => value.family && graphOccurrenceContentObserved(saved, value.family) &&
    matchesMeetingContent(baseline, patch, value.native, saved.identity.selfAddress, saved.context.masterID, false, saved.template.timeModel?.kind === "zoned" ? saved.template.timeModel.timeZone : undefined) &&
    value.family.instances.find(n => n.externalID === saved.targetID)?.etag === microsoftMeetingContentEvidence(value.native, saved.identity.selfAddress, saved.context.masterID).etag;
  const verify = async () => {
    for (const wait of [0, 200, 400, 800]) {
      if (wait) await delay(wait, undefined, { signal });
      const value = await read().catch(() => null);
      if (value && matches(value)) return value;
    }
    return null;
  };
  if (saved.dispatch) {
    const after = await verify();
    if (!saved.dispatch.acceptedAt || !after || !matches(after)) return unknown();
    return { kind: "observed" as const, observation: after.family! };
  }
  const current = await read();
  if (!same(current.family, saved.baseline) || !same(microsoftMeetingContentEvidence(current.native, saved.identity.selfAddress, saved.context.masterID), baseline)) fail();
  if (matches(current)) return { kind: "observed" as const, observation: current.family! };
  await mark();
  try {
    const response = await fetch(transport.path(saved.targetID), { method: "PATCH", headers: { ...transport.headers, "Content-Type": "application/json", "If-Match": baseline.etag }, body: JSON.stringify(patch), signal, redirect: "error" });
    if (response.status === 412) return { kind: "rejected" as const };
    if (response.status === 400 && saved.request.patch.time) {
      const error = await response.json().catch(() => null);
      if (error?.error?.code === "ErrorOccurrenceCrossingBoundary") return { kind: "rejected" as const };
    }
    if (response.status !== 200) return unknown();
    // Graph omits originalStart from ordinary PATCH responses. Identity here
    // acknowledges acceptance; the selected full GET below proves the result.
    const native = await response.json();
    if (native?.id !== baseline.id || native.iCalUId !== baseline.iCalUId || native.seriesMasterId !== saved.context.masterID || !["occurrence", "exception"].includes(native.type)) return unknown();
    await accepted();
    const after = await verify();
    if (!after) return unknown();
    return { kind: "observed" as const, observation: after.family! };
  } catch { return unknown(); }
}
