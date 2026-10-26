import { reserveProviderMutation, providerDeferral } from "../provider_budget";
import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { resolveEventTimeEdit, unambiguousCivilToInstant, outlookEndpointZonesMatch, outlookTimeZoneMatches } from "@musubi/calendar";
import { microsoftEventVersion } from "./microsoft_event_content";
import { graphTimeForEvent } from "./microsoft_time";
import { graphRsvpTime } from "./microsoft_rsvp";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { config } from "@musubi/config";
import { EventWriteError, MicrosoftOrganizerRequestSchema, OrganizerDispatchSchema, type MicrosoftOrganizerRequest, type ProviderOrganizerIntent } from "@musubi/types";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { ProviderEventWriteError } from "../event_write";
import { microsoftEventState } from "./provider_event_state";
import { verifiedGraphIdentity } from "./microsoft_identity";
const root = "https://graph.microsoft.com/v1.0";
const id = z.string().min(1).refine(value => value.trim() === value && value !== "." && value !== "..");
function fail(): never { throw new ProviderEventWriteError("provider-conflict"); }
export function microsoftOrganizerBody(request: MicrosoftOrganizerRequest, self: string) {
  request = MicrosoftOrganizerRequestSchema.parse(request);
  if (request.action !== "create") fail();
  if (request.guests.some(guest => guest.email.toLowerCase() === self.toLowerCase())) fail();
  const time = request.time;
  if (time.kind === "floating") fail();
  return {
    transactionId: request.operationID,
    subject: request.content.title,
    body: { contentType: "text", content: request.content.description ?? "" },
    location: { displayName: request.content.location ?? "" },
    isAllDay: time.kind === "all-day",
    start: { dateTime: time.kind === "all-day" ? `${time.startDate}T00:00:00` : time.startLocal, timeZone: "UTC" },
    end: { dateTime: time.kind === "all-day" ? new Date(Date.parse(time.endDate + "T00:00:00Z") + 86_400_000).toISOString().slice(0, -1) : time.endLocal, timeZone: "UTC" },
    attendees: request.guests.map(guest => ({ emailAddress: { address: guest.email }, type: guest.optional ? "optional" : "required" })),
    isOnlineMeeting: false,
  };
}
const endpoint = z.object({ dateTime: z.string(), timeZone: z.literal("UTC") });
const nativeSchema = z.object({
  id, iCalUId: id, "@odata.etag": id, transactionId: z.uuid(), type: z.literal("singleInstance"),
  isCancelled: z.literal(false), isDraft: z.literal(false), isOrganizer: z.literal(true),
  recurrence: z.null(), seriesMasterId: z.null().optional(),
  subject: z.string(), body: z.object({ contentType: z.string(), content: z.string() }), location: z.object({ displayName: z.string() }),
  start: endpoint, end: endpoint, isAllDay: z.boolean(),
  originalStartTimeZone: z.literal("UTC"), originalEndTimeZone: z.literal("UTC"),
  "attendees@odata.count": z.number().int().nonnegative().optional(),
  organizer: z.object({ emailAddress: z.object({ address: z.email() }) }),
  attendees: z.array(z.object({ emailAddress: z.object({ address: z.email() }), type: z.enum(["required", "optional"]), status: z.object({ response: z.enum(["none", "notResponded", "accepted", "tentativelyAccepted", "declined"]), time: z.iso.datetime().optional() }).optional() })).min(1).max(100),
  isOnlineMeeting: z.literal(false), onlineMeeting: z.null(), onlineMeetingUrl: z.null(), hasAttachments: z.literal(false),
  "@removed": z.never().optional(), "attendees@odata.nextLink": z.never().optional(),
});
function instant(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value) || /[1-9]/.test((value.split(".")[1] ?? "").slice(3))) fail();
  const timestamp = Date.parse(value + "Z"); if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) fail(); return timestamp;
}
export function microsoftOrganizerEvidence(raw: unknown, request: MicrosoftOrganizerRequest, self: string) {
  const native = nativeSchema.parse(raw), desired = microsoftOrganizerBody(request, self);
  const guests = (values: { emailAddress: { address: string }; type: string }[]) => values.map(value => `${value.emailAddress.address.toLowerCase()}:${value.type}`).sort();
  if (native.transactionId !== desired.transactionId || native.organizer.emailAddress.address.toLowerCase() !== self.toLowerCase()
    || native.subject !== desired.subject || native.body.contentType.toLowerCase() !== "text" || native.body.content !== desired.body.content
    || native.location.displayName !== desired.location.displayName || native.isAllDay !== desired.isAllDay
    || instant(native.start.dateTime) !== instant(desired.start.dateTime) || instant(native.end.dateTime) !== instant(desired.end.dateTime)
    || (native["attendees@odata.count"] !== undefined && native["attendees@odata.count"] !== native.attendees.length)
    || !isDeepStrictEqual(guests(native.attendees), guests(desired.attendees))) fail();
  return { native: { id: native.id, etag: native["@odata.etag"], iCalUID: native.iCalUId }, state: microsoftEventState(raw as Record<string, unknown>) };
}
/** Cancellation observes the complete organizer copy, including guests. It
 * never rewrites its time, invitation list, attachments or meeting content. */
