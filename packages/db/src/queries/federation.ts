import { and, eq, lte, gt } from "drizzle-orm";
import { db, user, memberTokens, musubiAccounts } from "..";
import { randomUUID } from "node:crypto";
import { MEMBER_TOKEN_TTL_MS } from "@musubi/types";

// Federation (Musubi ↔ Musubi): shadow accounts + member tokens.
// A shadow account is a normal `user` row (isExternal) standing in for someone
// whose real account lives on another Musubi server — so membership, roles and
// event attribution work natively. See apps/api/src/handlers/federation.ts.

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

/** Replace every prior credential for this shadow user with one fresh token. */
export async function replaceMemberToken(userID: string, tokenHash: string) {
  return db.transaction(async (tx) => {
    await tx.delete(memberTokens).where(eq(memberTokens.userID, userID));
    const [created] = await tx.insert(memberTokens).values({ userID, tokenHash }).returning();
    return created;
  });
}

/**
 * Compare-and-swap rotation. Concurrent clients cannot both exchange the same
 * credential: only the transaction that deletes currentTokenHash may insert.
 */
export async function rotateMemberToken(
  userID: string,
  currentTokenHash: string,
  nextTokenHash: string,
) {
  return db.transaction(async (tx) => {
    const [removed] = await tx.delete(memberTokens)
      .where(and(
        eq(memberTokens.userID, userID),
        eq(memberTokens.tokenHash, currentTokenHash),
      ))
      .returning({ id: memberTokens.id });
    if (!removed) return null;

    // Collapse any legacy multi-token state while the proved credential is
    // being exchanged. New lifecycle permits one active token per shadow.
    await tx.delete(memberTokens).where(eq(memberTokens.userID, userID));
    const [created] = await tx.insert(memberTokens)
      .values({ userID, tokenHash: nextTokenHash })
      .returning();
    return created;
  });
}

/** Resolve a non-expired token hash to its external user, or null. */
export async function getUserByTokenHash(tokenHash: string, now = new Date()) {
  const oldestAccepted = new Date(now.getTime() - MEMBER_TOKEN_TTL_MS);
  const [row] = await db
    .select({ user })
    .from(memberTokens)
    .innerJoin(user, eq(memberTokens.userID, user.id))
    .where(and(
      eq(memberTokens.tokenHash, tokenHash),
      gt(memberTokens.createdAt, oldestAccepted),
      eq(user.isExternal, true),
    ));
  return row?.user ?? null;
}

export async function deleteExpiredMemberTokens(now = new Date()) {
  const cutoff = new Date(now.getTime() - MEMBER_TOKEN_TTL_MS);
  await db.delete(memberTokens).where(lte(memberTokens.createdAt, cutoff));
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
