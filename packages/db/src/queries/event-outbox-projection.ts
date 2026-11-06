import { isDeepStrictEqual } from "node:util";
import { hasKnownEventTime, EventTimeModelSchema, OccurrenceStartSchema, type ProviderRsvpInstance, type Event, type GoogleReminderWrite, type ProviderEventState } from "@musubi/types";

type EventProjection = Pick<
  Event,
  | "title"
  | "start"
  | "end"
  | "isAllDay"
  | "description"
  | "location"
  | "recurrence"
>;

/** Compare the projection actually serialized by each EVENT adapter. Local
 * appearance and provider-owned organizer/meeting metadata are separate. */
export function matchesEventProviderProjection(
  provider: string,
  intended: EventProjection,
  observed: EventProjection,
) {
  const time = (value: Date) => {
    const milliseconds = new Date(value).getTime();
    return intended.isAllDay
      ? Math.floor(milliseconds / 86_400_000) * 86_400_000
      : provider === "caldav"
        ? Math.floor(milliseconds / 1000) * 1000
        : milliseconds;
  };
  const text = (value: string | null | undefined) =>
    (provider === "microsoft" ? value?.trim() : value) || null;
  const recurrence = (value: string | null | undefined) =>
    value
      ? [...new Set(value.split("\n").filter(Boolean))].sort().join("\n")
      : null;
  return (
    intended.title === observed.title &&
    intended.isAllDay === observed.isAllDay &&
    time(intended.start) === new Date(observed.start).getTime() &&
    time(intended.end) === new Date(observed.end).getTime() &&
    text(intended.description) === (observed.description || null) &&
    text(intended.location) === (observed.location || null) &&
    recurrence(intended.recurrence) === recurrence(observed.recurrence)
  );
}

/** Cancellation-only instances have identity, not the former overridden content. */
export function matchesGoogleOccurrenceProjection(
  expected: Event,
  actual: EventProjection & Partial<Pick<Event, "timeModel" | "originalStart" | "isCanceled">>,
) {
  const original = (value: unknown) => JSON.stringify(OccurrenceStartSchema.parse(value));
  const model = (value: unknown) => JSON.stringify(EventTimeModelSchema.parse(value));
  return !!expected.originalStart && !!actual.originalStart && original(expected.originalStart) === original(actual.originalStart) &&
    !!expected.isCanceled === !!actual.isCanceled &&
    (!!expected.isCanceled || (matchesEventProviderProjection("google", expected, actual) && model(expected.timeModel) === model(actual.timeModel)));
}

/** Shared by worker and pending pull; an equal instant is not evidence for a
 * different native civil model or occurrence identity. */
export function matchesReminderEventProjection(
  provider: string,
  expected: Event,
  actual: EventProjection & Partial<Pick<Event, "timeModel" | "seriesID" | "originalStart" | "isCanceled">> & { externalSeriesID?: string | null },
) {
  if (!matchesEventProviderProjection(provider, expected, actual) || expected.recurrence || expected.seriesID || expected.originalStart || expected.isCanceled || actual.recurrence || actual.seriesID || actual.externalSeriesID || actual.originalStart || actual.isCanceled) return false;
  if (!hasKnownEventTime(expected)) return true;
  if (provider !== "google" || !["zoned", "all-day"].includes(expected.timeModel!.kind)) return false;
  const observed = EventTimeModelSchema.safeParse(actual.timeModel);
  return observed.success && JSON.stringify(EventTimeModelSchema.parse(expected.timeModel)) === JSON.stringify(observed.data);
}

