import { and, eq } from "drizzle-orm";
import { caldavAccounts, db } from "..";

// Stores the ALREADY-ENCRYPTED password blob — this layer never sees plaintext.
// One user can have several CalDAV accounts; reconnecting the same server+user
// updates the password.
export async function saveCaldavAccount(
  userID: string,
  serverUrl: string,
  username: string,
  encryptedPassword: string,
) {
  await db.insert(caldavAccounts)
    .values({ userID, serverUrl, username, encryptedPassword })
    .onConflictDoUpdate({
      target: [caldavAccounts.userID, caldavAccounts.serverUrl, caldavAccounts.username],
      set: { encryptedPassword },
    });
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

export async function deleteCaldavAccount(userID: string, id: string) {
  await db.delete(caldavAccounts).where(and(eq(caldavAccounts.id, id), eq(caldavAccounts.userID, userID)));
}
