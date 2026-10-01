import { microsoftAdapter } from "../sync/adapters/microsoft";
import { queueProviderOrganizer, observeProviderOrganizer, observeOrganizerCalendar } from "../sync/provider_organizer";
import { caldavAlarmObservation, queueCaldavAlarms } from "../sync/caldav_alarms";
import { queueGoogleReminders } from "../sync/provider_reminders";
import { resolveEventTimeEdit } from "@musubi/calendar";
import { queueGraphSeriesCreateRequest, findGraphSeriesCreateRequest } from "../sync/graph_series_create";
import { queueProviderRsvp, observeCaldavRsvp, observeMicrosoftRsvp } from "../sync/provider_rsvp";
import { prepareCaldavSeries, prepareCaldavSeriesDelete, prepareCaldavSplit } from "../sync/caldav_scope";
import { ProviderEventWriteError } from "../sync/event_write";
import { prepareGoogleOccurrence } from "../sync/google_scope";
import { config } from "@musubi/config";
import { eventMutationIdentity } from "./event_mutation";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import {
  type AttendanceStatus,
  type NewEvent,
  applyLocalEventScope,
  createEvent,
  createLocalEventWithTime,
  forkLocalEventWithTimeAtRevision,
  diffEventContent,
  forkEventAtRevision,
  getCalendarMembers,
  getEventSnapshot,
  readEventCreateReceipt,
  getExternalLinkForCalendar,
  readGraphSeriesCreateReceipt,
  getOwnProviderEventObservation,
  getEventAttendees,
  getEventOrigin,
  getUsersEvents,
  patchEventAndCalendarLinks,
  replaceLocalEventTimeAtRevision,
  setAttendance,
} from "@musubi/db";
import {
  BadRequestError,
  OrganizerAdmissionRejectedError,
  type Event,
  EventSchema,
  EventTimeEditRequestSchema,
  EventTimeCreateRequestSchema,
  hasKnownEventTime,
  eventCreateRequest,
  EventCreateRequestSchema,
  EventDeleteRequestSchema,
  EventUnlinkRequestSchema,
  EventLinkRequestSchema,
  EventForkRequestSchema,
  EventPatchRequestSchema,
  type EventPatchRequest,
  EventWriteError,
  NotFoundError,
} from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import {
  prepareEventWrites,
  type CalendarEventWrite,
} from "../sync/engine";
import { committedFailure } from "./event_commit";
import { assertCanViewEvent } from "../permissions";
import {
  assertEventCalendarAccess,
  assertEventContentAccess,
  hasEventCalendarAccess,
} from "../event_permissions";
import {
  dropEventNotifications,
  queueEventChange,
} from "../event_notifications";
import {
  optionalDateQuery,
  optionalDateRangeQuery,
  requireUUID,
} from "../request_validation";

const MAX_EVENT_RANGE_MS = 3 * 366 * 24 * 60 * 60 * 1000;

async function currentEvent(id: string) {
  const row = await getEventSnapshot(id);
  if (!row) throw new NotFoundError("Event not found.");
  return row;
}

function conflict(res: Response, current: Event) {
  return res.status(409).json({
    error:
      "This event changed after editing began. Your draft was kept. Refresh and reconcile before saving again.",
    code: "event-revision-conflict",
    localCommitted: false,
    current,
    currentRevision: current.revision,
  });
}

/** Authenticated actor metadata is additive; it never changes recipients. */
export function eventStreamPayload(result: Record<string, unknown>, actorID: string) {
  return { ...result, actorID };
}

async function notifyEvent(
  calendars: string[],
  type: "event_created" | "event_updated" | "event_removed",
  result: Record<string, unknown>,
  actorID: string,
) {
  const members = new Set<string>();
  for (const calendarID of new Set(calendars)) {
    for (const member of await getCalendarMembers(calendarID))
      members.add(member.userID);
  }
  notifyCalendarMembers([...members], type, eventStreamPayload(result, actorID));
}

/** The local commit is final. Never claim a provider failure undid it, and never
 * expose internal account/resource identities in a collaborator's receipt. */