export function matchesGoogleReminderIntent(intent: GoogleReminderWrite, state: ProviderEventState | undefined) {
  if (state?.provider !== "google" || state.reminders.provider !== "google" || intent.useDefault !== state.reminders.useDefault) return false;
  if (intent.useDefault) return true;
  const canonical = (items: { method: string | null; minutes: number | null }[]) => JSON.stringify(items.map(item => [item.method, item.minutes]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return canonical(intent.overrides) === canonical(state.reminders.overrides);
}


/** RSVP may target a bound existing child. Reminder edits retain their separate
 * one-off contract; neither equal instants nor social attendance bind a slot. */
export function matchesRsvpEventProjection(
  provider: string,
  expected: Event,
  actual: EventProjection & Partial<Pick<Event, "timeModel" | "seriesID" | "originalStart" | "isCanceled">> & { externalSeriesID?: string | null },
  instance?: ProviderRsvpInstance,
  graphOccurrence?: import("@musubi/types").GraphRsvpOccurrence,
) {
  if (provider === "microsoft" && graphOccurrence) {
    const observed = EventTimeModelSchema.safeParse(actual.timeModel);
    return !instance && !expected.seriesID && !expected.originalStart && !expected.recurrence && !expected.isCanceled &&
      !actual.seriesID && !actual.recurrence && !actual.isCanceled && actual.externalSeriesID === graphOccurrence.externalSeriesID &&
      JSON.stringify(actual.originalStart) === JSON.stringify(graphOccurrence.originalStart) && observed.success &&
      ["zoned", "all-day"].includes(observed.data.kind) && matchesEventProviderProjection(provider, expected, actual);
  }
  if (provider === "caldav" || provider === "microsoft") {
    const observed = EventTimeModelSchema.safeParse(actual.timeModel);
    return !instance && !expected.recurrence && !expected.seriesID && !expected.originalStart && !expected.isCanceled && !actual.recurrence && !actual.seriesID && !actual.externalSeriesID && !actual.originalStart && !actual.isCanceled && observed.success && ["zoned", "all-day"].includes(observed.data.kind) && (provider === "microsoft" || hasKnownEventTime(expected) && JSON.stringify(EventTimeModelSchema.parse(expected.timeModel)) === JSON.stringify(observed.data)) && matchesEventProviderProjection(provider, expected, actual);
  }
  if (!instance) return matchesReminderEventProjection(provider, expected, actual);
  const original = OccurrenceStartSchema.safeParse(expected.originalStart);
  const binding = OccurrenceStartSchema.safeParse(instance.originalStart);
  if (provider !== "google" || expected.seriesID !== instance.seriesID || expected.recurrence || actual.recurrence || expected.isCanceled || actual.isCanceled ||
      !original.success || !binding.success || JSON.stringify(original.data) !== JSON.stringify(binding.data) ||
      !hasKnownEventTime(expected) || !["zoned", "all-day"].includes(expected.timeModel!.kind) ||
      (!actual.seriesID && !actual.externalSeriesID) || (actual.seriesID && actual.seriesID !== instance.seriesID) ||
      (actual.externalSeriesID && actual.externalSeriesID !== instance.externalSeriesID)) return false;
  return matchesGoogleOccurrenceProjection(expected, actual);
}

type MirrorCanonical = EventProjection & Pick<Event, "organizer" | "url" | "seriesID" | "originalStart" | "isCanceled" | "hasAttendees"> & { deletedAt: Date | null };
type MirrorObservation = EventProjection & Pick<Event, "organizer" | "url">;

/** Provider-owned metadata of a copy Musubi wrote. Returns null only when the
 * observation proves the same serialized content and the same personal,
 * non-meeting shape; otherwise the first failing guard name and, for a changed
 * baseline, its differing field NAMES. Never returns provider values. */
export function ownMirrorMetadataMismatch(input: {
  provider: string;
  canonical: MirrorCanonical;
  values: MirrorObservation;
  state: ProviderEventState;
  baseline: ProviderEventState | null;
}): null | { guard: string; stateFields?: string[] } {
  const { provider, canonical, values, state, baseline } = input;
  if (!["google", "microsoft", "caldav"].includes(provider)) return { guard: "provider" };
  if (!matchesEventProviderProjection(provider, canonical, values)) return { guard: "content" };
  if (values.url !== null && values.url !== canonical.url) return { guard: "url" };
  if (canonical.recurrence || values.recurrence || canonical.seriesID || canonical.originalStart || canonical.isCanceled || canonical.hasAttendees || canonical.deletedAt)
    return { guard: "shape" };
  const active = provider === "microsoft" ? state.status === "active" : provider === "google" ? state.status === "confirmed" : state.status === null || state.status.toUpperCase() === "CONFIRMED";
  const type = provider === "microsoft" ? state.eventType === "singleInstance" : provider === "google" ? state.eventType === null || state.eventType === "default" : state.eventType === null;
  if (state.provider !== provider || state.attendees.length || !state.attendeesComplete || state.conferenceURLs.length || !active || !type)
    return { guard: "state" };
  // Musubi never serializes an organizer for these providers. Only the
  // provider's own self-organizer evidence may explain a different value.
  if (values.organizer !== canonical.organizer) {
    const self = provider === "caldav"
      ? state.organizer === null && values.organizer === ""
      : state.isOrganizer === true && !!state.organizer?.address && state.organizer.address.toLowerCase() === values.organizer.toLowerCase();
    if (!self) return { guard: "organizer" };
  }
  if (baseline) {
    if (!isDeepStrictEqual(state, baseline)) {
      const fields = [...new Set([...Object.keys(state), ...Object.keys(baseline)])]
        .filter(key => !isDeepStrictEqual(state[key as keyof ProviderEventState], baseline[key as keyof ProviderEventState])).sort();
      return { guard: "baseline", stateFields: fields };
    }
  } else {
    const defaultPrivacy = provider === "microsoft" ? state.privacy === "normal" : provider === "google" ? state.privacy === null || state.privacy === "default" : state.privacy === null || state.privacy.toUpperCase() === "PUBLIC";
    if (!defaultPrivacy) return { guard: "baseline", stateFields: ["privacy"] };
  }
  return null;
}
