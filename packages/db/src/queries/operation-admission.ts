import { and, eq, sql } from "drizzle-orm";
import { config } from "@musubi/config";
import { SyncOperationCaptureSchema, SyncOperationEnvelopeSchema, SyncJsonObjectSchema, type Event, type Task, type SyncOperationCapture } from "@musubi/types";
import { encodeEventV1, encodeTaskV1, parseNativeWritePlanV1, type EncodedSyncWriteV1, type SyncCodecProvider } from "@musubi/sync-codec";
import { db } from "..";
import { account, caldavAccounts, externalCalendars, events, tasks } from "../schema";
import type { DbTransaction } from "./calendars";
import type { EventOutboxIntent, EventOutboxRow } from "./event-outbox";
import type { TaskOutboxIntent, TaskOutboxRow } from "./task-outbox";
import { decodeEventOutboxOperation, decodeTaskOutboxOperation } from "./outbox-operation";
import { eventOutbox, taskOutbox } from "../schema";
import { lockCalendarLifecycle } from "./calendar-lifecycle";

type Target = Pick<EventOutboxIntent, "externalCalendarLinkID" | "calendarID" | "provider" | "userID" | "accountID" | "externalCalendarID">;
const providers = ["google", "microsoft", "caldav"];
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const eventSpecialized = ["organizer", "rsvp", "reminderEdit", "reminderInstance", "timeEdit", "googleOccurrence", "graphOccurrence", "graphOccurrenceContent", "graphMeetingCancellation", "graphSeriesDeletion", "graphSeriesCreate", "caldavAlarm", "caldavSplit", "caldavSeries", "caldavSeriesDeletion"];
const changed = (): never => { throw new Error("Operation admission source changed. No changes were saved."); };
// Portable source/account keys stay opaque. This host's physical DAV account
// table uses UUIDs; an old unavailable text alias has no provable incarnation.
const physicalCaldavAccountKey = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function connectionCapture(tx: DbTransaction, target: Target, requireActive = true, allowMissingAtAdmission = false) {
  if (target.provider === "caldav") {
    // Reject before SQL: a caught UUID cast error leaves an ACK transaction
    // aborted and cannot be converted into a safe HOLD by a later UPDATE.
    if (!physicalCaldavAccountKey(target.accountID)) return allowMissingAtAdmission ? undefined : changed();
    const [row] = await tx.select({ id: caldavAccounts.id, updatedAt: caldavAccounts.updatedAt }).from(caldavAccounts)
      .where(and(eq(caldavAccounts.id, target.accountID), eq(caldavAccounts.userID, target.userID))).for("share");
    if (!row) return allowMissingAtAdmission ? undefined : changed();
    // DAV has no OAuth grant generation. Capture the current host connection
    // revision timestamp in addition to the immutable account/source UUIDs.
    return { connectionId: row.id, connectionGeneration: row.updatedAt.getTime() };
  }
  const [row] = await tx.select({ id: account.id, status: account.syncStatus, refreshToken: account.refreshToken,
    generation: sql<number>`sync_read_generation` }).from(account).where(and(eq(account.userId, target.userID),
      eq(account.providerId, target.provider), eq(account.accountId, target.accountID))).for("share");
  if (!row) return allowMissingAtAdmission ? undefined : changed();
  if (!Number.isSafeInteger(row.generation) || row.generation < 0 ||
      requireActive && (row.status !== "active" || !row.refreshToken)) return changed();
  return { connectionId: row.id, connectionGeneration: row.generation };
}
async function capture(tx: DbTransaction, target: Target, privacyEpoch: string): Promise<SyncOperationCapture | undefined> {
  const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.id, target.externalCalendarLinkID),
    eq(externalCalendars.calendarID, target.calendarID), eq(externalCalendars.provider, target.provider),
    eq(externalCalendars.userID, target.userID), eq(externalCalendars.accountID, target.accountID),
    eq(externalCalendars.externalCalendarID, target.externalCalendarID))).for("share");
  if (!source) return changed();
  // Admission records a destination incarnation, not current write authority.
  // An inactive secondary grant must not roll back authoritative source data.
  // Dispatch and ACK separately require the same incarnation to be active.
  // A historical/disconnected secondary target with no physical account has
  // no provable v1 incarnation. Preserve explicit legacy admission rather than
  // rolling back authoritative content. The exact source fence above still
  // throws on missing/mismatching source, and SQL/codec errors never fall back.
  const connection = await connectionCapture(tx, target, false, true);
  if (!connection) return undefined;
  return SyncOperationCaptureSchema.parse({ sourceId: source.id, writeGeneration: source.providerAccessRevision,
    ...connection, privacyEpoch });
}
async function nativeUid(tx: DbTransaction, target: Target, hostID: string, kind: "event" | "task", capturedUid: string | null | undefined, predecessorID: string | null) {
  if (capturedUid) return capturedUid;
  if (!predecessorID) return undefined;
  const previous = kind === "event"
    ? (await tx.select().from(eventOutbox).where(eq(eventOutbox.id, predecessorID)).for("share"))[0]
    : (await tx.select().from(taskOutbox).where(eq(taskOutbox.id, predecessorID)).for("share"))[0];
  if (!previous || previous.provider !== "caldav" || previous.userID !== target.userID || previous.accountID !== target.accountID ||
      previous.externalCalendarLinkID !== target.externalCalendarLinkID || previous.externalCalendarID !== target.externalCalendarID ||
      ("eventID" in previous ? previous.eventID : previous.taskID) !== hostID) return undefined;
  if (previous.resultRef?.icalUid) return previous.resultRef.icalUid;
  const decoded = "eventID" in previous ? decodeEventOutboxOperation(previous) : decodeTaskOutboxOperation(previous);
  if (decoded.kind !== "pinned-v1") return undefined;
  const plan = parseNativeWritePlanV1(decoded.envelope.serializer, decoded.envelope.operation.action,
    decoded.envelope.operation.kind, decoded.envelope.nativePlan.data);
  return plan?.planKind === "caldav-properties" ? plan.uid : undefined;
}
function envelope(encoded: EncodedSyncWriteV1, input: { kind: "event" | "task"; action: "create" | "update" | "delete";
  id: string; mutationID: string; hostID: string; revision: number; target: Target; resourceID: string | null; predecessorID: string | null },
  captured: SyncOperationCapture) {
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1",
    operation: { kind: input.kind, action: input.action, version: 1 }, serializer: encoded.serializer,
    commandId: input.mutationID, operationId: input.id, hostObjectId: input.hostID,
    locator: { provider: input.target.provider, connectionId: input.target.accountID,
      collectionId: input.target.externalCalendarID, resourceId: input.resourceID },
    ...(input.predecessorID ? { predecessorOperationId: input.predecessorID } : {}),
    sourceEpoch: { sourceId: captured.sourceId, generation: captured.writeGeneration },
    acceptedRevision: input.revision, privacyEpoch: captured.privacyEpoch,
    allowedSideEffects: ["provider-content-write"], admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
}