async function sendCommitted(
  res: Response,
  deliver: Awaited<ReturnType<typeof prepareEventWrites>>,
  event: Event,
  result: unknown,
  status = 200,
  afterCommit: () => Promise<void> = async () => {},
) {
  try {
    await afterCommit();
    await deliver(undefined, event.revision);
  } catch (error) {
    const failure = committedFailure(error, [event]);
    // Reconciliation is optional. Purge or database failure cannot erase commit truth.
    let current: Event | undefined;
    try { current = await currentEvent(event.id); } catch { /* retained receipt below */ }
    return res.status(failure.status).json({
      ...failure.body,
      ...(current ? { current, currentRevision: current.revision } : {}),
    });
  }
  return res.status(status).json(result);
}

function validateCalendars(event: Event) {
  event.id = requireUUID(event.id, "event.id");
  event.calendars = [
    ...new Set(
      event.calendars.map((id) => requireUUID(id, "event.calendars[]")),
    ),
  ];
  if (!event.calendars.length)
    throw new BadRequestError("Event needs at least one calendar.");
  if (event.originCalendarID)
    event.originCalendarID = requireUUID(event.originCalendarID, "event.originCalendarID");
}

function plannedWrites(
  previous: Event,
  event: Event,
  scopeEditValidated = false,
): CalendarEventWrite[] {
  const removed = previous.calendars.filter(
    (id) => !event.calendars.includes(id),
  );
  const added = event.calendars.filter(
    (id) => !previous.calendars.includes(id),
  );
  const kept = event.calendars.filter((id) => previous.calendars.includes(id));
  const patch = diffEventContent(previous, event);
  return [
    { event: previous, calendarIDs: removed, action: "delete" },
    { event, calendarIDs: added, action: "create" },
    // A current no-op still has a CAS check, but no provider mutation.
    ...(Object.keys(patch).length
      ? [
          {
            event,
            previous,
            patch,
            calendarIDs: kept,
            action: "update" as const,
            scopeEditValidated,
          },
        ]
      : []),
  ];
}

async function prepareUpdate(
  userID: string,
  request: EventPatchRequest,
  previous: Event,
  identity: ReturnType<typeof eventMutationIdentity>,
) {
  const event = { ...previous, ...request.patch };
  validateCalendars(event);
  for (const id of event.calendars.filter(
    (id) => !previous.calendars.includes(id),
  ))
    await assertEventCalendarAccess(userID, id);
  const scope = request.scopeEdit;
  let create: Event | undefined;
  if (scope) {
    const { scopeEdit: _scope, ...update } = request;
    if (JSON.stringify(scope.updates[0]) !== JSON.stringify(update))
      throw new BadRequestError(
        "Scope edit intent does not match the first update.",
      );
    create = scope.creates[0];
    if (create) {
      validateCalendars(create);
      if (
        create.id === event.id ||
        (create.originCalendarID &&
          !create.calendars.includes(create.originCalendarID))
      )
        throw new BadRequestError("Invalid scope create destination.");
      for (const id of create.calendars)
        await assertEventCalendarAccess(userID, id);
    }
  }
  const writes = plannedWrites(previous, event, Boolean(scope));
  // Even update-only recurrence intents must receive complete recurrence preflight.
  if (scope && !writes.some((write) => write.action === "update"))
    writes.push({
      event,
      previous,
      patch: {},
      calendarIDs: event.calendars,
      action: "update",
      scopeEditValidated: true,
    });
  const scopeWrites = create
    ? [
        ...writes,
        {
          event: create,
          calendarIDs: create.calendars,
          action: "create" as const,
        },
      ]
    : writes;
  if (create) await prepareEventWrites(scopeWrites); // authorize future create now; not an atomic scope operation
  return prepareEventWrites(writes, identity);
}

async function sendExistingCreate(res: Response, actorID: string, event: Event) {
  const receipt = await readEventCreateReceipt(actorID, event);
  if (receipt.kind === "missing") return false;
  res.setHeader("Cache-Control", "private, no-store");
  if (receipt.kind === "matching") res.status(202).json({ ...receipt.event, localCommitted: true, replayed: true });
  else res.status(409).json({ code: "event-create-changed", error: "This creation was saved, but its event changed or is no longer available. Refresh and reconcile.", localCommitted: true, ...(receipt.kind === "changed" ? { current: receipt.event } : {}) });
  return true;
}

