import { providerDeferral } from "./provider_budget";
import { stopGraphOccurrenceContent, confirmGraphOccurrenceContent, markGraphOccurrenceContent, completeGraphOccurrenceContent } from "@musubi/db";
import { stopUndispatchedGraphMeetingCancellation, confirmGraphMeetingCancellation, markGraphMeetingCancellation, completeGraphMeetingCancellation } from "@musubi/db";
import { confirmGraphSeriesDeletionOutbox, completeGraphSeriesDeletionOutbox } from "@musubi/db";
import { microsoftEventVersion } from "./adapters/microsoft_event_content";
import { withProviderOrganizerLease, markProviderOrganizer, completeProviderOrganizer, stopMicrosoftMeetingUpdate } from "@musubi/db";
import { confirmCaldavAlarm } from "@musubi/db";
import { googleReminderInstanceEvidence, googleReminderInstanceProjection } from "./adapters/google_reminder_instance";
import { hasProviderReminderInstanceSource, completeProviderReminderInstanceOutbox, matchesProviderReminderInstanceState } from "@musubi/db";
import { confirmGraphSeriesCreateOutbox, completeGraphSeriesCreateOutbox, type GraphFamilyObservation } from "@musubi/db";
import { googleRsvpEventEvidence } from "./adapters/google_rsvp_projection";
import { googleRsvpEvidence } from "./adapters/google_rsvp";
import { googleEventState } from "./adapters/provider_event_state";
import { isDeepStrictEqual } from "node:util";
import { matchesGoogleOccurrence } from "./adapters/google_occurrence";
import { config } from "@musubi/config";
import { googleRsvpDeliveryPolicy, BadRequestError, ProviderRsvpEditSchema, providerRsvpDesiredState, ProviderReminderEditSchema, type GoogleReminderWrite, type ProviderEventState, hasKnownEventTime, SyncOperationCaptureSchema, EventSchema, EventWriteError, type Event } from "@musubi/types";
import {
  confirmCaldavSplitOutbox,
  confirmCaldavSeriesOutbox,
  confirmCaldavSeriesDeletionOutbox,
  matchesRsvpEventProjection,
  hasProviderRsvpSource,
  markGoogleRsvpDispatched,
  hasProviderReminderSource,
  completeProviderRsvpOutbox,
  matchesReminderEventProjection,
  matchesGoogleReminderIntent,
  matchesEventProviderProjection,
  claimEventOutbox,
  decodeEventOutboxOperation,
  assertPinnedOutboxSource,
  completeEventOutbox,
  finishEventOutbox,
  getEventOutboxExpectedRef,
  getEventOutboxRow,
  getExternalLinkForCalendar,
  hasEventOutboxRevisionCoverage,
  renewEventOutboxLease,
  setEventOutboxProjection,
  getEventOutboxDeletion,
  type EventOutboxRow,
  type EventContentPatch,
} from "@musubi/db";
import type {
  CalendarAdapter,
  AcceptedEventUpdateContext,
  CreatedEventEvidence,
  ExternalEventRef,
  NormalizedEvent,
} from "./adapter";
import { ProviderAuthError } from "./errors";
import {
  caldavEventCreateIdentity,
  googleEventCreateID,
} from "./event_create_identity";
import { ProviderEventWriteError, strongEventEtag } from "./event_write";
import { deliveryNextAttemptAt, validateDeliveryAttemptOptions } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";
import { parseNativeWritePlanV1 } from "@musubi/sync-codec";

import { copyCompatibilityData } from "@musubi/sync-runtime";
import type { EventCompatibilityHostPorts, EventCompatibilityNativePorts, EventCompatibilityPreparation, EventCompatibilityObservation, EventCompatibilityNativeOutcome } from "@musubi/sync-runtime";
import type { NativeWritePlanV1 } from "@musubi/sync-codec";
import type { SyncOperationEnvelope } from "@musubi/types";

export function matchesReminderIntent(intent: GoogleReminderWrite, state: ProviderEventState) {
  return matchesGoogleReminderIntent(intent, state);
}

export function matchesReminderEvent(provider: string, expected: Event, actual: NormalizedEvent) {
  return actual.status === "active" && matchesReminderEventProjection(provider, expected, actual);
}

/** Only fields actually projected by EVENT serializers. Provider-owned URLs,
 * organizer and local appearance are not evidence of our write. */
export function matchesDeliveredEvent(
  provider: string,
  expected: Event,
  actual: NormalizedEvent,
) {
  return (
    actual.status === "active" &&
    matchesEventProviderProjection(provider, expected, actual)
  );
}

function revivePatch(
  patch: Record<string, unknown> | undefined,
): EventContentPatch | undefined {
  if (!patch) return undefined;
  return {
    ...patch,
    ...(patch.start === undefined
      ? {}
      : { start: new Date(patch.start as string) }),
    ...(patch.end === undefined ? {} : { end: new Date(patch.end as string) }),
  };
}

/** The current claim and all native/family contexts stay host-owned. Opaque
 * native outcomes below are attempt-local observations, never durable receipts
 * or a claim of portable provider capability. */
