import type { CaldavPersonalContentOperation } from "./caldav_personal_content";
import type { CaldavAlarmContext, CaldavAlarmIntent } from "@musubi/db";
import type { CaldavAlarmEvidence } from "./adapters/caldav_alarms";
import type { googleReminderInstanceTransport } from "./adapters/google_reminder_instance";
import type { GraphSeriesFamily } from "./adapters/microsoft_series_family";
import type { GoogleRsvpEvidence, GoogleRsvpResponse, GoogleRsvpOccurrence } from "./adapters/google_rsvp";
import type { GoogleOccurrenceIntent } from "@musubi/db";
import type { GoogleOccurrenceEvidence, GoogleSeriesEvidence } from "./adapters/google_occurrence";
import type { CaldavSeriesSplit, CaldavSeriesDeletion, CaldavSeriesIntent, CaldavSeriesEvidence, CaldavSeriesWrite, CaldavSeriesResolutionEvidence } from "./adapters/caldav_series";
import type { GoogleReminderWrite, ProviderEventState, Event, Task, TaskStatus, ProviderSettingTimeEvidence, EventTimeModel, OccurrenceStart } from "@musubi/types";
import type { EventContentPatch } from "@musubi/db";

// A calendar event reduced to what Musubi stores, provider-agnostic.
// Adapters translate their own format (Google JSON / Graph JSON / iCal) <-> this.
export type NormalizedEvent = {
  providerState?: ProviderEventState;
  creationOperationID?: string;
  providerOccurrence?: { externalSeriesID: string; originalStart: OccurrenceStart };
  // Native parent address for import admission only; never canonical identity.
  sourceSeriesID?: string;
  // Observation-only proof for pending reminders; never adopts canonical time.
  reminderTimeEvidence?: ProviderSettingTimeEvidence;
  timeModel?: EventTimeModel;
  externalSeriesID?: string | null;
  originalStart?: OccurrenceStart | null;
  isCanceled?: boolean;
  externalId: string;
  status: "active" | "cancelled"; // cancelled => delete locally
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  description: string | null;
  location: string | null;
  organizer: string | null;
  recurrence: string | null; // RRULE text, or null
  url: string | null;
  etag?: string | null; // exact provider validator when exposed; never synthesize from changeKey
  icalUid?: string | null; // preserve the remote UID across CalDAV writes
};

export type NormalizedTask = {
  externalId: string;
  deleted?: boolean;
  status: TaskStatus;
  title: string;
  description: string | null;
  start: Date | null;
  due: Date | null;
  isAllDay: boolean;
  completedAt: Date | null;
  percentComplete: number;
  priority: number;
  recurrence: string | null;
  relatedTo: string | null;
  sequence: number;
  url: string | null;
  etag?: string | null;
  icalUid?: string | null;
};

export type NormalizedChange =
  | { kind: "event"; data: NormalizedEvent }
  | { kind: "event-resource"; externalId: string; events: NormalizedEvent[] }
  | { kind: "task"; data: NormalizedTask };

export type ExternalEventRef = {
  externalEventId: string;
  etag?: string | null;
  icalUid?: string | null;
};

/** Identity of one persisted create intent, never a new ID on retry. */
export type EventCreateIdentity = { operationID: string; signal?: AbortSignal };
export type CreatedEventEvidence = {
  ref: ExternalEventRef;
  event: NormalizedEvent;
};

export type ExternalTaskRef = {
  beforeMutation?: () => Promise<void>;
  externalTaskId: string;
  etag?: string | null;
  icalUid?: string | null;
};

/** Provider-owned writable fields only, with dates encoded as JSON strings. */
export type TaskProjection = Record<string, unknown>;
export type TaskReadEvidence = { ref: ExternalTaskRef; projection: TaskProjection };
export type TaskPreparedWrite = import("@musubi/db").TaskPreparedDestination & { action: "create" | "update" | "delete" };
export type TaskWriteOperation = {
  action: "create" | "update" | "delete";
  task: Task;
  external?: ExternalTaskRef;
  projection?: TaskProjection;
  signal?: AbortSignal;
  secondary?: boolean;
};

export type EventWriteOperation = {
  signal?: AbortSignal;
  action: "create" | "update" | "delete";
  event: Event;
  previous?: Event;
  // Server-computed actual content diff; never a client full snapshot. Missing
  // is not an empty diff. CAS callers supply the committed transaction's patch.
  patch?: EventContentPatch;
  external?: ExternalEventRef;
  // Server-only: the handler validated the complete request intent and its ACLs.
  scopeEditValidated?: boolean;
};