export async function handlerCreateEvent(req: Request, res: Response) {
  const identity = eventMutationIdentity(req);
  const event = EventCreateRequestSchema.parse(req.body);
  validateCalendars(event);
  event.originCalendarID ??= event.calendars[0];
  if (!event.calendars.includes(event.originCalendarID!))
    throw new BadRequestError(
      "originCalendarID must be one of the event's calendars.",
    );
  if (await sendExistingCreate(res, req.user!.id, { ...event, creatorID: req.user!.id })) return;
  for (const id of event.calendars)
    await assertEventCalendarAccess(req.user!.id, id);
  const deliver = await prepareEventWrites([
    { event, calendarIDs: event.calendars, action: "create" },
  ], identity);
  let created;
  try {
    created = await createEvent({ ...event, creatorID: req.user!.id }, event.calendars, deliver.outbox);
  } catch (error) {
    // A concurrent first request may have committed after the initial lookup.
    if (await sendExistingCreate(res, req.user!.id, { ...event, creatorID: req.user!.id })) return;
    throw error;
  }

  const result = { ...created, providerReadRetiredRevision: created.providerReadRetiredRevision ?? undefined, calendars: event.calendars };

  return sendCommitted(res, deliver, result, result, 201, () =>
    notifyEvent(event.calendars, "event_created", result, req.user!.id));
}

export async function handlerCreateEventTime(req: Request, res: Response) {
  if (!config.api.eventTimeEditsEnabled)
    throw new EventWriteError("event-write", "unsupported", "Explicit time creation is not enabled on this server. No changes were saved.");
  const identity = eventMutationIdentity(req);
  const deliver = await prepareEventWrites([], identity);
  const request = EventTimeCreateRequestSchema.parse(req.body);
  const ids = [...new Set(request.event.calendars.map(id => id.toLowerCase()))];
  // Callers must retain this identity across retries of the same intent.
  const operationID = req.get("Idempotency-Key") === undefined ? request.event.id.toLowerCase() : identity.mutationID;
  let queued = await findGraphSeriesCreateRequest(req.user!.id, operationID, request);
  const expected = { ...request.event, ...resolveEventTimeEdit(request.time), creatorID: req.user!.id, organizer: req.user!.id, calendars: ids, originCalendarID: request.event.originCalendarID ?? ids[0] };
  if (!queued) {
    if (await sendExistingCreate(res, req.user!.id, expected)) return;
    for (const id of ids) await assertEventCalendarAccess(req.user!.id, id);
    const link = ids.length === 1 ? await getExternalLinkForCalendar(ids[0]!) : null;
    if (link?.provider === "microsoft" && request.event.recurrence)
      queued = await queueGraphSeriesCreateRequest(req.user!.id, operationID, request);
  }
  if (queued) {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const receipt = await readGraphSeriesCreateReceipt(req.user!.id, queued.operationID);
      if (receipt.kind !== "active") return res.status(409).json({ code: "event-create-no-longer-active", error: "This creation was saved, but its event is no longer available here. Refresh before continuing.", localCommitted: true });
      await notifyEvent(receipt.event.calendars, "event_created", receipt.event, req.user!.id);
      return res.status(202).json({ ...receipt.event, localCommitted: true });
    } catch (error) {
      const failure = committedFailure(error, [queued.event]);
      return res.status(failure.status).json(failure.body);
    }
  }
  let result;
  try {
    const created = await createLocalEventWithTime(request, req.user!.id);
    result = { ...created, providerReadRetiredRevision: created.providerReadRetiredRevision ?? undefined };
  }
  catch (error) {
    if (await sendExistingCreate(res, req.user!.id, expected)) return;
    throw error;
  }
  return sendCommitted(res, deliver, result, result, 201, () =>
    notifyEvent(result.calendars, "event_created", result, req.user!.id));
}

export async function handlerUpdateEvent(req: Request, res: Response) {
  const request = EventPatchRequestSchema.parse(req.body);

  await assertEventContentAccess(req.user!.id, request.id);
  const previous = await currentEvent(request.id);
  if (previous.revision !== request.expectedRevision || previous.deletedAt)
    return conflict(res, previous);
  const deliver = await prepareUpdate(req.user!.id, request, previous, eventMutationIdentity(req));
  const saved = await patchEventAndCalendarLinks(
    request.id,
    request.expectedRevision,
    request.patch,
    false,
    deliver.outbox,
  );

  if (saved.status === "not_found") throw new NotFoundError("Event not found.");
  if (saved.status === "conflict") return conflict(res, saved.current);
  return sendCommitted(res, deliver, saved.event, saved.event, 200, async () => {
  if (saved.changed) {
    await notifyEvent(
      [...saved.previous.calendars, ...saved.event.calendars],
      "event_updated",
      saved.event,
      req.user!.id,
    );
    await queueEventChange(saved.previous, saved.event, req.user!.id);
  }

  });
}

