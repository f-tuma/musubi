import { deliverSharedGoogleCreate, usesSharedGoogleCreate } from "./google_shared_create_delivery";
import { deliverSharedGoogleDelete, usesSharedGoogleDelete } from "./google_shared_delete_delivery";
import { deliverSharedGoogleEvent, usesSharedGoogleDelivery } from "./google_shared_delivery";
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
import { BadRequestError, ProviderRsvpEditSchema, providerRsvpDesiredState, ProviderReminderEditSchema, type GoogleReminderWrite, type ProviderEventState, hasKnownEventTime, SyncOperationCaptureSchema, EventSchema, EventWriteError, type Event } from "@musubi/types";
import {
  confirmCaldavSplitOutbox,
  confirmCaldavSeriesOutbox,
  confirmCaldavSeriesDeletionOutbox,
  matchesRsvpEventProjection,
  hasProviderRsvpSource,
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
import { createDeliveryAttempt, deliveryNextAttemptAt, validateDeliveryAttemptOptions } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";
import { parseNativeWritePlanV1 } from "@musubi/sync-codec";

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

function snapshot(
  ref: ExternalEventRef,
  evidence: CreatedEventEvidence | null,
): EventOutboxRow["remoteSnapshot"] {
  return {
    externalEventId: ref.externalEventId,
    etag: evidence?.ref.etag ?? null,
    icalUid: evidence?.ref.icalUid ?? ref.icalUid,
    deleted: !evidence,
    observedAt: new Date().toISOString(),
    ...(evidence ? { values: JSON.parse(JSON.stringify(evidence.event)) } : {}),
  };
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

/** Shared request/background executor. Provider calls never run inside a DB
 * transaction. A timed-out or crashed attempt must reconcile before retrying. */
export async function deliverEventOutbox(
  id: string,
  adapterFor: (provider: string) => CalendarAdapter | null,
  options: { timeoutMs?: number } = {},
): Promise<EventOutboxRow | undefined> {
  validateDeliveryAttemptOptions(options);
  const row = await claimEventOutbox(id);
  if (!row) return getEventOutboxRow(id);
  const token = row.leaseToken!;
  const decoded = decodeEventOutboxOperation(row);
  if (decoded.kind === "blocked") {
    // A claim does not prove dispatch. Preserve prior uncertainty, payload and
    // remote evidence; never route an unknown format through legacy adapters.
    await finishEventOutbox(row.id, token, "blocked", decoded.code, { uncertain: row.reconciling });
    return getEventOutboxRow(row.id);
  }
  const pinned = decoded.kind === "pinned-v1" ? decoded.envelope : undefined;
  const nativePlan = pinned ? parseNativeWritePlanV1(pinned.serializer, row.action, "event", pinned.nativePlan.data) : undefined;
  if (pinned && !nativePlan) {
    await finishEventOutbox(row.id, token, "blocked", "delivery-serializer-unavailable", { uncertain: row.reconciling });
    return getEventOutboxRow(row.id);
  }
  if (pinned && !await assertPinnedOutboxSource(row, true)) {
    await finishEventOutbox(row.id, token, "blocked", "delivery-source-changed", { uncertain: row.reconciling });
    return getEventOutboxRow(row.id);
  }
  const adapter = adapterFor(row.provider);
  const parsedPersonal = EventSchema.safeParse(row.payload.event);
  const specialized = ["organizer", "rsvp", "reminderEdit", "reminderInstance", "googleOccurrence", "caldavAlarm",
    "caldavSplit", "caldavSeries", "caldavSeriesDeletion", "graphSeriesCreate", "graphSeriesDeletion", "graphMeetingCancellation", "graphOccurrenceContent"];
  if (pinned && parsedPersonal.success && !hasKnownEventTime(parsedPersonal.data) &&
    !parsedPersonal.data.seriesID && !parsedPersonal.data.originalStart && !parsedPersonal.data.hasAttendees && !parsedPersonal.data.isMeeting &&
    !parsedPersonal.data.isAllDay && !parsedPersonal.data.recurrence && !parsedPersonal.data.isCanceled &&
    ![...specialized, "timeEdit", "graphOccurrence"].some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) && usesSharedGoogleCreate(pinned, adapter))
    return deliverSharedGoogleCreate(row, pinned, adapter!.googlePersonalCreateV1!.bind(adapter), options);
  if (pinned && parsedPersonal.success && !hasKnownEventTime(parsedPersonal.data) &&
    !specialized.some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) && usesSharedGoogleDelivery(pinned, adapter))
    return deliverSharedGoogleEvent(row, pinned, adapter!.googlePersonalContentV1!.bind(adapter), options);
  if (pinned && parsedPersonal.success && !hasKnownEventTime(parsedPersonal.data) &&
    !parsedPersonal.data.seriesID && !parsedPersonal.data.originalStart &&
    !specialized.some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) &&
    row.externalEventID && strongEventEtag(row.expectedEtag) && usesSharedGoogleDelete(pinned, adapter))
    return deliverSharedGoogleDelete(row, pinned, adapter!.googlePersonalDeleteV1!.bind(adapter), options);
  const attempt = createDeliveryAttempt(() => renewEventOutboxLease(row.id, token), options);
  const signal = attempt.signal;
  let acceptedUpdate: AcceptedEventUpdateContext | undefined;
  let mutationStarted = false;
  let caldavDispatchPossible = row.payload.rsvp?.request.provider === "caldav" &&
    (row.payload.rsvp.caldavDelivery === undefined || row.payload.rsvp.caldavDelivery?.startedAt !== undefined);
  let remoteSnapshot: EventOutboxRow["remoteSnapshot"] = null;
  let expectedRef: ExternalEventRef | null = null;
  let resultRef: ExternalEventRef | null = null;
  try {
    const run = async () => {
      const event = EventSchema.parse(row.payload.event);
      const checkDestination = async () => {
        signal.throwIfAborted();
        if (pinned && !await assertPinnedOutboxSource(row, row.action === "delete")) {
          await finishEventOutbox(row.id, token, "blocked", "delivery-source-changed", { uncertain: row.reconciling || mutationStarted });
          return false;
        }
        const link = await getExternalLinkForCalendar(row.calendarID);
        if (
          !link ||
          link.id !== row.externalCalendarLinkID ||
          link.userID !== row.userID ||
          link.accountID !== row.accountID ||
          link.provider !== row.provider ||
          link.externalCalendarID !== row.externalCalendarID ||
          link.disabled ||
          !link.supportsEvents
        ) {
          await finishEventOutbox(
            row.id,
            token,
            "cancelled",
            "destination-disconnected",
            { uncertain: row.reconciling || mutationStarted },
          );
          return false;
        }
        return true;
      };
      if (row.payload.graphOccurrenceContent) {
        if (!config.api.providerOrganizerEditsEnabled || row.provider !== "microsoft" || row.action !== "update" || !adapter?.updateGraphOccurrenceContent) throw new EventWriteError("organizer", "unsupported");
        const confirmSource = async () => {
          try { await confirmGraphOccurrenceContent(row); }
          catch { throw new ProviderEventWriteError("provider-conflict", row.payload.graphOccurrenceContent?.dispatch || mutationStarted ? "unconfirmed" : "not-written"); }
        };
        await confirmSource();
        const result = await adapter.updateGraphOccurrenceContent(row.payload.graphOccurrenceContent, async () => { await confirmSource(); await markGraphOccurrenceContent(row); mutationStarted = true; }, async () => { await markGraphOccurrenceContent(row, true); }, signal);
        if (result.kind === "rejected") {
          if (!await stopGraphOccurrenceContent(row, true)) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        } else await completeGraphOccurrenceContent(row, result.observation);
        return;
      }
      if (row.payload.graphMeetingCancellation) {
        if (!config.api.providerOrganizerEditsEnabled || row.provider !== "microsoft" || row.action !== "delete" || !adapter?.cancelGraphMeeting) throw new EventWriteError("organizer", "unsupported");
        const confirmSource = async () => {
          try { await confirmGraphMeetingCancellation(row); }
          catch { throw new ProviderEventWriteError("provider-conflict", row.payload.graphMeetingCancellation?.dispatch || mutationStarted ? "unconfirmed" : "not-written"); }
        };
        await confirmSource();
        const observation = await adapter.cancelGraphMeeting(row.payload.graphMeetingCancellation, async () => { await confirmSource(); await markGraphMeetingCancellation(row); mutationStarted = true; }, async () => { await markGraphMeetingCancellation(row, true); }, signal);
        await completeGraphMeetingCancellation(row, observation);
        return;
      }
      if (row.payload.organizer) {
        const caldav = row.provider === "caldav";
        if (caldav ? !config.api.caldavOrganizerEditsEnabled || !adapter?.caldavOrganizer : !config.api.providerOrganizerEditsEnabled || (row.provider === "microsoft" ? !adapter?.microsoftOrganizer : !adapter?.organizer)) throw new EventWriteError("organizer", "unsupported");
        await withProviderOrganizerLease(row, async () => undefined);
        const mark = async () => { await markProviderOrganizer(row); mutationStarted = true; };
        const accepted = async () => { await markProviderOrganizer(row, true); };
        if (row.provider === "microsoft") {
          if (!["create", "update", "delete"].includes(row.action)) throw new EventWriteError("organizer", "unsupported");
          const transport = await adapter!.microsoftOrganizer!(row.userID, row.accountID, row.externalCalendarID, signal);
          const outcome = await transport.deliver(row.payload.organizer, mark, accepted);
          if (outcome.kind === "observed") await completeProviderOrganizer(row, { ...outcome.native, state: outcome.state });
          else if (outcome.kind === "deleted") await completeProviderOrganizer(row, null);
          else if (outcome.kind === "rejected") {
            if (!(await stopMicrosoftMeetingUpdate(row, true))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
          }
          else await finishEventOutbox(row.id, token, "unconfirmed", "organizer-outcome-unknown", { uncertain: !!row.payload.organizer.dispatch || mutationStarted, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7))) });
        } else if (caldav) {
          const transport = await adapter!.caldavOrganizer!(row.userID, row.accountID, row.externalCalendarID, row.action, row.externalEventID ?? undefined, signal);
          const outcome = await transport.deliver(row.payload.organizer, mark, accepted);
          if (outcome.kind === "observed") await completeProviderOrganizer(row, { id: outcome.native.id, etag: outcome.native.etag, iCalUID: outcome.native.iCalUID, state: outcome.state });
          else if (outcome.kind === "deleted") await completeProviderOrganizer(row, null);
          else await finishEventOutbox(row.id, token, "unconfirmed", outcome.kind === "absent" ? "organizer-copy-absent" : "organizer-outcome-unknown", { uncertain: !!row.payload.organizer.dispatch || mutationStarted, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7))) });
        } else {
          const transport = await adapter!.organizer!(row.userID, row.accountID, row.externalCalendarID, signal);
          const outcome = await transport.deliver(row.payload.organizer, mark, accepted);
          if (outcome.kind === "observed") await completeProviderOrganizer(row, { id: outcome.native.id, etag: outcome.native.etag, iCalUID: outcome.native.iCalUID, state: googleEventState(outcome.native) });
          else if (outcome.kind === "deleted") await completeProviderOrganizer(row, null);
          else await finishEventOutbox(row.id, token, "unconfirmed", outcome.kind === "absent" ? "organizer-copy-absent" : "organizer-outcome-unknown", { uncertain: !!row.payload.organizer.dispatch || mutationStarted, nextAttemptAt: new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts, 7))) });
        }
        return;
      }
      if (row.payload.reminderInstance) {
        if (!config.api.providerReminderEditsEnabled || row.provider !== "google" || row.action !== "update" || !adapter?.reminderInstance) throw new EventWriteError("event-write", "unsupported");
        const requireSource = async () => {
          signal.throwIfAborted();
          if (!(await checkDestination()) || !(await hasProviderReminderInstanceSource(row))) throw new ProviderEventWriteError("provider-conflict", mutationStarted ? "unconfirmed" : "not-written");
        };
        await requireSource();
        const intent = row.payload.reminderInstance;
        const request = ProviderReminderEditSchema.parse(intent.request);
        if (request.expectedRevision !== row.revision || !matchesProviderReminderInstanceState(intent, intent.desiredState)) throw new ProviderEventWriteError("provider-conflict");
        expectedRef = { externalEventId: row.externalEventID!, etag: row.expectedEtag };
        const evidence = googleReminderInstanceEvidence(intent.baseline, { eventID: expectedRef.externalEventId, etag: expectedRef.etag ?? "", occurrence: { externalSeriesID: intent.instance.externalSeriesID, originalStart: intent.instance.originalStart } }, request.reminders);
        const native = googleReminderInstanceProjection(evidence);
        if (!isDeepStrictEqual(intent.nativeTime, native.timeModel) || !isDeepStrictEqual(googleEventState(evidence.baseline), intent.baselineState) || !matchesRsvpEventProjection(row.provider, event, native, intent.instance)) throw new ProviderEventWriteError("provider-conflict");
        const observed = await adapter.reminderInstance.write(row.userID, row.accountID, row.externalCalendarID, evidence, async () => {
          await requireSource(); mutationStarted = true;
        }, signal);
        // A recovered full proof also confirms a prior applied mutation.
        mutationStarted = true;
        resultRef = observed.ref;
        signal.throwIfAborted();
        if (!matchesProviderReminderInstanceState(intent, observed.state) || !matchesRsvpEventProjection(row.provider, event, observed.event, intent.instance)) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        await completeProviderReminderInstanceOutbox(row.id, token, resultRef, expectedRef, { isEcho: true, externalEventId: resultRef.externalEventId, etag: resultRef.etag ?? null, deleted: false, providerState: observed.state, observedAt: new Date().toISOString() });
        return;
      }
      if (row.payload.graphSeriesDeletion) {
        if (!config.api.eventTimeEditsEnabled || row.provider !== "microsoft" || row.action !== "delete" || !adapter?.deleteGraphSeries) throw new EventWriteError("event-write", "unsupported");
        const check = async () => {
          if (!(await checkDestination()) || !(await confirmGraphSeriesDeletionOutbox(row.id, token))) throw new ProviderEventWriteError("provider-conflict");
        };
        await check();
        const observation = await adapter.deleteGraphSeries(row.payload.graphSeriesDeletion, row.reconciling, async () => { await check(); mutationStarted = true; }, signal);
        mutationStarted = true;
        if (!(await completeGraphSeriesDeletionOutbox(row.id, token, observation))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        return;
      }
      if (row.payload.graphSeriesCreate) {
        if (!config.api.eventTimeEditsEnabled || row.provider !== "microsoft" || row.action !== "create" || !adapter?.createGraphFamily)
          throw new EventWriteError("event-write", "unsupported");
        const check = async () => {
          if (!(await checkDestination()) || !(await confirmGraphSeriesCreateOutbox(row.id, token))) throw new ProviderEventWriteError("provider-conflict");
        };
        await check();
        let family;
        try {
          family = await adapter.createGraphFamily(row.userID, row.accountID, row.externalCalendarID, EventSchema.parse(row.payload.graphSeriesCreate.nativeEvent), { operationID: row.id, signal }, { uncertain: row.reconciling, beforeWrite: async () => { await check(); mutationStarted = true; } });
        } catch (error) {
          // A recovered native create can fail its subsequent complete read
          // even when this attempt sent no POST. Preserve that uncertainty.
          if (error instanceof ProviderEventWriteError && error.outcome === "unconfirmed") mutationStarted = true;
          throw error;
        }
        mutationStarted = true;
        signal.throwIfAborted();
        const project = (value: NormalizedEvent): GraphFamilyObservation["master"] => {
          if (!value.timeModel || !value.icalUid || !value.providerState) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
          return { creationOperationID: value.creationOperationID, externalID: value.externalId, icalUid: value.icalUid, etag: value.etag ?? null, providerState: value.providerState,
            values: { title: value.title, description: value.description, location: value.location, organizer: value.organizer ?? "", url: value.url, start: value.start, end: value.end, isAllDay: value.isAllDay, recurrence: value.recurrence, timeModel: value.timeModel } };
        };
        const observation: GraphFamilyObservation = { master: project(family.master), instances: family.instances.map(value => {
          if (!value.originalStart) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
          return { ...project(value), originalStart: value.originalStart };
        }), cancelled: family.cancelled };
        // Do not persist a master-only resultRef on failed acknowledgement.
        // Retry must recover the stable transaction and read its whole family.
        if (!(await checkDestination())) return;
        if (!(await completeGraphSeriesCreateOutbox(row.id, token, observation))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        return;
      }
      if (row.payload.caldavAlarm) {
        if (!config.api.caldavAlarmEditsEnabled || row.provider !== "caldav" || row.action !== "update" || !adapter?.writeCaldavAlarm) throw new EventWriteError("event-write", "unsupported");
        const check = async () => {
          if (!(await checkDestination()) || !(await confirmCaldavAlarm(row.id, token))) throw new ProviderEventWriteError("provider-conflict", mutationStarted ? "unconfirmed" : "not-written");
        };
        await check();
        expectedRef = row.payload.caldavAlarm.context.mapping.ref;
        const observed = await adapter.writeCaldavAlarm(row.payload.caldavAlarm, signal, async () => { await check(); mutationStarted = true; });
        mutationStarted = true;
        resultRef = observed.ref;
        signal.throwIfAborted();
        if (!(await checkDestination())) return;
        if (!(await confirmCaldavAlarm(row.id, token, { ref: observed.ref, state: observed.state }))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        return;
      }
      if (row.payload.caldavSplit) {
        const journal = row.payload.caldavSplit;
        const source = row.id === journal.sourceOperationID;
        if (!config.api.eventTimeEditsEnabled || row.provider !== "caldav" || !adapter?.writeCaldavSplitSource || !adapter.createCaldavSeries) throw new EventWriteError("event-write", "unsupported");
        const check = async () => {
          if (!(await checkDestination()) || !(await confirmCaldavSplitOutbox(row.id, token))) throw new ProviderEventWriteError("provider-conflict");
        };
        await check();
        expectedRef = source ? journal.prepared.split.source.baseline.ref : journal.prepared.split.creation.ref;
        mutationStarted = true;
        const observed = source
          ? await adapter.writeCaldavSplitSource(row.userID, row.accountID, row.externalCalendarID, journal.prepared.split, signal, check)
          : await adapter.createCaldavSeries(row.userID, row.accountID, row.externalCalendarID, journal.prepared.split, signal, check);
        resultRef = observed.ref;
        signal.throwIfAborted();
        if (!(await checkDestination())) return;
        if (!(await confirmCaldavSplitOutbox(row.id, token, resultRef))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        return;
      }
      if (row.payload.caldavSeriesDeletion) {
        if (!config.api.eventTimeEditsEnabled || row.provider !== "caldav" || row.action !== "delete" || !adapter?.deleteCaldavSeries) throw new EventWriteError("event-write", "unsupported");
        const check = async () => {
          if (!(await checkDestination()) || !(await confirmCaldavSeriesDeletionOutbox(row.id, token))) throw new ProviderEventWriteError("provider-conflict");
        };
        await check();
        expectedRef = row.payload.caldavSeriesDeletion.deletion.baseline.ref;
        mutationStarted = true;
        resultRef = await adapter.deleteCaldavSeries(row.userID, row.accountID, row.externalCalendarID, row.payload.caldavSeriesDeletion.deletion, signal, check);
        signal.throwIfAborted();
        if (!(await checkDestination())) return;
        if (!(await confirmCaldavSeriesDeletionOutbox(row.id, token, resultRef))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        return;
      }
      if (row.payload.caldavSeries) {
        if (!config.api.eventTimeEditsEnabled || row.provider !== "caldav" || row.action !== "update" || !adapter?.writeCaldavSeries)
          throw new EventWriteError("event-write", "unsupported");
        if (!(await checkDestination())) return;
        if (!(await confirmCaldavSeriesOutbox(row.id, token))) throw new ProviderEventWriteError("provider-conflict");
        expectedRef = row.payload.caldavSeries.write.baseline.ref;
        mutationStarted = true; // The resource executor reconciles before every conditional PUT.
        const observed = await adapter.writeCaldavSeries(row.userID, row.accountID, row.externalCalendarID, row.payload.caldavSeries.write, signal, async () => {
          if (!(await checkDestination()) || !(await confirmCaldavSeriesOutbox(row.id, token))) throw new ProviderEventWriteError("provider-conflict");
        });
        resultRef = observed.ref;
        signal.throwIfAborted();
        if (!(await checkDestination())) return;
        if (!(await confirmCaldavSeriesOutbox(row.id, token, resultRef))) throw new ProviderEventWriteError("provider-conflict", "unconfirmed");
        return;
      }
      if (row.payload.googleOccurrence) {
        if (!config.api.eventTimeEditsEnabled || row.provider !== "google" || row.action !== "update" || !adapter?.readOccurrence || !adapter.writeOccurrence)
          throw new EventWriteError("event-write", "unsupported");
        if (!(await checkDestination())) return;
        if (!(await hasEventOutboxRevisionCoverage(row))) throw new ProviderEventWriteError("provider-conflict");
        const intent = { ...row.payload.googleOccurrence, master: EventSchema.parse(row.payload.googleOccurrence.master), baseline: EventSchema.parse(row.payload.googleOccurrence.baseline) };
        expectedRef = await getEventOutboxExpectedRef(row);
        if (!expectedRef) throw new ProviderEventWriteError("provider-version-unavailable");
        const readOccurrence = row.reconciling ? adapter.recoverOccurrence : adapter.readOccurrence;
        if (!readOccurrence) throw new EventWriteError("event-write", "unsupported");
        let observed = await readOccurrence(row.userID, row.accountID, row.externalCalendarID, intent, expectedRef, signal);
        remoteSnapshot = { externalEventId: observed.ref.externalEventId, etag: observed.ref.etag ?? null, deleted: false, values: JSON.parse(JSON.stringify(observed.event)), providerState: observed.state, observedAt: new Date().toISOString() };
        if (!matchesGoogleOccurrence(event, observed.event)) {
          if (observed.ref.etag !== expectedRef.etag || !matchesGoogleOccurrence(intent.baseline, observed.event)) throw new ProviderEventWriteError("provider-conflict");
          if (!(await checkDestination())) return;
          remoteSnapshot = null;
          mutationStarted = true;
          observed = await adapter.writeOccurrence(row.userID, row.accountID, row.externalCalendarID, intent, event, expectedRef, signal);
        }
        resultRef = observed.ref;
        signal.throwIfAborted();
        await completeEventOutbox(row.id, token, resultRef, expectedRef, { isEcho: true, externalEventId: resultRef.externalEventId, etag: resultRef.etag ?? null, deleted: false, providerState: observed.state, observedAt: new Date().toISOString() });
        remoteSnapshot = null;
        return;
      }
      if (row.payload.rsvp?.request.provider === "microsoft") {
        if (!config.api.providerRsvpEditsEnabled || row.provider !== "microsoft" || row.action !== "update" || !adapter?.writeMicrosoftRsvp) throw new EventWriteError("event-write", "unsupported");
        if (!(await checkDestination())) return;
        const { microsoftRsvpEvidence, microsoftRsvpProjection } = await import("./adapters/microsoft_rsvp");
        const { GraphRsvpDispatchSchema, microsoftRsvpTargetDesiredState } = await import("@musubi/types");
        const { markGraphRsvpDispatched, markGraphRsvpAccepted, providerRsvpBaselineVersion } = await import("@musubi/db");
        const intent = row.payload.rsvp, request = ProviderRsvpEditSchema.parse(intent.request);
        if (request.provider !== "microsoft" || intent.instance || request.expectedRevision !== row.revision) throw new ProviderEventWriteError("provider-conflict");
        const evidence = microsoftRsvpEvidence(intent.baseline.native, String(intent.baseline.selfAddress), request.response, intent.baseline.graphIdentity, intent.graphOccurrence, intent.baseline.master, intent.baseline.series as Record<string, unknown>[] | undefined);
        if (!!intent.graphOccurrence !== !!request.scope || (request.scope === "series") !== !!evidence.series) throw new ProviderEventWriteError("provider-conflict");
        if (!isDeepStrictEqual(evidence, intent.baseline) || evidence.id !== row.externalEventID || evidence.etag !== row.expectedEtag || !matchesRsvpEventProjection("microsoft", row.payload.event, microsoftRsvpProjection(evidence), undefined, intent.graphOccurrence) || !isDeepStrictEqual(intent.desiredState, microsoftRsvpTargetDesiredState(intent.baselineState, evidence.selfAddress, request.response, request.scope === "series"))) throw new ProviderEventWriteError("provider-conflict");
        if (request.scope === "series") {
          const { microsoftRsvpSeriesVersion } = await import("./adapters/microsoft_rsvp_series");
          if (microsoftRsvpSeriesVersion(evidence) !== request.expectedSeriesVersion) throw new ProviderEventWriteError("provider-conflict");
        }
        expectedRef = { externalEventId: row.externalEventID!, etag: row.expectedEtag, icalUid: row.icalUid };
        const dispatched = intent.graphDispatch !== undefined;
        if (dispatched) GraphRsvpDispatchSchema.parse(intent.graphDispatch);
        if (!(await hasProviderRsvpSource(row))) throw new ProviderEventWriteError("provider-conflict");
        const observed = await adapter.writeMicrosoftRsvp(row.userID, row.accountID, row.externalCalendarID, evidence, dispatched, signal, async () => {
          signal.throwIfAborted();
          if (!(await markGraphRsvpDispatched(row))) throw new ProviderEventWriteError("provider-conflict");
          mutationStarted = true;
        }, async () => { if (!(await markGraphRsvpAccepted(row.id, token))) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed"); });
        if (observed.kind !== "observed") {
          await finishEventOutbox(row.id, token, "unconfirmed", observed.kind === "absent" ? "graph-rsvp-copy-absent" : "graph-rsvp-response-unconfirmed", { uncertain: dispatched || mutationStarted });
          return;
        }
        const native = microsoftRsvpProjection(observed.evidence);
        resultRef = { externalEventId: native.externalId, etag: native.etag, icalUid: native.icalUid };
        await completeProviderRsvpOutbox(row.id, token, resultRef, expectedRef!, { isEcho: true, externalEventId: native.externalId, etag: native.etag, deleted: false, providerState: native.providerState, observedAt: new Date().toISOString() }, undefined, { baselineHash: providerRsvpBaselineVersion(intent.mappingID, intent.baseline), observedResponse: native.providerState.ownResponse!, ...(request.scope === "series" ? { seriesResponse: (observed.evidence.master!.responseStatus as { response: string }).response } : {}) });
        return;
      }
      if (row.payload.rsvp?.request.provider === "caldav") {
        if (!config.api.providerRsvpEditsEnabled || row.provider !== "caldav" || row.action !== "update" || !adapter?.writeCaldavRsvp) throw new EventWriteError("event-write", "unsupported");
        if (!(await checkDestination())) return;
        const { prepareCaldavRsvp, caldavRsvpState } = await import("./adapters/caldav_rsvp");
        const { normalizeCaldavResource } = await import("./adapters/caldav_time");
        const { caldavRsvpDesiredState, CaldavRsvpDeliverySchema } = await import("@musubi/types");
        const { markCaldavRsvpDispatched } = await import("@musubi/db");
        const intent = row.payload.rsvp, request = ProviderRsvpEditSchema.parse(intent.request);
        const delivery = intent.caldavDelivery === undefined ? undefined : CaldavRsvpDeliverySchema.parse(intent.caldavDelivery);
        const readOnly = delivery === undefined || delivery.startedAt !== undefined;
        if (request.provider !== "caldav" || intent.instance || request.expectedRevision !== row.revision) throw new ProviderEventWriteError("provider-conflict");
        const saved = intent.baseline as unknown as import("./adapters/caldav_rsvp").CaldavRsvpEvidence;
        const evidence = prepareCaldavRsvp(saved.before, saved, saved.proof, request.response);
        const native = normalizeCaldavResource({ url: evidence.id, etag: evidence.etag, data: evidence.before })[0]!;
        if (!isDeepStrictEqual(evidence, saved) || evidence.id !== row.externalEventID || evidence.etag !== row.expectedEtag || evidence.uid !== row.icalUid || !isDeepStrictEqual(intent.nativeTime, native.timeModel) || !matchesRsvpEventProjection("caldav", event, native) || !isDeepStrictEqual(intent.baselineState, caldavRsvpState(evidence.before)) || !isDeepStrictEqual(intent.desiredState, caldavRsvpDesiredState(intent.baselineState, evidence.selfAddress, request.response))) throw new ProviderEventWriteError("provider-conflict");
        const requireSource = async () => { signal.throwIfAborted(); if (!(await hasProviderRsvpSource(row))) throw new ProviderEventWriteError("provider-conflict", mutationStarted ? "unconfirmed" : "not-written"); };
        await requireSource();
        expectedRef = { externalEventId: evidence.id, etag: evidence.etag, icalUid: evidence.uid };
        const observed = await adapter.writeCaldavRsvp(row.userID, row.accountID, row.externalCalendarID, evidence, signal, async () => {
          await requireSource();
          if (readOnly) throw new ProviderEventWriteError("provider-conflict");
          let granted: boolean;
          try {
            granted = await markCaldavRsvpDispatched(row);
          } catch (error) {
            // The commit may have succeeded even if its acknowledgement was lost.
            caldavDispatchPossible = true;
            throw error;
          }
          if (!granted) throw new ProviderEventWriteError("provider-conflict");
          caldavDispatchPossible = true;
          mutationStarted = true;
        }, readOnly);
        resultRef = { externalEventId: evidence.id, etag: observed.etag, icalUid: evidence.uid };
        signal.throwIfAborted();
        await completeProviderRsvpOutbox(row.id, token, resultRef, expectedRef, { isEcho: true, externalEventId: evidence.id, etag: observed.etag, deleted: false, providerState: intent.desiredState, observedAt: new Date().toISOString() }, observed.confirmation);
        return;
      }
      if (row.payload.rsvp) {
        if (!config.api.providerRsvpEditsEnabled || row.provider !== "google" || row.action !== "update" || !adapter?.writeRsvp) throw new EventWriteError("event-write", "unsupported");
        if (!(await checkDestination())) return;
        const requireSource = async () => {
          signal.throwIfAborted();
          if (!(await hasProviderRsvpSource(row))) throw new ProviderEventWriteError("provider-conflict", mutationStarted ? "unconfirmed" : "not-written");
        };
        await requireSource();
        const intent = row.payload.rsvp;
        const request = ProviderRsvpEditSchema.parse(intent.request);
        if (request.provider !== "google" || request.expectedRevision !== row.revision || !isDeepStrictEqual(intent.desiredState, providerRsvpDesiredState(intent.baselineState, row.externalCalendarID, request.response))) throw new ProviderEventWriteError("provider-conflict");
        expectedRef = { externalEventId: row.externalEventID!, etag: row.expectedEtag };
        const evidence = googleRsvpEvidence(intent.baseline, { eventId: expectedRef.externalEventId, etag: expectedRef.etag ?? "", authenticatedCopyEmail: row.externalCalendarID, ...(intent.instance ? { occurrence: { externalSeriesID: intent.instance.externalSeriesID, originalStart: intent.instance.originalStart } } : {}) }, intent.request.response);
        const native = googleRsvpEventEvidence(evidence);
        if (!isDeepStrictEqual(intent.nativeTime, native.timeModel) || !isDeepStrictEqual(googleEventState(evidence.baseline), intent.baselineState) || !matchesRsvpEventProjection(row.provider, event, native, intent.instance)) throw new ProviderEventWriteError("provider-conflict");
        const observed = await adapter.writeRsvp(row.userID, row.accountID, row.externalCalendarID, evidence, { sendUpdates: request.sendUpdates }, signal, async () => {
          await requireSource();
          mutationStarted = true;
        });
        resultRef = { externalEventId: expectedRef.externalEventId, etag: observed.etag };
        signal.throwIfAborted();
        await completeProviderRsvpOutbox(row.id, token, resultRef, expectedRef, { isEcho: true, externalEventId: resultRef.externalEventId, etag: observed.etag, deleted: false, providerState: intent.desiredState, observedAt: new Date().toISOString() });
        return;
      }
      if (row.payload.reminderEdit) {
        if (!config.api.providerReminderEditsEnabled || event.timeModel?.kind === "floating" || event.recurrence || event.seriesID || event.originalStart || event.isCanceled) throw new EventWriteError("event-write", "unsupported");
        const intent = ProviderReminderEditSchema.parse(row.payload.reminderEdit);
        if (row.action !== "update" || row.provider !== intent.provider || !adapter?.readReminderState || !adapter.writeReminders)
          throw new EventWriteError("event-write", "unsupported");
        if (!(await checkDestination())) return;
        const requireSource = async () => {
          signal.throwIfAborted();
          if (!(await hasProviderReminderSource(row))) throw new ProviderEventWriteError("provider-conflict", mutationStarted ? "unconfirmed" : "not-written");
        };
        await requireSource();
        expectedRef = await getEventOutboxExpectedRef(row);
        if (!expectedRef) throw new ProviderEventWriteError("provider-version-unavailable");
        let observed = await adapter.readReminderState(row.userID, row.accountID, row.externalCalendarID, expectedRef, signal);
        remoteSnapshot = { externalEventId: expectedRef.externalEventId, etag: observed?.ref.etag ?? null, deleted: !observed, observedAt: new Date().toISOString(), ...(observed ? { providerState: observed.state, values: JSON.parse(JSON.stringify(observed.event)) } : {}) };
        if (!observed || !matchesReminderEvent(row.provider, event, observed.event)) throw new ProviderEventWriteError("provider-conflict");
        if (!matchesReminderIntent(intent.reminders, observed.state)) {
          if (observed.ref.etag !== expectedRef.etag) throw new ProviderEventWriteError("provider-conflict");
          if (!(await checkDestination())) return;
          signal.throwIfAborted();
          remoteSnapshot = null; // accepted baseline is not a remote conflict after an ambiguous write
          observed = await adapter.writeReminders(row.userID, row.accountID, row.externalCalendarID, expectedRef, intent.reminders, signal, async () => {
            await requireSource(); mutationStarted = true;
          });
          if (!matchesReminderIntent(intent.reminders, observed.state)) throw new ProviderEventWriteError("provider-write-failed", "unconfirmed");
        }
        if (!matchesReminderEvent(row.provider, event, observed.event)) {
          remoteSnapshot = { externalEventId: observed.ref.externalEventId, etag: observed.ref.etag ?? null, deleted: false, providerState: observed.state, values: JSON.parse(JSON.stringify(observed.event)), observedAt: new Date().toISOString() };
          throw new ProviderEventWriteError("provider-conflict", mutationStarted ? "unconfirmed" : "not-written");
        }
        resultRef = observed.ref;
        signal.throwIfAborted();
        await completeEventOutbox(row.id, token, resultRef, expectedRef, { isEcho: true, externalEventId: resultRef.externalEventId, etag: resultRef.etag ?? null, deleted: false, providerState: observed.state, observedAt: new Date().toISOString() });
        remoteSnapshot = null;
        return;
      }
      if (hasKnownEventTime(event))
        throw new EventWriteError("event-write", "unsupported");
      if (!adapter?.assertEventWrite)
        throw new EventWriteError("event-write", "unsupported");
      const projected = pinned
        ? EventSchema.pick({ title: true, start: true, end: true, isAllDay: true,
            description: true, location: true, recurrence: true }).parse(pinned.admittedProjection.data)
        : adapter.projectEvent?.(event);
      const expected = projected
        ? {
            ...event,
            title: projected.title,
            start: projected.start,
            end: projected.end,
            isAllDay: projected.isAllDay,
            description: projected.description,
            location: projected.location,
            recurrence: projected.recurrence,
          }
        : event;
      if (
        !pinned && projected &&
        !(await setEventOutboxProjection(row.id, token, projected))
      )
        return;
      if (!(await checkDestination())) return;
      if (
        row.action !== "delete" &&
        !(await hasEventOutboxRevisionCoverage(row))
      )
        throw new ProviderEventWriteError(
          "provider-write-failed",
          row.reconciling ? "unconfirmed" : "not-written",
        );
      expectedRef = await getEventOutboxExpectedRef(row);
      // Select the bounded provider port from the accepted plan, never a current
      // mapper. Other pinned/legacy operations keep their existing family route.
      if (pinned && row.provider === "google" && row.action === "update" &&
          pinned.serializer.id === "google-personal-event" && pinned.serializer.version === 1 &&
          nativePlan?.planKind === "json-body" && nativePlan.body !== null &&
          Object.keys(nativePlan.body).every(key => ["summary", "description", "location"].includes(key)) &&
          !projected?.recurrence && !hasKnownEventTime(event)) {
        const capture = SyncOperationCaptureSchema.parse(row.payload.operationCapture);
        acceptedUpdate = {
          operationId: row.id, attemptId: token,
          serializer: { id: "google-personal-event", version: 1 },
          connectionId: capture.connectionId, connectionGeneration: capture.connectionGeneration,
          beforeMutation: async () => {
            signal.throwIfAborted();
            // Token refresh can suspend the caller after its earlier preflight.
            // Re-prove the current lease and host authority after credentials.
            if (!await renewEventOutboxLease(row.id, token))
              throw new ProviderEventWriteError("provider-write-failed");
            if (!await checkDestination()) throw new EventWriteError("event-write", "unknown");
            signal.throwIfAborted();
            mutationStarted = true;
          },
        };
      }
      const identity =
        pinned || row.payload.createIdentityVersion === 1
          ? { operationID: row.id, signal }
          : undefined;
      if (identity && row.action === "create") {
        const knownID =
          row.provider === "google"
            ? googleEventCreateID(identity)
            : row.provider === "caldav"
              ? caldavEventCreateIdentity(row.externalCalendarID, identity).url
              : undefined;
        if (knownID && (await getEventOutboxDeletion(row, knownID))) {
          remoteSnapshot = snapshot({ externalEventId: knownID }, null);
          throw new ProviderEventWriteError("provider-conflict");
        }
      }
      const patch = revivePatch(row.payload.patch);
      let recovered = false;
      if (row.reconciling || row.action === "delete") {
        if (row.action === "create") {
          if (!identity || !adapter.findCreatedEvent) {
            await finishEventOutbox(
              row.id,
              token,
              "blocked",
              "create-recovery-unavailable",
              { uncertain: true },
            );
            return;
          }
          const evidence = await adapter.findCreatedEvent(
            row.userID,
            row.accountID,
            row.externalCalendarID,
            identity,
          );
          if (evidence) {
            remoteSnapshot = snapshot(evidence.ref, evidence);
            if (!matchesDeliveredEvent(row.provider, expected, evidence.event))
              throw new ProviderEventWriteError("provider-conflict");
            resultRef = evidence.ref;
            remoteSnapshot = null;
            recovered = true;
          } else if (row.provider !== "google" && row.provider !== "caldav") {
            await finishEventOutbox(
              row.id,
              token,
              "blocked",
              "create-outcome-unknown",
              { uncertain: true },
            );
            return;
          }
        } else if (expectedRef) {
          if (!adapter.readEvent)
            throw new EventWriteError("event-write", "unsupported");
          const evidence = await adapter.readEvent(
            row.userID,
            row.accountID,
            row.externalCalendarID,
            expectedRef,
            signal,
            acceptedUpdate,
          );
          remoteSnapshot = snapshot(expectedRef, evidence);
          // A new operation created by an explicit, current comparison may send
          // once. Retrying that operation (including after a crash) may not.
          const firstExplicitResolution =
            row.attempts === 1 &&
            row.payload.resolution?.expectedRemoteExists === true &&
            row.payload.resolution.expectedRemoteEtag === expectedRef.etag;
          if (
            evidence && row.provider === "microsoft" &&
            row.action === "delete" && row.reconciling &&
            !firstExplicitResolution
          ) {
            // A timed-out DELETE may still arrive at Graph. Seeing the same
            // version now does not authorize another unconditional deletion.
            await finishEventOutbox(row.id, token, "unconfirmed", "provider-write-failed", {
              uncertain: true,
              remoteSnapshot,
              nextAttemptAt: new Date(Date.now() + 3_600_000),
            });
            return;
          }
          if (!evidence && row.action === "delete") recovered = true;
          else if (
            evidence &&
            row.action === "update" &&
            matchesDeliveredEvent(row.provider, expected, evidence.event)
          ) {
            resultRef = evidence.ref;
            recovered = true;
          } else if (
            evidence &&
            (row.provider === "microsoft" ? microsoftEventVersion(expectedRef.etag) : strongEventEtag(expectedRef.etag)) &&
            evidence.ref.etag === expectedRef.etag
          ) {
            // Content differs at the accepted version: proceed through the
            // provider's write guards (Graph DELETE has only a preflight).
          } else throw new ProviderEventWriteError("provider-conflict");
          remoteSnapshot = null;
        } else if (row.predecessorID) {
          throw new ProviderEventWriteError("provider-version-unavailable");
        }
      }
      if (!recovered) {
        if (row.action !== "create" && !expectedRef) {
          if (row.predecessorID)
            throw new ProviderEventWriteError("provider-version-unavailable");
          await completeEventOutbox(row.id, token, null, null);
          return;
        }
        await adapter.assertEventWrite(
          row.userID,
          row.accountID,
          row.externalCalendarID,
          {
            action: row.action,
            event,
            patch,
            external: expectedRef ?? undefined,
            scopeEditValidated: row.payload.scopeEditValidated,
            nativePlan,
            acceptedUpdate,
            signal,
          },
        );
        if (!(await checkDestination())) return;
        signal.throwIfAborted();
        if (!acceptedUpdate) mutationStarted = true;
        if (row.action === "create") {
          resultRef = await adapter.pushCreate(
            row.userID,
            row.accountID,
            row.externalCalendarID,
            event,
            identity,
            nativePlan,
          );
        } else if (row.action === "update") {
          const result = await adapter.pushUpdate(
            row.userID,
            row.accountID,
            row.externalCalendarID,
            expectedRef!.externalEventId,
            event,
            expectedRef!,
            patch,
            signal,
            nativePlan,
            acceptedUpdate,
          );
          resultRef = result
            ? {
                externalEventId: expectedRef!.externalEventId,
                etag: result.etag ?? null,
                icalUid: result.icalUid ?? expectedRef!.icalUid,
              }
            : expectedRef;
        } else {
          await adapter.pushDelete(
            row.userID,
            row.accountID,
            row.externalCalendarID,
            expectedRef!.externalEventId,
            expectedRef!,
            signal,
          );
        }
      }
      signal.throwIfAborted();
      await completeEventOutbox(row.id, token, resultRef, expectedRef);
    };
    await attempt.run(() => withProviderCallMetrics(row.provider, "event", () => run().catch(async (error) => {
        if (
          error instanceof ProviderEventWriteError &&
          error.code === "provider-conflict" &&
          !row.payload.caldavSeries &&
          !remoteSnapshot &&
          expectedRef &&
          adapter?.readEvent &&
          !signal.aborted
        ) {
          try {
            const observed = await adapter.readEvent(
              row.userID,
              row.accountID,
              row.externalCalendarID,
              expectedRef,
              signal,
              acceptedUpdate,
            );
            remoteSnapshot = snapshot(expectedRef, observed);
          } catch {
            /* Keep the conflict; absence of readable evidence is not resolution. */
          }
        }
        throw error;
      })));
  } catch (error) {
    const providerError =
      error instanceof ProviderEventWriteError ? error : undefined;
    const uncertain =
      caldavDispatchPossible || row.reconciling ||
      (mutationStarted && providerError?.outcome !== "not-written");
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
    if (row.payload.graphOccurrenceContent && (conflict || blocked || error instanceof BadRequestError) && await stopGraphOccurrenceContent(row)) return getEventOutboxRow(row.id);
    if (row.payload.graphMeetingCancellation && (conflict || blocked) && await stopUndispatchedGraphMeetingCancellation(row)) return getEventOutboxRow(row.id);
    if (row.payload.organizer && (conflict || blocked || error instanceof BadRequestError) && await stopMicrosoftMeetingUpdate(row)) return getEventOutboxRow(row.id);
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
        ...(remoteSnapshot ? { remoteSnapshot } : {}),
        ...(resultRef ? { resultRef } : {}),
      },
    );
  } finally {
    attempt.dispose();
  }
  return getEventOutboxRow(row.id);
}
