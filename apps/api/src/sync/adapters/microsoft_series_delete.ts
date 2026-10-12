import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { z } from "zod";
import { EventSchema, EventScopeRequestSchema } from "@musubi/types";
import { sameCaldavScopeContext as same, type GraphFamilyContext, type GraphFamilyObservation, type GraphSeriesDeletionPrepared } from "@musubi/db";
import { ProviderEventWriteError } from "../event_write";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { readGraphSeriesFamilyOrMissing, type GraphSeriesFamily } from "./microsoft_series_family";
import { microsoftEventVersion } from "./microsoft_event_content";

function conflict(): never { throw new ProviderEventWriteError("provider-conflict"); }
function unknown(): never { throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); }

export function graphFamilyObservation(family: GraphSeriesFamily): GraphFamilyObservation {
  const project = (value: GraphSeriesFamily["master"]): GraphFamilyObservation["master"] => {
    if (!value.timeModel || !value.icalUid || !value.providerState) conflict();
    return { ...(value.creationOperationID ? { creationOperationID: value.creationOperationID } : {}), externalID: value.externalId, icalUid: value.icalUid, etag: value.etag ?? null, providerState: value.providerState,
      values: { title: value.title, description: value.description, location: value.location, organizer: value.organizer ?? "", url: value.url, start: value.start, end: value.end, isAllDay: value.isAllDay, recurrence: value.recurrence, timeModel: value.timeModel } };
  };
  return { master: project(family.master), instances: family.instances.map(value => {
    if (!value.originalStart) conflict();
    return { ...project(value), originalStart: value.originalStart };
  }), cancelled: family.cancelled };
}

