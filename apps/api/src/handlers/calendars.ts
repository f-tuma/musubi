import { Request, Response } from "express";
import { addCalendarMember, createCalendar, getCalendar, getCalendarEvents, getCalendarIDFromToken, getCalendarMembers, getExternalLinkForCalendar, getUserRoleForCalendar, getUsersCalendars, NewCalendar, removeCalendar, removeClaendarMember, setMemberRole, updateCalendar } from '@musubi/db';
import { BadRequestError, Calendar, CalendarSchema, ForbiddenError, NotFoundError, User } from "@musubi/types";
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
  res.status(201).json({ ...result, role: "owner", members: [{ id: req.user!.id, name: req.user!.name, email: req.user!.email }], invites: "wip" });
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
      serverUrl: link?.serverUrl ?? null, // caldav only — client uses it to spot iCloud
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
      image: u.user.image,
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
  const calendarID = req.params.calendarId as string;
  // Membership is granted by invite only — a bare calendar id is NOT enough
  // (ids leak via shared events' `calendars` arrays).
  const token = req.body?.token as string | undefined;
  if (!token || (await getCalendarIDFromToken(token)) !== calendarID) {
    throw new ForbiddenError("A valid invite is required to join this calendar.");
  }
  const result = await addCalendarMember(req.user?.id!, calendarID);

  res.status(200).json(result);
}

export async function handlerLeaveCalendar(req: Request, res: Response) {
  const calendarID = req.params.calendarId as string;
  const calendar = await getCalendar(calendarID);
  if (req.user!.id === calendar.creatorID) {
    // Would orphan the calendar — transfer ownership (setMemberRole "owner") or delete it.
    throw new BadRequestError("The owner can't leave. Transfer ownership or delete the calendar.");
  }
  await removeClaendarMember(req.user?.id!, calendarID);

  res.sendStatus(200);
}

export async function handlerKickMember(req: Request, res: Response) {
  const calendarID = req.params.calendarId as string;
  const targetUserID = req.params.userId as string;

  await assertCan(req.user!.id, calendarID, "manageMembers");

  const calendar = await getCalendar(calendarID);
  if (!calendar) throw new NotFoundError("Calendar not found...");
  if (targetUserID === calendar.creatorID) {
    throw new BadRequestError("The calendar owner can't be removed.");
  }

  await removeClaendarMember(targetUserID, calendarID);
  // Tell the removed user's client to drop the calendar.
  notifyCalendarMembers([targetUserID], "calendar_removed", { id: calendarID });

  res.sendStatus(200);
}

export async function handlerGetCalendarMembers(req: Request, res: Response) {
  const calendarID = req.params.calendarId as string;
  // Any member can see who's in the calendar; only owners change roles (setMemberRole).
  const role = await getUserRoleForCalendar(req.user!.id, calendarID);
  if (!role) throw new ForbiddenError("You're not a member of this calendar.");
  const members = await getCalendarMembers(calendarID);
  res.status(200).json(members.map(m => ({
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
    role: m.role,
  })));
}

export async function handlerSetMemberRole(req: Request, res: Response) {
  const calendarID = req.params.calendarId as string;
  const targetUserID = req.params.userId as string;
  const role = req.body?.role;

  if (role !== "viewer" && role !== "editor" && role !== "owner") {
    throw new BadRequestError("Role must be 'viewer', 'editor' or 'owner'.");
  }
  await assertCan(req.user!.id, calendarID, "manageMembers");

  const calendar = await getCalendar(calendarID);
  if (!calendar) throw new NotFoundError("Calendar not found...");
  if (targetUserID === calendar.creatorID) {
    throw new BadRequestError("The calendar owner's role can't be changed.");
  }

  if (role === "owner") {
    // Ownership transfer: only the current owner may hand it off. They step
    // down to editor; creatorID moves so owner-guards keep working.
    if (req.user!.id !== calendar.creatorID) {
      throw new ForbiddenError("Only the owner can transfer ownership.");
    }
    const updated = await setMemberRole(targetUserID, calendarID, "owner");
    if (!updated) throw new NotFoundError("Member not found on this calendar...");
    await updateCalendar({ ...calendar, creatorID: targetUserID });
    await setMemberRole(req.user!.id, calendarID, "editor");
    return res.status(200).json({ id: targetUserID, role: "owner" });
  }

  const updated = await setMemberRole(targetUserID, calendarID, role);
  if (!updated) throw new NotFoundError("Member not found on this calendar...");

  res.status(200).json({ id: targetUserID, role: updated.role });
}

