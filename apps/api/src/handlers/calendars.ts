import { Request, Response } from "express";
import ICAL from "ical.js";
import { addCalendarMember, consumeInvite, createCalendar, getCalendar, getCalendarEvents, getCalendarIDFromToken, getCalendarMembers, getExternalLinkForCalendar, getUserRoleForCalendar, getUsersCalendars, importExternalCalendar, NewCalendar, removeCalendar, removeCalendarMember, setMemberRole, updateCalendar } from '@musubi/db';
import { toVevent } from "../sync/adapters/caldav";
import { BadRequestError, Calendar, CalendarSchema, ForbiddenError, NotFoundError, User } from "@musubi/types";
import { notifyCalendarMembers } from "./stream";
import { assertCan } from "../permissions";
import { getAdapter } from "../sync/engine";

// External mirror? Then only the person whose provider account backs it may
// change/delete it — and the change must land on the provider FIRST (throwing
// aborts the local write, keeping Musubi and the provider consistent).
async function pushExternal(
  userID: string,
  calendarID: string,
  action: (adapter: NonNullable<ReturnType<typeof getAdapter>>, link: NonNullable<Awaited<ReturnType<typeof getExternalLinkForCalendar>>>) => Promise<void>,
) {
  const link = await getExternalLinkForCalendar(calendarID);
  if (!link) return;
  if (link.userID !== userID) {
    throw new ForbiddenError("Only the owner of the connected account can change this calendar.");
  }
  const adapter = getAdapter(link.provider);
  if (!adapter) throw new BadRequestError(`Unknown provider "${link.provider}".`);
  try {
    await action(adapter, link);
  } catch (e: any) {
    throw new BadRequestError(e?.message ?? "The provider rejected the change.");
  }
}