async function session(token: string, context: GraphFamilyContext, signal?: AbortSignal) {
  const headers = { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"', "Cache-Control": "no-cache" };
  const root = "https://graph.microsoft.com/v1.0";
  const get = async (path: string) => {
    const response = await fetch(root + path, { headers, signal, redirect: "error" });
    assertCompleteEventReadResponse(response); return response.json();
  };
  const user = z.object({ id: z.string().min(1), mail: z.email().nullable(), userPrincipalName: z.string() }).parse(await get("/me?$select=id,mail,userPrincipalName"));
  const self = z.email().parse(user.mail ?? user.userPrincipalName).toLowerCase();
  const calendarID = context.link.externalCalendarID;
  const calendar = z.object({ id: z.literal(calendarID), canEdit: z.literal(true), owner: z.object({ address: z.email() }) }).parse(await get(`/me/calendars/${encodeURIComponent(calendarID)}?$select=id,canEdit,owner`));
  if (calendar.owner.address.toLowerCase() !== self) conflict();
  const mapping = context.mappings.find(value => value.eventID === context.root.id)!;
  const template = EventSchema.parse({ ...context.root, deletedAt: null, calendars: [context.address.calendarID] });
  const read = async () => {
    const family = await readGraphSeriesFamilyOrMissing(token, calendarID, template, { externalEventId: mapping.externalEventID, icalUid: mapping.icalUid, etag: mapping.etag }, signal);
    if (!family) return null;
    const observation = graphFamilyObservation(family);
    for (const item of [observation.master, ...observation.instances]) {
      const state = item.providerState;
      if (!microsoftEventVersion(item.etag) || state.isOrganizer !== true || !state.attendeesComplete || state.attendees.length || state.conferenceURLs.length || state.status !== "active" || state.organizer?.address?.toLowerCase() !== self) conflict();
    }
    return observation;
  };
  const path = (eventID: string) => `/me/calendars/${encodeURIComponent(calendarID)}/events/${encodeURIComponent(eventID)}`;
  const verifyTarget = async (eventID: string, etag: string, masterID?: string) => {
    const native = await get(path(eventID));
    if (native.id !== eventID || microsoftEventVersion(native["@odata.etag"]) !== etag || native.isOrganizer !== true || native.isDraft !== false || native.isCancelled !== false ||
      native.isOnlineMeeting !== false || native.onlineMeeting != null || native.onlineMeetingUrl != null || !Array.isArray(native.attendees) || native.attendees.length || native["attendees@odata.nextLink"] || native["@odata.nextLink"] || native["@removed"] ||
      (masterID ? !["occurrence", "exception"].includes(native.type) || native.seriesMasterId !== masterID || native.recurrence !== null : native.type !== "seriesMaster" || native.seriesMasterId != null)) conflict();
  };
  return { read, verifyTarget, remove: (id: string, etag: string) => fetch(root + path(id), { method: "DELETE", headers: { ...headers, "If-Match": etag }, signal, redirect: "error" }) };
}

export async function prepareGraphSeriesDeletion(token: string, context: GraphFamilyContext, input: unknown, signal?: AbortSignal): Promise<GraphSeriesDeletionPrepared> {
  const request = EventScopeRequestSchema.parse(input);
  if (request.action !== "delete" || !["series", "occurrence"].includes(request.scope)) conflict();
  const transport = await session(token, context, signal), baseline = await transport.read();
  if (!baseline) conflict();
  const active = [baseline.master, ...baseline.instances];
  for (const native of active) {
    const mapping = context.mappings.find(value => value.externalEventID === native.externalID);
    const local = [context.root, ...context.children].find(value => value.id === mapping?.eventID);
    if (!mapping || !local || local.deletedAt || local.isCanceled || mapping.etag !== native.etag || mapping.icalUid !== native.icalUid ||
      Object.entries(native.values).some(([key, value]) => !same(local[key as keyof typeof local], value))) conflict();
  }
  if (context.children.some(child => !child.deletedAt && (child.isCanceled ? !baseline.cancelled.some(value => same(value.originalStart, child.originalStart)) : !baseline.instances.some(value => same(value.originalStart, child.originalStart))))) conflict();
  const target = request.scope === "series" ? baseline.master : baseline.instances.find(value => same(value.originalStart, request.originalStart));
  if (!target?.etag) conflict();
  await transport.verifyTarget(baseline.master.externalID, baseline.master.etag!);
  if (target !== baseline.master) await transport.verifyTarget(target.externalID, target.etag, baseline.master.externalID);
  return { version: 1, context, request, baseline, targetID: target.externalID };
}

function deletionObserved(saved: GraphSeriesDeletionPrepared, observed: GraphFamilyObservation | null) {
  if (saved.request.scope === "series") return observed === null;
  if (!observed) return false;
  const target = saved.baseline.instances.find(value => value.externalID === saved.targetID)!;
  const content = ({ etag: _etag, ...value }: GraphFamilyObservation["master"]) => value;
  return same(content(observed.master), content(saved.baseline.master)) &&
    same(observed.instances.map(content), saved.baseline.instances.filter(value => value.externalID !== saved.targetID).map(content)) &&
    observed.cancelled.length === saved.baseline.cancelled.length + 1 &&
    observed.cancelled.some(value => same(value.originalStart, target.originalStart)) &&
    saved.baseline.cancelled.every(value => observed.cancelled.some(item => same(value, item)));
}

/** Graph ignores If-Match on DELETE. Fresh family/target reads are a guarded
 * preflight, not CAS. Every ambiguous attempt can only reconcile, never resend. */
export async function deleteGraphSeries(token: string, saved: GraphSeriesDeletionPrepared, reconciling: boolean, beforeWrite: () => Promise<void>, signal?: AbortSignal) {
  const transport = await session(token, saved.context, signal);
  const current = await transport.read();
  if (deletionObserved(saved, current)) return current;
  if (reconciling) unknown();
  if (!same(current, saved.baseline)) conflict();
  const target = [saved.baseline.master, ...saved.baseline.instances].find(value => value.externalID === saved.targetID);
  if (!target?.etag) conflict();
  await beforeWrite();
  await transport.verifyTarget(saved.baseline.master.externalID, saved.baseline.master.etag!);
  if (saved.request.scope === "occurrence") await transport.verifyTarget(target.externalID, target.etag, saved.baseline.master.externalID);
  try {
    const response = await transport.remove(target.externalID, target.etag);
    if (response.status !== 204) unknown();
    const after = await transport.read();
    if (!deletionObserved(saved, after)) unknown();
    return after;
  } catch { return unknown(); }
}
