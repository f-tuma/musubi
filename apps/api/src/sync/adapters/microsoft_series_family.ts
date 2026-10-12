import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Event } from "@musubi/types";
import type { ExternalEventRef, NormalizedEvent } from "../adapter";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { ProviderEventWriteError } from "../event_write";
import { graphMasterTimeFromUtc, graphMasterForSavedZone, graphOriginalStartFromUtc, graphInstanceTimeFromUtc } from "./microsoft_time";
import { recurrenceFromGraph } from "./microsoft_recurrence";
import { graphSeriesFootprint, type GraphSeriesOccurrence } from "./microsoft_series_footprint";
import { microsoftEventState } from "./provider_event_state";

const opaque = z.string().min(1).refine(value => value.trim() === value && value !== "." && value !== "..");
const person = z.object({ emailAddress: z.object({ address: z.string().min(1), name: z.string().optional() }) });
const event = z.object({
  id: opaque, iCalUId: opaque, "@odata.etag": opaque.optional(), "@removed": z.never().optional(),
  "@odata.nextLink": z.never().optional(), "attendees@odata.nextLink": z.never().optional(),
  subject: z.string(), body: z.object({ contentType: z.string(), content: z.string() }),
  location: z.object({ displayName: z.string() }), organizer: person.nullable(), isOrganizer: z.boolean(),
  attendees: z.array(person.extend({ type: z.string(), status: z.object({ response: z.string() }) })),
  "attendees@odata.count": z.number().int().nonnegative().optional(),
  isDraft: z.literal(false), isOnlineMeeting: z.boolean(), onlineMeeting: z.object({ joinUrl: z.string() }).nullable(), onlineMeetingUrl: z.string().nullable(),
  isReminderOn: z.boolean(), reminderMinutesBeforeStart: z.number().int().nonnegative(), showAs: z.string(), sensitivity: z.string(), responseStatus: z.object({ response: z.string() }),
}).passthrough();
const master = event.extend({
  transactionId: z.string().nullish(),
  cancelledOccurrences: z.array(opaque), exceptionOccurrences: z.array(z.unknown()),
  "exceptionOccurrences@odata.nextLink": z.never().optional(), "cancelledOccurrences@odata.nextLink": z.never().optional(),
  "exceptionOccurrences@odata.count": z.number().int().nonnegative().optional(), "cancelledOccurrences@odata.count": z.number().int().nonnegative().optional(),
});
function refuse(): never { throw new ProviderEventWriteError("provider-conflict"); }
const key = (value: GraphSeriesOccurrence["originalStart"]) => JSON.stringify(value);

export type GraphSeriesFamily = {
  master: NormalizedEvent;
  instances: NormalizedEvent[];
  // No fabricated provider IDs. These identities follow only from the complete
  // finite active set plus explicit, unique native cancellation cardinality.
  cancelled: GraphSeriesOccurrence[];
  cancelledOccurrenceIDs: string[];
};
function content(native: unknown): NormalizedEvent {
  const item = event.parse(native);
  if (item.body.contentType.toLowerCase() !== "text" || (item["attendees@odata.count"] !== undefined && item["attendees@odata.count"] !== item.attendees.length)) refuse();
  const providerState = microsoftEventState(item);
  return { externalId: item.id, icalUid: item.iCalUId, etag: item["@odata.etag"] ?? null,
    status: "active", title: item.subject, description: item.body.content.trim() || null, location: item.location.displayName.trim() || null,
    organizer: item.organizer?.emailAddress.address ?? null, url: providerState.conferenceURLs[0] ?? null, providerState,
    start: new Date(0), end: new Date(0), isAllDay: false, recurrence: null };
}
function header(native: unknown, template: Event, ref: ExternalEventRef) {
  const item = master.parse(graphMasterForSavedZone(native, template));
  if (item.id !== ref.externalEventId || !ref.icalUid || item.iCalUId !== ref.icalUid || template.seriesID || template.originalStart) refuse();
  if ((item["exceptionOccurrences@odata.count"] !== undefined && item["exceptionOccurrences@odata.count"] !== item.exceptionOccurrences.length) ||
      (item["cancelledOccurrences@odata.count"] !== undefined && item["cancelledOccurrences@odata.count"] !== item.cancelledOccurrences.length) ||
      new Set(item.cancelledOccurrences).size !== item.cancelledOccurrences.length) refuse();
  const time = graphMasterTimeFromUtc(item);
  const recurrence = recurrenceFromGraph({ ...template, ...time }, item.recurrence);
  const normalized = { ...content(item), ...time, timeModel: time.timeModel ?? undefined, recurrence, ...(typeof item.transactionId === "string" ? { creationOperationID: item.transactionId } : {}) };
  const slots = graphSeriesFootprint({ ...template, ...time, recurrence, isCanceled: false });
  return { item, normalized, slots };
}