export function microsoftCancellationEvidence(raw: unknown, self: string, masterID?: string, allowPersonal = false) {
  const schema = masterID ? nativeSchema.extend({
    type: z.enum(["seriesMaster", "occurrence", "exception"]),
    recurrence: z.record(z.string(), z.unknown()).nullable(), seriesMasterId: z.string().nullish(),
  }) : nativeSchema;
  const item = schema.extend({
    attendees: z.array(nativeSchema.shape.attendees.element).min(allowPersonal ? 0 : 1).max(100),
    transactionId: z.string().nullish(),
    originalStartTimeZone: z.string(), originalEndTimeZone: z.string(),
    hasAttachments: z.boolean(),
  }).parse(raw);
  if (masterID && (item.id === masterID
    ? item.type !== "seriesMaster" || !item.recurrence || item.seriesMasterId != null
    : !["occurrence", "exception"].includes(item.type) || item.seriesMasterId !== masterID || item.recurrence !== null)) fail();
  const etag = microsoftEventVersion(item["@odata.etag"]);
  if (!etag || item.organizer.emailAddress.address.toLowerCase() !== self.toLowerCase()
    || item["attendees@odata.count"] !== undefined && item["attendees@odata.count"] !== item.attendees.length
    || new Set(item.attendees.map(value => value.emailAddress.address.toLowerCase())).size !== item.attendees.length
    || instant(item.end.dateTime) <= instant(item.start.dateTime)) fail();
  return { ...item, etag };
}

/** Content writes retain the full native baseline, including fields not shown
 * in Musubi. Only explicitly changed fields are sent to Graph. */
