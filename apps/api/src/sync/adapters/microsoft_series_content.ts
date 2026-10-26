import { reserveProviderMutation, providerDeferral } from "../provider_budget";
import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { requireSupportedSeriesZone } from "./microsoft_time_zone";
import { config } from "@musubi/config";
import { OrganizerAdmissionRejectedError } from "@musubi/types";
import { graphSeriesTimeChange } from "@musubi/db";
import { setTimeout as delay } from "node:timers/promises";
import { type MicrosoftRecurringContentRequest } from "@musubi/types";
import { assertGraphMeetingRequest, graphContentVersion, graphSeriesContentObserved, sameCaldavScopeContext as same, type GraphMeetingContext, type GraphOccurrenceContent, type GraphFamilyObservation } from "@musubi/db";
import { ProviderEventWriteError } from "../event_write";
import { graphOrganizerFamilySession, observeGraphOrganizerFamily } from "./microsoft_meeting_cancel";
import { microsoftMeetingContentEvidence, microsoftMeetingContentBody, matchesMeetingContent } from "./microsoft_organizer";
import { graphOriginalStartFromUtc } from "./microsoft_time";

function fail(): never { throw new ProviderEventWriteError("provider-conflict"); }
const unknown = (): never => { throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); };
type Session = Awaited<ReturnType<typeof graphOrganizerFamilySession>>;
async function readNative(transport: Session, family: GraphFamilyObservation, masterID: string) {
  const read = async (id: string) => {
    const raw = await transport.get(transport.path(id) + "?$select=*,originalStart");
    // Graph can expand exceptions even for $select=*. They are independently
    // bound below; nested change tokens must not masquerade as master content.
    if (id === masterID) delete raw.exceptionOccurrences;
    return microsoftMeetingContentEvidence(raw, transport.identity.selfAddress, masterID, true);
  };
  const native = await read(masterID);
  if (native.etag !== family.master.etag || native.iCalUId !== family.master.icalUid) fail();
  // Only exceptions carry independent native fields. Ordinary slots inherit the
  // master's content; the complete family reader verifies every such slot.
  const exceptions = family.instances.filter(n => n.providerState.eventType === "exception");
  const nativeExceptions: Record<string, unknown>[] = [];
  for (let offset = 0; offset < exceptions.length; offset += 4) {
    const batch = await Promise.all(exceptions.slice(offset, offset + 4).map(async item => {
      const raw = await read(item.externalID);
      if (raw.id !== item.externalID || raw.etag !== item.etag || raw.iCalUId !== item.icalUid || !same(graphOriginalStartFromUtc(String(raw.originalStart), raw.isAllDay), item.originalStart)) fail();
      return raw;
    }));
    nativeExceptions.push(...batch);
  }
  if (!same(await read(masterID), native)) fail();
  return { native, nativeExceptions };
}
export async function observeGraphSeriesContent(token: string, context: GraphMeetingContext, signal?: AbortSignal) {
  const family = await observeGraphOrganizerFamily(token, context, signal, true);
  const transport = await graphOrganizerFamilySession(token, context, signal, true);
  if (!same(family.identity, transport.identity)) fail();
  const native = await readNative(transport, family.baseline, context.masterID);
  const timeZoneSupported = await requireSupportedSeriesZone(transport, family.template, native.native).then(() => true, () => false);
  return { ...family, ...native, timeZoneSupported, version: graphContentVersion({ ...family, ...native }) };
}
export async function prepareGraphSeriesContent(token: string, context: GraphMeetingContext, request: MicrosoftRecurringContentRequest, signal?: AbortSignal): Promise<GraphOccurrenceContent> {
  if (request.scope !== "series") fail();
  assertGraphMeetingRequest(context, request);
  const observed = await observeGraphSeriesContent(token, context, signal);
  if (observed.version !== request.expectedSeriesVersion) fail();
  const saved: GraphOccurrenceContent = { version: 1, context, request, baseline: observed.baseline, native: observed.native, nativeExceptions: observed.nativeExceptions, identity: observed.identity, template: observed.template, targetID: context.masterID };
  if (request.patch.time) {
    if (!observed.timeZoneSupported) throw new OrganizerAdmissionRejectedError("The series time zone is not supported by this Outlook mailbox.");
    if (!config.api.eventTimeEditsEnabled) throw new OrganizerAdmissionRejectedError("Time editing is not available.");
    try { graphSeriesTimeChange(saved); }
    catch (error) { if (providerDeferral(error)) throw error; throw new OrganizerAdmissionRejectedError(error instanceof Error ? error.message : "Choose a supported series time."); }
  }
  return saved;
}
function content(raw: Record<string, unknown>, field: string) {
  if (field === "subject") return raw.subject;
  if (field === "body") return (raw.body as { content: string }).content.trim();
  return (raw.location as { displayName: string }).displayName.trim();
}
/** One conditional master PATCH. Never separately rewrite exceptions: Outlook
 * owns their field inheritance and meeting notification behavior. */
