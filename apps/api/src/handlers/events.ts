import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { NewEvent, createEvent, getCalendarMembers, getEvent, getEventAttendees, getEventCalendars, getEventOrigin, getUserRoleForCalendar, getUsersEvents, linkEventToCalendars, setAttendance, unlinkEventAndTombstoneIfOrphaned, updateEventAndCalendarLinks } from '@musubi/db';
import { BadRequestError, Event, EventSchema, ForbiddenError, NotFoundError } from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import { pushEventToCalendars, pushEventToProviders } from "../sync/engine";
import { assertCan, assertCanEditEvent, assertCanViewEvent, canDo } from "../permissions";
import { optionalDateQuery, requireUUID } from "../request_validation";

function parseEvent(body: unknown, message: string): Event {
  let event: Event;
  try {
    event = EventSchema.parse(body);
  } catch {
    throw new BadRequestError(message);
  }

  event.id = requireUUID(event.id, "event.id");
  event.calendars = event.calendars.map((calendarID) =>
    requireUUID(calendarID, "event.calendars[]"));
  if (event.originCalendarID) {
    event.originCalendarID = requireUUID(event.originCalendarID, "event.originCalendarID");
  }
  return event;
}

export async function handlerCreateEvent(req: Request, res: Response) {
  const event = parseEvent(req.body, "Request is missing valid event data...");
  // Server-side shape guards (don't trust the client): an event needs at least
  // one calendar, and its HOME must be one of the linked calendars — those are
  // membership-verified below, which also proves they exist (clean 400/403
  // instead of an FK 500, and no smuggling a foreign calendar in as origin).
  if (event.calendars.length === 0) throw new BadRequestError("Event needs at least one calendar...");
  if (!event.originCalendarID) event.originCalendarID = event.calendars[0];
  if (!event.calendars.includes(event.originCalendarID)) {
    throw new BadRequestError("originCalendarID must be one of the event's calendars...");
  }
  const newEvent: NewEvent = {
    ...event,
    creatorID: req.user!.id,
  }
  for (const cal of event.calendars) await assertCan(req.user!.id, cal, "editEvents");
  const createdEvent = await createEvent(newEvent, event.calendars);

  const result = { ...createdEvent, calendars: event.calendars };

  await pushEventToProviders(result, "create");

  const memberIDSeen = new Set<string>();

  for (const cal of event.calendars) {
    const members = await getCalendarMembers(cal);

    for (const member of members) {
      if (!memberIDSeen.has(member.userID)) {
        memberIDSeen.add(member.userID);
      }
    }
  }

  notifyCalendarMembers([...memberIDSeen], "event_created", result);

  res.status(201).json(result);
}

export async function handlerUpdateEvent(req: Request, res: Response) {
  const event = parseEvent(req.body, "Request missing valid event data...");

  await assertCanEditEvent(req.user!.id, event.id!); // edit-content gated by home calendar

  // Diff the calendar links: what got removed / added / kept.
  const existing = await getEventCalendars(event.id!);
  const incoming = event.calendars;
  const removed = existing.filter(c => !incoming.includes(c));
  const added = incoming.filter(c => !existing.includes(c));
  const kept = incoming.filter(c => existing.includes(c));

  // Adding a link puts the event into someone's calendar — same gate as handlerLinkEvent.
  for (const cal of added) await assertCan(req.user!.id, cal, "editEvents");

  // creatorID / originCalendarID are immutable — never trust them from the client
  // (creator is the permission fallback, origin governs who may edit).
  const { creatorID: _c, originCalendarID: _o, ...editable } = event;
  // Remove provider copies while their mappings still exist. Provider delivery
  // is best-effort; the local event + link reconciliation below is one DB unit.
  await pushEventToCalendars(event, removed, "delete");
  const updatedEvent = await updateEventAndCalendarLinks(
    { ...editable, id: event.id! },
    added,
    removed,
  );

  if (updatedEvent) {

    // The local transaction has committed; propagate its new state outward.
    await pushEventToCalendars(event, added, "create");   // create in Google (+ mapping)
    await pushEventToCalendars(event, kept, "update");     // update the rest

    const result = { ...updatedEvent, calendars: incoming };

    // Notify members of both old and new calendars (removed ones need to drop it).
    const memberIDSeen = new Set<string>();
    for (const cal of new Set([...existing, ...incoming])) {
      const members = await getCalendarMembers(cal);
      for (const member of members) memberIDSeen.add(member.userID);
    }

    notifyCalendarMembers([...memberIDSeen], "event_updated", result);

    return res.status(200).json({ ...result, calendars: incoming });
  }
  throw new NotFoundError("Request missing valid event data...");
}

