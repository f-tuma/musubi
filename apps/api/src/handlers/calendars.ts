import { Request, Response } from "express";
import { addCalendarMember, createCalendar, getCalendar, getCalendarEvents, getCalendarIDFromToken, getCalendarMembers, getExternalLinkForCalendar, getUsersCalendars, NewCalendar, removeCalendar, removeClaendarMember, updateCalendar } from '@musubi/db';
import { BadRequestError, Calendar, CalendarSchema, NotFoundError, User } from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import { assertCan } from "../permissions";


export async function handlerCreateCalendar(req: Request, res: Response) {
  let calendar: Calendar;
  try {
    calendar = CalendarSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid calendar data...");
  }
  const newCalendar: NewCalendar = {
    name: calendar.name,
    color: calendar.color,
    creatorID: req.user!.id,
  }
  const result = await createCalendar(newCalendar);
  res.status(201).json({ ...result, members: [{ id: req.user!.id, name: req.user!.name, email: req.user!.email }], invites: "wip" });
}

export async function handlerRemoveCalendar(req: Request, res: Response) {
  let calendar: Calendar;
  try {
    calendar = CalendarSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid calendar data...");
  }
  const members = await getCalendarMembers(calendar.id);
  await assertCan(req.user!.id, calendar.id, "deleteCalendar");
  const removedCalendar = await removeCalendar(calendar.id);

  if (removedCalendar) {

    const result = { ...removedCalendar, members: [], invites: "wip" };

    const memberIDSeen = new Set<string>();


    for (const member of members) {
      if (!memberIDSeen.has(member.userID)) {
        memberIDSeen.add(member.userID);
      }
    }

    notifyCalendarMembers([...memberIDSeen], "calendar_removed", result);

    return res.status(200).json(result);
  }
  throw new NotFoundError("Calendar not found...")

}

export async function handlerUpdateCalendar(req: Request, res: Response) {
  let calendar: Calendar;
  try {
    calendar = CalendarSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request missing valid calendar data...");
  }

  await assertCan(req.user!.id, calendar.id, "editCalendar");
  const updatedCalendar = await updateCalendar({ ...calendar, creatorID: req.user!.id });

  if (updatedCalendar) {

    const result = { ...updatedCalendar, members: calendar.members, invite: calendar.invite };

    const memberIDSeen = new Set<string>();

    const members = await getCalendarMembers(calendar.id);

    for (const member of members) {
      if (!memberIDSeen.has(member.userID)) {
        memberIDSeen.add(member.userID);
      }
    }

    notifyCalendarMembers([...memberIDSeen], "calendar_updated", result);


    return res.status(200).json({ ...result, members: calendar.members, invite: calendar.invite });
  }
  throw new NotFoundError("Calendar not found...");
}

export async function handlerGetCalendars(req: Request, res: Response) {
  const calendars = await getUsersCalendars(req.user!.id!);
  const result: Calendar[] = [];

  for (const calendar of calendars) {
    const members: User[] = [];
    const users = await getCalendarMembers(calendar.calendarID);
    for (const user of users) {
      members.push({ id: user.user.id, name: user.user.name, email: user.user.email });
    }
    const link = await getExternalLinkForCalendar(calendar.calendarID);
    result.push({
      ...calendar.calendars,
      members: members,
      invite: "wip",
      role: calendar.role, // the requesting user's role on this calendar
      provider: link?.provider ?? null,
      accountId: link?.accountID ?? null,
      accountLabel: link?.accountLabel ?? null,
    })
  }

  res.status(200).json(result);
}

export async function handlerGetCalendarFromToken(req: Request, res: Response) {
  const calendarID = await getCalendarIDFromToken(req.params.token as string);
  const result = await getCalendar(calendarID);
  const members = await getCalendarMembers(calendarID);
  const events = await getCalendarEvents(calendarID);

  res.status(200).json({
    ...result,
    members: members.map(u => ({
      name: u.user.name,
      email: u.user.email,
      id: u.user.id,
    })),
    events: events.map(e => e.events).filter(e => !e.deletedAt), // exclude soft-deleted
  });
}

export async function handlerGetCalendar(req: Request, res: Response) {
  const result = await getCalendar(req.params.id as string);

  const members = await getCalendarMembers(req.params.id as string);

  res.status(200).json({
    ...result, members: members.map(u => ({
      name: u.user.name,
      email: u.user.email,
      id: u.user.id,
    })),
  });
}

export async function handlerJoinCalendar(req: Request, res: Response) {
  const result = await addCalendarMember(req.user?.id!, req.params.calendarId as string);

  res.status(200).json(result);
}

export async function handlerLeaveCalendar(req: Request, res: Response) {
  await removeClaendarMember(req.user?.id!, req.params.calendarId as string);

  res.sendStatus(200);
}

