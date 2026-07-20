import { Request, Response } from "express";
import { auth } from "@musubi/auth";
import { deleteCaldavAccount, getOAuthCredentials, getUserExternalCalendars, removeCalendar } from "@musubi/db";
import { BadRequestError } from "@musubi/types";
import { revokeGoogleToken } from "../sync/oauth";
import { decryptToken } from "../tokenCrypto";

// Disconnect one connected account of a provider: revoke the provider grant
// (Google only), then always remove the account's mirrored Musubi calendars and
// drop its credentials — even if revoke fails. Everything is scoped to the given
// accountId, so a second connected Google account is untouched.
export async function handlerDisconnectAccount(req: Request, res: Response) {
  const { provider, accountId } = req.body ?? {};
  if (!provider || !accountId) throw new BadRequestError("provider and accountId are required...");

  try {
    // Best-effort revoke of THIS account's grant before we drop its token.
    // Microsoft/CalDAV have no equivalent revoke step here.
    if (provider === "google") {
      const creds = await getOAuthCredentials(req.user!.id, "google", accountId);
      const refreshToken = await decryptToken(creds?.refreshToken);
      if (refreshToken) await revokeGoogleToken(refreshToken);
    }
  } finally {
    // Always remove local state, even if revoke or credential lookup threw.
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
  }

  res.sendStatus(200);
}
