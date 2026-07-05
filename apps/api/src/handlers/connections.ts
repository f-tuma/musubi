import { Request, Response } from "express";
import { auth } from "@musubi/auth";
import { deleteCaldavAccount, getUserExternalCalendars, removeCalendar } from "@musubi/db";
import { BadRequestError } from "@musubi/types";

// Disconnect one connected account of a provider: remove its mirrored Musubi
// calendars, then drop the credentials (unlink the OAuth account / delete CalDAV row).
export async function handlerDisconnectAccount(req: Request, res: Response) {
  const { provider, accountId } = req.body ?? {};
  if (!provider || !accountId) throw new BadRequestError("provider and accountId are required...");

  // remove the account's mirrored calendars (+ their events)
  for (const link of await getUserExternalCalendars(provider, req.user!.id, accountId)) {
    await removeCalendar(link.calendarID);
  }

  if (provider === "caldav") {
    await deleteCaldavAccount(req.user!.id, accountId);
  } else {
    // OAuth providers (google, ...) — unlink this specific account from Better Auth
    await auth.api.unlinkAccount({
      body: { providerId: provider, accountId },
      headers: new Headers(req.headers as Record<string, string>),
    });
  }

  res.sendStatus(200);
}
