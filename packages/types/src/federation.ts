export const MEMBER_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MEMBER_TOKEN_ROTATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const MEMBER_TOKEN_RE = /^mt1_([0-9a-z]+)_[0-9a-f]{64}$/i;

/**
 * New member tokens carry their issue time so clients can rotate them before
 * expiry. The database timestamp remains authoritative for authentication.
 */
export function memberTokenIssuedAt(token: string): Date | null {
  const match = MEMBER_TOKEN_RE.exec(token);
  if (!match) return null;

  const milliseconds = Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return null;

  const issuedAt = new Date(milliseconds);
  return Number.isNaN(issuedAt.getTime()) ? null : issuedAt;
}

export function memberTokenExpiresAt(token: string): Date | null {
  const issuedAt = memberTokenIssuedAt(token);
  return issuedAt ? new Date(issuedAt.getTime() + MEMBER_TOKEN_TTL_MS) : null;
}

export function shouldRotateMemberToken(token: string, now = new Date()): boolean {
  const expiresAt = memberTokenExpiresAt(token);
  // Legacy unversioned tokens have no client-readable timestamp. Rotate them
  // while they are still accepted by the database-side createdAt check.
  return !expiresAt
    || expiresAt.getTime() - now.getTime() <= MEMBER_TOKEN_ROTATION_WINDOW_MS;
}
