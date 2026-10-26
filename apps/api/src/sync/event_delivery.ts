import { withDeliveryBudgetScope } from "./provider_budget";
import { currentSyncWorkParking } from "./work_coordinator";
import * as budgetPersistence from "@musubi/db";
import { runClaimedEventCompatibility } from "@musubi/sync-runtime";
import { eventCompatibilityPorts } from "./event_compatibility_host";
import { deliverSharedCaldavCreate, usesSharedCaldavCreate } from "./caldav_shared_create_delivery";
import { deliverSharedMicrosoftCreate, usesSharedMicrosoftCreate } from "./microsoft_shared_create_delivery";
import { deliverSharedGoogleCreate, usesSharedGoogleCreate } from "./google_shared_create_delivery";
import { deliverSharedCaldavDelete, usesSharedCaldavDelete } from "./caldav_shared_delete_delivery";
import { deliverSharedMicrosoftDelete, usesSharedMicrosoftDelete } from "./microsoft_shared_delete_delivery";
import { deliverSharedGoogleDelete, usesSharedGoogleDelete } from "./google_shared_delete_delivery";
import { deliverSharedGoogleEvent, usesSharedGoogleDelivery } from "./google_shared_delivery";
import { EventSchema, hasKnownEventTime } from "@musubi/types";
import { claimEventOutbox, decodeEventOutboxOperation, assertPinnedOutboxSource, finishEventOutbox, getEventOutboxRow, type EventOutboxRow } from "@musubi/db";
import type { CalendarAdapter } from "./adapter";
import { strongEventEtag } from "./event_write";
import { validateDeliveryAttemptOptions } from "./delivery_policy";
import { withProviderCallMetrics } from "./provider_http_metrics";
import { parseNativeWritePlanV1 } from "@musubi/sync-codec";

export { matchesReminderIntent, matchesReminderEvent, matchesDeliveredEvent } from "./event_compatibility_host";

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
  return withDeliveryBudgetScope(row.provider, row.userID, row.accountID, { operationId: row.id, attemptId: token,
    sourceIncarnationKey: row.externalCalendarLinkID }, async () => {
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
    !parsedPersonal.data.isAllDay && !parsedPersonal.data.recurrence && !parsedPersonal.data.isCanceled && row.externalEventID &&
    ![...specialized, "timeEdit", "graphOccurrence"].some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) && usesSharedCaldavDelete(pinned, adapter))
    return deliverSharedCaldavDelete(row, pinned, adapter!.caldavPersonalDeleteV1!.bind(adapter), options);
  if (pinned && parsedPersonal.success && !hasKnownEventTime(parsedPersonal.data) &&
    !parsedPersonal.data.seriesID && !parsedPersonal.data.originalStart && !parsedPersonal.data.hasAttendees && !parsedPersonal.data.isMeeting &&
    !parsedPersonal.data.isAllDay && !parsedPersonal.data.recurrence && !parsedPersonal.data.isCanceled && row.externalEventID &&
    ![...specialized, "timeEdit", "graphOccurrence"].some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) && usesSharedMicrosoftDelete(pinned, adapter))
    return deliverSharedMicrosoftDelete(row, pinned, adapter!.microsoftPersonalDeleteV1!.bind(adapter), options);
  if (pinned && parsedPersonal.success && !hasKnownEventTime(parsedPersonal.data) &&
    !parsedPersonal.data.seriesID && !parsedPersonal.data.originalStart && !parsedPersonal.data.hasAttendees && !parsedPersonal.data.isMeeting &&
    !parsedPersonal.data.isAllDay && !parsedPersonal.data.recurrence && !parsedPersonal.data.isCanceled &&
    ![...specialized, "timeEdit", "graphOccurrence"].some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) && usesSharedCaldavCreate(pinned, adapter))
    return deliverSharedCaldavCreate(row, pinned, adapter!.caldavPersonalCreateV1!.bind(adapter), options);
  if (pinned && parsedPersonal.success && !hasKnownEventTime(parsedPersonal.data) &&
    !parsedPersonal.data.seriesID && !parsedPersonal.data.originalStart && !parsedPersonal.data.hasAttendees && !parsedPersonal.data.isMeeting &&
    !parsedPersonal.data.isAllDay && !parsedPersonal.data.recurrence && !parsedPersonal.data.isCanceled &&
    ![...specialized, "timeEdit", "graphOccurrence"].some(key => Object.prototype.hasOwnProperty.call(row.payload, key)) && usesSharedMicrosoftCreate(pinned, adapter))
    return deliverSharedMicrosoftCreate(row, pinned, adapter!.microsoftPersonalCreateV1!.bind(adapter), options);
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
  const { host, native } = eventCompatibilityPorts(row, adapter, pinned, nativePlan);
  await withProviderCallMetrics(row.provider, "event", () => runClaimedEventCompatibility({
    reconciling: row.reconciling, caldavDispatchPossible: row.payload.rsvp?.request.provider === "caldav" &&
      (row.payload.rsvp.caldavDelivery === undefined || row.payload.rsvp.caldavDelivery.startedAt !== undefined),
  }, host, native, options));
  return getEventOutboxRow(row.id);
  }, { park: currentSyncWorkParking() ? async (retryAtMs, signal) => {
    if (!await budgetPersistence.postponeEventOutbox(row.id, token, retryAtMs)) throw new Error("Event work lease changed while parking.");
    await currentSyncWorkParking()!(retryAtMs, signal);
  } : undefined });
}
