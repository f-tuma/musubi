import { cleanUsersGoogleTokens, googleCheck } from "@musubi/db";
import { Request, Response } from "express";

export async function handlerCheckGoogleStatus(req: Request, res: Response) {
  const result = await googleCheck(req.user!.id);
  res.status(200).json(result);
}

export async function handlerRevokeGoogle(req: Request, res: Response) {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${(await googleCheck(req.user!.id)).refreshToken}`,
  });

  cleanUsersGoogleTokens(req.user!.id);

  res.sendStatus(200);
}
