import { createHash, randomBytes } from "node:crypto";
import { memberTokenExpiresAt } from "@musubi/types";

export function hashMemberToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function issueMemberToken(now = new Date()) {
  const raw = `mt1_${now.getTime().toString(36)}_${randomBytes(32).toString("hex")}`;
  return {
    raw,
    tokenHash: hashMemberToken(raw),
    expiresAt: memberTokenExpiresAt(raw)!,
  };
}

export function bearerMemberToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}
