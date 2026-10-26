import type { Event, EventTimeModel, OccurrenceStart, ProviderEventState, ProviderSettingTimeEvidence } from "@musubi/types";

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

export type ExternalEventRef = {
  externalEventId: string;
  etag?: string | null;
  icalUid?: string | null;
};

export type CreatedEventEvidence = {
  ref: ExternalEventRef;
  event: NormalizedEvent;
};

export type AcceptedEventUpdateContext = {
  operationId: string;
  attemptId: string;
  serializer: { id: "google-personal-event"; version: 1 };
  connectionId: string;
  connectionGeneration: number;
  beforeMutation: () => Promise<void>;
};

export type EventCompatibilityPatch = Partial<Pick<Event, "title" | "color" | "start" | "end" | "isAllDay" | "description" | "location" | "isCanceled" | "hasAttendees" | "organizer" | "recurrence" | "url">>;