/** Profile selection precedes encoding. Native source imports may legitimately
 * carry features a bounded destination codec cannot represent; keep those new
 * intents on their existing legacy transport without changing source content.
 * Malformed values inside a selected profile still fail transactionally.
 */
function pinnedRecurrenceSyntax(recurrence: string | null | undefined, isAllDay: boolean) {
  if (!recurrence) return true;
  const lines = recurrence.split("\n").filter(Boolean);
  if (!lines.some(line => /^(?:RRULE:)?FREQ=/.test(line))) return false;
  return lines.every(line => /^(?:RRULE:)?FREQ=/.test(line) ||
    /^(?:EXDATE|RDATE):\d{8}T\d{6}Z?(?:,\d{8}T\d{6}Z?)*$/.test(line) ||
    isAllDay && /^(?:EXDATE|RDATE);VALUE=DATE:\d{8}(?:,\d{8})*$/.test(line));
}
function pinnedEventProfile(event: Event, intent: EventOutboxIntent) {
  if (event.isCanceled && intent.action !== "delete") return false;
  if (!pinnedRecurrenceSyntax(event.recurrence, event.isAllDay)) return false;
  if (intent.provider === "microsoft" && event.recurrence) return false;
  const patch = intent.payload.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const fields = intent.provider === "microsoft" && intent.action === "update"
      ? ["title", "description", "location", "color"]
      : ["title", "description", "location", "start", "end", "isAllDay", "recurrence", "color", "url"];
    if (Object.keys(patch).some(key => !fields.includes(key))) return false;
    if (typeof patch.recurrence === "string" && !pinnedRecurrenceSyntax(patch.recurrence,
      typeof patch.isAllDay === "boolean" ? patch.isAllDay : event.isAllDay)) return false;
  }
  return true;
}
function pinnedTaskProfile(task: Task, intent: TaskOutboxIntent) {
  return !(intent.provider !== "caldav" && task.recurrence) &&
    pinnedRecurrenceSyntax(task.recurrence, task.isAllDay);
}