export type ExternalCalendarInfo = {
  externalId: string;
  providerDefaultCalendar?: boolean | null;
  name: string;
  color: string;
  supportsEvents?: boolean;
  supportsTasks?: boolean;
  // Provider says the user can't write (holidays, subscribed calendars, …) →
  // mirror becomes read-only even for its owner.
  readOnly?: boolean;
  caldavAccess?: { read: boolean | null; readFreeBusy: boolean | null };
  microsoftAccess?: { canEdit: boolean | null; canViewPrivateItems: boolean | null };
  googleAccessRole?: "owner" | "writer" | "reader" | "writerWithoutPrivateAccess" | "unknown";
};

export type CalendarDiscoveryResult = {
  availabilityCalendars?: { externalId: string; name: string }[];
  calendars: ExternalCalendarInfo[];
  // False means optional task-list discovery was omitted or failed. Its absent
  // mirrors are not evidence of deletion and must not be fetched or swept.
  taskListsComplete: boolean;
};

export type FetchChangesResult = {
  changes: NormalizedChange[];
  nextCursor: string | null;
  reset?: boolean; // true => reconcile the complete collection snapshot (e.g. Google 410)
};

// Everything provider-specific lives behind this. The generic core (sync engine)
// never talks to Google/Graph/CalDAV directly — only through an adapter.
export type CalendarAdapter = {
  caldavOrganizer?: ReturnType<typeof import("./adapters/caldav_organizer_delivery").caldavOrganizerTransport>;
  observeGraphSeriesContent?: (context: import("@musubi/db").GraphMeetingContext, signal?: AbortSignal) => ReturnType<typeof import("./adapters/microsoft_series_content").observeGraphSeriesContent>;
  prepareGraphSeriesContent?: (context: import("@musubi/db").GraphMeetingContext, request: import("@musubi/types").MicrosoftRecurringContentRequest, signal?: AbortSignal) => Promise<import("@musubi/db").GraphOccurrenceContent>;
  observeGraphOccurrenceContent?: (context: import("@musubi/db").GraphMeetingContext, signal?: AbortSignal) => ReturnType<typeof import("./adapters/microsoft_occurrence_content").observeGraphOccurrenceContent>;
  prepareGraphOccurrenceContent?: (context: import("@musubi/db").GraphMeetingContext, request: import("@musubi/types").MicrosoftOccurrenceContentRequest, signal?: AbortSignal) => Promise<import("@musubi/db").GraphOccurrenceContent>;
  updateGraphOccurrenceContent?: (saved: import("@musubi/db").GraphOccurrenceContent, mark: () => Promise<void>, accepted: () => Promise<void>, signal?: AbortSignal) => ReturnType<typeof import("./adapters/microsoft_occurrence_content").updateGraphOccurrenceContent>;
  observeGraphMeetingCancellation?: (context: import("@musubi/db").GraphMeetingContext, signal?: AbortSignal) => ReturnType<typeof import("./adapters/microsoft_meeting_cancel").observeGraphMeetingCancellation>;
  prepareGraphMeetingCancellation?: (context: import("@musubi/db").GraphMeetingContext, request: import("@musubi/types").MicrosoftSeriesCancellationRequest, signal?: AbortSignal) => Promise<import("@musubi/db").GraphMeetingCancellation>;
  cancelGraphMeeting?: (saved: import("@musubi/db").GraphMeetingCancellation, mark: () => Promise<void>, accepted: () => Promise<void>, signal?: AbortSignal) => Promise<import("@musubi/db").GraphFamilyObservation | null>;
  microsoftOrganizer?: ReturnType<typeof import("./adapters/microsoft_organizer").microsoftOrganizerTransport>;
  organizer?: ReturnType<typeof import("./adapters/google_organizer_delivery").googleOrganizerTransport>;
  provider: string;
  readCaldavAlarm?(context: CaldavAlarmContext, signal?: AbortSignal): Promise<CaldavAlarmEvidence>;
  writeCaldavAlarm?(intent: CaldavAlarmIntent, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<CaldavAlarmEvidence>;
  createGraphFamily?(userID: string, accountID: string, calendarID: string, event: Event, identity: EventCreateIdentity, state: { uncertain: boolean; beforeWrite: () => Promise<void> }): Promise<GraphSeriesFamily>;
  readGraphCreateAdoption?(user: string, account: string, calendar: string, event: Event, identity: EventCreateIdentity): Promise<GraphSeriesFamily | null>;
  prepareGraphDeletion?(context: import("@musubi/db").GraphFamilyContext, request: unknown, signal?: AbortSignal): Promise<import("@musubi/db").GraphSeriesDeletionPrepared>;
  deleteGraphSeries?(saved: import("@musubi/db").GraphSeriesDeletionPrepared, reconciling: boolean, beforeWrite: () => Promise<void>, signal?: AbortSignal): Promise<import("@musubi/db").GraphFamilyObservation | null>;
  readGraphFamily?(userID: string, accountID: string, calendarID: string, template: Event, ref: ExternalEventRef, signal?: AbortSignal): Promise<GraphSeriesFamily | null>;
  readMicrosoftRsvp?(user: string, account: string, calendar: string, ref: ExternalEventRef, response: import("@musubi/types").ProviderRsvpEdit["response"], signal?: AbortSignal, occurrence?: import("@musubi/types").GraphRsvpOccurrence, series?: boolean): Promise<import("./adapters/microsoft_rsvp").MicrosoftRsvpEvidence>;
  writeMicrosoftRsvp?(user: string, account: string, calendar: string, evidence: import("./adapters/microsoft_rsvp").MicrosoftRsvpEvidence, dispatched: boolean, signal: AbortSignal, beforeDispatch: () => Promise<void>, accepted: () => Promise<void>): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof import("./adapters/microsoft_rsvp_delivery").graphRsvpSession>>["write"]>>>;
  readCaldavRsvp?(user: string, account: string, calendar: string, ref: ExternalEventRef, response: import("./adapters/caldav_rsvp").CaldavRsvpResponse, signal?: AbortSignal): Promise<import("./adapters/caldav_rsvp").CaldavRsvpEvidence>;
  writeCaldavRsvp?(user: string, account: string, calendar: string, evidence: import("./adapters/caldav_rsvp").CaldavRsvpEvidence, signal?: AbortSignal, beforeWrite?: () => Promise<void>, readOnly?: boolean): Promise<{ etag: string; recovered: boolean; notificationDelivery: "unknown"; confirmation: import("@musubi/types").CaldavRsvpConfirmation }>;
  readRsvp?(user: string, account: string, calendar: string, ref: ExternalEventRef, response: GoogleRsvpResponse, signal?: AbortSignal, occurrence?: GoogleRsvpOccurrence): Promise<GoogleRsvpEvidence>;
  readRsvpResolution?(user: string, account: string, calendar: string, ref: ExternalEventRef, response: GoogleRsvpResponse, signal?: AbortSignal, occurrence?: GoogleRsvpOccurrence): Promise<GoogleRsvpEvidence>;
  writeRsvp?(user: string, account: string, calendar: string, evidence: GoogleRsvpEvidence, policy: { sendUpdates: "all" }, signal?: AbortSignal, beforeWrite?: () => Promise<void>): Promise<{ etag: string; recovered: boolean; notificationDelivery: "unknown" }>;
  readCaldavSeries?(user: string, account: string, calendar: string, intent: CaldavSeriesIntent, signal?: AbortSignal, operation?: CaldavPersonalContentOperation): Promise<CaldavSeriesEvidence>;
  readCaldavSeriesDeletionResolution?(user: string, account: string, calendar: string, intent: CaldavSeriesIntent, before: string, signal?: AbortSignal): Promise<CaldavSeriesResolutionEvidence>;
  readCaldavSeriesResolution?(user: string, account: string, calendar: string, intent: CaldavSeriesIntent, before: string, signal?: AbortSignal, targetEventID?: string | null, operation?: CaldavPersonalContentOperation): Promise<CaldavSeriesResolutionEvidence>;
  readCaldavSeriesForDelete?(user: string, account: string, calendar: string, intent: CaldavSeriesIntent, signal?: AbortSignal): Promise<CaldavSeriesEvidence>;
  deleteCaldavSeries?(user: string, account: string, calendar: string, intent: CaldavSeriesDeletion, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<ExternalEventRef>;
  readCaldavSplitFuture?(user: string, account: string, calendar: string, intent: CaldavSeriesSplit, signal?: AbortSignal): Promise<CaldavSeriesEvidence | null>;
  assertCaldavSplitCreation?(user: string, account: string, calendar: string, intent: CaldavSeriesSplit, signal?: AbortSignal): Promise<void>;
  writeCaldavSplitSource?(user: string, account: string, calendar: string, intent: CaldavSeriesSplit, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<CaldavSeriesEvidence>;
  createCaldavSeries?(user: string, account: string, calendar: string, intent: CaldavSeriesSplit, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<CaldavSeriesEvidence>;
  writeCaldavSeries?(user: string, account: string, calendar: string, intent: CaldavSeriesWrite, signal?: AbortSignal, beforeMutation?: () => Promise<void>): Promise<CaldavSeriesEvidence>;
  readSeries?(user: string, account: string, calendar: string, intent: Pick<GoogleOccurrenceIntent, "master" | "masterExternalID" | "masterEtag">, signal?: AbortSignal): Promise<GoogleSeriesEvidence>;
  readOccurrence?(user: string, account: string, calendar: string, intent: GoogleOccurrenceIntent, ref?: ExternalEventRef, signal?: AbortSignal): Promise<GoogleOccurrenceEvidence>;
  recoverOccurrence?(user: string, account: string, calendar: string, intent: GoogleOccurrenceIntent, ref: ExternalEventRef, signal?: AbortSignal): Promise<GoogleOccurrenceEvidence>;
  writeOccurrence?(user: string, account: string, calendar: string, intent: GoogleOccurrenceIntent, event: Event, ref: ExternalEventRef, signal?: AbortSignal): Promise<GoogleOccurrenceEvidence>;
  reminderInstance?: ReturnType<typeof googleReminderInstanceTransport>;
  readReminderState?(userID: string, accountID: string, calendarID: string, ref: ExternalEventRef, signal?: AbortSignal): Promise<{ ref: ExternalEventRef; state: ProviderEventState; event: NormalizedEvent } | null>;
  writeReminders?(userID: string, accountID: string, calendarID: string, ref: ExternalEventRef, reminders: GoogleReminderWrite, signal?: AbortSignal, beforeWrite?: () => Promise<void>): Promise<{ ref: ExternalEventRef; state: ProviderEventState; event: NormalizedEvent }>;
  projectEvent?(event: Event): Pick<NormalizedEvent, "title" | "start" | "end" | "isAllDay" | "description" | "location" | "recurrence">;

  // Connected accounts for this provider (id = Better Auth account.accountId for
  // OAuth / caldav_accounts.id for CalDAV; label = human name e.g. email/username).
  // Empty = provider not connected.
  listAccounts(
    userID: string,
    accountId?: string,
  ): Promise<{ id: string; label: string }[]>;

  // Which calendars can this account sync?
  listCalendars(
    userID: string,
    accountId: string,
  ): Promise<CalendarDiscoveryResult>;

  // Pull changes since `cursor` (null = full sync). Adapter paginates internally
  // and returns the complete change set + the new cursor to persist.
  fetchChanges(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    cursor: string | null,
    options?: { excludedEventIDs?: readonly string[]; excludedSeriesIDs?: readonly string[] },
  ): Promise<FetchChangesResult>;

  // Read current provider evidence before any local mutation or provider write.
  // This is a preflight, not a reservation or a distributed transaction.
  assertEventWrite?(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    operation: EventWriteOperation,
  ): Promise<void>;

  // Push a Musubi event out. Adapter maps Event -> its own format.
  pushCreate(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    event: Event,
    identity?: EventCreateIdentity,
  ): Promise<ExternalEventRef>;
  // Read-only recovery. null means no matching live object was observed, not
  // permission to repeat a POST (Graph does not promise an infinite dedup window).
  findCreatedEvent?(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    identity: EventCreateIdentity,
  ): Promise<CreatedEventEvidence | null>;
  // Read current content without accepting its validator as a write baseline.
  readEvent?(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    ref: ExternalEventRef,
    signal?: AbortSignal,
  ): Promise<CreatedEventEvidence | null>;
  pushUpdate(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    externalEventId: string,
    event: Event,
    ref?: ExternalEventRef,
    patch?: EventContentPatch,
    signal?: AbortSignal,
  ): Promise<{ etag?: string | null; icalUid?: string | null } | void>;
  pushDelete(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    externalEventId: string,
    ref?: ExternalEventRef,
    signal?: AbortSignal,
  ): Promise<void>;

  pushTaskCreate?(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    task: Task,
    beforeMutation?: () => Promise<void>,
  ): Promise<ExternalTaskRef>;
  projectTask?(task: Task): TaskProjection;
  readTask?(userID: string, accountID: string, externalCalendarID: string, ref: ExternalTaskRef): Promise<TaskReadEvidence | null>;
  assertTaskWrite?(userID: string, accountID: string, externalCalendarID: string, operation: TaskWriteOperation): Promise<void>;
  pushTaskUpdate?(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    externalTaskId: string,
    task: Task,
    ref?: ExternalTaskRef,
    patch?: TaskProjection,
  ): Promise<{ etag?: string | null; icalUid?: string | null } | void>;
  pushTaskDelete?(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    externalTaskId: string,
    ref?: ExternalTaskRef,
  ): Promise<void>;

  // Calendar-level writes — create/rename/recolor/delete the calendar itself
  // on the provider. Callers must abort the local change when these throw.
  createCalendar(
    userID: string,
    accountId: string,
    data: { name: string; color: string },
  ): Promise<{ externalId: string }>;
  updateCalendar(
    userID: string,
    accountId: string,
    externalCalendarId: string,
    data: { name: string; color: string },
  ): Promise<void>;
  deleteCalendar(
    userID: string,
    accountId: string,
    externalCalendarId: string,
  ): Promise<void>;
};
