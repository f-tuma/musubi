import { upsertMusubiAccount } from "@musubi/db";
import { logger } from "@musubi/config";
import { shouldRotateMemberToken } from "@musubi/types";
import { decryptSecret, encryptSecret } from "./sync/crypto";
import { federationFetch } from "./federation_origin";

// Member-token lifecycle, server side (ADR-005 phase 4).
//
// Custody moved off the clients, so rotation moved with it: whoever uses a
// connection refreshes its credential first. Lazy on use rather than scheduled —
// a connection nobody touches doesn't need a fresh token, and every code path
// that needs the token already loads the row.

const ROTATE_TIMEOUT_MS = 10_000;

type ConnectionRow = {
  encryptedToken: string;
  id: string;
  remoteUserID: string;
  server: string;
};

/**
 * The usable member token for a connection, rotated when it is close to expiry.
 *
 * Failure is deliberately tolerated: an origin server too old to expose the
 * rotate route (or briefly unreachable) keeps working on the current token,
 * exactly as the mobile client did before custody moved here.
 */
export async function connectionMemberToken(
  userID: string,
  connection: ConnectionRow,
  origin: string,
): Promise<string> {
  const token = decryptSecret(connection.encryptedToken);
  if (!shouldRotateMemberToken(token)) return token;

  try {
    const response = await federationFetch(`${origin}/api/v1/federation/token/rotate`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(ROTATE_TIMEOUT_MS),
    });
    if (!response.ok) return token;

    const payload = (await response.json().catch(() => null)) as {
      memberToken?: string;
    } | null;
    if (!payload?.memberToken) return token;

    await upsertMusubiAccount(
      userID,
      origin,
      connection.remoteUserID,
      encryptSecret(payload.memberToken),
    );
    logger.info("federation.token.rotated", {
      connectionId: connection.id,
      server: origin,
    });
    return payload.memberToken;
  } catch (error) {
    logger.warn("federation.token.rotation_failed", {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
      server: origin,
    });
    return token;
  }
}
