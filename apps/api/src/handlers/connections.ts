import { Request, Response } from "express";
import { auth } from "@musubi/auth";
import { cleanUsersOAuthTokens, deleteCaldavAccount, getOAuthCredentials, getUserExternalCalendars, removeCalendar } from "@musubi/db";
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
      // OAuth providers (google, ...) — unlink this specific account from Better
      // Auth. Better Auth refuses to unlink the user's LAST account (it would
      // lock them out of login) and also requires a fresh session. The calendar
      // should disconnect regardless — its mirrored calendars are already gone
      // above — so on refusal fall back to clearing this provider's stored
      // tokens/scope: sync stops, but the login account survives.
      try {
        await auth.api.unlinkAccount({
          body: { providerId: provider, accountId },
          headers: new Headers(req.headers as Record<string, string>),
        });
      } catch {
        await cleanUsersOAuthTokens(req.user!.id, provider);
      }
    }
  }

  res.sendStatus(200);
}