export async function updateGraphSeriesContent(token: string, saved: GraphOccurrenceContent, mark: () => Promise<void>, accepted: () => Promise<void>, signal?: AbortSignal) {
  if (saved.request.scope !== "series" || saved.targetID !== saved.context.masterID || !saved.nativeExceptions) fail();
  const transport = await graphOrganizerFamilySession(token, saved.context, signal, true);
  if (!same(transport.identity, saved.identity)) fail();
  const baseline = microsoftMeetingContentEvidence(saved.native, saved.identity.selfAddress, saved.context.masterID, true);
  const patch = microsoftMeetingContentBody(saved.request, saved.native);
  const time = graphSeriesTimeChange(saved);
  if (time && !config.api.eventTimeEditsEnabled && !saved.dispatch) fail();
  const read = async (after = false) => {
    const family = await transport.read(after && time ? time.template : saved.template, saved.baseline.master.icalUid);
    if (!family) fail();
    return { family, ...await readNative(transport, family, saved.context.masterID) };
  };
  const matches = (after: Awaited<ReturnType<typeof read>>) => {
    if (!graphSeriesContentObserved(saved, after.family) || !matchesMeetingContent(baseline, patch, after.native, saved.identity.selfAddress, saved.context.masterID, true, saved.template.timeModel?.kind === "zoned" ? saved.template.timeModel.timeZone : undefined) || after.nativeExceptions.length !== saved.nativeExceptions!.length) return false;
    return saved.nativeExceptions!.every(before => {
      const next = after.nativeExceptions.find(n => n.id === before.id);
      if (!next) return false;
      const inherited: Record<string, unknown> = {};
      for (const field of Object.keys(patch)) {
        if (content(before, field) === content(baseline, field) && content(next, field) === content(patch, field)) inherited[field] = patch[field];
      }
      return matchesMeetingContent(before, inherited, next, saved.identity.selfAddress, saved.context.masterID);
    });
  };
  const verify = async () => {
    // Master propagation can briefly expose mixed change tokens. Repeat reads,
    // never the PATCH; unrelated changes still fail the exact outcome check.
    for (const pause of [0, 200, 400, 800]) {
      if (signal?.aborted) return unknown();
      if (pause) await delay(pause, undefined, { signal });
      const after = await read(true).catch(error => { if (providerDeferral(error)) throw error; return null; });
      if (after && matches(after)) return { kind: "observed" as const, observation: after.family };
    }
    return unknown();
  };
  if (saved.dispatch) {
    if (!saved.dispatch.acceptedAt) return unknown();
    return verify();
  }
  if (time) await requireSupportedSeriesZone(transport, saved.template, saved.native);
  const current = await read();
  if (!same(current.family, saved.baseline) || !same(current.native, baseline) || !same(current.nativeExceptions, saved.nativeExceptions)) fail();
  if (matches(current)) return { kind: "observed" as const, observation: current.family };
  await reserveProviderMutation({ url: transport.path(saved.targetID), method: "PATCH" }, mark);
  try {
    const response = await fetch(transport.path(saved.targetID), { method: "PATCH", headers: { ...transport.headers, "Content-Type": "application/json", "If-Match": baseline.etag }, body: JSON.stringify(patch), signal, redirect: "error" });
    if (response.status === 412) return { kind: "rejected" as const };
    if (response.status !== 200) return unknown();
    const native = await response.json();
    if (native?.id !== baseline.id || native.iCalUId !== baseline.iCalUId || native.type !== "seriesMaster" || native.seriesMasterId != null) return unknown();
    await accepted();
    return await verify();
  } catch (error) { if (providerDeferral(error)) throw error; return unknown(); }
}
