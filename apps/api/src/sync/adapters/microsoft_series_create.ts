import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type Event, EventWriteError } from "@musubi/types";
import type { CreatedEventEvidence, EventCreateIdentity } from "../adapter";
import { assertCompleteEventReadResponse, eventCreateOperationID } from "../event_create_identity";
import { ProviderEventWriteError } from "../event_write";
import { graphTimeForEvent, graphMasterTimeFromUtc, graphMasterForSavedZone } from "./microsoft_time";
import { graphRecurrenceForEvent, recurrenceFromGraph, type GraphRecurrence } from "./microsoft_recurrence";
import { microsoftEventState } from "./provider_event_state";
import { graphSeriesFootprint } from "./microsoft_series_footprint";

/** Personal create candidate. Production recurring creation remains gated by
 * the missing durable family import/echo contract, not by this serializer. */
export function graphSeriesCreateBody(event: Event, identity: EventCreateIdentity) {
  if (!event.recurrence || event.seriesID || event.originalStart || event.isCanceled || event.organizer || event.url)
    throw new EventWriteError("event-write", "unsupported", "Outlook recurring creation requires a personal master. No changes were saved.");
  return {
    subject: event.title, body: { contentType: "text", content: event.description ?? "" },
    location: { displayName: event.location ?? "" }, ...graphTimeForEvent(event),
    recurrence: graphRecurrenceForEvent(event), transactionId: eventCreateOperationID(identity),
    attendees: [], isOnlineMeeting: false,
  };
}

const opaqueID = z.string().min(1).refine(value => value.trim() === value && value !== "." && value !== "..");
const nativeSeries = z.object({
  id: opaqueID, transactionId: z.string(), iCalUId: opaqueID,
  "@odata.etag": opaqueID.optional(), "@removed": z.never().optional(),
  "@odata.nextLink": z.never().optional(), "exceptionOccurrences@odata.nextLink": z.never().optional(),
  "exceptionOccurrences@odata.count": z.literal(0).optional(), "cancelledOccurrences@odata.count": z.literal(0).optional(),
  subject: z.string(), body: z.object({ contentType: z.string(), content: z.string() }),
  location: z.object({ displayName: z.string() }),
  attendees: z.array(z.unknown()).length(0), isOrganizer: z.literal(true),
  organizer: z.object({ emailAddress: z.object({ address: z.string().min(1) }) }),
  isDraft: z.literal(false), isOnlineMeeting: z.literal(false),
  onlineMeeting: z.null(), onlineMeetingUrl: z.null(),
  cancelledOccurrences: z.array(z.unknown()).length(0), exceptionOccurrences: z.array(z.unknown()).length(0),
  recurrence: z.unknown(),
});

function recurrenceSemantics(value: GraphRecurrence): GraphRecurrence {
  return { ...value, pattern: { ...value.pattern, ...(value.pattern.daysOfWeek ? { daysOfWeek: [...value.pattern.daysOfWeek].sort() } : {}) } };
}

/** Validates only an unchanged personal master found on the exact destination.
 * Its native ETag is retained as opaque metadata, never a family CAS proof. */
export function graphSeriesCreateEvidence(native: unknown, saved: Event, identity: EventCreateIdentity, externalID: string): CreatedEventEvidence {
  const expected = graphSeriesCreateBody(saved, identity);
  try {
    const projected = graphMasterForSavedZone(native, saved);
    const item = nativeSeries.parse(projected);
    if (item.id !== externalID || item.transactionId !== expected.transactionId || item.subject !== expected.subject ||
        item.body.contentType.toLowerCase() !== "text" || item.body.content !== expected.body.content || item.location.displayName !== expected.location.displayName)
      throw new Error("Changed master");
    const time = graphMasterTimeFromUtc(projected);
    const recurrence = recurrenceFromGraph({ ...saved, ...time }, item.recurrence);
    if (!isDeepStrictEqual(graphTimeForEvent(time), graphTimeForEvent(saved)) ||
        !isDeepStrictEqual(recurrenceSemantics(graphRecurrenceForEvent({ ...saved, ...time, recurrence })), recurrenceSemantics(expected.recurrence))) throw new Error("Changed recurrence");
    return {
      ref: { externalEventId: item.id, etag: item["@odata.etag"] ?? null, icalUid: item.iCalUId },
      event: { ...time, timeModel: time.timeModel ?? undefined, externalId: item.id, etag: item["@odata.etag"] ?? null, icalUid: item.iCalUId,
        status: "active", title: item.subject, description: item.body.content || null, location: item.location.displayName || null,
        organizer: item.organizer.emailAddress.address, recurrence, url: null, creationOperationID: expected.transactionId,
        providerState: microsoftEventState(native) },
    };
  } catch { throw new ProviderEventWriteError("provider-conflict"); }
}