/** Existing host inputs outside v1 storage budgets keep their legacy profile.
 * Check only profile size here; malformed selected codec input still throws.
 * Generated codec values are lossless JSON, so these checks bound their size
 * without catching parser/admission errors or touching a PRESENT envelope.
 */
function oversizedV1Identity(...values: Array<string | null | undefined>) {
  return values.some(value => typeof value === "string" && value.length > 2048);
}
function boundedV1Plan(encoded: EncodedSyncWriteV1) {
  return SyncJsonObjectSchema.safeParse(encoded.admittedProjection.data).success &&
    SyncJsonObjectSchema.safeParse(encoded.nativePlan.data).success;
}

/** Called after canonical CAS under its existing lifecycle/row locks. Only new
 * supported generic profiles are encoded; historical/specialized intents retain
 * their explicit legacy profile. Never backfill or alter an existing envelope.
 */
export async function admitEventOperationInTransaction(tx: DbTransaction, event: Event, intent: EventOutboxIntent,
  predecessorID: string | null): Promise<EventOutboxRow["payload"]> {
  const payload = { ...intent.payload, event };
  if (!config.api.syncOperationV1EncoderEnabled || own(payload, "operationEnvelope") ||
      !providers.includes(intent.provider) || intent.provider === "caldav" && !physicalCaldavAccountKey(intent.accountID) ||
      eventSpecialized.some(key => own(payload, key)) ||
      event.hasAttendees || event.isMeeting || event.seriesID || event.originalStart ||
      event.timeModel && event.timeModel.kind !== "legacy-unknown" || !pinnedEventProfile(event, intent) ||
      oversizedV1Identity(intent.id, intent.mutationID, event.id, intent.externalCalendarLinkID, intent.accountID,
        intent.externalCalendarID, intent.externalEventID, predecessorID)) return payload;
  if (intent.action !== "create" && !intent.externalEventID && !predecessorID) return payload; // no native operation
  const captured = await capture(tx, intent, `event:${event.providerReadRetiredRevision ?? 0}`);
  if (!captured) return payload;
  const uid = intent.provider === "caldav" && intent.action !== "create"
    ? await nativeUid(tx, intent, event.id, "event", intent.icalUid, predecessorID) : intent.icalUid;
  if (intent.provider === "caldav" && intent.action !== "create" && !uid) return payload; // explicit unproven-UID legacy profile
  const encoded = encodeEventV1(intent.provider as SyncCodecProvider, event, payload.patch,
    { action: intent.action, operationId: intent.id!, uid: intent.action === "create" ? undefined : uid ?? undefined, acceptedAt: new Date().toISOString() });
  const resourceID = intent.externalEventID ?? (intent.action === "create" && intent.provider === "google"
    ? `musubi${intent.id!.toLowerCase().replace(/-/g, "")}`
    : intent.action === "create" && intent.provider === "caldav"
      ? `${intent.externalCalendarID.replace(/\/?$/, "/")}musubi-${intent.id!.toLowerCase()}.ics` : null);
  if (oversizedV1Identity(resourceID) || !boundedV1Plan(encoded)) return payload;
  return { ...payload, ...(intent.action === "create" ? { createIdentityVersion: 1 } : {}), operationCapture: captured, operationEnvelope: envelope(encoded,
    { kind: "event", action: intent.action, id: intent.id!, mutationID: intent.mutationID, hostID: event.id,
      revision: event.revision!, target: intent, resourceID, predecessorID }, captured) };
}
export async function admitTaskOperationInTransaction(tx: DbTransaction, task: Task, intent: TaskOutboxIntent,
  predecessorID: string | null): Promise<TaskOutboxRow["payload"]> {
  const payload = { ...intent.payload, task };
  if (!config.api.syncOperationV1EncoderEnabled || own(payload, "operationEnvelope") ||
      !providers.includes(intent.provider) || intent.provider === "caldav" && !physicalCaldavAccountKey(intent.accountID) ||
      !pinnedTaskProfile(task, intent) ||
      oversizedV1Identity(intent.id, intent.mutationID, task.id, intent.externalCalendarLinkID, intent.accountID,
        intent.externalCalendarID, intent.externalTaskID, predecessorID)) return payload;
  if (intent.action !== "create" && !intent.externalTaskID && !predecessorID) return payload;
  const captured = await capture(tx, intent, `task:${intent.retiredGeneration ?? 0}`);
  if (!captured) return payload;
  // Freeze the full target now. A predecessor/read may establish the baseline
  // later, but can never change this target or serialize it again.
  const uid = intent.provider === "caldav" && intent.action !== "create"
    ? await nativeUid(tx, intent, task.id, "task", intent.icalUid, predecessorID) : intent.icalUid;
  if (intent.provider === "caldav" && intent.action !== "create" && !uid) return payload;
  const encoded = encodeTaskV1(intent.provider as SyncCodecProvider, task, undefined,
    { action: intent.action, operationId: intent.id!, uid: intent.action === "create" ? task.id : uid ?? undefined, acceptedAt: new Date().toISOString() });
  const resourceID = intent.externalTaskID ?? (intent.action === "create" && intent.provider === "caldav"
    ? `${intent.externalCalendarID.replace(/\/?$/, "/")}${task.id}.ics` : null);
  if (oversizedV1Identity(resourceID) || !boundedV1Plan(encoded)) return payload;
  return { ...payload, operationCapture: captured, operationEnvelope: envelope(encoded,
    { kind: "task", action: intent.action, id: intent.id!, mutationID: intent.mutationID, hostID: task.id,
      revision: task.revision!, target: intent, resourceID, predecessorID }, captured) };
}

