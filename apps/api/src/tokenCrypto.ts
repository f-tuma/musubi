import { auth } from "@musubi/auth";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

// OAuth access/refresh tokens are stored encrypted at rest via Better Auth's
// `account.encryptOAuthTokens`. Better Auth transparently decrypts tokens it
// reads through its own flow, but our sync layer reads the `account` columns
// directly (manual refresh + revoke), so we decrypt/encrypt here using the exact
// same key material Better Auth uses — auth.$context.secretConfig — which lives
// outside the database. Tokens are never logged.

// Mirror of Better Auth's own heuristic: a stored token is only decrypted if it
// looks encrypted. Real OAuth tokens contain "/", "-", "_" or "." so they never
// match, which lets pre-encryption plaintext tokens pass through untouched until
// they're re-encrypted on the next refresh.
function isLikelyEncrypted(token: string): boolean {
  if (token.startsWith("$ba$")) return true;
  return token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token);
}

async function encryptionKey() {
  return (await auth.$context).secretConfig;
}

export async function decryptToken<T extends string | null | undefined>(token: T): Promise<T> {
  if (!token || !isLikelyEncrypted(token)) return token;
  try {
    return (await symmetricDecrypt({ key: await encryptionKey(), data: token })) as T;
  } catch {
    // Authenticated-decrypt failure = not our ciphertext (legacy plaintext that
    // happened to look hex). Fall back to the raw value.
    return token;
  }
}

export async function encryptToken(token: string): Promise<string> {
  return symmetricEncrypt({ key: await encryptionKey(), data: token });
}
