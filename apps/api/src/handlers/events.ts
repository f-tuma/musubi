import { Request, Response } from "express";
import { NewEvent, createEvent, getCalendarMembers, getUsersEvents, removeEvent, updateEvent } from '@musubi/db';
import { BadRequestError, Event, EventSchema, NotFoundError } from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import { pushEventToProviders } from "../sync/engine";
import { assertCan } from "../permissions";

export async function handlerCreateEvent(req: Request, res: Response) {
  let event: Event;
  try {
    event = EventSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid event data...");
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
  let event: Event;
  try {
    event = EventSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request missing valid event data...");
  }

  for (const cal of event.calendars) await assertCan(req.user!.id, cal, "editEvents");
  const updatedEvent = await updateEvent({
    ...event,
    creatorID: req.user!.id,
  });

  if (updatedEvent) {

    await pushEventToProviders(event, "update");

    const result = { ...updatedEvent, calendars: event.calendars };

    const memberIDSeen = new Set<string>();

    for (const cal of event.calendars) {
      const members = await getCalendarMembers(cal);

      for (const member of members) {
        if (!memberIDSeen.has(member.userID)) {
          memberIDSeen.add(member.userID);
        }
      }
    }

    notifyCalendarMembers([...memberIDSeen], "event_updated", result);

    return res.status(200).json({ ...result, calendars: event.calendars });
  }
  throw new NotFoundError("Request missing valid event data...");
}

export async function handlerRemoveEvent(req: Request, res: Response) {
  const event = EventSchema.parse(req.body);
  if (!event.id) throw new BadRequestError("Event id is required...");

  for (const cal of event.calendars) await assertCan(req.user!.id, cal, "editEvents");

  await pushEventToProviders(event, "delete");   // before removeEvent so the external mapping still exists

  const removedEvent = await removeEvent(event.id);

  if (removedEvent) {

    const result = { ...removedEvent, calendars: event.calendars };

    const memberIDSeen = new Set<string>();

    for (const cal of event.calendars) {
      const members = await getCalendarMembers(cal);

      for (const member of members) {
        if (!memberIDSeen.has(member.userID)) {
          memberIDSeen.add(member.userID);
        }
      }
    }

    notifyCalendarMembers([...memberIDSeen], "event_removed", result);

    return res.status(200).json(result);
  }
  throw new NotFoundError("Event not found...");
}

export async function handlerGetEvents(req: Request, res: Response) {
  const since = req.query.since ? new Date(req.query.since as string) : undefined;
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