export async function handlerRemoveEvent(req: Request, res: Response) {
  const event = parseEvent(req.body, "Request missing valid event data...");

  // "Delete" = unlink from every calendar the user is allowed to edit. Calendars
  // they can only view are left untouched. The event row is tombstoned only once
  // its last link is gone.
  const existing = await getEventCalendars(event.id);
  const unlinkCalendarID = req.body?.unlinkCalendarID === undefined
    ? undefined
    : requireUUID(req.body.unlinkCalendarID, "unlinkCalendarID");

  let targets: string[];
  if (unlinkCalendarID) {
    // Unlink from ONE calendar only (used from a non-origin calendar view).
    if (!existing.includes(unlinkCalendarID)) throw new BadRequestError("Event isn't in that calendar...");
    if (!(await canDo(req.user!.id, unlinkCalendarID, "editEvents"))) {
      throw new ForbiddenError("You can't remove this event from that calendar.");
    }
    targets = [unlinkCalendarID];
  } else {
    // Delete: unlink every calendar the user can edit. If the HOME (origin) is among
    // them the delete is authoritative → cascade to ALL calendars (even viewers').
    const editable: string[] = [];
    for (const cal of existing) {
      if (await canDo(req.user!.id, cal, "editEvents")) editable.push(cal);
    }
    if (editable.length === 0) {
      throw new ForbiddenError("You can't remove this event from any of your calendars.");
    }
    const origin = (await getEventOrigin(event.id))?.originCalendarID ?? null;
    targets = (origin && editable.includes(origin)) ? existing : editable;
  }

  await pushEventToCalendars(event, targets, "delete"); // remove from external while mapping still exists
  const { remaining, removed } = await unlinkEventAndTombstoneIfOrphaned(event.id, targets);

  const result = { id: event.id, calendars: remaining, removed };

  // Notify everyone who had it: full removal → drop; partial → update their view.
  const memberIDSeen = new Set<string>();
  for (const cal of existing) {
    const members = await getCalendarMembers(cal);
    for (const member of members) memberIDSeen.add(member.userID);
  }
  notifyCalendarMembers(
    [...memberIDSeen],
    removed ? "event_removed" : "event_updated",
    removed ? result : { ...event, calendars: remaining },
  );

  return res.status(200).json(result);
}

// Propagate: add an existing event into another calendar. Anyone who can VIEW the
// event may link it into a calendar they can EDIT — no edit-on-event needed. To
// change the event itself they'd have to fork it.
export async function handlerLinkEvent(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  const calendarID = requireUUID(req.body?.calendarID, "calendarID");

  // Must be able to see the event (member of some calendar it lives in).
  const existing = await assertCanViewEvent(req.user!.id, eventID);

  // Must be able to edit the target calendar.
  if (!(await canDo(req.user!.id, calendarID, "editEvents"))) {
    throw new ForbiddenError("You can't add events to that calendar.");
  }

  if (!existing.includes(calendarID)) {
    await linkEventToCalendars(eventID, [calendarID]);
    const row = await getEvent(eventID);
    await pushEventToCalendars({ ...row, calendars: [...existing, calendarID] } as Event, [calendarID], "create");
  }

  const calendars = await getEventCalendars(eventID);
  const row = await getEvent(eventID);
  const result = { ...row, calendars };

  // Everyone who can see the event needs the new `calendars` list — not just
  // the target calendar's members (their open detail modal shows the links).
  const memberIDSeen = new Set<string>();
  for (const cal of calendars) {
    for (const member of await getCalendarMembers(cal)) memberIDSeen.add(member.userID);
  }
  notifyCalendarMembers([...memberIDSeen], "event_updated", result);

  return res.status(200).json(result);
}

