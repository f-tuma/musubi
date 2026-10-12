import { z } from "zod";
import type { EventContentPatch } from "@musubi/db";
import { EventWriteError } from "@musubi/types";
import { ProviderEventWriteError, assertEventWriteEvidence, assertProviderEventMutationResponse, requireEventPatch } from "../event_write";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import { observedProviderRequest } from "../provider_http_metrics";

const GRAPH = "https://graph.microsoft.com/v1.0";
const boundedSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
const PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

/** Preserve Graph's native version for conditional PATCH and before-delete
 * comparisons. DELETE ignores If-Match: comparing this tag before a delete is
 * only a preflight, never an atomic concurrency guarantee. */
export function microsoftEventVersion(value: unknown): string | null {
  return typeof value === "string" && /^W\/"[\x21\x23-\x7e\x80-\xff]+"$/.test(value) ? value : null;
}
function requireVersion(value: unknown) {
  const etag = microsoftEventVersion(value);
  if (!etag) throw new ProviderEventWriteError("provider-version-unavailable");
  return etag;
}
function unsupported(action: "update" | "delete" = "update"): never {
  if (action === "delete") throw new EventWriteError("event-write", "unsupported", "Delete meetings, recurring events and shared-calendar events in Outlook. No changes were saved.");
  throw new EventWriteError("event-write", "unsupported", "Only the title, notes and location of personal, non-recurring Outlook events can be edited here. Make other changes in Outlook. No changes were saved.");
}
export function microsoftPersonalContentPatch(patch: EventContentPatch | undefined) {
  const diff = requireEventPatch(patch);
  if (Object.keys(diff).some(key => !["title", "description", "location", "color"].includes(key))) unsupported();
  const payload: Record<string, unknown> = {};
  if (diff.title !== undefined) {
    if (typeof diff.title !== "string") unsupported();
    payload.subject = diff.title;
  }
  for (const key of ["description", "location"] as const) {
    if (diff[key] !== undefined && diff[key] !== null && typeof diff[key] !== "string") unsupported();
  }
  if (diff.description !== undefined) payload.body = { contentType: "text", content: diff.description ?? "" };
  if (diff.location !== undefined) payload.location = { displayName: diff.location ?? "" };
  return payload;
}
function pathFor(calendarID: string, eventID: string) {
  if ([calendarID, eventID].some(id => !id || id.trim() !== id || [".", ".."].includes(id))) throw new ProviderEventWriteError("provider-conflict");
  return `/me/calendars/${encodeURIComponent(calendarID)}/events/${encodeURIComponent(eventID)}`;
}
export type MicrosoftContentSession = { token: string; calendarID: string; eventID: string; etag: string | null | undefined; signal?: AbortSignal; fetchImpl?: typeof fetch };
async function get(session: MicrosoftContentSession, path: string, allowMissing = false) {
  const response = await observedProviderRequest(session.fetchImpl ?? fetch, `${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${session.token}`, Prefer: PREFER, "Cache-Control": "no-cache" },
    redirect: "error", signal: boundedSignal(session.signal),
  });
  if (allowMissing && response.status === 404) return null;
  assertCompleteEventReadResponse(response);
  return response.json();
}
export async function assertMicrosoftPersonalContent(session: MicrosoftContentSession, action: "update" | "delete" = "update") {
  const expected = requireVersion(session.etag);
  const path = pathFor(session.calendarID, session.eventID);
  const me = await get(session, "/me?$select=id,mail,userPrincipalName");
  const calendar = await get(session, `/me/calendars/${encodeURIComponent(session.calendarID)}?$select=id,canEdit,owner`);
  assertEventWriteEvidence(calendar.canEdit, "event-write");
  const self = me.mail ?? me.userPrincipalName;
  if (typeof me.id !== "string" || !me.id || !z.email().safeParse(self).success || calendar.id !== session.calendarID || typeof self !== "string" || !self || typeof calendar.owner?.address !== "string" || calendar.owner.address.toLowerCase() !== self.toLowerCase()) unsupported(action);
  const current = await get(session, path, action === "delete");
  // Only an event 404 after the source/calendar permission checks is a no-op.
  if (current === null) return null;
  if (current.id !== session.eventID || requireVersion(current["@odata.etag"]) !== expected) throw new ProviderEventWriteError("provider-conflict");
  // Complete native read, never a select/projection with omitted guest evidence.
  if (current.type !== "singleInstance" || current.isCancelled !== false || current.isOrganizer !== true || current.isDraft !== false || current.recurrence !== null || current.seriesMasterId != null || !Array.isArray(current.attendees) || current.attendees.length || current.isOnlineMeeting !== false || current.onlineMeeting != null || current.onlineMeetingUrl != null || current["@removed"] || current["@odata.nextLink"] || current["attendees@odata.nextLink"]) unsupported(action);
  return current;
}
export async function updateMicrosoftPersonalContent(session: MicrosoftContentSession, patch: EventContentPatch | undefined) {
  const payload = microsoftPersonalContentPatch(patch);
  const etag = requireVersion(session.etag);
  await assertMicrosoftPersonalContent(session);
  if (!Object.keys(payload).length) return;
  const response = await observedProviderRequest(session.fetchImpl ?? fetch, `${GRAPH}${pathFor(session.calendarID, session.eventID)}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json", Prefer: PREFER, "If-Match": etag },
    body: JSON.stringify(payload), redirect: "error", signal: boundedSignal(session.signal),
  });
  assertProviderEventMutationResponse(response);
  if (response.status !== 200) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", response.status);
  const data = await response.json().catch(() => null);
  if (data?.id !== session.eventID) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", response.status);
  return { etag: microsoftEventVersion(data["@odata.etag"]) };
}

/** User-approved compromise: check the current version immediately before a
 * normal DELETE. Outlook ignores the condition, so a concurrent edit after the
 * read can still be deleted. Durable delivery must reconcile ambiguous attempts
 * read-only and require a fresh explicit intent before sending another DELETE. */
export async function deleteMicrosoftPersonalEvent(session: MicrosoftContentSession) {
  const current = await assertMicrosoftPersonalContent(session, "delete");
  if (!current) return;
  const path = pathFor(session.calendarID, session.eventID);
  let response: Response;
  try {
    response = await observedProviderRequest(session.fetchImpl ?? fetch, `${GRAPH}${path}`, {
      method: "DELETE",
      // Retain the native condition as best effort, never as proof of CAS.
      headers: { Authorization: `Bearer ${session.token}`, "If-Match": requireVersion(session.etag) },
      redirect: "error", signal: boundedSignal(session.signal),
    });
  } catch {
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
  }
  if (response.status === 408) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", 408);
  if (response.status !== 404) assertProviderEventMutationResponse(response);
  if (![204, 404].includes(response.status)) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed", response.status);
  try {
    if (await get(session, path, true) !== null) throw new Error("Delete not observed");
  } catch {
    // The mutation may already have succeeded; a failed verification cannot
    // downgrade it to not-written and permit an automatic resend.
    throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
  }
}
