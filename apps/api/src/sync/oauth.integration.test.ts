import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { account, db, user, getOAuthCredentials, updateOAuthTokens, markOAuthAccountReconnectRequired } from "@musubi/db";
import { decryptToken, encryptToken } from "../tokenCrypto";
import { ProviderAuthError } from "./errors";
import { getOAuthAccessToken } from "./oauth";

async function main() {
  if (process.env.ENVIRONMENT !== "test") {
    throw new Error("Refusing to run provider DB integration test unless ENVIRONMENT=test");
  }

  const suffix = randomUUID();
  const userID = `provider-oauth-${suffix}`;
  const rotatingID = `rotating-${suffix}`;
  const revokedID = `revoked-${suffix}`;
  const transientID = `transient-${suffix}`;
  const siblingID = `sibling-${suffix}`;
  const concurrentID = `concurrent-${suffix}`;
  const raceID = `race-${suffix}`;
  const transientAttempts = { count: 0 };
  const receivedRefreshTokens: string[] = [];
  let tokenEndpoint = "";
  let userCreated = false;
  let delayedRefreshStarted: (() => void) | undefined;
  let releaseDelayedRefresh: (() => void) | undefined;
  let delayedResult = { status: 200, payload: { access_token: "concurrent-access", expires_in: 3600 } as unknown };

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const refreshToken = new URLSearchParams(body).get("refresh_token") ?? "";
      receivedRefreshTokens.push(refreshToken);
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (refreshToken === "rotating-refresh") {
        return json(200, {
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 1_800,
        });
      }
      if (refreshToken === "revoked-refresh") {
        return json(400, {
          error: "invalid_grant",
          error_subtype: "invalid_rapt",
        });
      }
      if (refreshToken === "transient-refresh") {
        transientAttempts.count++;
        if (transientAttempts.count === 1) {
          return json(503, { error: "temporarily_unavailable" });
        }
        return json(200, {
          access_token: "recovered-access",
          expires_in: 3_600,
        });
      }
      if (["concurrent-refresh", "race-old-refresh"].includes(refreshToken)) {
        releaseDelayedRefresh = () => json(delayedResult.status, delayedResult.payload);
        delayedRefreshStarted?.();
        return;
      }
      if (refreshToken === "new-relinked-refresh") return json(200, { access_token: "renewed-relinked-access", expires_in: 3600 });
      return json(500, { error: "unexpected_test_refresh_token" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake token endpoint did not bind.");
  tokenEndpoint = `http://127.0.0.1:${address.port}/token`;

  try {
    await db.insert(user).values({
      id: userID,
      name: "Provider OAuth test",
      email: `${userID}@example.test`,
    });
    userCreated = true;

    const encrypted = await Promise.all([
      encryptToken("rotating-refresh"),
      encryptToken("revoked-refresh"),
      encryptToken("transient-refresh"),
      encryptToken("sibling-refresh"),
    ]);
    await db.insert(account).values([
      {
        id: `row-${rotatingID}`,
        accountId: rotatingID,
        providerId: "google",
        userId: userID,
        refreshToken: encrypted[0],
        accessToken: await encryptToken("expired-access"),
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      },
      {
        id: `row-${revokedID}`,
        accountId: revokedID,
        providerId: "google",
        userId: userID,
        refreshToken: encrypted[1],
      },
      {
        id: `row-${transientID}`,
        accountId: transientID,
        providerId: "google",
        userId: userID,
        refreshToken: encrypted[2],
      },
      {
        id: `row-${siblingID}`,
        accountId: siblingID,
        providerId: "google",
        userId: userID,
        refreshToken: encrypted[3],
      },
      { id: `row-${concurrentID}`, accountId: concurrentID, providerId: "google", userId: userID, refreshToken: "concurrent-refresh" },
      { id: `row-${raceID}`, accountId: raceID, providerId: "google", userId: userID, refreshToken: "race-old-refresh" },
    ]);

    const config = {
      tokenEndpoint,
      clientId: "test-client",
      clientSecret: "test-secret",
      subtypeKey: "error_subtype",
    };

    assert.equal(
      await getOAuthAccessToken("google", userID, rotatingID, config),
      "rotated-access",
    );
    const [rotated] = await db.select().from(account)
      .where(eq(account.id, `row-${rotatingID}`));
    assert.notEqual(rotated.accessToken, "rotated-access");
    assert.notEqual(rotated.refreshToken, "rotated-refresh");
    assert.equal(await decryptToken(rotated.accessToken), "rotated-access");
    assert.equal(await decryptToken(rotated.refreshToken), "rotated-refresh");
    assert.ok(rotated.accessTokenExpiresAt! > new Date());

    await assert.rejects(
      getOAuthAccessToken("google", userID, revokedID, config),
      (error: unknown) =>
        error instanceof ProviderAuthError
        && error.code === "invalid_grant"
        && error.subtype === "invalid_rapt"
        && error.reconnectRequired,
    );
    const [revoked, sibling] = await Promise.all([
      db.select().from(account).where(eq(account.id, `row-${revokedID}`))
        .then((rows) => rows[0]),
      db.select().from(account).where(eq(account.id, `row-${siblingID}`))
        .then((rows) => rows[0]),
    ]);
    assert.equal(revoked.syncStatus, "reconnect_required");
    assert.equal(revoked.refreshToken, null);
    assert.equal(revoked.syncErrorCode, "invalid_grant");
    assert.equal(revoked.syncErrorSubtype, "invalid_rapt");
    assert.equal(await decryptToken(sibling.refreshToken), "sibling-refresh");
    assert.equal(sibling.syncStatus, "active");

    await assert.rejects(
      getOAuthAccessToken("google", userID, transientID, config),
      (error: unknown) =>
        error instanceof ProviderAuthError
        && error.code === "temporarily_unavailable"
        && !error.reconnectRequired,
    );
    const [afterTransientFailure] = await db.select().from(account)
      .where(eq(account.id, `row-${transientID}`));
    assert.equal(afterTransientFailure.syncStatus, "active");
    assert.equal(
      await decryptToken(afterTransientFailure.refreshToken),
      "transient-refresh",
    );

    assert.equal(
      await getOAuthAccessToken("google", userID, transientID, config),
      "recovered-access",
    );
    assert.equal(transientAttempts.count, 2);
    assert.deepEqual(receivedRefreshTokens, [
      "rotating-refresh",
      "revoked-refresh",
      "transient-refresh",
      "transient-refresh",
    ]);

    const waitForRefresh = () => new Promise<void>((resolve) => { delayedRefreshStarted = resolve; });
    let started = waitForRefresh();
    const concurrent = Promise.all(Array.from({ length: 6 }, () => getOAuthAccessToken("google", userID, concurrentID, config)));
    await started;
    releaseDelayedRefresh!();
    assert.deepEqual(await concurrent, Array(6).fill("concurrent-access"));
    assert.equal(receivedRefreshTokens.filter((token) => token === "concurrent-refresh").length, 1, "Concurrent refreshes share one provider request");

    // A stale 401 after another reader's refresh uses the new token instead of
    // refreshing the rotated grant for a second time.
    const refreshCount = receivedRefreshTokens.length;
    assert.equal(await getOAuthAccessToken("google", userID, concurrentID, config, { rejectedAccessToken: "old-concurrent-access" }), "concurrent-access");
    assert.equal(receivedRefreshTokens.length, refreshCount);

    for (const result of [
      { status: 400, payload: { error: "invalid_grant" } },
      { status: 200, payload: { access_token: "obsolete-access", refresh_token: "obsolete-refresh", expires_in: 3600, scope: "obsolete.scope" } },
    ]) {
      await db.update(account).set({ accessToken: null, refreshToken: "race-old-refresh", accessTokenExpiresAt: null, scope: "old.scope", syncStatus: "active" }).where(eq(account.id, `row-${raceID}`));
      delayedResult = result;
      started = waitForRefresh();
      const racing = getOAuthAccessToken("google", userID, raceID, config);
      await started;
      await db.update(account).set({ accessToken: await encryptToken("relinked-access"), refreshToken: await encryptToken("relinked-refresh"), accessTokenExpiresAt: new Date(Date.now() + 3600000), scope: "relinked.scope", syncStatus: "active", syncErrorCode: null }).where(eq(account.id, `row-${raceID}`));
      releaseDelayedRefresh!();
      assert.equal(await racing, "relinked-access", "A relink wins over both stale invalid_grant and stale successful refresh");
      const [relinked] = await db.select().from(account).where(eq(account.id, `row-${raceID}`));
      assert.equal(relinked.syncStatus, "active");
      assert.equal(await decryptToken(relinked.refreshToken), "relinked-refresh");
      assert.equal(relinked.scope, "relinked.scope");
    }

    // A GET using the relinked token can itself get 401 while an obsolete grant
    // refresh remains in flight. It must refresh its own grant independently.
    await db.update(account).set({ accessToken: null, refreshToken: "race-old-refresh", accessTokenExpiresAt: null }).where(eq(account.id, `row-${raceID}`));
    delayedResult = { status: 400, payload: { error: "invalid_grant" } };
    started = waitForRefresh();
    const obsoleteRefresh = getOAuthAccessToken("google", userID, raceID, config);
    await started;
    await db.update(account).set({ accessToken: "new-relinked-access", refreshToken: "new-relinked-refresh", accessTokenExpiresAt: new Date(Date.now() + 3600000) }).where(eq(account.id, `row-${raceID}`));
    const releaseIfIncorrectlyBlocked = setTimeout(() => releaseDelayedRefresh!(), 5000);
    try {
      assert.equal(await getOAuthAccessToken("google", userID, raceID, config, { rejectedAccessToken: "new-relinked-access" }), "renewed-relinked-access");
    } finally {
      clearTimeout(releaseIfIncorrectlyBlocked);
      releaseDelayedRefresh!();
    }
    assert.equal(await obsoleteRefresh, "renewed-relinked-access");
    assert.equal(receivedRefreshTokens.filter((token) => token === "new-relinked-refresh").length, 1);

    // Deleting and recreating the same provider identity is a different grant,
    // even when every credential value happens to be unchanged.
    const oldCredentials = (await getOAuthCredentials(userID, "google", raceID))!;
    const [oldRow] = await db.select().from(account).where(eq(account.id, `row-${raceID}`));
    await db.delete(account).where(eq(account.id, oldRow.id));
    await db.insert(account).values({ ...oldRow, id: `recreated-${raceID}` });
    assert.equal(await markOAuthAccountReconnectRequired(userID, "google", raceID, "invalid_grant", undefined, oldCredentials), false);
    assert.equal(await updateOAuthTokens(userID, "google", raceID, { accessToken: "obsolete-access", accessTokenExpiresAt: new Date() }, oldCredentials), false);
    assert.equal((await getOAuthCredentials(userID, "google", raceID))?.syncStatus, "active");

    await db.update(account).set({ accessToken: null, refreshToken: "race-old-refresh", accessTokenExpiresAt: null }).where(eq(account.id, `recreated-${raceID}`));
    started = waitForRefresh();
    const disconnectedRefresh = getOAuthAccessToken("google", userID, raceID, config);
    await started;
    await db.update(account).set({ accessToken: null, refreshToken: null, accessTokenExpiresAt: null, scope: null, syncStatus: "active" }).where(eq(account.id, `recreated-${raceID}`));
    releaseDelayedRefresh!();
    await assert.rejects(disconnectedRefresh, (error: unknown) => error instanceof ProviderAuthError && error.code === "credentials_changed" && !error.reconnectRequired);
    assert.equal((await getOAuthCredentials(userID, "google", raceID))?.syncStatus, "active", "A stale refresh must not change the intentional disconnect state");
  } finally {
    if (userCreated) await db.delete(user).where(eq(user.id, userID));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }

  console.log("provider OAuth lifecycle integration self-check: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
