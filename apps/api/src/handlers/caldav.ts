import { Request, Response } from "express";
import {
  deleteCaldavAccount,
  getCaldavAccountsByUser,
  getUserExternalCalendars,
  removeCalendar,
  saveCaldavAccount,
} from "@musubi/db";
import { BadRequestError } from "@musubi/types";
import { logger } from "@musubi/config";
import { encryptSecret } from "../sync/crypto";
import { createCaldavClient } from "../sync/caldav_client";
import { syncUser } from "../sync/engine";

export async function handlerConnectCaldav(req: Request, res: Response) {
  // Trim: pasted app-specific passwords routinely carry a trailing space/newline
  // from the mobile clipboard, and Apple answers that with a bare 401.
  const serverUrl = (req.body?.serverUrl as string | undefined)?.trim();
  const username = (req.body?.username as string | undefined)?.trim();
  const password = (req.body?.password as string | undefined)?.trim();
  if (!serverUrl || !username || !password) {
    throw new BadRequestError("serverUrl, username and password are required...");
  }

  // Verify credentials by attempting discovery before storing anything.
  try {
    const client = await createCaldavClient(serverUrl, username, password);
    await client.fetchCalendars();
  } catch (err) {
    logger.warn("caldav.connect.discovery_failed", {
      userId: req.user!.id,
      serverOrigin: safeOrigin(serverUrl),
      error: err,
    });
    throw new BadRequestError("Could not connect to CalDAV server — check URL and credentials. (iCloud requires an app-specific password.)");
  }

  const account = await saveCaldavAccount(req.user!.id, serverUrl, username, encryptSecret(password));

  // Connecting is not complete until the account's calendars and events can be
  // imported. Keep this strict (unlike the scheduled best-effort sync) so the
  // client never reports success after discovery passed but event fetching did
  // not — notably the failure mode iCloud had with calendar-query REPORTs.
  try {
    await syncUser(req.user!.id, { provider: "caldav", accountId: account.id, throwOnError: true });
  } catch (err) {
    logger.warn("caldav.connect.initial_sync_failed", {
      userId: req.user!.id,
      accountId: account.id,
      serverOrigin: safeOrigin(serverUrl),
      error: err,
    });
    const detail = err instanceof Error ? ` ${err.message}` : "";
    throw new BadRequestError(`Credentials were accepted, but the initial calendar sync failed.${detail}`);
  }

  res.sendStatus(200);
}

function safeOrigin(serverUrl: string) {
  try { return new URL(serverUrl).origin; }
  catch { return "invalid-url"; }
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
