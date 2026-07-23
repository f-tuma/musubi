import { auth } from "@musubi/auth";
import { getUserByTokenHash } from "@musubi/db";
import { UnauthorizedError } from "@musubi/types";
import { NextFunction, Request, Response } from "express";
import { bearerMemberToken, hashMemberToken } from "../federation_tokens";
import { logger } from "@musubi/config";


export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await auth.api.getSession({ headers: new Headers(req.headers as Record<string, string>) });
  if (session) {
    req.user = session.user;
    logger.addContext({ userId: session.user.id });
    return next();
  }

  // Federation fallback: external (shadow) members authenticate with a member
  // token issued on invite accept — not a Better Auth session. Authentication
  // only; every route still authorizes via calendar_members/assertCan.
  const bearer = bearerMemberToken(req.headers.authorization);
  if (bearer) {
    const external = await getUserByTokenHash(hashMemberToken(bearer));
    if (external) {
      req.user = external;
      logger.addContext({ userId: external.id });
      return next();
    }
  }

  throw new UnauthorizedError("Unauthorized");
}
