import { Request, Response } from "express";
import { resetUsers } from '@musubi/db';
import { config } from "@musubi/config";
import { auth } from "@musubi/auth";
import { BadRequestError, UnauthorizedError } from "@musubi/types";


export async function handlerDeleteUser(req: Request, res: Response) {
  const result = await auth.api.deleteUser({
    headers: new Headers(req.headers as Record<string, string>),
    body: {},
  });

  if (!result.success) {
    throw new Error(result.message);
  }
  res.sendStatus(200);
}


export async function handlerResetPassword(req: Request, res: Response) {
  if (typeof req.body.newPassword !== "string" || typeof req.body.token !== "string") {
    throw new BadRequestError("Missing required data for password reset...");
  }

  const { status } = await auth.api.resetPassword({
    body: req.body,
  });

  if (!status) {
    throw new UnauthorizedError("Invalid token...");
  }

  res.sendStatus(200);
}



// DEV ONLY

export async function handlerResetUsers(req: Request, res: Response) {
  if (config.api.environment === "dev") {
    await resetUsers();
    res.sendStatus(205);
  } else {
    res.sendStatus(403);
  }
}