export async function handlerEditEventTime(req: Request, res: Response) {
  if (!config.api.eventTimeEditsEnabled)
    throw new EventWriteError("event-write", "unsupported", "Explicit time editing is not enabled on this server. No changes were saved.");
  const eventID = requireUUID(req.params.eventId, "eventId");
  const request = EventTimeEditRequestSchema.parse(req.body);
  await assertEventContentAccess(req.user!.id, eventID);
  const deliver = await prepareEventWrites([], eventMutationIdentity(req));
  const saved = await replaceLocalEventTimeAtRevision(eventID, request.expectedRevision, request.time, req.user!.id, request.patch);
  if (saved.status === "not_found") throw new NotFoundError("Event not found.");
  if (saved.status === "conflict") return conflict(res, saved.current);
  return sendCommitted(res, deliver, saved.event, saved.event, 200, async () => {
    if (!saved.changed) return;
    await notifyEvent(saved.event.calendars, "event_updated", saved.event, req.user!.id);
    await queueEventChange(saved.previous, saved.event, req.user!.id);
  });
}

/** One scope request commits one family. Clients reconcile IDs/revisions from
 * the receipt through their normal delta read, including after a lost response. */
export async function handlerEventScope(req: Request, res: Response) {
  if (!config.api.eventTimeEditsEnabled)
    throw new EventWriteError("event-write", "unsupported", "Scope editing is not enabled on this server. No changes were saved.");
  const eventID = requireUUID(req.params.eventId, "eventId");
  let result = await applyLocalEventScope(eventID, req.user!.id, req.body, { prepareProvider: true });
  if (result.status === "provider_required") {
    try {
      const provider = await prepareGoogleOccurrence(result.context, req.body);
      result = await applyLocalEventScope(eventID, req.user!.id, req.body, { provider });
    } catch (error) {
      if (error instanceof ProviderEventWriteError && error.code === "provider-conflict")
        return res.status(409).json({ error: "The provider occurrence changed. Sync the calendar before retrying.", code: "provider-conflict", localCommitted: false });
      throw error;
    }
  }
  if (result.status === "graph_delete_required") {
    try {
      const graphDeletion = await microsoftAdapter.prepareGraphDeletion!(result.context, req.body, AbortSignal.timeout(60_000));
      result = await applyLocalEventScope(eventID, req.user!.id, req.body, { graphDeletion });
    } catch (error) {
      if (error instanceof ProviderEventWriteError && error.code === "provider-conflict")
        return res.status(409).json({ error: "The Outlook series changed. Sync and reopen before deleting.", code: "provider-conflict", localCommitted: false });
      throw error;
    }
  }
  if (result.status === "caldav_required") {
    try {
      if (result.deleteResource) {
        const caldavDeletion = await prepareCaldavSeriesDelete(result.context, req.body);
        result = await applyLocalEventScope(eventID, req.user!.id, req.body, { caldavDeletion });
      } else if (result.splitResource) {
        const caldavSplit = await prepareCaldavSplit(result.context, req.body);
        result = await applyLocalEventScope(eventID, req.user!.id, req.body, { caldavSplit });
      } else {
        const caldav = await prepareCaldavSeries(result.context, req.body);
        result = await applyLocalEventScope(eventID, req.user!.id, req.body, { caldav });
      }
    } catch (error) {
      if (error instanceof ProviderEventWriteError && error.code === "provider-conflict")
        return res.status(409).json({ error: "The provider series changed. Sync the calendar before retrying.", code: "provider-conflict", localCommitted: false });
      throw error;
    }
  }
  if (result.status === "provider_required" || result.status === "caldav_required" || result.status === "graph_delete_required") throw new Error("Missing provider scope preparation.");
  if (result.status === "not_found") throw new NotFoundError("Event not found.");
  if (result.status === "conflict") return conflict(res, result.current);
  if (result.status === "replayed") return res.json({ ...result.outcome, localCommitted: true, replayed: true });
  try {
    const previous = new Map(result.previous.map(event => [event.id, event]));
    for (const event of result.events) {
      const before = previous.get(event.id);
      await notifyEvent(event.calendars, before ? "event_updated" : "event_created", event, req.user!.id);
      if (before) await queueEventChange(before, event, req.user!.id);
    }
    for (const deletion of result.outcome.deleted) {
      const before = previous.get(deletion.id)!;
      await notifyEvent(before.calendars, "event_removed", { ...deletion, calendars: before.calendars, removed: true }, req.user!.id);
      await dropEventNotifications(deletion.id);
    }
  } catch {
    return res.status(502).json({ ...result.outcome, localCommitted: true, error: "Saved locally, but follow-up work was not confirmed. Refresh to reconcile.", code: "event-scope-follow-up-unconfirmed" });
  }
  return res.json({ ...result.outcome, localCommitted: true, replayed: false });
}

