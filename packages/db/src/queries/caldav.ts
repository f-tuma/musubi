import { eq } from "drizzle-orm";
import { caldavAccounts, db } from "..";

// Stores the ALREADY-ENCRYPTED password blob — this layer never sees plaintext.
export async function saveCaldavAccount(
  userID: string,
  serverUrl: string,
  username: string,
  encryptedPassword: string,
) {
  await db.insert(caldavAccounts)
    .values({ userID, serverUrl, username, encryptedPassword })
    .onConflictDoUpdate({
      target: caldavAccounts.userID,
      set: { serverUrl, username, encryptedPassword },
    });
}

export async function getCaldavAccount(userID: string) {
  const [res] = await db
    .select({
      serverUrl: caldavAccounts.serverUrl,
      username: caldavAccounts.username,
      encryptedPassword: caldavAccounts.encryptedPassword,
    })
    .from(caldavAccounts)
    .where(eq(caldavAccounts.userID, userID));
  return res ?? null;
}

export async function deleteCaldavAccount(userID: string) {
  await db.delete(caldavAccounts).where(eq(caldavAccounts.userID, userID));
}
