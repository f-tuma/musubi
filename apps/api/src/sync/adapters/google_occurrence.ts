import { observedProviderFetch as fetch } from "../provider_http_metrics";
import { createHash } from "node:crypto";
import { config } from "@musubi/config";
import {
  matchesGoogleOccurrenceProjection,
  matchesEventProviderProjection,
  type GoogleOccurrenceIntent,
} from "@musubi/db";
import {
  EventTimeModelSchema,
  EventWriteError,
  OccurrenceStartSchema,
  type Event,
} from "@musubi/types";
import type { ExternalEventRef, NormalizedEvent } from "../adapter";
import { normalizeGoogleTime } from "./google_time";
import { googleEventState } from "./provider_event_state";
import { assertCompleteEventReadResponse } from "../event_create_identity";
import {
  assertAcceptedEventEtag,
  assertOAuthEventWriteGrant,
  assertProviderEventMutationResponse,
  ProviderEventWriteError,
  requireEventEtag,
} from "../event_write";

const GCAL = "https://www.googleapis.com/calendar/v3";
export type GoogleOccurrenceEvidence = {
  ref: ExternalEventRef;
  event: NormalizedEvent;
  state: ReturnType<typeof googleEventState>;
  masterProof?: GoogleOccurrenceIntent["masterProof"];
};
// Keep every native field, including unknown extensions. Google changes these
// two top-level observation fields when a detached instance changes.
function masterProof(raw: Record<string, unknown>): NonNullable<GoogleOccurrenceIntent["masterProof"]> {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
      : value;
  const { etag: _etag, updated: _updated, ...semantic } = raw;
  return { version: 1, digest: createHash("sha256").update(JSON.stringify(canonical(semantic))).digest("hex") };
}
export type GoogleSeriesEvidence = {
  master: GoogleOccurrenceEvidence;
  exceptions: GoogleOccurrenceEvidence[];
};
export function matchesGoogleOccurrence(
  expected: Event,
  actual: NormalizedEvent,
) {
  return (
    actual.status === "active" &&
    matchesGoogleOccurrenceProjection(expected, actual)
  );
}