export async function handlerRemoveEvent(req: Request, res: Response) {
  const request =
    req.body?.unlinkCalendarID === undefined
      ? EventDeleteRequestSchema.parse(req.body)
      : EventUnlinkRequestSchema.parse(req.body);
  const existing = await assertCanViewEvent(req.user!.id, request.id);
  const unlinkCalendarID =
    "unlinkCalendarID" in request
      ? requireUUID(request.unlinkCalendarID, "unlinkCalendarID")
      : undefined;

  let targets: string[];
  if (unlinkCalendarID) {
    if (!existing.includes(unlinkCalendarID))
      throw new BadRequestError("Event isn't in that calendar.");
    await assertEventCalendarAccess(req.user!.id, unlinkCalendarID);
    targets = [unlinkCalendarID];
  } else {
    const editable: string[] = [];
    for (const id of existing)
      if (await hasEventCalendarAccess(req.user!.id, id)) editable.push(id);
    if (!editable.length) throw new EventWriteError("event-write", "denied");
    const origin = (await getEventOrigin(request.id))?.originCalendarID;
    targets = origin && editable.includes(origin) ? existing : editable;
  }

  const previous = await currentEvent(request.id);
  if (previous.revision !== request.expectedRevision || previous.deletedAt)
    return conflict(res, previous);
  const deliver = await prepareEventWrites([
    { event: previous, calendarIDs: targets, action: "delete" },
  ], eventMutationIdentity(req));
  const saved = await patchEventAndCalendarLinks(
    request.id,
    request.expectedRevision,
    { calendars: existing.filter((id) => !targets.includes(id)) },
    true,
    deliver.outbox,
  );
  if (saved.status === "not_found") throw new NotFoundError("Event not found.");
  if (saved.status === "conflict") return conflict(res, saved.current);
  const removed = saved.event.deletedAt !== null;

  const result = {
    id: saved.event.id,
    revision: saved.event.revision,
    calendars: saved.event.calendars,
    removed,
    event: saved.event,
  };
  return sendCommitted(res, deliver, saved.event, result, 200, async () => {
  await notifyEvent(
    existing,
    removed ? "event_removed" : "event_updated",
    removed ? result : saved.event,
    req.user!.id,
  );
  if (removed) await dropEventNotifications(request.id);

  });
}

export async function handlerLinkEvent(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  const parsed = EventLinkRequestSchema.parse(req.body);
  const calendarID = requireUUID(parsed.calendarID, "calendarID");
  const { expectedRevision } = parsed;
  const existing = await assertCanViewEvent(req.user!.id, eventID);

  await assertEventCalendarAccess(req.user!.id, calendarID);
  const previous = await currentEvent(eventID);
  if (previous.revision !== expectedRevision || previous.deletedAt)
    return conflict(res, previous);
  const calendars = [...new Set([...existing, calendarID])];
  const deliver = await prepareEventWrites(
    existing.includes(calendarID)
      ? []
      : [
          {
            event: { ...previous, calendars },
            calendarIDs: [calendarID],
            action: "create",
          },
        ],
    eventMutationIdentity(req),
  );
  const saved = await patchEventAndCalendarLinks(eventID, expectedRevision, {
    calendars,
  }, false, deliver.outbox);
  if (saved.status === "not_found") throw new NotFoundError("Event not found.");
  if (saved.status === "conflict") return conflict(res, saved.current);
  return sendCommitted(res, deliver, saved.event, saved.event, 200, async () => {
    if (saved.changed) await notifyEvent(calendars, "event_updated", saved.event, req.user!.id);
  });
}

