import { and, eq } from "drizzle-orm";
import { db, user, memberTokens, musubiAccounts } from "..";
import { randomUUID } from "node:crypto";

// Federation (Musubi ↔ Musubi): shadow accounts + member tokens.
// A shadow account is a normal `user` row (isExternal) standing in for someone
// whose real account lives on another Musubi server — so membership, roles and
// event attribution work natively. See apps/api/src/handlers/federation.ts.

/** The shadow user for (homeServer, email), or null. Never matches local users. */
export async function findExternalUser(homeServer: string, email: string) {
  const [row] = await db.select().from(user)
    .where(and(eq(user.isExternal, true), eq(user.homeServer, homeServer), eq(user.email, email)));
  return row ?? null;
}

/**
 * Create a shadow user. Security invariant: NEVER binds to an existing local
 * user — an unverified email claim must not impersonate a local account. On an
 * email collision the stored email falls back to a synthetic unique one (the
 * display name still shows who they are).
 */
export async function createExternalUser(profile: { name: string; email: string; image?: string | null; homeServer: string }) {
  const base = {
    id: `fed_${randomUUID()}`,
    name: profile.name,
    emailVerified: false,
    image: profile.image ?? null,
    isExternal: true,
    homeServer: profile.homeServer,
  };
  try {
    const [row] = await db.insert(user).values({ ...base, email: profile.email }).returning();
    return row;
  } catch {
    // email unique collision (a local user owns it) — synthesize a unique one
    const host = profile.homeServer.replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
    const [row] = await db.insert(user)
      .values({ ...base, email: `federated+${base.id.slice(4, 12)}@${host}` })
      .returning();
    return row;
  }
}

/** Persist a member token (SHA-256 hash only — the raw token is never stored). */
export async function saveMemberToken(userID: string, tokenHash: string) {
  await db.insert(memberTokens).values({ userID, tokenHash });
}

/** Resolve a presented token hash to its (external) user, or null. */
export async function getUserByTokenHash(tokenHash: string) {
  const [row] = await db
    .select({ user })
    .from(memberTokens)
    .innerJoin(user, eq(memberTokens.userID, user.id))
    .where(eq(memberTokens.tokenHash, tokenHash));
  return row?.user ?? null;
}

/** Drop all of a user's member tokens (e.g. when their last membership ends). */
export async function revokeMemberTokens(userID: string) {
  await db.delete(memberTokens).where(eq(memberTokens.userID, userID));
}

// ── Home side: this user's connections to OTHER Musubi servers ───────────────
// Tokens arrive here already encrypted (AES-GCM at the API layer) so every
// signed-in device can pick the connection up.

export async function getMusubiAccounts(userID: string) {
  return db.select().from(musubiAccounts).where(eq(musubiAccounts.userID, userID));
}

export async function upsertMusubiAccount(userID: string, server: string, remoteUserID: string, encryptedToken: string) {
  await db.insert(musubiAccounts)
    .values({ userID, server, remoteUserID, encryptedToken })
    .onConflictDoUpdate({
      target: [musubiAccounts.userID, musubiAccounts.server],
      set: { remoteUserID, encryptedToken, updatedAt: new Date() },
    });
}

export async function deleteMusubiAccount(userID: string, server: string) {
  await db.delete(musubiAccounts)
    .where(and(eq(musubiAccounts.userID, userID), eq(musubiAccounts.server, server)));
}
