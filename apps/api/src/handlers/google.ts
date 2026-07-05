import { cleanUsersGoogleTokens, getGoogleRefreshToken, googleCheck } from "@musubi/db";
import { Request, Response } from "express";
import { syncUser } from "../sync/engine";

export async function handlerCheckGoogleStatus(req: Request, res: Response) {
  const result = await googleCheck(req.user!.id);
  res.status(200).json(result);
}

export async function handlerRevokeGoogle(req: Request, res: Response) {
  const refreshToken = await getGoogleRefreshToken(req.user!.id);

  if (refreshToken) {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${refreshToken}`,
    });
  }

  await cleanUsersGoogleTokens(req.user!.id);

  res.sendStatus(200);
}

export async function handlerGetGoogleCalendars(req: Request, res: Response) {
  await syncUser(req.user!.id);

  res.sendStatus(200);
}