const fields = "id,transactionId,iCalUId,type,isAllDay,isCancelled,seriesMasterId,originalStart,start,end,originalStartTimeZone,originalEndTimeZone,recurrence,subject,body,location,attendees,isOrganizer,organizer,isDraft,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,cancelledOccurrences,exceptionOccurrences,isReminderOn,reminderMinutesBeforeStart,showAs,sensitivity,responseStatus";
const pageSchema = z.object({ value: z.array(z.object({ id: opaqueID, transactionId: z.string().nullish() })), "@odata.nextLink": opaqueID.optional() });

/** Read-only recovery candidate. Absence is NOT permission to repeat POST.
 * A complete scoped listing must identify exactly one transaction, followed by
 * a fresh exact-master GET with explicit exception/cancellation expansion. */
async function findGraphCreatedSeriesNative(accessToken: string, calendarID: string, saved: Event, identity: EventCreateIdentity): Promise<{ native: unknown; id: string } | null> {
  saved = structuredClone(saved);
  identity = { ...identity };
  const expected = graphSeriesCreateBody(saved, identity);
  if (!opaqueID.safeParse(calendarID).success) throw new ProviderEventWriteError("provider-write-failed");
  const base = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarID)}/events`);
  const read = async (url: URL) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"', "Cache-Control": "no-cache" }, redirect: "error", signal: identity.signal });
    assertCompleteEventReadResponse(response);
    return response.json();
  };
  let next: string | undefined = `${base}?$select=id,transactionId&$top=100`;
  const visited = new Set<string>();
  let found: string | undefined;
  while (next !== undefined) {
    const url = new URL(next);
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash || visited.has(url.href) || visited.size >= 1000)
      throw new ProviderEventWriteError("provider-write-failed");
    visited.add(url.href);
    const parsed = pageSchema.safeParse(await read(url));
    if (!parsed.success) throw new ProviderEventWriteError("provider-write-failed");
    for (const item of parsed.data.value) if (item.transactionId === expected.transactionId) {
      if (found) throw new ProviderEventWriteError("provider-conflict");
      found = item.id;
    }
    next = parsed.data["@odata.nextLink"];
  }
  if (!found) return null;
  const url = new URL(`${base}/${encodeURIComponent(found)}`);
  url.searchParams.set("$select", fields);
  url.searchParams.set("$expand", "exceptionOccurrences");
  return { native: await read(url), id: found };
}

export async function findGraphCreatedSeries(accessToken: string, calendarID: string, saved: Event, identity: EventCreateIdentity): Promise<CreatedEventEvidence | null> {
  saved = structuredClone(saved);
  identity = { ...identity };
  const found = await findGraphCreatedSeriesNative(accessToken, calendarID, saved, identity);
  return found ? graphSeriesCreateEvidence(found.native, saved, identity, found.id) : null;
}
/** Explicit local adoption candidate: the saved create intent remains immutable.
 * A different but supported personal master may be displayed for confirmation. */
export async function findGraphCreatedSeriesAdoption(accessToken: string, calendarID: string, saved: Event, identity: EventCreateIdentity) {
  saved = structuredClone(saved);
  identity = { ...identity };
  const found = await findGraphCreatedSeriesNative(accessToken, calendarID, saved, identity);
  if (!found) return null;
  try {
    const item = nativeSeries.parse(found.native), time = graphMasterTimeFromUtc(found.native);
    const recurrence = recurrenceFromGraph({ ...saved, ...time }, item.recurrence);
    const candidate: Event = { ...saved, ...time, recurrence, title: item.subject, description: item.body.content || null, location: item.location.displayName || null };
    graphSeriesFootprint(candidate);
    const evidence = graphSeriesCreateEvidence(found.native, candidate, identity, found.id);
    return { candidate, evidence };
  } catch { throw new ProviderEventWriteError("provider-conflict"); }
}
