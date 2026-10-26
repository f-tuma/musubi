import type { Event, ProviderEventState } from "@musubi/types";
import type { RuntimeAttemptOptions } from "./ports";
import type { AcceptedEventUpdateContext, CreatedEventEvidence, EventCompatibilityPatch, ExternalEventRef, NormalizedEvent } from "./event-compatibility-types";

export type EventCompatibilityFamily = "graphOccurrenceContent" | "graphMeetingCancellation" | "organizer" | "reminderInstance" |
  "graphSeriesDeletion" | "graphSeriesCreate" | "caldavAlarm" | "caldavSplit" | "caldavSeriesDeletion" | "caldavSeries" | "googleOccurrence" |
  "microsoftRsvp" | "caldavRsvp" | "googleRsvp" | "reminderEdit" | "generic";
export interface EventCompatibilityPreparation {
  readonly family: EventCompatibilityFamily;
  readonly profile: "shared-host-compatibility";
  readonly operationId: string;
  readonly provider: string;
  readonly action: "create" | "update" | "delete";
  readonly attempts: number;
  readonly reconciling: boolean;
  readonly event: Event;
  readonly priorDispatch: boolean;
  readonly caldavDispatchPossible: boolean;
  readonly expectedRef?: ExternalEventRef | null;
  readonly canReadEvent: boolean;
  readonly skipConflictRead: boolean;
  readonly generic?: {
    readonly expected: Event;
    readonly saveProjection: boolean;
    readonly identity: boolean;
    readonly patch?: EventCompatibilityPatch;
    readonly predecessor: boolean;
    readonly findCreated: boolean;
    readonly firstExplicitResolution?: { readonly expectedRemoteExists: boolean; readonly expectedRemoteEtag: string | null };
  };
}
export interface EventCompatibilitySnapshot {
  readonly isEcho?: boolean;
  readonly providerState?: ProviderEventState;
  readonly externalEventId: string;
  readonly values?: Record<string, unknown>;
  readonly etag: string | null;
  readonly icalUid?: string | null;
  readonly deleted: boolean;
  readonly observedAt: string;
}
export interface EventCompatibilityObservation {
  readonly ref: ExternalEventRef;
  readonly event?: NormalizedEvent;
  readonly state?: ProviderEventState;
}
export type EventCompatibilityNativeOutcome =
  | { readonly kind: "observed"; readonly observation?: EventCompatibilityObservation }
  | { readonly kind: "deleted" | "rejected" | "absent" | "unconfirmed" };
export type EventCompatibilityConfirmation = "graphOccurrenceContent" | "graphMeetingCancellation" | "organizer" | "reminderInstance" |
  "graphSeriesDeletion" | "graphSeriesCreate" | "caldavAlarm" | "caldavSplit" | "caldavSeriesDeletion" | "caldavSeries" | "revision" | "rsvp" | "reminderEdit";
export type EventCompatibilityMark = "graphOccurrenceContent" | "graphMeetingCancellation" | "organizer" | "microsoftRsvp" | "caldavRsvp";
export type EventCompatibilityCompletion =
  | { readonly family: "graphOccurrenceContent" | "graphMeetingCancellation" | "organizer" | "graphSeriesDeletion" | "graphSeriesCreate" }
  | { readonly family: "caldavAlarm"; readonly observation: EventCompatibilityObservation }
  | { readonly family: "caldavSplit" | "caldavSeriesDeletion" | "caldavSeries"; readonly ref: ExternalEventRef }
  | { readonly family: "generic" | "googleOccurrence" | "reminderEdit" | "reminderInstance" | "microsoftRsvp" | "caldavRsvp" | "googleRsvp";
      readonly resultRef: ExternalEventRef | null; readonly expectedRef: ExternalEventRef | null; readonly snapshot?: EventCompatibilitySnapshot };
