import { reserveProviderMutation, providerDeferral } from "../provider_budget";
import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { config } from "@musubi/config";
import { copyCompatibilityData } from "@musubi/sync-runtime";
import { EventWriteError } from "@musubi/types";
import type { CalendarAdapter, ExternalEventRef } from "../adapter";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { assertProviderEventMutationResponse, ProviderEventWriteError } from "../event_write";
import { googleRsvpEvidence, confirmGoogleRsvp } from "./google_rsvp";

const GCAL = "https://www.googleapis.com/calendar/v3";
const primaryCalendar = z.object({ id: z.email(), primary: z.literal(true), accessRole: z.literal("owner") });
/** The injected token reader must refresh credentials and verify OAuth write
 * scope for this exact user/account. Production wiring does both; no caller
 * supplied URL or email can substitute for the provider's primary identity. */
export function googleRsvpMethods(getAuthorizedToken: (user: string, account: string) => Promise<string>): Pick<CalendarAdapter, "readRsvp" | "readRsvpResolution" | "writeRsvp"> {
  async function context(user: string, account: string, calendar: string, ref: ExternalEventRef, signal?: AbortSignal) {
    if (!config.api.providerRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported");
    const token = await getAuthorizedToken(user, account);
    const headers = { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" };
    const response = await fetch(`${GCAL}/users/me/calendarList/primary`, { headers, redirect: "error", signal });
    assertCompleteEventReadResponse(response);
    const parsed = primaryCalendar.safeParse(await response.json());
    if (!parsed.success || calendar.toLowerCase() !== parsed.data.id.toLowerCase())
      throw new EventWriteError("event-write", "unsupported");
    const url = `${GCAL}/calendars/${encodeURIComponent(parsed.data.id)}/events/${encodeURIComponent(ref.externalEventId)}`;
    async function read() {
      const result = await fetch(url, { headers, redirect: "error", signal });
      assertCompleteEventReadResponse(result);
      return result.json();
    }
    return { headers, url, read, email: parsed.data.id };
  }
  return {
    async readRsvp(user, account, calendar, ref, response, signal, occurrence) {
      const ctx = await context(user, account, calendar, ref, signal);
      return googleRsvpEvidence(await ctx.read(), { eventId: ref.externalEventId, etag: ref.etag ?? "", authenticatedCopyEmail: ctx.email, occurrence }, response);
    },
    async readRsvpResolution(user, account, calendar, ref, response, signal, occurrence) {
      const ctx = await context(user, account, calendar, ref, signal);
      const current = await ctx.read();
      // Read the current version for an explicit preview; enqueue readRsvp keeps
      // enforcing the originally accepted ETag. No write occurs here.
      return googleRsvpEvidence(current, { eventId: ref.externalEventId, etag: current?.etag ?? "", authenticatedCopyEmail: ctx.email, occurrence }, response);
    },
    async writeRsvp(user, account, calendar, evidence, policy, signal, beforeWrite) {
      // Snapshot the entire ingress before reading even its identity. Existing
      // parsers validate owned data; they must never evaluate caller accessors.
      // The shared clone retains Dates/undefined and adds no admission limits.
      const ownedEvidence = copyCompatibilityData(evidence);
      // Policy is private host evidence. Missing permission is read-only; never
      // evaluate getters or inherit dispatch permission from a prototype.
      const descriptors = Object.getOwnPropertyDescriptors(policy);
      if (![Object.prototype, null].includes(Object.getPrototypeOf(policy)) || Reflect.ownKeys(policy).some(key => typeof key !== "string" || !["sendUpdates", "observeOnly"].includes(key)) || Object.values(descriptors).some(field => !("value" in field) || !field.enumerable) || descriptors.sendUpdates?.value !== "all" || (descriptors.observeOnly && typeof descriptors.observeOnly.value !== "boolean")) throw new EventWriteError("event-write", "unsupported");
      const observeOnly = descriptors.observeOnly?.value !== false;
      const ref = { externalEventId: ownedEvidence.baseline.id, etag: ownedEvidence.baseline.etag };
      // Own the accepted version, response and original slot before token refresh
      // or HTTP yields to a mutable caller. Fresh primary identity is re-proven
      // below; neither stored patch nor selfEmail grants authority.
      const accepted = googleRsvpEvidence(ownedEvidence.baseline, { eventId: ref.externalEventId, etag: ref.etag, authenticatedCopyEmail: calendar, occurrence: ownedEvidence.occurrence }, ownedEvidence.response);
      const ctx = await context(user, account, calendar, ref, signal);
      const intent = googleRsvpEvidence(accepted.baseline, { eventId: ref.externalEventId, etag: ref.etag, authenticatedCopyEmail: ctx.email, occurrence: accepted.occurrence }, accepted.response);
      const current = await ctx.read();
      try {
        const confirmed = confirmGoogleRsvp(current, intent);
        return { ...confirmed, recovered: true, notificationDelivery: "unknown" as const };
      } catch (error) { if (providerDeferral(error)) throw error; /* Full observation is required even after provider acceptance. */ }
      if (observeOnly) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
      if (!isDeepStrictEqual(current, intent.baseline)) throw new ProviderEventWriteError("provider-conflict");
      // A native helper cannot grant durable permission. The host must commit
      // its permanent started marker before the first possible PATCH.
      if (!beforeWrite) throw new ProviderEventWriteError("provider-write-failed");
      await reserveProviderMutation({ url: `${ctx.url}?sendUpdates=all&conferenceDataVersion=1`, method: "PATCH" }, beforeWrite);
      signal?.throwIfAborted();
      let result: Response;
      try {
        result = await fetch(`${ctx.url}?sendUpdates=all&conferenceDataVersion=1`, { method: "PATCH", headers: { ...ctx.headers, "Content-Type": "application/json", "If-Match": ref.etag }, body: JSON.stringify(intent.patch), redirect: "error", signal });
      } catch (error) { if (providerDeferral(error)) throw error; throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); }
      assertProviderEventMutationResponse(result);
      // Disposing an already errored successful body must not skip the full
      // confirmation GET or escape as an ordinary pre-write network failure.
      try { await result.body?.cancel(); } catch (error) { if (providerDeferral(error)) throw error; /* Confirmation is authoritative. */ }
      // A complete fresh GET also covers a truncated successful PATCH response.
      try {
        return { ...confirmGoogleRsvp(await ctx.read(), intent), recovered: false, notificationDelivery: "unknown" as const };
      } catch (cause) { if (providerDeferral(cause)) throw cause;
        if (cause instanceof ProviderEventWriteError && cause.outcome === "unconfirmed") throw cause;
        throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
      }
    },
  };
}