/** Pure projection of a COMPLETE finite /instances listing and explicitly
 * expanded master. Do not call this with calendarView or a partial page set.
 * No write, DB import, ACK, or whole-family concurrency guarantee is implied. */
export function graphSeriesFamilyEvidence(native: unknown, listed: unknown[], template: Event, ref: ExternalEventRef): GraphSeriesFamily {
  try {
    const { item, normalized, slots } = header(native, template, ref);
    const bySlot = new Map(slots.map(slot => [key(slot.originalStart), slot]));
    const project = (value: unknown) => {
      const parsed = event.parse(value);
      if (parsed.id === item.id || parsed.recurrence !== null) refuse();
      const originalStart = graphOriginalStartFromUtc(parsed.originalStart, normalized.isAllDay);
      const slot = bySlot.get(key(originalStart));
      if (!slot) refuse();
      const time = graphInstanceTimeFromUtc(parsed, item.id, slot);
      const result = { ...content(parsed), ...time, timeModel: time.timeModel ?? undefined, externalSeriesID: item.id };
      if (parsed.type === "occurrence" && ["title", "description", "location"].some(field => result[field as "title"] !== normalized[field as "title"])) refuse();
      return result;
    };
    const exceptions = new Map<string, NormalizedEvent>();
    for (const value of item.exceptionOccurrences) {
      const parsed = event.parse(value);
      if (parsed.type !== "exception" || exceptions.has(parsed.id)) refuse();
      exceptions.set(parsed.id, project(value));
    }
    const active = new Map(exceptions), seen = new Set<string>();
    for (const value of listed) {
      const parsed = event.parse(value);
      if (seen.has(parsed.id)) refuse();
      seen.add(parsed.id);
      const projected = project(value), expanded = exceptions.get(parsed.id);
      if (parsed.type === "exception" ? !expanded || !isDeepStrictEqual(expanded, projected) : expanded !== undefined) refuse();
      active.set(parsed.id, projected);
    }
    const originals = new Set<string>();
    for (const value of active.values()) {
      const original = key(value.originalStart!);
      if (originals.has(original)) refuse();
      originals.add(original);
    }
    const cancelled = slots.filter(slot => !originals.has(key(slot.originalStart)));
    if (cancelled.length !== item.cancelledOccurrences.length) refuse();
    return { master: normalized, instances: [...active.values()].sort((a, b) => key(a.originalStart!).localeCompare(key(b.originalStart!))), cancelled, cancelledOccurrenceIDs: [...item.cancelledOccurrences].sort() };
  } catch { return refuse(); }
}

const fields = "id,iCalUId,type,isAllDay,isCancelled,seriesMasterId,originalStart,start,end,originalStartTimeZone,originalEndTimeZone,recurrence,subject,body,location,attendees,isOrganizer,organizer,isDraft,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,isReminderOn,reminderMinutesBeforeStart,showAs,sensitivity,responseStatus";
const page = z.object({ value: z.array(z.unknown()), "@odata.nextLink": opaque.optional(), "@odata.count": z.number().int().nonnegative().optional() });

/** Complete read for tracked known families. A second expanded master detects
 * changed rule/cancellation/exception observations;
 * neither it nor an unchanged master ETag constitutes an atomic family read. */
