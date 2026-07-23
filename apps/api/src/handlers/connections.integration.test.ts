import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { account, cleanOAuthAccountTokens, db, user } from "@musubi/db";

const TEST_SCOPE = "https://www.googleapis.com/auth/calendar.events";

async function main() {
  if (process.env.ENVIRONMENT !== "test") {
    throw new Error("Refusing to run OAuth DB integration test unless ENVIRONMENT=test");
  }

  const suffix = randomUUID();
  const ownerID = `oauth-owner-${suffix}`;
  const otherUserID = `oauth-other-${suffix}`;
  const targetAccountID = `target-${suffix}`;
  const siblingAccountID = `sibling-${suffix}`;
  const rows = [
    {
      id: `account-target-${suffix}`,
      accountId: targetAccountID,
      providerId: "google",
      userId: ownerID,
      accessToken: "target-access",
      refreshToken: "target-refresh",
      accessTokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
      refreshTokenExpiresAt: new Date("2031-01-01T00:00:00Z"),
      scope: TEST_SCOPE,
      syncStatus: "reconnect_required",
      syncErrorCode: "target-error",
      syncErrorSubtype: "target-subtype",
      syncDisabledAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: `account-sibling-${suffix}`,
      accountId: siblingAccountID,
      providerId: "google",
      userId: ownerID,
      accessToken: "sibling-access",
      refreshToken: "sibling-refresh",
      scope: TEST_SCOPE,
    },
    {
      id: `account-microsoft-${suffix}`,
      accountId: targetAccountID,
      providerId: "microsoft",
      userId: ownerID,
      accessToken: "microsoft-access",
      refreshToken: "microsoft-refresh",
      scope: "Calendars.ReadWrite",
    },
    {
      id: `account-other-user-${suffix}`,
      accountId: targetAccountID,
      providerId: "google",
      userId: otherUserID,
      accessToken: "other-access",
      refreshToken: "other-refresh",
      scope: TEST_SCOPE,
    },
  ];

  await db.insert(user).values([
    { id: ownerID, name: "OAuth test owner", email: `${ownerID}@example.test` },
    { id: otherUserID, name: "OAuth test other", email: `${otherUserID}@example.test` },
  ]);

  try {
    await db.insert(account).values(rows);
    await cleanOAuthAccountTokens(ownerID, "google", targetAccountID);

    const stored = await db.select().from(account).where(and(
      inArray(account.userId, [ownerID, otherUserID]),
      inArray(account.id, rows.map((row) => row.id)),
    ));
    const byID = new Map(stored.map((row) => [row.id, row]));

    const target = byID.get(`account-target-${suffix}`)!;
    assert.equal(target.accessToken, null);
    assert.equal(target.refreshToken, null);
    assert.equal(target.accessTokenExpiresAt, null);
    assert.equal(target.refreshTokenExpiresAt, null);
    assert.equal(target.scope, null);
    assert.equal(target.syncStatus, "active");
    assert.equal(target.syncErrorCode, null);
    assert.equal(target.syncErrorSubtype, null);
    assert.equal(target.syncDisabledAt, null);

    assert.equal(byID.get(`account-sibling-${suffix}`)?.refreshToken, "sibling-refresh");
    assert.equal(byID.get(`account-microsoft-${suffix}`)?.refreshToken, "microsoft-refresh");
    assert.equal(byID.get(`account-other-user-${suffix}`)?.refreshToken, "other-refresh");
  } finally {
    await db.delete(user).where(inArray(user.id, [ownerID, otherUserID]));
  }

  const leftovers = await db.select({ id: account.id }).from(account).where(
    inArray(account.id, rows.map((row) => row.id)),
  );
  assert.deepEqual(leftovers, []);
  console.log("OAuth account-scoped fallback integration self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
