import { Request, Response } from "express";
import { createInvite, deleteInvite, getCalendarInvites, getInvite, NewCalendarInvite } from '@musubi/db';
import { BadRequestError, Invite, InviteSchema } from "@musubi/types";
import { assertCan } from "../permissions";


export async function handlerCreateCalendarInvite(req: Request, res: Response) {
  let invite: Invite;
  try {
    invite = InviteSchema.parse(req.body);
  } catch (err) {
    throw new BadRequestError("Request is missing valid invite data...");
  }
  await assertCan(req.user!.id, invite.calendarID, "invite");
  const newCalendarInvite: NewCalendarInvite = {
    expiresAt: invite.expiresAt, // null = never expires
    maxUses: invite.maxUses,     // null = unlimited
    calendarID: invite.calendarID,
  }
  const result = await createInvite(newCalendarInvite);

  res.status(201).json(result);
}

// Who may create invites may also see and revoke them — one "invite" gate.
export async function handlerGetCalendarInvites(req: Request, res: Response) {
  const calendarID = req.params.calendarId as string;
  await assertCan(req.user!.id, calendarID, "invite");
  res.status(200).json(await getCalendarInvites(calendarID));
}

export async function handlerRevokeInvite(req: Request, res: Response) {
  const invite = await getInvite(req.params.inviteId as string);
  await assertCan(req.user!.id, invite.calendarID, "invite");
  await deleteInvite(invite.id); // token stops working immediately — joins validate per request
  res.sendStatus(200);
}