async function readFamily(accessToken: string, calendarID: string, template: Event, ref: ExternalEventRef, signal: AbortSignal | undefined, allowMissing: boolean): Promise<GraphSeriesFamily | null> {
  template = structuredClone(template); ref = { ...ref };
  if (!opaque.safeParse(calendarID).success || !opaque.safeParse(ref.externalEventId).success || !opaque.safeParse(ref.icalUid).success) refuse();
  const base = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarID)}/events/${encodeURIComponent(ref.externalEventId)}`);
  const request = (url: URL) => fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"', "Cache-Control": "no-cache" }, redirect: "error", signal });
  const read = async (url: URL): Promise<unknown> => {
    const response = await request(url);
    assertCompleteEventReadResponse(response);
    return response.json();
  };
  const masterURL = new URL(base);
  masterURL.searchParams.set("$select", `${fields},transactionId,cancelledOccurrences,exceptionOccurrences`);
  masterURL.searchParams.set("$expand", "exceptionOccurrences");
  const firstResponse = await request(masterURL);
  if (allowMissing && firstResponse.status === 404) {
    const missing = async (response: Response) => {
      if (response.status !== 404 || response.headers.has("content-range")) refuse();
      // Consume and validate the complete standard Graph error response. A
      // truncated/partial body or a generic failed request is not absence.
      const error = z.object({ error: z.object({ code: z.string().min(1) }) }).safeParse(await response.json());
      if (!error.success) refuse();
    };
    await missing(firstResponse);
    const calendarURL = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarID)}`);
    calendarURL.searchParams.set("$select", "id");
    const calendar = z.object({ id: opaque, "@odata.nextLink": z.never().optional(), "@removed": z.never().optional() }).safeParse(await read(calendarURL));
    if (!calendar.success || calendar.data.id !== calendarID) refuse();
    await missing(await request(masterURL));
    return null;
  }
  assertCompleteEventReadResponse(firstResponse);
  const first = await firstResponse.json();
  let slots: GraphSeriesOccurrence[];
  try { slots = header(first, template, ref).slots; } catch { return refuse(); }
  const instanceURL = new URL(`${base}/instances`);
  instanceURL.searchParams.set("startDateTime", slots[0]!.start.toISOString());
  instanceURL.searchParams.set("endDateTime", new Date(Math.max(...slots.map(slot => slot.end.getTime() + (slot.isAllDay ? 86_400_000 : 0)))).toISOString());
  instanceURL.searchParams.set("$select", fields); instanceURL.searchParams.set("$top", "100");
  let next: string | undefined = instanceURL.href, total: number | undefined;
  const visited = new Set<string>(), values: unknown[] = [];
  while (next !== undefined) {
    const url = new URL(next);
    if (url.origin !== base.origin || url.pathname !== instanceURL.pathname || url.username || url.password || url.hash || visited.has(url.href) || visited.size >= 1000) refuse();
    visited.add(url.href);
    const parsed = page.safeParse(await read(url));
    if (!parsed.success) refuse();
    if (parsed.data["@odata.count"] !== undefined) {
      if (total !== undefined && total !== parsed.data["@odata.count"]) refuse();
      total = parsed.data["@odata.count"];
    }
    values.push(...parsed.data.value);
    if (values.length > slots.length) refuse();
    next = parsed.data["@odata.nextLink"];
  }
  if (total !== undefined && total !== values.length) refuse();
  const result = graphSeriesFamilyEvidence(first, values, template, ref);
  const again = graphSeriesFamilyEvidence(await read(masterURL), values, template, ref);
  if (!isDeepStrictEqual(result, again)) refuse();
  return result;
}

/** Strict full-family evidence, including for future create ACK. */
export async function readGraphSeriesFamily(accessToken: string, calendarID: string, template: Event, ref: ExternalEventRef, signal?: AbortSignal): Promise<GraphSeriesFamily> {
  const family = await readFamily(accessToken, calendarID, template, ref, signal, false);
  if (!family) refuse();
  return family;
}

/** Null means two complete exact-master 404 responses bracketing a successful
 * exact-calendar read. It is never permission to repeat a create POST. */
export function readGraphSeriesFamilyOrMissing(accessToken: string, calendarID: string, template: Event, ref: ExternalEventRef, signal?: AbortSignal): Promise<GraphSeriesFamily | null> {
  return readFamily(accessToken, calendarID, template, ref, signal, true);
}
