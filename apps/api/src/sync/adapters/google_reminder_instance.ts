import { reserveProviderMutation, providerDeferral } from "../provider_budget";
import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { unambiguousCivilToInstant } from "@musubi/calendar";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { config } from "@musubi/config";
import { EventTimeModelSchema, EventWriteError, GoogleReminderWriteSchema, OccurrenceStartSchema, type GoogleReminderWrite } from "@musubi/types";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { assertProviderEventMutationResponse, ProviderEventWriteError, requireEventEtag } from "../event_write";
import { googleReminderEventEvidence } from "./google";
import { GoogleRsvpOccurrenceSchema, type GoogleRsvpOccurrence } from "./google_rsvp";
import { googleEventState } from "./provider_event_state";

const endpoint = z.union([
  z.object({ date: z.iso.date(), dateTime: z.never().optional() }).passthrough(),
  z.object({ dateTime: z.iso.datetime({ offset: true }), date: z.never().optional() }).passthrough(),
]);
const native = z.object({
  id: z.string().min(1), etag: z.string(), status: z.enum(["confirmed", "tentative"]),
  recurrence: z.never().optional(), recurringEventId: z.string().min(1), originalStartTime: endpoint,
  start: endpoint, end: endpoint,
  attendeesOmitted: z.literal(false).optional(), locked: z.literal(false).optional(),
  privateCopy: z.literal(false).optional(), eventType: z.literal("default").optional(),
  reminders: z.object({ useDefault: z.boolean(), overrides: z.array(z.object({ method: z.enum(["popup", "email"]), minutes: z.number().int().min(0).max(40320) }).strict()).max(5).optional() }).strict(),
}).passthrough();
const unsupported = () => new EventWriteError("event-write", "unsupported");
export type GoogleReminderInstanceEvidence = {
  baseline: z.infer<typeof native>;
  occurrence: GoogleRsvpOccurrence;
  reminders: GoogleReminderWrite;
};

/** Native binding and time proof only. The caller must establish the accepted
 * local parent/mapping/lease independently; a parent ETag is never a family CAS. */
export function googleReminderInstanceEvidence(input: unknown, expected: { eventID: string; etag: string; occurrence: GoogleRsvpOccurrence }, reminders: GoogleReminderWrite): GoogleReminderInstanceEvidence {
  const parsed = native.safeParse(input), binding = GoogleRsvpOccurrenceSchema.safeParse(expected.occurrence);
  if (!parsed.success || !binding.success) throw unsupported();
  const baseline = structuredClone(parsed.data), original = baseline.originalStartTime;
  if (baseline.id !== expected.eventID || requireEventEtag(baseline.etag) !== requireEventEtag(expected.etag)) throw new ProviderEventWriteError("provider-conflict");
  if (baseline.id === binding.data.externalSeriesID || baseline.recurringEventId !== binding.data.externalSeriesID ||
      (typeof original.dateTime === "string" && /\.\d{4}/.test(original.dateTime))) throw unsupported();
  const identity = OccurrenceStartSchema.parse(typeof original.date === "string" ? { kind: "date", value: original.date } : { kind: "instant", value: new Date(String(original.dateTime)).toISOString() });
  if (!isDeepStrictEqual(identity, binding.data.originalStart)) throw unsupported();
  if ([baseline.start, baseline.end].some(value => typeof value.dateTime === "string" && /\.\d{4}/.test(value.dateTime))) throw unsupported();
  const { recurringEventId: _series, originalStartTime: _original, ...content } = baseline;
  const event = googleReminderEventEvidence(content), model = EventTimeModelSchema.safeParse(event.timeModel);
  if (!model.success || !["zoned", "all-day"].includes(model.data.kind) || event.isAllDay !== (identity.kind === "date")) throw unsupported();
  if (model.data.kind === "zoned") {
    try {
      if (unambiguousCivilToInstant(model.data.startLocal, model.data.timeZone).getTime() !== event.start.getTime() ||
          unambiguousCivilToInstant(model.data.endLocal, model.data.timeZone).getTime() !== event.end.getTime()) throw unsupported();
    } catch (error) { if (providerDeferral(error)) throw error; throw unsupported(); }
  }
  return { baseline, occurrence: structuredClone(binding.data), reminders: GoogleReminderWriteSchema.parse(reminders) };
}

