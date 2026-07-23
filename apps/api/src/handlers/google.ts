import { cleanProviderOAuthTokens, getOAuthRefreshToken, oauthConnectionCheck } from "@musubi/db";
import { Request, Response } from "express";
import { syncUser } from "../sync/engine";
import { revokeGoogleToken } from "../sync/oauth";
import { decryptToken } from "../tokenCrypto";

export async function handlerCheckGoogleStatus(req: Request, res: Response) {
  const result = await oauthConnectionCheck(req.user!.id, "google");
  res.status(200).json(result);
}

export async function handlerRevokeGoogle(req: Request, res: Response) {
  const refreshToken = await decryptToken(await getOAuthRefreshToken(req.user!.id, "google"));
  if (refreshToken) await revokeGoogleToken(refreshToken);

  // Legacy endpoint has no accountId and is intentionally provider-wide.
  await cleanProviderOAuthTokens(req.user!.id, "google");

  res.sendStatus(200);
}

export async function handlerGetGoogleCalendars(req: Request, res: Response) {
  await syncUser(req.user!.id);

  res.sendStatus(200);
}