export function eventCompatibilityPorts(original: EventOutboxRow & { reconciling: boolean }, adapter: CalendarAdapter | null,
  pinnedInput: SyncOperationEnvelope | undefined, nativePlanInput: NativeWritePlanV1 | undefined) {
  const own = copyCompatibilityData;
  const row = own(original);
  const pinned = own(pinnedInput), nativePlan = own(nativePlanInput);
  const flags = own({ providerOrganizerEditsEnabled: config.api.providerOrganizerEditsEnabled, caldavOrganizerEditsEnabled: config.api.caldavOrganizerEditsEnabled, providerReminderEditsEnabled: config.api.providerReminderEditsEnabled, eventTimeEditsEnabled: config.api.eventTimeEditsEnabled, caldavAlarmEditsEnabled: config.api.caldavAlarmEditsEnabled, providerRsvpEditsEnabled: config.api.providerRsvpEditsEnabled });
  let event: Event, projected: Pick<Event, "title" | "start" | "end" | "isAllDay" | "description" | "location" | "recurrence"> | undefined;
  let expected: Event, reminder: ReturnType<typeof ProviderReminderEditSchema.parse> | undefined;
  let occurrence: NonNullable<EventOutboxRow["payload"]["googleOccurrence"]> | undefined;
  let instanceEvidence: ReturnType<typeof googleReminderInstanceEvidence> | undefined;
  let googlePolicy: ReturnType<typeof googleRsvpDeliveryPolicy> | undefined, googleDispatchPossible = false;
  let googleEvidence: ReturnType<typeof googleRsvpEvidence> | undefined;
  let microsoftEvidence: import("./adapters/microsoft_rsvp").MicrosoftRsvpEvidence | undefined;
  let davEvidence: import("./adapters/caldav_rsvp").CaldavRsvpEvidence | undefined;
  let graphContent: Awaited<ReturnType<NonNullable<CalendarAdapter["updateGraphOccurrenceContent"]>>> | undefined;
  let graphCancellation: Awaited<ReturnType<NonNullable<CalendarAdapter["cancelGraphMeeting"]>>> | undefined;
  let graphDeletion: Awaited<ReturnType<NonNullable<CalendarAdapter["deleteGraphSeries"]>>> | undefined;
  let graphFamily: Awaited<ReturnType<NonNullable<CalendarAdapter["createGraphFamily"]>>> | undefined, graphObservation: GraphFamilyObservation | undefined;
  let organizer: { kind: "observed"; native: Record<string, unknown>; state?: import("@musubi/types").ProviderEventState } | { kind: "deleted" | "rejected" | "absent" | "unconfirmed" } | undefined;
  let microsoftObserved: Awaited<ReturnType<NonNullable<CalendarAdapter["writeMicrosoftRsvp"]>>> | undefined;
  let davObserved: Awaited<ReturnType<NonNullable<CalendarAdapter["writeCaldavRsvp"]>>> | undefined;
  let alarmObservation: Awaited<ReturnType<NonNullable<CalendarAdapter["writeCaldavAlarm"]>>> | undefined;
  const token = row.leaseToken!;
  function unsupported(): never { throw new EventWriteError("event-write", "unsupported"); }
  function conflict(): never { throw new ProviderEventWriteError("provider-conflict"); }
  const observation = (raw: { ref: ExternalEventRef; event?: NormalizedEvent; state?: import("@musubi/types").ProviderEventState }): EventCompatibilityNativeOutcome => {
    const value = own(raw);
    return { kind: "observed", observation: own({ ref: value.ref, ...(value.event ? { event: value.event } : {}), ...(value.state ? { state: value.state } : {}) }) };
  };
  const host: EventCompatibilityHostPorts = {
    async prepare() {
      event = EventSchema.parse(row.payload.event);
      let family: EventCompatibilityPreparation["family"];
      if (row.payload.graphOccurrenceContent) {
        if (!flags.providerOrganizerEditsEnabled || row.provider !== "microsoft" || row.action !== "update" || !adapter?.updateGraphOccurrenceContent) throw new EventWriteError("organizer", "unsupported");
        family = "graphOccurrenceContent";
      } else if (row.payload.graphMeetingCancellation) {
        if (!flags.providerOrganizerEditsEnabled || row.provider !== "microsoft" || row.action !== "delete" || !adapter?.cancelGraphMeeting) throw new EventWriteError("organizer", "unsupported");
        family = "graphMeetingCancellation";
      } else if (row.payload.organizer) {
        const caldav = row.provider === "caldav";
        if (caldav ? !flags.caldavOrganizerEditsEnabled || !adapter?.caldavOrganizer : !flags.providerOrganizerEditsEnabled || (row.provider === "microsoft" ? !adapter?.microsoftOrganizer : !adapter?.organizer)) throw new EventWriteError("organizer", "unsupported");
        family = "organizer";
      } else if (row.payload.reminderInstance) {
        if (!flags.providerReminderEditsEnabled || row.provider !== "google" || row.action !== "update" || !adapter?.reminderInstance) unsupported(); family = "reminderInstance";
      } else if (row.payload.graphSeriesDeletion) {
        if (!flags.eventTimeEditsEnabled || row.provider !== "microsoft" || row.action !== "delete" || !adapter?.deleteGraphSeries) unsupported(); family = "graphSeriesDeletion";
      } else if (row.payload.graphSeriesCreate) {
        if (!flags.eventTimeEditsEnabled || row.provider !== "microsoft" || row.action !== "create" || !adapter?.createGraphFamily) unsupported(); family = "graphSeriesCreate";
      } else if (row.payload.caldavAlarm) {
        if (!flags.caldavAlarmEditsEnabled || row.provider !== "caldav" || row.action !== "update" || !adapter?.writeCaldavAlarm) unsupported(); family = "caldavAlarm";
      } else if (row.payload.caldavSplit) {
        if (!flags.eventTimeEditsEnabled || row.provider !== "caldav" || !adapter?.writeCaldavSplitSource || !adapter.createCaldavSeries) unsupported(); family = "caldavSplit";
      } else if (row.payload.caldavSeriesDeletion) {
        if (!flags.eventTimeEditsEnabled || row.provider !== "caldav" || row.action !== "delete" || !adapter?.deleteCaldavSeries) unsupported(); family = "caldavSeriesDeletion";
      } else if (row.payload.caldavSeries) {
        if (!flags.eventTimeEditsEnabled || row.provider !== "caldav" || row.action !== "update" || !adapter?.writeCaldavSeries) unsupported(); family = "caldavSeries";
      } else if (row.payload.googleOccurrence) {
        if (!flags.eventTimeEditsEnabled || row.provider !== "google" || row.action !== "update" || !adapter?.readOccurrence || !adapter.writeOccurrence) unsupported(); family = "googleOccurrence";
      } else if (row.payload.rsvp) {
        if (!flags.providerRsvpEditsEnabled || row.action !== "update") unsupported();
        family = row.payload.rsvp.request.provider === "microsoft" ? "microsoftRsvp" : row.payload.rsvp.request.provider === "caldav" ? "caldavRsvp" : "googleRsvp";
        if (family === "microsoftRsvp" ? row.provider !== "microsoft" || !adapter?.writeMicrosoftRsvp : family === "caldavRsvp" ? row.provider !== "caldav" || !adapter?.writeCaldavRsvp : row.provider !== "google" || !adapter?.writeRsvp) unsupported();
        if (family === "googleRsvp") {
          // Private policy is validated inside the active attempt, before any
          // credential/native port. Markerless history remains read-only.
          try { googlePolicy = googleRsvpDeliveryPolicy(row.payload.rsvp); } catch { unsupported(); }
          googleDispatchPossible = googlePolicy!.observeOnly;
        }
      } else if (row.payload.reminderEdit) {
        if (!flags.providerReminderEditsEnabled || event.timeModel?.kind === "floating" || event.recurrence || event.seriesID || event.originalStart || event.isCanceled) unsupported();
        reminder = ProviderReminderEditSchema.parse(row.payload.reminderEdit);
        if (row.action !== "update" || row.provider !== reminder.provider || !adapter?.readReminderState || !adapter.writeReminders) unsupported(); family = "reminderEdit";
      } else {
        if (hasKnownEventTime(event) || !adapter?.assertEventWrite) unsupported(); family = "generic";
        projected = pinned ? EventSchema.pick({ title: true, start: true, end: true, isAllDay: true, description: true, location: true, recurrence: true }).parse(pinned.admittedProjection.data) : own(adapter.projectEvent?.(own(event, false)));
        expected = projected ? { ...event, title: projected.title, start: projected.start, end: projected.end, isAllDay: projected.isAllDay,
          description: projected.description, location: projected.location, recurrence: projected.recurrence } : event;
      }
      let ref: ExternalEventRef | undefined;
      if (family === "caldavAlarm") ref = row.payload.caldavAlarm!.context.mapping.ref;
      if (family === "caldavSplit") { const journal = row.payload.caldavSplit!; ref = row.id === journal.sourceOperationID ? journal.prepared.split.source.baseline.ref : journal.prepared.split.creation.ref; }
      if (family === "caldavSeriesDeletion") ref = row.payload.caldavSeriesDeletion!.deletion.baseline.ref;
      if (family === "caldavSeries") ref = row.payload.caldavSeries!.write.baseline.ref;
      return { family, profile: "shared-host-compatibility", operationId: row.id, provider: row.provider, action: row.action, attempts: row.attempts,
        reconciling: row.reconciling, event, priorDispatch: family === "graphOccurrenceContent" ? !!row.payload.graphOccurrenceContent?.dispatch : family === "graphMeetingCancellation" ? !!row.payload.graphMeetingCancellation?.dispatch : family === "organizer" ? !!row.payload.organizer?.dispatch : family === "microsoftRsvp" ? row.payload.rsvp?.graphDispatch !== undefined : false,
        caldavDispatchPossible: row.payload.rsvp?.request.provider === "caldav" && (row.payload.rsvp.caldavDelivery === undefined || row.payload.rsvp.caldavDelivery.startedAt !== undefined),
        ...(ref ? { expectedRef: ref } : {}), canReadEvent: !!adapter?.readEvent, skipConflictRead: !!row.payload.caldavSeries,
        ...(family === "generic" ? { generic: { expected, saveProjection: !pinned && !!projected, identity: !!pinned || row.payload.createIdentityVersion === 1,
          patch: revivePatch(row.payload.patch), predecessor: !!row.predecessorID, findCreated: !!adapter?.findCreatedEvent,
          ...(row.payload.resolution ? { firstExplicitResolution: { expectedRemoteExists: row.payload.resolution.expectedRemoteExists, expectedRemoteEtag: row.payload.resolution.expectedRemoteEtag } } : {}) } } : {}) };
    },
    async prepareNative(family, captureRef) {
      if (family === "reminderInstance") {
        const intent = row.payload.reminderInstance!, request = ProviderReminderEditSchema.parse(intent.request);
        if (request.expectedRevision !== row.revision || !matchesProviderReminderInstanceState(intent, intent.desiredState)) conflict();
        const ref = { externalEventId: row.externalEventID!, etag: row.expectedEtag }; captureRef(ref);
        instanceEvidence = googleReminderInstanceEvidence(intent.baseline, { eventID: ref.externalEventId, etag: ref.etag ?? "", occurrence: { externalSeriesID: intent.instance.externalSeriesID, originalStart: intent.instance.originalStart } }, request.reminders);
        const native = googleReminderInstanceProjection(instanceEvidence);
        if (!isDeepStrictEqual(intent.nativeTime, native.timeModel) || !isDeepStrictEqual(googleEventState(instanceEvidence.baseline), intent.baselineState) || !matchesRsvpEventProjection(row.provider, event, native, intent.instance)) conflict();
      } else if (family === "googleOccurrence") {
        occurrence = { ...row.payload.googleOccurrence!, master: EventSchema.parse(row.payload.googleOccurrence!.master), baseline: EventSchema.parse(row.payload.googleOccurrence!.baseline) };
      } else if (family === "microsoftRsvp") {
        const { microsoftRsvpEvidence, microsoftRsvpProjection } = await import("./adapters/microsoft_rsvp");
        const { GraphRsvpDispatchSchema, microsoftRsvpTargetDesiredState } = await import("@musubi/types");
        const intent = row.payload.rsvp!, request = ProviderRsvpEditSchema.parse(intent.request);
        if (request.provider !== "microsoft" || intent.instance || request.expectedRevision !== row.revision) conflict();
        microsoftEvidence = microsoftRsvpEvidence(intent.baseline.native, String(intent.baseline.selfAddress), request.response, intent.baseline.graphIdentity, intent.graphOccurrence, intent.baseline.master, intent.baseline.series as Record<string, unknown>[] | undefined);
        const evidence = microsoftEvidence;
        if (!!intent.graphOccurrence !== !!request.scope || (request.scope === "series") !== !!evidence.series) conflict();
        if (!isDeepStrictEqual(evidence, intent.baseline) || evidence.id !== row.externalEventID || evidence.etag !== row.expectedEtag || !matchesRsvpEventProjection("microsoft", row.payload.event, microsoftRsvpProjection(evidence), undefined, intent.graphOccurrence) || !isDeepStrictEqual(intent.desiredState, microsoftRsvpTargetDesiredState(intent.baselineState, evidence.selfAddress, request.response, request.scope === "series"))) conflict();
        if (request.scope === "series") { const { microsoftRsvpSeriesVersion } = await import("./adapters/microsoft_rsvp_series"); if (microsoftRsvpSeriesVersion(evidence) !== request.expectedSeriesVersion) conflict(); }
        captureRef({ externalEventId: row.externalEventID!, etag: row.expectedEtag, icalUid: row.icalUid });
        if (intent.graphDispatch !== undefined) GraphRsvpDispatchSchema.parse(intent.graphDispatch);
      } else if (family === "caldavRsvp") {
        const { prepareCaldavRsvp, caldavRsvpState } = await import("./adapters/caldav_rsvp"), { normalizeCaldavResource } = await import("./adapters/caldav_time");
        const { caldavRsvpDesiredState, CaldavRsvpDeliverySchema } = await import("@musubi/types");
        const intent = row.payload.rsvp!, request = ProviderRsvpEditSchema.parse(intent.request);
        if (intent.caldavDelivery !== undefined) CaldavRsvpDeliverySchema.parse(intent.caldavDelivery);
        if (request.provider !== "caldav" || intent.instance || request.expectedRevision !== row.revision) conflict();
        const saved = intent.baseline as unknown as import("./adapters/caldav_rsvp").CaldavRsvpEvidence;
        davEvidence = prepareCaldavRsvp(saved.before, saved, saved.proof, request.response); const evidence = davEvidence;
        const native = normalizeCaldavResource({ url: evidence.id, etag: evidence.etag, data: evidence.before })[0]!;
        if (!isDeepStrictEqual(evidence, saved) || evidence.id !== row.externalEventID || evidence.etag !== row.expectedEtag || evidence.uid !== row.icalUid || !isDeepStrictEqual(intent.nativeTime, native.timeModel) || !matchesRsvpEventProjection("caldav", event, native) || !isDeepStrictEqual(intent.baselineState, caldavRsvpState(evidence.before)) || !isDeepStrictEqual(intent.desiredState, caldavRsvpDesiredState(intent.baselineState, evidence.selfAddress, request.response))) conflict();
        // Assigned after source confirmation by the runtime's explicit stage.
      } else if (family === "googleRsvp") {
        const intent = row.payload.rsvp!, request = ProviderRsvpEditSchema.parse(intent.request);
        if (request.provider !== "google" || request.expectedRevision !== row.revision || !isDeepStrictEqual(intent.desiredState, providerRsvpDesiredState(intent.baselineState, row.externalCalendarID, request.response))) conflict();
        const ref = { externalEventId: row.externalEventID!, etag: row.expectedEtag }; captureRef(ref);
        googleEvidence = googleRsvpEvidence(intent.baseline, { eventId: ref.externalEventId, etag: ref.etag ?? "", authenticatedCopyEmail: row.externalCalendarID, ...(intent.instance ? { occurrence: { externalSeriesID: intent.instance.externalSeriesID, originalStart: intent.instance.originalStart } } : {}) }, intent.request.response);
        const native = googleRsvpEventEvidence(googleEvidence);
        if (!isDeepStrictEqual(intent.nativeTime, native.timeModel) || !isDeepStrictEqual(googleEventState(googleEvidence.baseline), intent.baselineState) || !matchesRsvpEventProjection(row.provider, event, native, intent.instance)) conflict();
      }
    },
    nativeRef: () => ({ externalEventId: davEvidence!.id, etag: davEvidence!.etag, icalUid: davEvidence!.uid }),
    async confirm(kind, signal) {
      signal.throwIfAborted();
      switch (kind) {
        case "graphOccurrenceContent": await confirmGraphOccurrenceContent(row); return true;
        case "graphMeetingCancellation": await confirmGraphMeetingCancellation(row); return true;
        case "organizer": await withProviderOrganizerLease(row, async () => undefined); return true;
        case "reminderInstance": return hasProviderReminderInstanceSource(row);
        case "graphSeriesDeletion": return confirmGraphSeriesDeletionOutbox(row.id, token);
        case "graphSeriesCreate": return confirmGraphSeriesCreateOutbox(row.id, token);
        case "caldavAlarm": return confirmCaldavAlarm(row.id, token);
        case "caldavSplit": return confirmCaldavSplitOutbox(row.id, token);
        case "caldavSeriesDeletion": return confirmCaldavSeriesDeletionOutbox(row.id, token);
        case "caldavSeries": return confirmCaldavSeriesOutbox(row.id, token);
        case "revision": return hasEventOutboxRevisionCoverage(row);
        case "rsvp": return hasProviderRsvpSource(row);
        case "reminderEdit": return hasProviderReminderSource(row);
      }
    },
    async checkDestination(uncertain, signal) {
      signal.throwIfAborted();
      uncertain ||= googleDispatchPossible;
      if (pinned && !await assertPinnedOutboxSource(row, row.action === "delete")) { await finishEventOutbox(row.id, token, "blocked", "delivery-source-changed", { uncertain }); return false; }
      const link = await getExternalLinkForCalendar(row.calendarID);
      if (!link || link.id !== row.externalCalendarLinkID || link.userID !== row.userID || link.accountID !== row.accountID || link.provider !== row.provider || link.externalCalendarID !== row.externalCalendarID || link.disabled || !link.supportsEvents) {
        await finishEventOutbox(row.id, token, "cancelled", "destination-disconnected", { uncertain }); return false;
      }
      return true;
    },
    async mark(kind, accepted, signal) {
      signal.throwIfAborted();
      if (kind === "graphOccurrenceContent") { await markGraphOccurrenceContent(row, accepted); return true; }
      if (kind === "graphMeetingCancellation") { await markGraphMeetingCancellation(row, accepted); return true; }
      if (kind === "organizer") { await markProviderOrganizer(row, accepted); return true; }
      if (kind === "googleRsvp") {
        if (!googlePolicy || googlePolicy.observeOnly) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
        const prior = googleDispatchPossible;
        // A timeout or lost COMMIT acknowledgement remains possible dispatch.
        // Only a conclusive active false result restores the prior no-send fact.
        googleDispatchPossible = true;
        const granted = await markGoogleRsvpDispatched(row, signal);
        signal.throwIfAborted();
        if (!granted) googleDispatchPossible = prior;
        return granted;
      }
      const { markGraphRsvpDispatched, markGraphRsvpAccepted, markCaldavRsvpDispatched } = await import("@musubi/db");
      return kind === "microsoftRsvp" ? accepted ? markGraphRsvpAccepted(row.id, token) : markGraphRsvpDispatched(row) : markCaldavRsvpDispatched(row);
    },
    async complete(input) {
      if (input.family === "graphOccurrenceContent") { if (graphContent?.kind !== "rejected") await completeGraphOccurrenceContent(row, graphContent!.observation); return true; }
      if (input.family === "graphMeetingCancellation") { await completeGraphMeetingCancellation(row, graphCancellation!); return true; }
      if (input.family === "graphSeriesDeletion") return completeGraphSeriesDeletionOutbox(row.id, token, graphDeletion!);
      if (input.family === "graphSeriesCreate") return completeGraphSeriesCreateOutbox(row.id, token, graphObservation!);
      if (input.family === "organizer") {
        if (organizer!.kind === "deleted") await completeProviderOrganizer(row, null);
        else if (organizer!.kind === "observed") {
          const value = organizer as Extract<NonNullable<typeof organizer>, { kind: "observed" }>;
          if (row.provider === "microsoft") await completeProviderOrganizer(row, { ...value.native, state: value.state } as Parameters<typeof completeProviderOrganizer>[1]);
          else await completeProviderOrganizer(row, { id: value.native.id, etag: value.native.etag, iCalUID: value.native.iCalUID, state: row.provider === "google" ? googleEventState(value.native) : value.state } as Parameters<typeof completeProviderOrganizer>[1]);
        }
        return true;
      }
      if (input.family === "caldavAlarm") return confirmCaldavAlarm(row.id, token, { ref: alarmObservation!.ref, state: alarmObservation!.state });
      if (input.family === "caldavSplit") return confirmCaldavSplitOutbox(row.id, token, input.ref);
      if (input.family === "caldavSeriesDeletion") return confirmCaldavSeriesDeletionOutbox(row.id, token, input.ref);
      if (input.family === "caldavSeries") return confirmCaldavSeriesOutbox(row.id, token, input.ref);
      if (input.family === "reminderInstance") return !!await completeProviderReminderInstanceOutbox(row.id, token, input.resultRef!, input.expectedRef!, input.snapshot!);
      if (input.family === "caldavRsvp") return !!await completeProviderRsvpOutbox(row.id, token, input.resultRef!, input.expectedRef!, input.snapshot!, davObserved!.confirmation);
      if (input.family === "microsoftRsvp") {
        const { providerRsvpBaselineVersion } = await import("@musubi/db");
        if (microsoftObserved?.kind !== "observed") return false;
        const evidence = microsoftObserved.evidence, request = ProviderRsvpEditSchema.parse(row.payload.rsvp!.request);
        if (request.provider !== "microsoft") conflict();
        return !!await completeProviderRsvpOutbox(row.id, token, input.resultRef!, input.expectedRef!, input.snapshot!, undefined, { baselineHash: providerRsvpBaselineVersion(row.payload.rsvp!.mappingID, row.payload.rsvp!.baseline), observedResponse: input.snapshot!.providerState!.ownResponse!, ...(request.scope === "series" ? { seriesResponse: (evidence.master!.responseStatus as { response: string }).response } : {}) });
      }
      if (input.family === "googleRsvp") return !!await completeProviderRsvpOutbox(row.id, token, input.resultRef!, input.expectedRef!, input.snapshot!);
      // Preserve existing signal capability: ordinary legacy completion did not
      // pass its optional signal; specialized APIs expose no signal parameter.
      if (!("resultRef" in input)) throw new Error("Unknown event completion family.");
      return !!await completeEventOutbox(row.id, token, input.resultRef, input.expectedRef, input.snapshot);
    },
    stop: (kind, rejected) => kind === "graphOccurrenceContent" ? stopGraphOccurrenceContent(row, rejected) : kind === "graphMeetingCancellation" ? stopUndispatchedGraphMeetingCancellation(row) : stopMicrosoftMeetingUpdate(row, rejected),
    expectedRef: () => getEventOutboxExpectedRef(row),
    saveProjection: () => setEventOutboxProjection(row.id, token, projected!),
    async acceptedUpdate() {
      if (pinned && row.provider === "google" && row.action === "update" && pinned.serializer.id === "google-personal-event" && pinned.serializer.version === 1 && nativePlan?.planKind === "json-body" && nativePlan.body !== null && Object.keys(nativePlan.body).every(key => ["summary", "description", "location"].includes(key)) && !projected?.recurrence && !hasKnownEventTime(event)) {
        const capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
        return { operationId: row.id, attemptId: token, serializer: { id: "google-personal-event", version: 1 }, connectionId: capture.connectionId, connectionGeneration: capture.connectionGeneration };
      }
      return null;
    },
    knownCreateId: signal => row.provider === "google" ? googleEventCreateID({ operationID: row.id, signal }) : row.provider === "caldav" ? caldavEventCreateIdentity(row.externalCalendarID, { operationID: row.id, signal }).url : undefined,
    deletedCreate: async id => !!await getEventOutboxDeletion(row, id),
    matches(kind, observed, expectedEvent) {
      if (kind === "delivered") return !!observed.event && matchesDeliveredEvent(row.provider, expectedEvent!, observed.event);
      if (kind === "occurrence-desired") return !!observed.event && matchesGoogleOccurrence(event, observed.event);
      if (kind === "occurrence-baseline") return !!observed.event && matchesGoogleOccurrence(occurrence!.baseline, observed.event);
      if (kind === "reminder-intent") return matchesReminderIntent(reminder!.reminders, observed.state!);
      if (kind === "reminder-event") return !!observed.event && matchesReminderEvent(row.provider, event, observed.event);
      const intent = row.payload.reminderInstance!;
      return !!observed.event && matchesProviderReminderInstanceState(intent, observed.state!) && matchesRsvpEventProjection(row.provider, event, observed.event, intent.instance);
    },
    prepareGraphFamilyObservation() {
      const project = (value: NormalizedEvent): GraphFamilyObservation["master"] => {
        if (!value.timeModel || !value.icalUid || !value.providerState) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
        return { creationOperationID: value.creationOperationID, externalID: value.externalId, icalUid: value.icalUid, etag: value.etag ?? null, providerState: value.providerState,
          values: { title: value.title, description: value.description, location: value.location, organizer: value.organizer ?? "", url: value.url, start: value.start, end: value.end, isAllDay: value.isAllDay, recurrence: value.recurrence, timeModel: value.timeModel } };
      };
      graphObservation = own({ master: project(graphFamily!.master), instances: graphFamily!.instances.map(value => { if (!value.originalStart) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); return { ...project(value), originalStart: value.originalStart }; }), cancelled: graphFamily!.cancelled });
    },
    async finish(input) {
      const nextAttemptAt = input.retry === "organizer" ? new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7))) : input.retry === "hour" ? new Date(Date.now() + 3_600_000) : undefined;
      await finishEventOutbox(row.id, token, input.status, input.code, { uncertain: input.uncertain, ...(nextAttemptAt ? { nextAttemptAt } : {}), ...(input.remoteSnapshot ? { remoteSnapshot: input.remoteSnapshot } : {}) });
    },
    async fail(error, facts) {
      const deferral = providerDeferral(error);
      if (deferral) {
        const uncertain = googleDispatchPossible || facts.caldavDispatchPossible || row.reconciling || facts.mutationStarted || facts.writerFulfilled;
        await finishEventOutbox(row.id, token, uncertain ? "unconfirmed" : "retry", "provider-budget-deferred", {
          uncertain, nextAttemptAt: new Date(deferral.retryAtMs), ...(facts.resultRef ? { resultRef: facts.resultRef } : {}),
          ...(facts.remoteSnapshot ? { remoteSnapshot: facts.remoteSnapshot } : {}),
        });
        return;
      }
      // Existing host error/rollback authority is deliberately retained here.
    const providerError =
      error instanceof ProviderEventWriteError ? error : undefined;
    const uncertain =
      googleDispatchPossible || facts.caldavDispatchPossible || row.reconciling ||
      (facts.mutationStarted && providerError?.outcome !== "not-written");
    const conflict = providerError?.code === "provider-conflict";
    const retryableStatus =
      providerError?.providerStatus === 429 ||
      providerError?.providerStatus === 408 ||
      (providerError?.providerStatus ?? 0) >= 500;
    const blocked =
      error instanceof EventWriteError ||
      (error instanceof ProviderAuthError && error.reconnectRequired) ||
      (providerError &&
        !conflict &&
        !retryableStatus &&
        providerError.outcome !== "unconfirmed");
    if (row.payload.graphOccurrenceContent && (conflict || blocked || error instanceof BadRequestError) && await stopGraphOccurrenceContent(row)) return;
    if (row.payload.graphMeetingCancellation && (conflict || blocked) && await stopUndispatchedGraphMeetingCancellation(row)) return;
    if (row.payload.organizer && (conflict || blocked || error instanceof BadRequestError) && await stopMicrosoftMeetingUpdate(row)) return;
    await finishEventOutbox(
      row.id,
      token,
      conflict
        ? "conflict"
        : blocked
          ? "blocked"
          : uncertain
            ? "unconfirmed"
            : "retry",
      providerError?.code ??
        (error instanceof ProviderAuthError && error.reconnectRequired
          ? "provider-reconnect-required"
          : error instanceof EventWriteError
            ? error.reason === "unknown"
              ? "provider-permission-unknown"
              : `provider-write-${error.reason}`
            : blocked
              ? "provider-permission-unavailable"
              : "provider-write-failed"),
      {
        uncertain,
        nextAttemptAt: deliveryNextAttemptAt(row.attempts, providerError?.retryAfterMs),
        ...(facts.remoteSnapshot ? { remoteSnapshot: facts.remoteSnapshot } : {}),
        ...(facts.resultRef ? { resultRef: facts.resultRef } : {}),
      },
    );

    },
    failure: (code, outcome) => new ProviderEventWriteError(code as import("./event_write").ProviderEventWriteCode, outcome),
    errorInfo: error => error instanceof ProviderEventWriteError ? error : undefined,
    sameAcceptedVersion: (expected, current) => !!(row.provider === "microsoft" ? microsoftEventVersion(expected.etag) : strongEventEtag(expected.etag)) && current.etag === expected.etag,
    renew: signal => { signal.throwIfAborted(); return renewEventOutboxLease(row.id, token); }, now: Date.now,
  };
  const native: EventCompatibilityNativePorts = {
    async read(input, signal) {
      let value: EventCompatibilityObservation | null;
      if (input.family === "generic") { if (!adapter?.readEvent) unsupported(); const evidence = own(await adapter!.readEvent!(row.userID, row.accountID, row.externalCalendarID, own(input.ref, false), signal, input.acceptedUpdate)); value = evidence ? { ref: evidence.ref, event: evidence.event } : null; }
      else if (input.family === "find-created") { const evidence = own(await adapter!.findCreatedEvent!(row.userID, row.accountID, row.externalCalendarID, input.identity)); value = evidence ? { ref: evidence.ref, event: evidence.event } : null; }
      else if (input.family === "googleOccurrence") { const read = input.recover ? adapter?.recoverOccurrence : adapter?.readOccurrence; if (!read) unsupported(); value = await read!(row.userID, row.accountID, row.externalCalendarID, own(occurrence!, false), own(input.ref, false), signal); }
      else value = await adapter!.readReminderState!(row.userID, row.accountID, row.externalCalendarID, own(input.ref, false), signal);
      return own(value);
    },
    async deliver(input, signal) {
      if (input.family === "graphOccurrenceContent") { graphContent = own(await adapter!.updateGraphOccurrenceContent!(own(row.payload.graphOccurrenceContent!, false), input.mark, input.accepted, signal)); return { kind: graphContent.kind === "rejected" ? "rejected" : "observed" }; }
      if (input.family === "graphMeetingCancellation") { graphCancellation = own(await adapter!.cancelGraphMeeting!(own(row.payload.graphMeetingCancellation!, false), input.mark, input.accepted, signal)); return { kind: "observed" }; }
      if (input.family === "organizer") {
        let value;
        if (row.provider === "microsoft") { const transport = await adapter!.microsoftOrganizer!(row.userID, row.accountID, row.externalCalendarID, signal); signal.throwIfAborted(); value = await transport.deliver(own(row.payload.organizer!, false), input.mark, input.accepted); }
        else if (row.provider === "caldav") { const transport = await adapter!.caldavOrganizer!(row.userID, row.accountID, row.externalCalendarID, row.action, row.externalEventID ?? undefined, signal); signal.throwIfAborted(); value = await transport.deliver(own(row.payload.organizer!, false), input.mark, input.accepted); }
        else { const transport = await adapter!.organizer!(row.userID, row.accountID, row.externalCalendarID, signal); signal.throwIfAborted(); value = await transport.deliver(own(row.payload.organizer!, false), input.mark, input.accepted); }
        const captured = own(value); organizer = captured as typeof organizer; return { kind: captured.kind };
      }
      if (input.family === "reminderInstance") return observation(await adapter!.reminderInstance!.write(row.userID, row.accountID, row.externalCalendarID, own(instanceEvidence!, false), input.mark, signal));
      if (input.family === "graphSeriesDeletion") { graphDeletion = own(await adapter!.deleteGraphSeries!(own(row.payload.graphSeriesDeletion!, false), row.reconciling, input.mark, signal)); return { kind: "observed" }; }
      if (input.family === "graphSeriesCreate") { graphFamily = own(await adapter!.createGraphFamily!(row.userID, row.accountID, row.externalCalendarID, EventSchema.parse(own(row.payload.graphSeriesCreate!.nativeEvent, false)), { operationID: row.id, signal }, { uncertain: row.reconciling, beforeWrite: input.mark })); return { kind: "observed" }; }
      if (input.family === "caldavAlarm") { alarmObservation = own(await adapter!.writeCaldavAlarm!(own(row.payload.caldavAlarm!, false), signal, input.mark)); return observation({ ref: alarmObservation.ref, state: alarmObservation.state }); }
      if (input.family === "caldavSplit") { const journal = row.payload.caldavSplit!; const method = row.id === journal.sourceOperationID ? adapter!.writeCaldavSplitSource! : adapter!.createCaldavSeries!; const value = own(await method.call(adapter, row.userID, row.accountID, row.externalCalendarID, own(journal.prepared.split, false), signal, input.mark)); return observation({ ref: value.ref }); }
      if (input.family === "caldavSeriesDeletion") return observation({ ref: await adapter!.deleteCaldavSeries!(row.userID, row.accountID, row.externalCalendarID, own(row.payload.caldavSeriesDeletion!.deletion, false), signal, input.mark) });
      if (input.family === "caldavSeries") { const value = own(await adapter!.writeCaldavSeries!(row.userID, row.accountID, row.externalCalendarID, own(row.payload.caldavSeries!.write, false), signal, input.mark)); return observation({ ref: value.ref }); }
      if (input.family === "googleOccurrence") return observation(await adapter!.writeOccurrence!(row.userID, row.accountID, row.externalCalendarID, own(occurrence!, false), own(input.event, false), own(input.ref, false), signal));
      if (input.family === "microsoftRsvp") {
        microsoftObserved = own(await adapter!.writeMicrosoftRsvp!(row.userID, row.accountID, row.externalCalendarID, own(microsoftEvidence!, false), row.payload.rsvp!.graphDispatch !== undefined, signal, input.mark, input.accepted!));
        if (microsoftObserved.kind !== "observed") return { kind: microsoftObserved.kind };
        const { microsoftRsvpProjection } = await import("./adapters/microsoft_rsvp"); const value = microsoftRsvpProjection(microsoftObserved.evidence);
        return observation({ ref: { externalEventId: value.externalId, etag: value.etag, icalUid: value.icalUid }, state: value.providerState });
      }
      if (input.family === "caldavRsvp") { const evidence = davEvidence!; davObserved = own(await adapter!.writeCaldavRsvp!(row.userID, row.accountID, row.externalCalendarID, own(evidence, false), signal, input.mark, row.payload.rsvp!.caldavDelivery === undefined || row.payload.rsvp!.caldavDelivery.startedAt !== undefined)); return observation({ ref: { externalEventId: evidence.id, etag: davObserved.etag, icalUid: evidence.uid }, state: row.payload.rsvp!.desiredState }); }
      if (input.family === "googleRsvp") { const request = ProviderRsvpEditSchema.parse(row.payload.rsvp!.request); if (request.provider !== "google") conflict(); const value = own(await adapter!.writeRsvp!(row.userID, row.accountID, row.externalCalendarID, own(googleEvidence!, false), { sendUpdates: request.sendUpdates, observeOnly: googlePolicy!.observeOnly }, signal, input.mark)); return observation({ ref: { externalEventId: row.externalEventID!, etag: value.etag }, state: row.payload.rsvp!.desiredState }); }
      if (input.family === "reminderEdit") return observation(await adapter!.writeReminders!(row.userID, row.accountID, row.externalCalendarID, own(input.ref, false), own(reminder!.reminders, false), signal, input.mark));
      if (input.family !== "generic") throw new Error("Unknown native event family.");
      if (input.action === "create") return observation({ ref: await adapter!.pushCreate(row.userID, row.accountID, row.externalCalendarID, own(input.event, false), input.identity, nativePlan && own(nativePlan, false)) });
      if (input.action === "update") { const result = own(await adapter!.pushUpdate(row.userID, row.accountID, row.externalCalendarID, input.ref!.externalEventId, own(input.event, false), own(input.ref!, false), input.patch && own(input.patch, false), signal, nativePlan && own(nativePlan, false), input.acceptedUpdate)); return observation({ ref: result ? { externalEventId: input.ref!.externalEventId, etag: result.etag ?? null, icalUid: result.icalUid ?? input.ref!.icalUid } : input.ref! }); }
      await adapter!.pushDelete(row.userID, row.accountID, row.externalCalendarID, input.ref!.externalEventId, own(input.ref!, false), signal); return { kind: "deleted" };
    },
    preflight: (event, ref, patch, acceptedUpdate, signal) => adapter!.assertEventWrite!(row.userID, row.accountID, row.externalCalendarID, { action: row.action, event: own(event, false), patch: patch && own(patch, false), external: ref ? own(ref, false) : undefined, scopeEditValidated: row.payload.scopeEditValidated, nativePlan: nativePlan && own(nativePlan, false), acceptedUpdate, signal }),
  };
  return { host, native };
}
