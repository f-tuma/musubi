import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { caldavAccounts, db } from "..";
import type { DbTransaction } from "./calendars";

// Stores the ALREADY-ENCRYPTED password blob — this layer never sees plaintext.
// One user can have several CalDAV accounts; reconnecting the same server+user
// updates the password.
export async function saveCaldavAccount(
  userID: string,
  serverUrl: string,
  username: string,
  encryptedPassword: string,
) {
  const [account] = await db.insert(caldavAccounts)
    .values({ userID, serverUrl, username, encryptedPassword })
    .onConflictDoUpdate({
      target: [caldavAccounts.userID, caldavAccounts.serverUrl, caldavAccounts.username],
      set: { encryptedPassword },
    })
    .returning({ id: caldavAccounts.id });
  return account;
}

// account ids (uuid) for this user — used by the adapter's listAccounts.
export async function getCaldavAccountsByUser(userID: string) {
  return db
    .select({
      id: caldavAccounts.id,
      serverUrl: caldavAccounts.serverUrl,
      username: caldavAccounts.username,
    })
    .from(caldavAccounts)
    .where(eq(caldavAccounts.userID, userID));
}

// credentials for one account — used by the adapter to build a client.
export async function getCaldavAccountById(id: string) {
  const [res] = await db
    .select({
      serverUrl: caldavAccounts.serverUrl,
      username: caldavAccounts.username,
      encryptedPassword: caldavAccounts.encryptedPassword,
    })
    .from(caldavAccounts)
    .where(eq(caldavAccounts.id, id));
  return res ?? null;
}

/** A native session can attest the current owned DAV row and captured host
 * revision without changing the legacy credential helper's result shape. */
export async function getOwnedCaldavAccountById(userID: string, id: string) {
  const [res] = await db.select({
    id: caldavAccounts.id, userID: caldavAccounts.userID, updatedAt: caldavAccounts.updatedAt,
    serverUrl: caldavAccounts.serverUrl, username: caldavAccounts.username, encryptedPassword: caldavAccounts.encryptedPassword,
  }).from(caldavAccounts).where(and(eq(caldavAccounts.id, id), eq(caldavAccounts.userID, userID)));
  return res ?? null;
}

/** Private credential/session boundary. SQL text preserves PostgreSQL's six
 * microsecond digits; the historical numeric operation timestamp stays a floor.
 * Neither this credential row nor its private digest belongs in logs/metrics. */
export async function getOwnedCaldavAccountBinding(userID: string, id: string,
  tx?: DbTransaction) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const query = (tx ?? db).select({
    id: caldavAccounts.id, userID: caldavAccounts.userID,
    serverUrl: caldavAccounts.serverUrl, username: caldavAccounts.username,
    encryptedPassword: caldavAccounts.encryptedPassword,
    credentialRevision: sql<string>`to_char(${caldavAccounts.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
  }).from(caldavAccounts).where(and(eq(caldavAccounts.id, id), eq(caldavAccounts.userID, userID)));
  const [row] = await (tx ? query.for("share") : query);
  if (!row) return null;
  const credentialFingerprint = createHash("sha256").update(JSON.stringify([
    "caldav-credential-v1", row.id, row.credentialRevision, row.serverUrl,
    row.username, row.encryptedPassword,
  ])).digest("hex");
  return { ...row, credentialFingerprint };
}