export async function handlerCreateCalendar(req: Request, res: Response) {
  let calendar: Calendar;
  try {
    calendar = CalendarSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid calendar data...");
  }

  // Create INTO a connected provider account: make it on the provider first,
  // then import the mirror exactly like the sync engine would.
  if (calendar.provider && calendar.accountId) {
    const adapter = getAdapter(calendar.provider);
    if (!adapter) throw new BadRequestError(`Unknown provider "${calendar.provider}".`);
    const account = (await adapter.listAccounts(req.user!.id)).find(a => a.id === calendar.accountId);
    if (!account) throw new ForbiddenError("That account isn't connected to your user.");

    let externalId: string;
    try {
      ({ externalId } = await adapter.createCalendar(req.user!.id, account.id, { name: calendar.name, color: calendar.color }));
    } catch (e: any) {
      throw new BadRequestError(e?.message ?? "The provider rejected the new calendar.");
    }
    const created = await importExternalCalendar(
      calendar.provider, req.user!.id, account.id, account.label,
      { externalId, name: calendar.name, color: calendar.color },
    );
    const link = await getExternalLinkForCalendar(created.id);
    return res.status(201).json({
      ...created,
      role: "owner",
      members: [{ id: req.user!.id, name: req.user!.name, email: req.user!.email }],
      provider: link?.provider ?? calendar.provider,
      accountId: link?.accountID ?? account.id,
      accountLabel: link?.accountLabel ?? account.label,
      serverUrl: link?.serverUrl ?? null,
    });
  }

  const newCalendar: NewCalendar = {
    name: calendar.name,
    color: calendar.color,
    creatorID: req.user!.id,
  }
  const result = await createCalendar(newCalendar);
  res.status(201).json({ ...result, role: "owner", members: [{ id: req.user!.id, name: req.user!.name, email: req.user!.email }] });
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
  const existing = await getCalendar(calendar.id);
  if (existing.isDefault) {
    throw new BadRequestError("Your personal calendar can't be deleted.");
  }
  // External mirror → delete on the provider first; failure aborts the local delete.
  await pushExternal(req.user!.id, calendar.id, (adapter, link) =>
    adapter.deleteCalendar(link.userID, link.accountID, link.externalCalendarID));
  const removedCalendar = await removeCalendar(calendar.id);

  if (removedCalendar) {

    const result = { ...removedCalendar, members: [] };

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
  // External mirror → rename/recolor on the provider first; failure aborts the local write.
  await pushExternal(req.user!.id, calendar.id, (adapter, link) =>
    adapter.updateCalendar(link.userID, link.accountID, link.externalCalendarID, { name: calendar.name, color: calendar.color }));
  // isDefault is server-managed — never writable from the client.
  const { isDefault: _ignored, ...editable } = calendar;
  const updatedCalendar = await updateCalendar({ ...editable, creatorID: req.user!.id });

  if (updatedCalendar) {

    const result = { ...updatedCalendar, members: calendar.members };

    const memberIDSeen = new Set<string>();

    const members = await getCalendarMembers(calendar.id);

    for (const member of members) {
      if (!memberIDSeen.has(member.userID)) {
        memberIDSeen.add(member.userID);
      }
    }

    notifyCalendarMembers([...memberIDSeen], "calendar_updated", result);


    return res.status(200).json(result);
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

// One-shot .ics snapshot of a whole calendar. Any member may export — they can
// already see every event. Reuses the CalDAV adapter's VEVENT serializer, so
// recurrence (RRULE + EXDATE) and all-day semantics round-trip identically.
export async function handlerExportCalendar(req: Request, res: Response) {
  const calendarID = req.params.id as string;
  if (!(await getUserRoleForCalendar(req.user!.id, calendarID))) {
    throw new ForbiddenError("You can't access this calendar.");
  }
  const calendar = await getCalendar(calendarID);
  const rows = await getCalendarEvents(calendarID);

  const vcal = new ICAL.Component("vcalendar");
  vcal.updatePropertyWithValue("version", "2.0");
  vcal.updatePropertyWithValue("prodid", "-//Musubi//EN");
  vcal.updatePropertyWithValue("x-wr-calname", calendar.name);
  for (const row of rows) {
    if (!row.events.deletedAt) vcal.addSubcomponent(toVevent(row.events));
  }

  const filename = `${calendar.name.replace(/[^\w.-]+/g, "_") || "calendar"}.ics`;
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.status(200).send(vcal.toString());
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
  // Empty result = was already a member (conflict) — don't burn a use on re-joins.
  if (result.length > 0) await consumeInvite(token);

  res.status(200).json(result);
}

export async function handlerLeaveCalendar(req: Request, res: Response) {
  const calendarID = req.params.calendarId as string;
  const calendar = await getCalendar(calendarID);
  if (req.user!.id === calendar.creatorID) {
    // Would orphan the calendar — transfer ownership (setMemberRole "owner") or delete it.
    throw new BadRequestError("The owner can't leave. Transfer ownership or delete the calendar.");
  }
  await removeCalendarMember(req.user?.id!, calendarID);

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

  await removeCalendarMember(targetUserID, calendarID);
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
    if (calendar.isDefault) {
      throw new BadRequestError("Your personal calendar's ownership can't be transferred.");
    }
    const updated = await setMemberRole(targetUserID, calendarID, "owner");
    if (!updated) throw new NotFoundError("Member not found on this calendar...");
    await updateCalendar({ ...calendar, creatorID: targetUserID });
    await setMemberRole(req.user!.id, calendarID, "editor");
    // Role is per-user → personalized payloads, so open clients update live.
    notifyCalendarMembers([targetUserID], "calendar_updated", { ...calendar, creatorID: targetUserID, role: "owner" });
    notifyCalendarMembers([req.user!.id], "calendar_updated", { ...calendar, creatorID: targetUserID, role: "editor" });
    return res.status(200).json({ id: targetUserID, role: "owner" });
  }

  const updated = await setMemberRole(targetUserID, calendarID, role);
  if (!updated) throw new NotFoundError("Member not found on this calendar...");

  // Tell the affected user right away — no reload needed to gain/lose edit UI.
  notifyCalendarMembers([targetUserID], "calendar_updated", { ...calendar, role });

  res.status(200).json({ id: targetUserID, role: updated.role });
}

