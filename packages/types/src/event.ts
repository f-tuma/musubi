import { z } from "zod";
import { EventTimeModelSchema, OccurrenceStartSchema, EventTimeEditSchema, type EventTimeEdit, hasKnownEventTime } from "./event_time";
import { WireOffsetDateTimeSchema } from "./wire_primitives";

export const EventRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const EventSchema = z.object({
  id: z.string(),
  // Optional only for old disk caches. Absence never grants a writable revision.
  revision: EventRevisionSchema.optional(),
  providerReadRetiredRevision: EventRevisionSchema.nullish().transform((value): number | null | undefined => value ?? undefined).optional(),
  timeModel: EventTimeModelSchema.nullish(),
  seriesID: z.string().uuid().transform(value => value.toLowerCase()).nullish(),
  originalStart: OccurrenceStartSchema.nullish(),
  creatorID: z.string(),
  organizer: z.string(),
  title: z.string(),
  color: z.string(),
  start: z.coerce.date(),
  end: z.coerce.date(),
  calendars: z.array(z.string()),
  originCalendarID: z.string().nullish(),
  isCanceled: z.boolean(),
  isAllDay: z.boolean(),
  hasAttendees: z.boolean().default(false),
  /** Read-only classification, including provider invitations. */
  isMeeting: z.boolean().optional(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  recurrence: z.string().nullish(),
  url: z.string().nullish(),
});

export type Event = z.infer<typeof EventSchema>;

const eventWriteDate = z
  .union([z.date(), WireOffsetDateTimeSchema])
  .pipe(z.coerce.date());
export const EventCreateRequestSchema = EventSchema.omit({ isMeeting: true, providerReadRetiredRevision: true, revision: true, timeModel: true, seriesID: true, originalStart: true })
  .extend({ start: eventWriteDate, end: eventWriteDate })
  .strict();
export const EventPatchSchema = EventSchema.omit({
  isMeeting: true,
  id: true,
  providerReadRetiredRevision: true,
  revision: true,
  creatorID: true,
  originCalendarID: true,
  timeModel: true,
  seriesID: true,
  originalStart: true,
})
  .extend({
    // Read defaults must never turn an omitted PATCH field into a write.
    hasAttendees: z.boolean(),
    start: eventWriteDate,
    end: eventWriteDate,
  })
  .partial()
  .strict();
export type EventPatch = z.infer<typeof EventPatchSchema>;
const patchRequest = z
  .object({
    id: z.string().uuid(),
    expectedRevision: EventRevisionSchema,
    patch: EventPatchSchema,
  })
  .strict();
export const ScopeEditIntentSchema = z
  .object({
    updates: z.array(patchRequest).length(1),
    creates: z.array(EventCreateRequestSchema).max(1),
  })
  .strict();
export const EventPatchRequestSchema = patchRequest.extend({
  scopeEdit: ScopeEditIntentSchema.optional(),
});
export type EventPatchRequest = z.infer<typeof EventPatchRequestSchema>;
// Content that can share the local time transaction. Membership, meeting
// identity, cancellation and occurrence scope use their dedicated operations.
export const EventTimeContentPatchSchema = EventPatchSchema.pick({
  title: true,
  color: true,
  description: true,
  location: true,
  url: true,
  recurrence: true,
}).strict();
export type EventTimeContentPatch = z.infer<typeof EventTimeContentPatchSchema>;
export const EventTimeEditRequestSchema = z.object({
  expectedRevision: EventRevisionSchema,
  time: EventTimeEditSchema,
  patch: EventTimeContentPatchSchema.optional(),
}).strict();
export type EventTimeEditRequest = z.infer<typeof EventTimeEditRequestSchema>;

export const EventTimeCreateRequestSchema = z.object({
  event: EventCreateRequestSchema.omit({ start: true, end: true, isAllDay: true }).extend({
    id: z.string().uuid(),
    calendars: z.array(z.string().uuid()).min(1).max(100),
    originCalendarID: z.string().uuid().nullish(),
  }).strict(),
  time: EventTimeEditSchema,
}).strict();

export function eventCreateOperation(event: EventWriteRequest) {
  if (!event.timeEdit) return { path: "/events" as const, body: eventCreateRequest(event) };
  if (event.seriesID || event.originalStart || event.scopeEdit)
    throw new Error("This draft requires an occurrence-aware create. No changes were saved.");
  const { isMeeting, providerReadRetiredRevision, start, end, isAllDay, revision, timeModel, seriesID, originalStart, ...content } = EventSchema.parse(event);
  return { path: "/events/time" as const, body: EventTimeCreateRequestSchema.parse({ event: content, time: event.timeEdit }) };
}

export const EventDeleteRequestSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: EventRevisionSchema,
  })
  .strict();
export const EventUnlinkRequestSchema = EventDeleteRequestSchema.extend({
  unlinkCalendarID: z.string().uuid(),
});
export const EventLinkRequestSchema = z
  .object({
    calendarID: z.string().uuid(),
    expectedRevision: EventRevisionSchema,
  })
  .strict();
export const EventForkRequestSchema = EventLinkRequestSchema;

