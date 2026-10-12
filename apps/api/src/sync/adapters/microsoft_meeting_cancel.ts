import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { EventSchema, type MicrosoftSeriesCancellationRequest } from "@musubi/types";
import { assertGraphMeetingRequest, graphMeetingVersion, sameCaldavScopeContext as same, type GraphFamilyObservation, type GraphMeetingContext, type GraphMeetingCancellation } from "@musubi/db";
import { ProviderEventWriteError } from "../event_write";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { graphFamilyObservation } from "./microsoft_series_delete";
import { readGraphSeriesFamilyOrMissing } from "./microsoft_series_family";
import { graphOrganizerMasterTimeFromUtc, graphOriginalStartFromUtc } from "./microsoft_time";
import { microsoftCancellationEvidence } from "./microsoft_organizer";
import { verifiedGraphIdentity } from "./microsoft_identity";

function fail(): never { throw new ProviderEventWriteError("provider-conflict"); }
const unknown = (): never => { throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); };
const root = "https://graph.microsoft.com/v1.0";
export async function graphOrganizerFamilySession(token: string, context: GraphMeetingContext, signal?: AbortSignal, allowPersonal = false) {
  const headers = { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"', "Cache-Control": "no-cache" };
  const get = async (url: string) => { const response = await fetch(url, { headers, signal, redirect: "error" }); assertCompleteEventReadResponse(response); return response.json(); };
  const identity = await verifiedGraphIdentity(get, context.link.accountID, context.link.externalCalendarID);
  const path = (id: string) => `${root}/me/calendars/${encodeURIComponent(identity.calendarID)}/events/${encodeURIComponent(id)}`;
  const readTarget = async (id: string) => {
    const native = microsoftCancellationEvidence(await get(path(id)), identity.selfAddress, context.masterID, allowPersonal);
    if (native.id !== id) fail();
    return native;
  };
  const read = async (template: GraphMeetingCancellation["template"], uid: string) => {
    const family = await readGraphSeriesFamilyOrMissing(token, identity.calendarID, EventSchema.parse(template), { externalEventId: context.masterID, icalUid: uid }, signal);
    if (!family) return null;
    const observation = graphFamilyObservation(family);
    for (const value of [observation.master, ...observation.instances]) {
      const state = value.providerState;
      if (!value.etag || !state.attendeesComplete || (!allowPersonal && !state.attendees.length) || state.attendees.length > 100 || state.isOrganizer !== true || state.status !== "active" || state.organizer?.address?.toLowerCase() !== identity.selfAddress || state.conferenceURLs.length || new Set(state.attendees.map(p => p.address?.toLowerCase())).size !== state.attendees.length || state.attendees.some(p => !p.address)) fail();
    }
    return observation;
  };
  return { identity, read, readTarget, get, path, headers, cancel: (id: string, etag: string) => fetch(path(id) + "/cancel", { method: "POST", headers: { ...headers, "Content-Type": "application/json", "If-Match": etag }, body: "{}", signal, redirect: "error" }) };
}
function verifyLocal(context: GraphMeetingContext, baseline: GraphFamilyObservation) {
  for (const event of context.family) {
    const mapping = context.mappings.find(m => m.eventID === event.id);
    if (event.deletedAt || event.isCanceled) {
      // Cancelled canonical slots retain a mapping; unrelated stale flat rows
      // do not get silently swept into a new whole-series operation.
      const original = event.originalStart ?? mapping?.originalStart;
      const normalized = original?.kind === "instant" ? graphOriginalStartFromUtc(original.value, event.isAllDay) : original;
      if (!normalized || !baseline.cancelled.some(c => same(c.originalStart, normalized))) fail();
      continue;
    }
    const native = [baseline.master, ...baseline.instances].find(n => n.externalID === mapping?.externalEventID);
    if (!mapping || !native || mapping.icalUid !== native.icalUid || mapping.etag !== native.etag || !same(mapping.providerState, native.providerState)) fail();
    // Flat imported instances deliberately have legacy time metadata. Exact UTC
    // times and the native original slot still bind them without inventing a rule.
    for (const field of ["title", "description", "location", "start", "end", "isAllDay", "organizer", "url"] as const)
      if (!same(event[field], native.values[field])) fail();
    if ("originalStart" in native) {
      const original = mapping.originalStart;
      const normalized = original?.kind === "instant" ? graphOriginalStartFromUtc(original.value, native.values.isAllDay) : original;
      if (!same(normalized, native.originalStart)) fail();
    } else if (event.id !== context.rootID || event.recurrence !== native.values.recurrence) fail();
  }
}
export async function observeGraphOrganizerFamily(token: string, context: GraphMeetingContext, signal?: AbortSignal, allowPersonal = false) {
  const transport = await graphOrganizerFamilySession(token, context, signal, allowPersonal);
  const raw = await transport.readTarget(context.masterID);
  const existing = context.family.find(e => e.id === context.rootID);
  const template = EventSchema.parse({ ...context.family.find(e => e.id === context.address.eventID), ...(existing ?? graphOrganizerMasterTimeFromUtc(raw)), seriesID: null, originalStart: null, isCanceled: false, deletedAt: null, calendars: [context.address.calendarID] });
  const baseline = await transport.read(template, raw.iCalUId);
  if (!baseline || baseline.master.etag !== raw.etag) fail();
  verifyLocal(context, baseline);
  const mapping = context.mappings.find(m => m.eventID === context.address.eventID)!;
  const scopes: ("occurrence" | "series")[] = mapping.externalSeriesID ? ["occurrence", "series"] : ["series"];
  return { context, template, baseline, identity: transport.identity, scopes,
    version: graphMeetingVersion({ context, baseline, identity: transport.identity }) };
}
export const observeGraphMeetingCancellation = (token: string, context: GraphMeetingContext, signal?: AbortSignal) => observeGraphOrganizerFamily(token, context, signal);
export async function prepareGraphMeetingCancellation(token: string, context: GraphMeetingContext, request: MicrosoftSeriesCancellationRequest, signal?: AbortSignal): Promise<GraphMeetingCancellation> {
  assertGraphMeetingRequest(context, request);
  const observed = await observeGraphMeetingCancellation(token, context, signal);
  if (observed.version !== request.expectedSeriesVersion || !observed.scopes.includes(request.scope)) fail();
  const mapping = context.mappings.find(m => m.eventID === request.eventID)!;
  return { version: 1, context, request, baseline: observed.baseline, identity: observed.identity, template: observed.template,
    targetID: request.scope === "series" ? context.masterID : mapping.externalEventID };
}
export function graphMeetingCancellationObserved(saved: GraphMeetingCancellation, after: GraphFamilyObservation | null) {
  if (saved.request.scope === "series") return after === null;
  if (!after) return false;
  const target = saved.baseline.instances.find(n => n.externalID === saved.targetID);
  const content = ({ etag: _etag, ...value }: GraphFamilyObservation["master"]) => value;
  return !!target && same(content(after.master), content(saved.baseline.master)) &&
    same(after.instances.map(content), saved.baseline.instances.filter(n => n.externalID !== saved.targetID).map(content)) &&
    after.cancelled.length === saved.baseline.cancelled.length + 1 && after.cancelled.some(c => same(c.originalStart, target.originalStart)) &&
    saved.baseline.cancelled.every(c => after.cancelled.some(n => same(c, n)));
}
/** One permanent dispatch marker, one POST. Durable 202 + full native outcome
 * is acceptance, never proof of delivery to the guest's mailbox. */
export async function cancelGraphMeeting(token: string, saved: GraphMeetingCancellation, mark: () => Promise<void>, accepted: () => Promise<void>, signal?: AbortSignal) {
  const transport = await graphOrganizerFamilySession(token, saved.context, signal);
  if (!same(transport.identity, saved.identity)) fail();
  const current = await transport.read(saved.template, saved.baseline.master.icalUid);
  if (saved.dispatch) {
    if (saved.dispatch.acceptedAt && graphMeetingCancellationObserved(saved, current)) return current;
    return unknown();
  }
  if (!same(current, saved.baseline)) fail();
  const target = [saved.baseline.master, ...saved.baseline.instances].find(n => n.externalID === saved.targetID);
  if (!target?.etag) fail();
  const master = await transport.readTarget(saved.context.masterID);
  const native = saved.targetID === saved.context.masterID ? master : await transport.readTarget(saved.targetID);
  if (master.etag !== saved.baseline.master.etag || native.etag !== target.etag || native.iCalUId !== target.icalUid) fail();
  await mark();
  try {
    const response = await transport.cancel(saved.targetID, target.etag);
    if (response.status !== 202) return unknown();
    await accepted();
    const after = await transport.read(saved.template, saved.baseline.master.icalUid);
    if (!graphMeetingCancellationObserved(saved, after)) return unknown();
    return after;
  } catch (error) {
    if (error instanceof ProviderEventWriteError && (error.providerStatus === 429 ||
        error.providerStatus === 408 || (error.providerStatus ?? 0) >= 500)) {
      throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", error.providerStatus, error.retryAfterMs);
    }
    return unknown();
  }
}