export async function handlerForkEvent(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  const parsed = EventForkRequestSchema.parse(req.body);
  const calendarID = requireUUID(parsed.calendarID, "calendarID");
  const { expectedRevision } = parsed;
  const sourceCalendars = await assertCanViewEvent(req.user!.id, eventID);
  await assertEventCalendarAccess(req.user!.id, calendarID);
  if (sourceCalendars.includes(calendarID))
    throw new BadRequestError("This event is already in that calendar.");
  const source = await currentEvent(eventID);
  if (source.revision !== expectedRevision || source.deletedAt)
    return conflict(res, source);

  if (hasKnownEventTime(source)) {
    if (!config.api.eventTimeEditsEnabled)
      throw new EventWriteError("event-write", "unsupported", "Explicit time copying is not enabled on this server. No changes were saved.");
    const deliver = await prepareEventWrites([], eventMutationIdentity(req));
    const saved = await forkLocalEventWithTimeAtRevision(eventID, expectedRevision, calendarID, req.user!.id);
    if (saved.status === "not_found") throw new NotFoundError("Event not found.");
    if (saved.status === "conflict") return conflict(res, saved.current);
    return sendCommitted(res, deliver, saved.event, saved.event, 201, () =>
      notifyEvent(saved.event.calendars, "event_created", saved.event, req.user!.id));
  }
  const newEvent: NewEvent = {
    ...eventCreateRequest(EventSchema.parse(source)),
    id: randomUUID(),
    creatorID: req.user!.id,
    organizer: req.user!.id,
    originCalendarID: calendarID,
    isCanceled: false,
  };
  const projected = {
    ...source,
    ...newEvent,
    revision: 1,
    calendars: [calendarID],
  } as Event;
  const deliver = await prepareEventWrites([
    {
      event: projected,
      calendarIDs: [calendarID],
      action: "create",
    },
  ], eventMutationIdentity(req));
  const saved = await forkEventAtRevision(eventID, expectedRevision, newEvent, [
    calendarID,
  ], deliver.outbox);
  if (saved.status === "not_found") throw new NotFoundError("Event not found.");
  if (saved.status === "conflict") return conflict(res, saved.current);
  return sendCommitted(res, deliver, saved.event, saved.event, 201, () =>
    notifyEvent([calendarID], "event_created", saved.event, req.user!.id));
}

// Attendees: anyone who can view the event sees the list and can answer.
// No emails in the payload (see query).
export async function handlerGetAttendees(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  await assertCanViewEvent(req.user!.id, eventID);
  res.status(200).json(await getEventAttendees(eventID));
}

const ATTENDANCE_STATUSES = new Set(["declined", "going", "maybe", "none"]);

/**
 * What the client wants to be true.
 *
 * `{status}` is the shape everything speaks now. `{attending: boolean}` is the
 * mobile build that is already on Play — deploying the API must not wait on a
 * store review, so it keeps working and means going/withdrawn.
 */
export function parseAttendanceBody(body: unknown): AttendanceStatus | "none" {
  const input = (body ?? {}) as { attending?: unknown; status?: unknown };

  if (typeof input.status === "string") {
    if (!ATTENDANCE_STATUSES.has(input.status)) {
      throw new BadRequestError(
        "status must be going, maybe, declined or none...",
      );
    }
    return input.status as AttendanceStatus | "none";
  }
  if (typeof input.attending === "boolean")
    return input.attending ? "going" : "none";

  throw new BadRequestError(
    "status (going | maybe | declined | none) is required...",
  );
}

/**
 * Live-update open details for everyone who can see the event, and hand back the
 * list that was sent.
 */
async function notifyAttendanceChanged(
  eventID: string,
  eventCalendars: string[],
) {
  const attendees = await getEventAttendees(eventID);
  // The actor gets the frame too — it carries the same list the PUT response
  // does, harmless.
  const memberIDSeen = new Set<string>();
  for (const cal of eventCalendars) {
    for (const member of await getCalendarMembers(cal))
      memberIDSeen.add(member.userID);
  }
  notifyCalendarMembers([...memberIDSeen], "attendance_changed", {
    eventID,
    attendees,
  });

  return attendees;
}

// PUT desired state rather than POST/DELETE — retries are safe and the client
// just sends what it wants. Returns the fresh list.
export async function handlerSetAttendance(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  const status = parseAttendanceBody(req.body);
  const eventCalendars = await assertCanViewEvent(req.user!.id, eventID);
  await setAttendance(eventID, req.user!.id, status);

  res.status(200).json(await notifyAttendanceChanged(eventID, eventCalendars));
}

