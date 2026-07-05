import { auth } from "@musubi/auth";
import { UnauthorizedError } from "@musubi/types";
import { NextFunction, Request, Response } from "express";


export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await auth.api.getSession({ headers: new Headers(req.headers as Record<string, string>) });
  if (!session) throw new UnauthorizedError("Unauthorized");
  req.user = session.user;
  next();
}
