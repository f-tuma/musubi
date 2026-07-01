import { Request, Response } from "express";
import { NewEvent, createEvent, getCalendarMembers, getGoogleEventID, getGoogleLinkForCalendar, getUsersEvents, removeEvent, updateEvent } from '@musubi/db';
import { BadRequestError, Event, EventSchema, NotFoundError } from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import { pushEventCreateToGoogle, pushEventDeleteToGoogle, pushEventUpdateToGoogle } from "../sync/google_sync";

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
  const createdEvent = await createEvent(newEvent, event.calendars);

  try {
    for (const cal of event.calendars) {
      const link = await getGoogleLinkForCalendar(cal);
      if (link) {
        await pushEventCreateToGoogle(link.userID, link.googleCalendarID, { ...createdEvent, calendars: event.calendars });
      }
    }
  } catch (e) {
    console.error(e);
  }

  const result = { ...createdEvent, calendars: event.calendars };

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

  const updatedEvent = await updateEvent({
    ...event,
    creatorID: req.user!.id,
  });

  try {
    for (const cal of event.calendars) {
      const link = await getGoogleLinkForCalendar(cal);
      if (link) {
        await pushEventUpdateToGoogle(link.userID, link.googleCalendarID, { ...updatedEvent, calendars: event.calendars });
      }
    }
  } catch (e) {
    console.error(e);
  }

  if (updatedEvent) {

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

  try {
    for (const cal of event.calendars) {
      const link = await getGoogleLinkForCalendar(cal);
      if (link) {
        const googleEventID = await getGoogleEventID(event.id, link.googleCalendarID)
        if (googleEventID) {
          await pushEventDeleteToGoogle(link.userID, link.googleCalendarID, googleEventID);
        }
      }
    }
  } catch (e) {
    console.error(e);
  }

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
  const result = await getUsersEvents(req.user!.id!);
  const seen = new Map<string, Event>();
  for (const calendarMember of result) {
    for (const calendarEvent of calendarMember.calendars.calendarEvents) {
      const dbEvent = calendarEvent.events
      if (!seen.has(dbEvent.id)) {
        const newEvent = { ...dbEvent, calendars: [calendarEvent.calendarID] };
        seen.set(dbEvent.id, newEvent);
      } else {
        const updateEvent = seen.get(dbEvent.id);
        updateEvent?.calendars.push(calendarEvent.calendarID);
      }
    }
  }
  const events: Event[] = Array.from(seen.values());
  res.status(200).json({
    events,
  });
}