// UI request-only fields. Transports encode the distinct wire contracts above;
// EventSchema strips these fields before any cache, SSE or provider use.
export type EventWriteRequest = Event & {
  contentPatch?: EventPatch;
  timeEdit?: EventTimeEdit;
  scopeEdit?: { updates: EventWriteRequest[]; creates: Event[] };
};

export function requireEventRevision(event: Pick<Event, "revision">): number {
  const parsed = EventRevisionSchema.safeParse(event.revision);
  if (!parsed.success)
    throw new Error(
      "Refresh this event before editing. Its saved revision is unavailable.",
    );
  return parsed.data;
}

export function eventContentPatch(baseline: Event, edited: Event): EventPatch {
  const patch: EventPatch = {};
  const fields = Object.keys(EventPatchSchema.shape) as (keyof EventPatch)[];
  for (const key of fields) {
    const value = edited[key];
    if (value === undefined) continue;
    const comparable = (v: unknown) =>
      v instanceof Date
        ? v.toISOString()
        : Array.isArray(v)
          ? [...new Set(v)].sort().join("\n")
          : (v ?? null);
    if (comparable(value) !== comparable(baseline[key]))
      Object.assign(patch, { [key]: value });
  }
  return patch;
}

export function eventPatchRequest(event: EventWriteRequest): EventPatchRequest {
  if (event.timeEdit) throw new Error("This draft requires an atomic time edit. No changes were saved.");
  const request = {
    id: event.id,
    expectedRevision: requireEventRevision(event),
    patch:
      event.contentPatch ??
      EventPatchSchema.parse(
        Object.fromEntries(
          Object.keys(EventPatchSchema.shape).map((key) => [
            key,
            event[key as keyof Event],
          ]),
        ),
      ),
  };
  return {
    ...request,
    ...(event.scopeEdit
      ? {
          scopeEdit: {
            updates: event.scopeEdit.updates.map((update) =>
              eventPatchRequest({ ...update, scopeEdit: undefined }),
            ),
            creates: event.scopeEdit.creates.map(eventCreateRequest),
          },
        }
      : {}),
  };
}

/** Select the complete write before either home or federation transport runs. */
export function eventUpdateOperation(event: EventWriteRequest): { path: `/events${string}`; method: "PATCH" | "PUT"; body: EventPatchRequest | EventTimeEditRequest } {
  if (!event.timeEdit) return { path: "/events", method: "PATCH" as const, body: eventPatchRequest(event) };
  if (event.scopeEdit || event.seriesID || event.originalStart || !event.contentPatch)
    throw new Error("This time change requires an occurrence-aware scope edit. No changes were saved.");
  const { start: _start, end: _end, isAllDay: _allDay, ...content } = event.contentPatch;
  const parsed = EventTimeContentPatchSchema.safeParse(content);
  if (!parsed.success)
    throw new Error("Save calendar or meeting changes separately from time changes. No changes were saved.");
  const body = EventTimeEditRequestSchema.parse({
    expectedRevision: requireEventRevision(event), time: event.timeEdit, patch: parsed.data,
  });
  return { path: `/events/${encodeURIComponent(event.id)}/time`, method: "PUT" as const, body };
}

export function eventCreateRequest(
  event: Event,
): z.infer<typeof EventCreateRequestSchema> {
  if (hasKnownEventTime(event))
    throw new Error("This event requires a time-model-aware copy. No changes were saved.");
  const { isMeeting: _isMeeting, providerReadRetiredRevision: _retiredRevision, revision: _revision, timeModel: _timeModel, seriesID: _seriesID, originalStart: _originalStart, ...create } = EventSchema.parse(event);
  return EventCreateRequestSchema.parse(create);
}

export function editedEvent(baseline: Event, edited: Event): EventWriteRequest {
  return {
    ...edited,
    revision: baseline.revision,
    contentPatch: eventContentPatch(baseline, edited),
  };
}

export const EventMutationFailureSchema = z.object({
  error: z.string(),
  code: z.string(),
  localCommitted: z.boolean(),
  current: EventSchema.extend({
    deletedAt: z.coerce.date().nullish(),
  }).optional(),
  currentRevision: EventRevisionSchema.optional(),
  // Last committed snapshots are evidence, never confirmed-latest cache authority.
  committed: z.array(EventSchema.extend({ deletedAt: z.coerce.date().nullish() })).optional(),
});
export class EventMutationError extends Error {
  constructor(
    message: string,
    readonly localCommitted: boolean,
    readonly current?: Event & { deletedAt?: Date | null },
    readonly code?: string,
  ) {
    super(message);
    this.name = "EventMutationError";
  }
  static from(payload: unknown) {
    const parsed = EventMutationFailureSchema.parse(payload);
    return new EventMutationError(
      parsed.error,
      parsed.localCommitted,
      parsed.current,
      parsed.code,
    );
  }
}

/** A draft owns dates and links as well as content and the read revision. */
export function snapshotEvent(event: Event): Event {
  const snapshot = EventSchema.parse(event);
  return {
    ...snapshot,
    start: new Date(snapshot.start),
    end: new Date(snapshot.end),
    calendars: [...snapshot.calendars],
  };
}