/** Current host fences, separate from portable codec availability. Read-window
 * generations do not retire write admission; permission generation, connection
 * incarnation and provider-read privacy retirement do. No HTTP under these locks.
 */
export async function assertPinnedOutboxSource(row: EventOutboxRow | TaskOutboxRow, allowDeletedObject = false) {
  return db.transaction(async tx => {
    await lockCalendarLifecycle(tx, [row.calendarID], "shared");
    return assertPinnedOutboxSourceInTransaction(tx, row, allowDeletedObject);
  });
}
/** Caller already holds lifecycle and canonical locks in admission/ACK order. */
export async function assertPinnedOutboxSourceInTransaction(tx: DbTransaction, row: EventOutboxRow | TaskOutboxRow, allowDeletedObject = false) {
  const parsed = SyncOperationCaptureSchema.safeParse(row.payload.operationCapture);
  if (!parsed.success) return false;
  const captured = parsed.data;
  const [source] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.id, row.externalCalendarLinkID),
    eq(externalCalendars.calendarID, row.calendarID), eq(externalCalendars.userID, row.userID), eq(externalCalendars.accountID, row.accountID),
    eq(externalCalendars.provider, row.provider), eq(externalCalendars.externalCalendarID, row.externalCalendarID))).for("share");
  if (!source || source.disabled || source.id !== captured.sourceId || source.providerAccessRevision !== captured.writeGeneration ||
      !("eventID" in row ? source.supportsEvents : source.supportsTasks)) return false;
  let connection: Awaited<ReturnType<typeof connectionCapture>>;
  try { connection = await connectionCapture(tx, row); } catch { return false; }
  if (!connection || connection.connectionId !== captured.connectionId || connection.connectionGeneration !== captured.connectionGeneration) return false;
  if ("eventID" in row) {
    const [current] = await tx.select({ deletedAt: events.deletedAt, retired: events.providerReadRetiredRevision }).from(events).where(eq(events.id, row.eventID));
    if (!current) return row.action === "delete" || allowDeletedObject;
    return captured.privacyEpoch === `event:${current.retired ?? 0}` && (allowDeletedObject || row.action === "delete" || !current.deletedAt);
  }
  const [current] = await tx.select({ deletedAt: tasks.deletedAt, retired: tasks.providerReadRetiredGeneration }).from(tasks).where(eq(tasks.id, row.taskID));
  if (!current) return row.action === "delete" || allowDeletedObject;
  return captured.privacyEpoch === `task:${current.retired ?? 0}` && (allowDeletedObject || row.action === "delete" || !current.deletedAt);
}