export function parseEventReadQuery(query: Request["query"]) {
  const since = optionalDateQuery(query.since, "since");
  const range = optionalDateRangeQuery(
    query.start,
    query.end,
    MAX_EVENT_RANGE_MS,
  );
  if (since && range) {
    throw new BadRequestError("since cannot be combined with start and end.");
  }
  return { since, ...range };
}

export async function handlerGetEvents(req: Request, res: Response) {
  const eventQuery = parseEventReadQuery(req.query);
  const serverTime = new Date().toISOString(); // client stores this as its next `since`
  const rows = await getUsersEvents(req.user!.id!, eventQuery);
  const seen = new Map<string, Event>();
  const deletedIds = new Set<string>();
  for (const { event: dbEvent, calendarID } of rows) {
    if (dbEvent.deletedAt) {
      deletedIds.add(dbEvent.id);
      continue;
    } // tombstone → client drops it
    const existing = seen.get(dbEvent.id);
    if (existing) {
      existing.calendars.push(calendarID);
    } else {
      seen.set(dbEvent.id, { ...dbEvent, calendars: [calendarID] });
    }
  }
  res.status(200).json({
    events: Array.from(seen.values()),
    deletedIds: [...deletedIds],
    serverTime,
  });
}

export async function handlerGetProviderEventState(req: Request, res: Response) {
  const id = requireUUID(req.params.eventId, "eventId");
  await assertCanViewEvent(req.user!.id, id);
  res.setHeader("Cache-Control", "private, no-store");
  const observation = await getOwnProviderEventObservation(req.user!.id, id, config.api.providerReminderEditsEnabled, config.api.providerRsvpEditsEnabled, req.query.outlookRsvp === "1" || req.query.outlookRsvp === "2");
  res.json(await observeProviderOrganizer(req.user!.id, id, await observeMicrosoftRsvp(req.user!.id, id, await observeCaldavRsvp(req.user!.id, id, await caldavAlarmObservation(req.user!.id, id, observation)), req.query.outlookRsvp === "2"), req.query.outlookOrganizer === "10" ? "global-time-zones" : req.query.outlookOrganizer === "9" ? "occurrence-move" : req.query.outlookOrganizer === "8" ? "series-time" : req.query.outlookOrganizer === "7" ? "occurrence-all-day-time" : req.query.outlookOrganizer === "6" ? "occurrence-zone-time" : req.query.outlookOrganizer === "5" ? "occurrence-time" : req.query.outlookOrganizer === "4" ? "series-content" : req.query.outlookOrganizer === "3" ? "content" : req.query.outlookOrganizer === "2" ? "series" : req.query.outlookOrganizer === "1"));
}

export async function handlerProviderReminderEdit(req: Request, res: Response) {
  const id = requireUUID(req.params.eventId, "eventId");
  const receipt = req.body?.provider === "caldav" ? await queueCaldavAlarms(req.user!.id, id, req.body) : await queueGoogleReminders(req.user!.id, id, req.body);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(202).json({ ...receipt, localCommitted: true });
}

/** A durable intent receipt is not proof that an organizer received an email. */
export async function handlerProviderRsvpEdit(req: Request, res: Response) {
  const id = requireUUID(req.params.eventId, "eventId");
  const receipt = await queueProviderRsvp(req.user!.id, id, req.body);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(202).json({ ...receipt, localCommitted: true, notificationDelivery: "unknown" });
}

export async function handlerProviderOrganizer(req: Request, res: Response) {
  let receipt;
  try { receipt = await queueProviderOrganizer(req.user!.id, req.body); }
  catch (error) { if (!(error instanceof OrganizerAdmissionRejectedError)) throw error; res.status(400).json({ error: error.message, organizerAdmissionRejected: true }); return; }
  res.setHeader("Cache-Control", "private, no-store"); res.status(202).json(receipt);
  if (!receipt.replayed) { const { getEventSnapshot } = await import("@musubi/db"); const event = await getEventSnapshot(receipt.eventID); if (event) await notifyEvent(event.calendars, "event_updated", event, req.user!.id); }
}
export async function handlerOrganizerCalendar(req: Request, res: Response) {
  const id = String(req.params.calendarId);
  res.setHeader("Cache-Control", "private, no-store"); res.json(await observeOrganizerCalendar(req.user!.id, id));
}
