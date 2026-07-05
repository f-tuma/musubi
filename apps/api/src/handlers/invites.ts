import { Request, Response } from "express";
import { createInvite, NewCalendarInvite } from '@musubi/db';
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
    expiresAt: new Date(invite.expiresAt),
    maxUses: invite.maxUses,
    calendarID: invite.calendarID,
  }
  const result = await createInvite(newCalendarInvite);

  res.status(201).json(result);
}