function sameReminders(expected: GoogleReminderWrite, actual: z.infer<typeof native>["reminders"]) {
  if (expected.useDefault !== actual.useDefault) return false;
  if (expected.useDefault) return true;
  const ordered = (items: { method: string; minutes: number }[]) => items.map(item => [item.method, item.minutes]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return isDeepStrictEqual(ordered(expected.overrides), ordered(actual.overrides ?? []));
}
export function googleReminderInstanceProjection(evidence: GoogleReminderInstanceEvidence) {
  const verified = googleReminderInstanceEvidence(evidence.baseline, { eventID: evidence.baseline.id, etag: evidence.baseline.etag, occurrence: evidence.occurrence }, evidence.reminders);
  const { recurringEventId: _series, originalStartTime: _original, ...content } = verified.baseline;
  return { ...googleReminderEventEvidence(content), externalSeriesID: verified.occurrence.externalSeriesID, originalStart: verified.occurrence.originalStart };
}
export function confirmGoogleReminderInstance(input: unknown, evidence: GoogleReminderInstanceEvidence) {
  const parsed = native.safeParse(input);
  if (!parsed.success) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
  const strip = (value: z.infer<typeof native>) => { const { etag: _etag, updated: _updated, reminders: _reminders, ...rest } = value; return rest; };
  if (!isDeepStrictEqual(strip(parsed.data), strip(evidence.baseline)) || !sameReminders(evidence.reminders, parsed.data.reminders)) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
  try { requireEventEtag(parsed.data.etag); }
  catch (error) { if (providerDeferral(error)) throw error; throw new ProviderEventWriteError("provider-version-unavailable", "unconfirmed"); }
  const verified = googleReminderInstanceEvidence(parsed.data, { eventID: evidence.baseline.id, etag: parsed.data.etag, occurrence: evidence.occurrence }, evidence.reminders);
  return { ref: { externalEventId: verified.baseline.id, etag: requireEventEtag(verified.baseline.etag) }, state: googleEventState(verified.baseline), event: googleReminderInstanceProjection(verified) };
}

const GCAL = "https://www.googleapis.com/calendar/v3";
const primary = z.object({ id: z.email(), primary: z.literal(true), accessRole: z.literal("owner") });
/** Private default-off transport. Token injection must verify this account's
 * OAuth write grant. Public admission, durable binding and ACK are separate. */
export function googleReminderInstanceTransport(getAuthorizedToken: (user: string, account: string) => Promise<string>) {
  async function context(user: string, account: string, calendar: string, eventID: string, signal?: AbortSignal) {
    if (!config.api.providerReminderEditsEnabled) throw unsupported();
    const token = await getAuthorizedToken(user, account);
    const headers = { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" };
    const response = await fetch(`${GCAL}/users/me/calendarList/primary`, { headers, redirect: "error", signal });
    assertCompleteEventReadResponse(response);
    const parsed = primary.safeParse(await response.json());
    if (!parsed.success || parsed.data.id.toLowerCase() !== calendar.toLowerCase()) throw unsupported();
    const url = `${GCAL}/calendars/${encodeURIComponent(parsed.data.id)}/events/${encodeURIComponent(eventID)}`;
    const read = async () => { const response = await fetch(url, { headers, redirect: "error", signal }); assertCompleteEventReadResponse(response); return response.json(); };
    return { headers, url, read };
  }
  return {
    async read(user: string, account: string, calendar: string, expected: { eventID: string; etag: string; occurrence: GoogleRsvpOccurrence }, reminders: GoogleReminderWrite, signal?: AbortSignal) {
      const frozen = structuredClone(expected), desired = GoogleReminderWriteSchema.parse(reminders);
      const ctx = await context(user, account, calendar, frozen.eventID, signal);
      return googleReminderInstanceEvidence(await ctx.read(), frozen, desired);
    },
    async readResolution(user: string, account: string, calendar: string, eventID: string, occurrence: GoogleRsvpOccurrence, reminders: GoogleReminderWrite, signal?: AbortSignal) {
      const frozen = structuredClone(occurrence), desired = GoogleReminderWriteSchema.parse(reminders);
      const ctx = await context(user, account, calendar, eventID, signal);
      const current = await ctx.read();
      return googleReminderInstanceEvidence(current, { eventID, etag: requireEventEtag(current?.etag), occurrence: frozen }, desired);
    },
    async write(user: string, account: string, calendar: string, input: GoogleReminderInstanceEvidence, beforeWrite: () => Promise<void>, signal?: AbortSignal) {
      const intent = googleReminderInstanceEvidence(input.baseline, { eventID: input.baseline.id, etag: input.baseline.etag, occurrence: input.occurrence }, input.reminders);
      const ctx = await context(user, account, calendar, intent.baseline.id, signal);
      const current = await ctx.read();
      try { return { ...confirmGoogleReminderInstance(current, intent), recovered: true }; } catch (error) { if (providerDeferral(error)) throw error; /* Only the exact baseline permits one PATCH. */ }
      // Google can materialize instance defaults as explicit overrides. Only
      // exact read-only confirmation is safe for historical default intents.
      if (intent.reminders.useDefault) throw unsupported();
      if (!isDeepStrictEqual(current, intent.baseline)) throw new ProviderEventWriteError("provider-conflict");
      await reserveProviderMutation({ url: `${ctx.url}?sendUpdates=none`, method: "PATCH" }, beforeWrite); signal?.throwIfAborted();
      let response: Response;
      try { response = await fetch(`${ctx.url}?sendUpdates=none`, { method: "PATCH", headers: { ...ctx.headers, "Content-Type": "application/json", "If-Match": intent.baseline.etag }, body: JSON.stringify({ reminders: intent.reminders }), redirect: "error", signal }); }
      catch (error) { if (providerDeferral(error)) throw error; throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); }
      assertProviderEventMutationResponse(response);
      try { await response.body?.cancel(); } catch (error) { if (providerDeferral(error)) throw error; /* Full GET is authoritative. */ }
      try { return { ...confirmGoogleReminderInstance(await ctx.read(), intent), recovered: false }; }
      catch (error) { if (providerDeferral(error)) throw error;
        if (error instanceof ProviderEventWriteError && error.outcome === "unconfirmed") throw error;
        throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
      }
    },
  };
}