export function googleOccurrenceMethods(
  tokenFor: (user: string, account: string) => Promise<string>,
  normalize: (raw: any) => NormalizedEvent,
) {
  const guard = () => {
    if (!config.api.eventTimeEditsEnabled)
      throw new EventWriteError("event-write", "unsupported");
  };
  const personal = (raw: any, parent = false) => {
    if (
      ((raw.status !== "cancelled" || parent) &&
        raw.organizer?.self !== true) ||
      raw.attendeesOmitted ||
      (raw.attendees != null &&
        (!Array.isArray(raw.attendees) || raw.attendees.length > 0)) ||
      (raw.eventType && raw.eventType !== "default")
    )
      throw new EventWriteError(
        "event-write",
        "unsupported",
        "Meeting scope writes require explicit notification support.",
      );
  };
  const path = (calendar: string, event: string) =>
    `${GCAL}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(event)}`;
  const read = async (url: string, token: string, signal?: AbortSignal) => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal,
    });
    assertCompleteEventReadResponse(response);
    return response.json();
  };
  async function readMaster(
    user: string,
    account: string,
    calendar: string,
    expected: Event,
    masterExternalID: string,
    masterEtag: string,
    signal?: AbortSignal,
    proof?: GoogleOccurrenceIntent["masterProof"],
    recovery = false,
  ) {
    guard();
    const token = await tokenFor(user, account);
    await assertOAuthEventWriteGrant(user, "google", account);
    const grant = await read(
      `${GCAL}/users/me/calendarList/${encodeURIComponent(calendar)}`,
      token,
      signal,
    );
    if (!["owner", "writer"].includes(grant.accessRole))
      throw new EventWriteError("event-write", "denied");
    const master = await read(path(calendar, masterExternalID), token, signal);
    if (
      master.id !== masterExternalID ||
      master.status === "cancelled" ||
      master.recurringEventId ||
      !master.recurrence?.length
    )
      throw new ProviderEventWriteError("provider-conflict");
    personal(master, true);
    requireEventEtag(master.etag);
    const observedProof = masterProof(master);
    const proofMatches = proof?.version === 1 && /^[a-f0-9]{64}$/.test(proof.digest) && proof.digest === observedProof.digest;
    if (!recovery || !proofMatches) assertAcceptedEventEtag(masterEtag, master.etag);
    if (proof && !proofMatches) throw new ProviderEventWriteError("provider-conflict");
    const masterEvent = normalizeGoogleTime(
      master,
      normalize({ ...master, recurrence: undefined }),
    );
    if (
      !matchesEventProviderProjection("google", expected, masterEvent) ||
      JSON.stringify(EventTimeModelSchema.parse(expected.timeModel)) !==
        JSON.stringify(masterEvent.timeModel)
    )
      throw new ProviderEventWriteError("provider-conflict");
    return { token, master, masterEvent, observedProof };
  }
  async function readOccurrence(
    user: string,
    account: string,
    calendar: string,
    intent: GoogleOccurrenceIntent,
    ref?: ExternalEventRef,
    signal?: AbortSignal,
    recovery = false,
  ): Promise<GoogleOccurrenceEvidence> {
    const { token, master, observedProof } = await readMaster(
      user,
      account,
      calendar,
      intent.master,
      intent.masterExternalID,
      intent.masterEtag,
      signal,
      intent.masterProof,
      recovery,
    );
    const evidence = (raw: any): GoogleOccurrenceEvidence => {
      if (
        !raw ||
        typeof raw.id !== "string" ||
        raw.recurringEventId !== intent.masterExternalID
      )
        throw new ProviderEventWriteError("provider-conflict");
      personal(raw);
      const event = normalizeGoogleTime(
        raw,
        normalize({ ...raw, recurrence: undefined }),
        master,
      );
      if (
        JSON.stringify(event.originalStart) !==
        JSON.stringify(OccurrenceStartSchema.parse(intent.originalStart))
      )
        throw new ProviderEventWriteError("provider-conflict");
      return {
        ref: { externalEventId: raw.id, etag: requireEventEtag(raw.etag) },
        event,
        state: googleEventState(raw),
        masterProof: observedProof,
      };
    };
    if (ref) {
      const raw = await read(
        path(calendar, ref.externalEventId),
        token,
        signal,
      );
      if (raw.id !== ref.externalEventId)
        throw new ProviderEventWriteError("provider-conflict");
      return evidence(raw);
    }
    const matches: GoogleOccurrenceEvidence[] = [];
    const seen = new Set<string>();
    let next = "";
    do {
      if (seen.has(next))
        throw new ProviderEventWriteError("provider-conflict");
      seen.add(next);
      const query = new URLSearchParams({
        originalStart: intent.originalStart.value,
        showDeleted: "true",
        maxResults: "2500",
        ...(next ? { pageToken: next } : {}),
      });
      const page = await read(
        `${path(calendar, intent.masterExternalID)}/instances?${query}`,
        token,
        signal,
      );
      if (!Array.isArray(page.items))
        throw new ProviderEventWriteError("provider-conflict");
      for (const item of page.items) matches.push(evidence(item));
      next = page.nextPageToken ?? "";
      if (typeof next !== "string" || seen.size > 100)
        throw new ProviderEventWriteError("provider-conflict");
    } while (next);
    if (matches.length !== 1)
      throw new ProviderEventWriteError("provider-conflict");
    return matches[0];
  }
  /** A complete unexpanded scan discovers exceptions outside any view window.
   * These are sequential observations, not an atomic provider snapshot. */
  async function readSeries(
    user: string,
    account: string,
    calendar: string,
    intent: Pick<
      GoogleOccurrenceIntent,
      "master" | "masterExternalID" | "masterEtag"
    >,
    signal?: AbortSignal,
  ): Promise<GoogleSeriesEvidence> {
    const { token, master, masterEvent } = await readMaster(
      user,
      account,
      calendar,
      intent.master,
      intent.masterExternalID,
      intent.masterEtag,
      signal,
    );
    const exceptions: GoogleOccurrenceEvidence[] = [];
    const ids = new Set<string>();
    const originals = new Set<string>();
    const pages = new Set<string>();
    let foundMaster = false;
    let next = "";
    do {
      if (pages.has(next) || pages.size >= 100)
        throw new ProviderEventWriteError("provider-conflict");
      pages.add(next);
      const query = new URLSearchParams({
        singleEvents: "false",
        showDeleted: "true",
        maxResults: "2500",
        ...(next ? { pageToken: next } : {}),
      });
      const page = await read(
        `${GCAL}/calendars/${encodeURIComponent(calendar)}/events?${query}`,
        token,
        signal,
      );
      if (!Array.isArray(page.items))
        throw new ProviderEventWriteError("provider-conflict");
      for (const raw of page.items) {
        if (!raw || typeof raw !== "object")
          throw new ProviderEventWriteError("provider-conflict");
        if (raw.id === master.id) {
          if (foundMaster || raw.recurringEventId || raw.status === "cancelled")
            throw new ProviderEventWriteError("provider-conflict");
          assertAcceptedEventEtag(master.etag, raw.etag);
          foundMaster = true;
        }
        if (raw.recurringEventId !== master.id) continue;
        if (typeof raw.id !== "string" || !raw.id || ids.has(raw.id))
          throw new ProviderEventWriteError("provider-conflict");
        personal(raw);
        const event = normalizeGoogleTime(
          raw,
          normalize({ ...raw, recurrence: undefined }),
          master,
        );
        const original = JSON.stringify(
          OccurrenceStartSchema.parse(event.originalStart),
        );
        if (originals.has(original))
          throw new ProviderEventWriteError("provider-conflict");
        ids.add(raw.id);
        originals.add(original);
        exceptions.push({
          ref: { externalEventId: raw.id, etag: requireEventEtag(raw.etag) },
          event,
          state: googleEventState(raw),
        });
      }
      next = page.nextPageToken ?? "";
      if (typeof next !== "string")
        throw new ProviderEventWriteError("provider-conflict");
    } while (next);
    if (!foundMaster) throw new ProviderEventWriteError("provider-conflict");
    // Detect a master change while scanning; a later write must still revalidate
    // all evidence and use conditional requests. No write is authorized here.
    await readMaster(
      user,
      account,
      calendar,
      intent.master,
      intent.masterExternalID,
      intent.masterEtag,
      signal,
    );
    exceptions.sort((left, right) =>
      left.ref.externalEventId.localeCompare(right.ref.externalEventId),
    );
    return {
      master: {
        ref: {
          externalEventId: master.id,
          etag: requireEventEtag(master.etag),
        },
        event: masterEvent,
        state: googleEventState(master),
      },
      exceptions,
    };
  }
  async function writeOccurrence(
    user: string,
    account: string,
    calendar: string,
    intent: GoogleOccurrenceIntent,
    event: Event,
    ref: ExternalEventRef,
    signal?: AbortSignal,
  ): Promise<GoogleOccurrenceEvidence> {
    guard();
    const before = await readOccurrence(
      user,
      account,
      calendar,
      intent,
      ref,
      signal,
    );
    assertAcceptedEventEtag(ref.etag, before.ref.etag);
    if (!matchesGoogleOccurrence(intent.baseline, before.event))
      throw new ProviderEventWriteError("provider-conflict");
    let body: Record<string, unknown> = { status: "cancelled" };
    if (!event.isCanceled) {
      const model = EventTimeModelSchema.parse(event.timeModel);
      if (!["zoned", "all-day"].includes(model.kind))
        throw new EventWriteError("event-write", "unsupported");
      body = {
        ...(before.event.isCanceled ? { status: "confirmed" } : {}),
        summary: event.title,
        description: event.description ?? null,
        location: event.location ?? null,
        start:
          model.kind === "all-day"
            ? { date: event.start.toISOString().slice(0, 10) }
            : {
                dateTime: event.start.toISOString(),
                timeZone: model.kind === "zoned" ? model.timeZone : undefined,
              },
        end:
          model.kind === "all-day"
            ? {
                date: new Date(event.end.getTime() + 86400000)
                  .toISOString()
                  .slice(0, 10),
              }
            : {
                dateTime: event.end.toISOString(),
                timeZone: model.kind === "zoned" ? model.timeZone : undefined,
              },
      };
    }
    const response = await fetch(
      `${path(calendar, ref.externalEventId)}?sendUpdates=none`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await tokenFor(user, account)}`,
          "Content-Type": "application/json",
          "If-Match": requireEventEtag(ref.etag),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      },
    );
    assertProviderEventMutationResponse(response);
    // Confirm through the same identity/temporal evidence boundary. Malformed or
    // unavailable post-write evidence is always an ambiguous remote outcome.
    try {
      const result = await readOccurrence(
        user,
        account,
        calendar,
        intent,
        ref,
        signal,
        true,
      );
      if (!matchesGoogleOccurrence(event, result.event))
        throw new Error("Unconfirmed occurrence write");
      return result;
    } catch {
      throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
    }
  }
  const recoverOccurrence = (user: string, account: string, calendar: string, intent: GoogleOccurrenceIntent, ref: ExternalEventRef, signal?: AbortSignal) => readOccurrence(user, account, calendar, intent, ref, signal, true);
  return { readOccurrence, recoverOccurrence, readSeries, writeOccurrence };
}
