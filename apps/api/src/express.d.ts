import { auth } from "@musubi/auth";

type BetterAuthUser = typeof auth.$Infer.Session.user;

declare global {
  namespace Express {
    interface Request {
      user?: BetterAuthUser;
    }
  }
}