// Fork (claim): make an INDEPENDENT copy of the event into a calendar the user can
// edit. New id + creatorID + origin = target, no external mapping to the original.
// Detached from the previous owner — editing the fork never touches the source.
export async function handlerForkEvent(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  const calendarID = requireUUID(req.body?.calendarID, "calendarID");

  // Must be able to see the source, and edit the target.
  const sourceCalendars = await assertCanViewEvent(req.user!.id, eventID);
  if (!(await canDo(req.user!.id, calendarID, "editEvents"))) {
    throw new ForbiddenError("You can't add events to that calendar.");
  }
  if (sourceCalendars.includes(calendarID)) {
    throw new BadRequestError("This event is already in that calendar.");
  }

  const src = await getEvent(eventID);
  if (!src) throw new NotFoundError("Event not found...");

  const newEvent: NewEvent = {
    id: randomUUID(),
    creatorID: req.user!.id,
    title: src.title,
    color: src.color,
    start: src.start,
    end: src.end,
    isAllDay: src.isAllDay,
    hasAttendees: src.hasAttendees,
    description: src.description,
    location: src.location,
    organizer: req.user!.id,       // new owner
    recurrence: src.recurrence,
    url: src.url,
    originCalendarID: calendarID,   // fork's home = chosen calendar
  };
  const created = await createEvent(newEvent, [calendarID]);
  const result = { ...created, calendars: [calendarID] };

  await pushEventToProviders(result, "create"); // sync to target's provider if external

  const members = await getCalendarMembers(calendarID);
  notifyCalendarMembers(members.map(m => m.userID), "event_created", result);

  return res.status(201).json(result);
}

// Attendees: anyone who can VIEW the event sees the list and can join/leave.
// Viewers RSVP too — that's the point. No emails in the payload (see query).
export async function handlerGetAttendees(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  await assertCanViewEvent(req.user!.id, eventID);
  res.status(200).json(await getEventAttendees(eventID));
}

// PUT desired state ({ attending: boolean }) rather than POST/DELETE — retries
// are safe and the client just sends what it wants. Returns the fresh list.
export async function handlerSetAttendance(req: Request, res: Response) {
  const eventID = requireUUID(req.params.eventId, "eventId");
  const attending = req.body?.attending;
  if (typeof attending !== "boolean") throw new BadRequestError("attending (boolean) is required...");
  const eventCalendars = await assertCanViewEvent(req.user!.id, eventID);
  await setAttendance(eventID, req.user!.id, attending);
  const attendees = await getEventAttendees(eventID);

  // Live-update open detail modals for everyone who can see the event. The actor
  // gets the frame too — it carries the same list the PUT response does, harmless.
  const memberIDSeen = new Set<string>();
  for (const cal of eventCalendars) {
    for (const member of await getCalendarMembers(cal)) memberIDSeen.add(member.userID);
  }
  notifyCalendarMembers([...memberIDSeen], "attendance_changed", { eventID, attendees });

  res.status(200).json(attendees);
}

export async function handlerGetEvents(req: Request, res: Response) {
  const since = optionalDateQuery(req.query.since, "since");
  const serverTime = new Date().toISOString(); // client stores this as its next `since`
  const rows = await getUsersEvents(req.user!.id!, since);
  const seen = new Map<string, Event>();
  const deletedIds = new Set<string>();
  for (const { event: dbEvent, calendarID } of rows) {
    if (dbEvent.deletedAt) { deletedIds.add(dbEvent.id); continue; } // tombstone → client drops it
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