export function microsoftMeetingContentEvidence(raw: unknown, self: string, masterID?: string, allowMaster = false) {
  try {
    const proof = microsoftCancellationEvidence(raw, self, masterID, !!masterID);
    const item = z.record(z.string(), z.unknown()).parse(structuredClone(raw));
    if (proof.hasAttachments || proof.body.contentType.toLowerCase() !== "text" || item["@odata.nextLink"] || (!masterID && item.originalStart != null)
      || proof.attendees.some(guest => guest.emailAddress.address.toLowerCase() === self.toLowerCase())) fail();
    // The occurrence identity was checked above; reuse the UTC endpoint validator.
    graphRsvpTime(masterID ? { ...item, type: "singleInstance" } : item);
    if (masterID && (proof.id === masterID ? !allowMaster : !z.iso.datetime().safeParse(item.originalStart).success)) fail();
    return { ...proof, ...item, etag: proof.etag } as typeof proof & Record<string, unknown>;
  } catch { return fail(); }
}
export function microsoftMeetingContentProjection(raw: unknown, self: string) {
  const item = microsoftMeetingContentEvidence(raw, self);
  return { title: item.subject, description: item.body.content.trim() || null, location: item.location.displayName.trim() || null,
    recurrence: null, ...graphRsvpTime(item) };
}
export function microsoftMeetingContentBody(request: MicrosoftOrganizerRequest, native?: Record<string, unknown>) {
  request = MicrosoftOrganizerRequestSchema.parse(request);
  if (request.action !== "update") fail();
  const payload: Record<string, unknown> = {};
  if (request.patch.time) {
    if (!request.scope) fail();
    const time = graphTimeForEvent(resolveEventTimeEdit(request.patch.time));
    // Preserve all-day mode and every attendee field; only write endpoints.
    if (native && request.patch.time.kind === "zoned") {
      if (!outlookEndpointZonesMatch(native, request.patch.time.timeZone)) fail();
      time.start.timeZone = native.originalStartTimeZone as string;
      time.end.timeZone = native.originalEndTimeZone as string;
    }
    payload.start = time.start;
    payload.end = time.end;
  }
  if (request.patch.title !== undefined) payload.subject = request.patch.title;
  if (request.patch.description !== undefined) payload.body = { contentType: "text", content: request.patch.description ?? "" };
  if (request.patch.location !== undefined) payload.location = { displayName: request.patch.location ?? "" };
  return payload;
}
export function matchesMeetingContent(baseline: Record<string, unknown>, patch: Record<string, unknown>, actual: unknown, self: string, masterID?: string, allowMaster = false, seriesTimeZone?: string) {
  try {
    const next = microsoftMeetingContentEvidence(actual, self, masterID, allowMaster);
    const expected = { ...baseline, ...patch };
    const endpointInstant = (value: { dateTime: string; timeZone: string }) => value.timeZone === "UTC"
      ? instant(value.dateTime) : unambiguousCivilToInstant(value.dateTime, seriesTimeZone && outlookTimeZoneMatches(value.timeZone, seriesTimeZone) ? seriesTimeZone : value.timeZone).getTime();
    const changedTime = ("start" in patch || "end" in patch) && ["start", "end"].some(key => {
      const desired = expected[key] as { dateTime: string; timeZone: string };
      const before = baseline[key] as { dateTime: string; timeZone: string };
      return endpointInstant(desired) !== endpointInstant(before);
    });
    if (masterID && changedTime) {
      expected.attendees = (baseline.attendees as Record<string, unknown>[]).map((guest, index) => {
        const status = next.attendees[index]?.status;
        // A full meeting update can reset RSVP. Accept only the observed empty
        // response sentinel; never accept another response, altered guest or
        // role, or a new response timestamp as a side effect of our write.
        return status && ["none", "notResponded"].includes(status.response) && status.time === "4501-01-01T00:00:00Z"
          ? { ...guest, status: { response: status.response, time: status.time } } : guest;
      });
    }
    if ("location" in patch && next.locations != null) {
      const locations = z.array(z.object({ displayName: z.string() })).max(1).parse(next.locations);
      const name = (patch.location as { displayName: string }).displayName;
      if (locations.some(location => location.displayName !== name) || name && locations.length !== 1) return false;
    }
    const normalize = (input: Record<string, unknown>) => {
      const item = structuredClone(input);
      // A native occurrence becomes an exception on its first content edit.
      if (masterID && baseline.type === "occurrence" && next.type === "exception") {
        item.type = "exception";
        // Graph materializes a new exception object for this same ID/slot.
        delete item.createdDateTime;
      }
      for (const key of ["@odata.etag", "etag", "changeKey", "lastModifiedDateTime", "bodyPreview"]) delete item[key];
      // Graph updates locations together with location. The requested simple
      // location replaces the old collection; other changes retain it exactly.
      if ("location" in patch) {
        delete item.locations;
        item.location = { displayName: (item.location as { displayName: string }).displayName };
      }
      if ("start" in patch || "end" in patch) {
        // The requested civil endpoints use the verified series zone; native
        // evidence above remains a strict UTC projection (including precision).
        for (const key of ["start", "end"]) {
          const endpoint = item[key] as { dateTime: string; timeZone: string };
          item[key] = new Date(endpointInstant(endpoint)).toISOString();
        }
      }
      const body = item.body as { contentType: string; content: string };
      item.body = { ...body, contentType: body.contentType.toLowerCase(), content: body.content.trim() };
      return item;
    };
    return isDeepStrictEqual(normalize(expected), normalize(next));
  } catch { return false; }
}
export function microsoftOrganizerTransport(token: (user: string, account: string) => Promise<string>) {
  return async (userID: string, accountID: string, calendarID: string, signal?: AbortSignal) => {
    if (!config.api.providerOrganizerEditsEnabled) throw new EventWriteError("organizer", "unsupported");
    id.parse(accountID); id.parse(calendarID);
    const headers = { Authorization: `Bearer ${await token(userID, accountID)}`, Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"', "Cache-Control": "no-cache" };
    const get = async (url: string) => { const response = await fetch(url, { headers, redirect: "error", signal }); assertCompleteEventReadResponse(response); return response.json(); };
    const identity = await verifiedGraphIdentity(get, accountID, calendarID);
    const email = identity.selfAddress;
    const base = `${root}/me/calendars/${encodeURIComponent(calendarID)}/events`;
    async function find(request: MicrosoftOrganizerRequest) {
      let next: string | undefined = `${base}?$top=100`;
      const visited = new Set<string>(); let found: unknown;
      while (next) {
        const url = new URL(next);
        if (url.origin !== new URL(base).origin || url.pathname !== new URL(base).pathname || url.username || url.password || url.hash || visited.has(url.href) || visited.size >= 1000) fail();
        visited.add(url.href);
        const page = z.object({ value: z.array(z.record(z.string(), z.unknown())), "@odata.nextLink": z.string().min(1).refine(value => value.trim() === value).optional() }).parse(await get(url.href));
        for (const item of page.value) if (item.transactionId === request.operationID) { if (found) fail(); found = item; }
        next = page["@odata.nextLink"];
      }
      return found ? microsoftOrganizerEvidence(found, request, email) : null;
    }
    async function read(eventID: string, content = false) {
      const response = await fetch(`${base}/${encodeURIComponent(id.parse(eventID))}`, { headers, redirect: "error", signal });
      if (response.status === 404 && !response.headers.has("content-range")) {
        z.object({ error: z.object({ code: z.string().min(1) }) }).parse(await response.json());
        return null;
      }
      assertCompleteEventReadResponse(response);
      const raw = await response.json();
      const native = content ? microsoftMeetingContentEvidence(raw, email) : microsoftCancellationEvidence(raw, email);
      if (native.id !== eventID) fail();
      return native;
    }
    return { email, identity, read, deliver: async (intent: ProviderOrganizerIntent, beforeDispatch: () => Promise<void>, accepted: () => Promise<void>) => {
      const saved = structuredClone(intent), request = MicrosoftOrganizerRequestSchema.parse(saved.request);
      if (!isDeepStrictEqual(saved.graphIdentity, identity)) fail();
      if (request.action === "update") {
        const baseline = microsoftMeetingContentEvidence(saved.baseline, email);
        const patch = microsoftMeetingContentBody(request);
        if (!saved.mappingID || !isDeepStrictEqual(saved.desired, patch) || saved.baseline?.etag !== baseline.etag) fail();
        if (saved.dispatch && OrganizerDispatchSchema.parse(saved.dispatch).kind !== "microsoft-organizer-dispatch") fail();
        const observed = (current: Awaited<ReturnType<typeof read>>) => {
          if (!current || !matchesMeetingContent(baseline, patch, current, email)) return { kind: "unconfirmed" as const };
          return { kind: "observed" as const, native: { id: current.id, etag: current.etag, iCalUID: current.iCalUId }, state: microsoftEventState(current) };
        };
        const current = saved.dispatch ? await read(baseline.id, true).catch(error => { if (providerDeferral(error)) throw error; return null; }) : await read(baseline.id, true);
        // A possible notification dispatch is never repeated, even if Graph
        // still shows the old content. Acceptance and readback are independent.
        if (saved.dispatch) return saved.dispatch.acceptedAt ? observed(current) : { kind: "unconfirmed" as const };
        if (!current || !isDeepStrictEqual(current, baseline)) fail();
        if (matchesMeetingContent(baseline, patch, current, email)) return observed(current);
        await reserveProviderMutation({ url: `${base}/${encodeURIComponent(baseline.id)}`, method: "PATCH" }, beforeDispatch);
        let acknowledged = false;
        try {
          const response = await fetch(`${base}/${encodeURIComponent(baseline.id)}`, {
            method: "PATCH", headers: { ...headers, "Content-Type": "application/json", "If-Match": baseline.etag },
            body: JSON.stringify(patch), redirect: "error", signal,
          });
          if (response.status === 412) return { kind: "rejected" as const };
          if (response.status === 200) {
            const updated = microsoftMeetingContentEvidence(await response.json(), email);
            if (updated.id === baseline.id && updated.iCalUId === baseline.iCalUId) {
              await accepted(); acknowledged = true;
            }
          }
        } catch (error) { if (providerDeferral(error)) throw error; if (signal?.aborted) throw error; }
        const remaining = await read(baseline.id, true).catch(error => { if (providerDeferral(error)) throw error; return null; });
        return acknowledged ? observed(remaining) : { kind: "unconfirmed" as const };
      }
      if (request.action === "delete") {
        const baseline = microsoftCancellationEvidence(saved.baseline, email);
        if (!saved.mappingID || saved.desired !== null || saved.baseline?.etag !== baseline.etag) fail();
        if (saved.dispatch && OrganizerDispatchSchema.parse(saved.dispatch).kind !== "microsoft-organizer-dispatch") fail();
        const current = await read(baseline.id);
        // A lost response is never permission to send another cancellation.
        // Absence without the durable HTTP acceptance is not proof of notices.
        if (saved.dispatch) return { kind: saved.dispatch.acceptedAt && !current ? "deleted" as const : "unconfirmed" as const };
        if (!current || current.etag !== baseline.etag || !isDeepStrictEqual(current, baseline)) fail();
        await reserveProviderMutation({ url: `${base}/${encodeURIComponent(baseline.id)}/cancel`, method: "POST" }, beforeDispatch);
        let acknowledged = false;
        try {
          const response = await fetch(`${base}/${encodeURIComponent(baseline.id)}/cancel`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json", "If-Match": baseline.etag },
            body: "{}", redirect: "error", signal,
          });
          if (response.status === 202) { await accepted(); acknowledged = true; }
        } catch (error) { if (providerDeferral(error)) throw error; if (signal?.aborted) throw error; }
        const remaining = await read(baseline.id);
        return { kind: acknowledged && !remaining ? "deleted" as const : "unconfirmed" as const };
      }
      if (saved.baseline || saved.mappingID || !isDeepStrictEqual(saved.desired, microsoftOrganizerBody(request, email))) fail();
      if (saved.dispatch && OrganizerDispatchSchema.parse(saved.dispatch).kind !== "microsoft-organizer-dispatch") fail();
      if (saved.dispatch) { const observed = await find(request); return observed ? { kind: "observed" as const, ...observed } : { kind: "unconfirmed" as const }; }
      const existing = await find(request);
      if (existing) return { kind: "observed" as const, ...existing };
      // Persist possible dispatch before POST. No later attempt may send again.
      await reserveProviderMutation({ url: base, method: "POST" }, beforeDispatch);
      let returnedID: string | undefined;
      try {
        const response = await fetch(base, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(saved.desired), redirect: "error", signal });
        if (response.status === 201) { returnedID = id.parse((await response.json()).id); await accepted(); }
      } catch (error) { if (providerDeferral(error)) throw error; if (signal?.aborted) throw error; }
      const observed = await find(request);
      if (observed && returnedID && observed.native.id !== returnedID) fail();
      return observed ? { kind: "observed" as const, ...observed } : { kind: "unconfirmed" as const };
    } };
  };
}