export interface EventCompatibilityFailureInfo { readonly code: string; readonly outcome: "not-written" | "unconfirmed"; readonly providerStatus?: number; readonly retryAfterMs?: number }
export interface EventCompatibilityFacts {
  /** Historical pessimistic uncertainty control, not proven HTTP acceptance. */
  readonly mutationStarted: boolean;
  readonly caldavDispatchPossible: boolean;
  readonly writerFulfilled: boolean;
  readonly expectedRef: ExternalEventRef | null;
  readonly resultRef: ExternalEventRef | null;
  readonly remoteSnapshot: EventCompatibilitySnapshot | null;
}
export interface EventCompatibilityFinish {
  readonly status: "blocked" | "cancelled" | "unconfirmed";
  readonly code: string;
  readonly uncertain: boolean;
  readonly retry: "none" | "organizer" | "hour";
  readonly remoteSnapshot?: EventCompatibilitySnapshot;
}
export interface EventCompatibilityHostPorts {
  prepare(signal: AbortSignal): Promise<EventCompatibilityPreparation>;
  /** Existing host-native parsers and evidence validators; capture the paired
   * ref at its original point, including validation failures after that point. */
  prepareNative(family: EventCompatibilityFamily, captureRef: (ref: ExternalEventRef) => void, signal: AbortSignal): Promise<void>;
  nativeRef(family: "caldavRsvp"): ExternalEventRef;
  confirm(kind: EventCompatibilityConfirmation, signal: AbortSignal): Promise<boolean>;
  checkDestination(uncertain: boolean, signal: AbortSignal): Promise<boolean>;
  mark(kind: EventCompatibilityMark, accepted: boolean, signal: AbortSignal): Promise<boolean>;
  complete(input: EventCompatibilityCompletion, signal: AbortSignal): Promise<boolean>;
  stop(kind: "graphOccurrenceContent" | "graphMeetingCancellation" | "organizer", rejected: boolean): Promise<boolean>;
  expectedRef(signal: AbortSignal): Promise<ExternalEventRef | null>;
  saveProjection(signal: AbortSignal): Promise<boolean>;
  acceptedUpdate(signal: AbortSignal): Promise<Omit<AcceptedEventUpdateContext, "beforeMutation"> | null>;
  knownCreateId(signal: AbortSignal): string | undefined;
  deletedCreate(id: string, signal: AbortSignal): Promise<boolean>;
  matches(kind: "delivered" | "occurrence-desired" | "occurrence-baseline" | "reminder-intent" | "reminder-event" | "reminder-instance",
    observed: EventCompatibilityObservation, expected?: Event): boolean;
  prepareGraphFamilyObservation(signal: AbortSignal): void;
  finish(input: EventCompatibilityFinish): Promise<void>;
  fail(cause: unknown, facts: EventCompatibilityFacts): Promise<void>;
  failure(code: string, outcome?: "not-written" | "unconfirmed"): Error;
  errorInfo(error: unknown): EventCompatibilityFailureInfo | undefined;
  sameAcceptedVersion(expected: ExternalEventRef, current: ExternalEventRef): boolean;
  renew(signal: AbortSignal): Promise<boolean>;
  now(): number;
}
export type EventCompatibilityRead =
  | { readonly family: "generic"; readonly ref: ExternalEventRef; readonly acceptedUpdate?: AcceptedEventUpdateContext }
  | { readonly family: "find-created"; readonly identity: { readonly operationID: string; readonly signal: AbortSignal } }
  | { readonly family: "googleOccurrence"; readonly ref: ExternalEventRef; readonly recover: boolean }
  | { readonly family: "reminderEdit"; readonly ref: ExternalEventRef };
export type EventCompatibilityDelivery =
  | { readonly family: "graphOccurrenceContent" | "graphMeetingCancellation" | "organizer"; readonly mark: () => Promise<void>; readonly accepted: () => Promise<void> }
  | { readonly family: "reminderInstance" | "graphSeriesDeletion" | "graphSeriesCreate" | "caldavAlarm" | "caldavSplit" | "caldavSeriesDeletion" | "caldavSeries" | "microsoftRsvp" | "caldavRsvp" | "googleRsvp"; readonly mark: () => Promise<void>; readonly accepted?: () => Promise<void> }
  | { readonly family: "googleOccurrence"; readonly ref: ExternalEventRef; readonly event: Event }
  | { readonly family: "reminderEdit"; readonly ref: ExternalEventRef; readonly mark: () => Promise<void> }
  | { readonly family: "generic"; readonly action: "create" | "update" | "delete"; readonly event: Event; readonly ref: ExternalEventRef | null;
      readonly patch?: EventCompatibilityPatch; readonly identity?: { readonly operationID: string; readonly signal: AbortSignal }; readonly acceptedUpdate?: AcceptedEventUpdateContext };
export interface EventCompatibilityNativePorts {
  read(input: EventCompatibilityRead, signal: AbortSignal): Promise<EventCompatibilityObservation | null>;
  deliver(input: EventCompatibilityDelivery, signal: AbortSignal): Promise<EventCompatibilityNativeOutcome>;
  preflight(event: Event, ref: ExternalEventRef | null, patch: EventCompatibilityPatch | undefined, acceptedUpdate: AcceptedEventUpdateContext | undefined, signal: AbortSignal): Promise<void>;
}
export type EventCompatibilityAttemptOptions = RuntimeAttemptOptions;
