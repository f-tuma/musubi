import { Request, Response } from "express";
import {
  deleteCaldavAccount,
  getCaldavAccountsByUser,
  getUserExternalCalendars,
  removeCalendar,
  saveCaldavAccount,
} from "@musubi/db";
import { BadRequestError } from "@musubi/types";
import { encryptSecret } from "../sync/crypto";
import { createCaldavClient } from "../sync/caldav_client";

export async function handlerConnectCaldav(req: Request, res: Response) {
  const { serverUrl, username, password } = req.body ?? {};
  if (!serverUrl || !username || !password) {
    throw new BadRequestError("serverUrl, username and password are required...");
  }

  // Verify credentials by attempting discovery before storing anything.
  try {
    const client = await createCaldavClient(serverUrl, username, password);
    await client.fetchCalendars();
  } catch (err) {
    console.error("CalDAV connect failed:", serverUrl, username, err);
    throw new BadRequestError("Could not connect to CalDAV server — check URL and credentials. (iCloud requires an app-specific password.)");
  }

  await saveCaldavAccount(req.user!.id, serverUrl, username, encryptSecret(password));
  res.sendStatus(200);
}

export async function handlerCheckCaldavStatus(req: Request, res: Response) {
  const accounts = await getCaldavAccountsByUser(req.user!.id);
  res.status(200).json({ accounts }); // [{ id, serverUrl, username }]
}

export async function handlerDisconnectCaldav(req: Request, res: Response) {
  const accountId = (req.body?.accountId ?? req.query.accountId) as string | undefined;
  if (!accountId) throw new BadRequestError("accountId is required...");

  // Remove this account's mirrored calendars (+ their events), then the account.
  for (const link of await getUserExternalCalendars("caldav", req.user!.id, accountId)) {
    await removeCalendar(link.calendarID);
  }
  await deleteCaldavAccount(req.user!.id, accountId);
  res.sendStatus(200);
}
