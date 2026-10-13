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
  const abaRefreshes = new Map<string, {
    started: () => void;
    release?: () => void;
    requests: number;
    obsoleteStatus: number;
    obsoletePayload: unknown;
    acceptedAccess: string;
    acceptedRefresh: string;
  }>();

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

      const aba = abaRefreshes.get(refreshToken);
      if (aba) {
        aba.requests++;
        if (aba.requests === 1) {
          let released = false;
          aba.release = () => {
            if (released) return;
            released = true;
            json(aba.obsoleteStatus, aba.obsoletePayload);
          };
          aba.started();
          return;
        }
        return json(200, { access_token: aba.acceptedAccess, refresh_token: aba.acceptedRefresh, expires_in: 3600 });
      }

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

    const rotatingGeneration = (await getOAuthCredentials(userID, "google", rotatingID))!.syncReadGeneration;
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
    assert.equal(rotated.syncReadGeneration, rotatingGeneration, "A routine non-null access/refresh token rotation preserves the grant generation");

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

    // Values alone cannot distinguish a grant that loses authority and regains
    // the identical tokens, expiry, scope and status before its HTTP reply.
    // Exercise both stale-success and stale-invalid_grant for every trigger.
    for (const dimension of ["scope", "status", "refresh-presence"] as const) {
      for (const obsoleteStatus of [200, 400]) {
        const abaID = `aba-${dimension}-${obsoleteStatus}-${suffix}`;
        const refreshToken = `aba.refresh-${abaID}`;
        await db.insert(account).values({
          id: `row-${abaID}`, accountId: abaID, providerId: "google", userId: userID,
          scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks",
          accessToken: "aba.expired-access", accessTokenExpiresAt: new Date(0), refreshToken,
        });
        const before = (await getOAuthCredentials(userID, "google", abaID))!;
        let startedABA!: () => void;
        const started = new Promise<void>(resolve => { startedABA = resolve; });
        const fixture = {
          started: startedABA, requests: 0,
          obsoleteStatus,
          obsoletePayload: obsoleteStatus === 200
            ? { access_token: "obsolete-aba-access", refresh_token: "obsolete-aba-refresh", expires_in: 3600, scope: "obsolete.scope" }
            : { error: "invalid_grant", error_subtype: "invalid_rapt" },
          acceptedAccess: `accepted.access-${abaID}`, acceptedRefresh: `accepted.refresh-${abaID}`,
          release: undefined as (() => void) | undefined,
        };
        abaRefreshes.set(refreshToken, fixture);
        const pending = getOAuthAccessToken("google", userID, abaID, config);
        try {
          await started;
          const where = eq(account.id, before.id);
          if (dimension === "scope") {
            await db.update(account).set({ scope: "openid email" }).where(where);
            await db.update(account).set({ scope: before.scope }).where(where);
          } else if (dimension === "status") {
            await db.update(account).set({ syncStatus: "reconnect_required" }).where(where);
            await db.update(account).set({ syncStatus: before.syncStatus }).where(where);
          } else {
            await db.update(account).set({ refreshToken: null }).where(where);
            await db.update(account).set({ refreshToken: before.refreshToken }).where(where);
          }
          const restored = (await getOAuthCredentials(userID, "google", abaID))!;
          assert.deepEqual({ ...restored, syncReadGeneration: before.syncReadGeneration }, before,
            `${dimension}: the original credential snapshot is restored byte-for-byte apart from its generation`);
          assert.equal(restored.syncReadGeneration, before.syncReadGeneration + 2);
          assert.equal(await updateOAuthTokens(userID, "google", abaID, {
            accessToken: "forbidden-stale-save", accessTokenExpiresAt: new Date(Date.now() + 3600000),
          }, before), false, `${dimension}: even identical restored values cannot authorize stale token persistence`);
          assert.equal(await markOAuthAccountReconnectRequired(userID, "google", abaID,
            "invalid_grant", "invalid_rapt", before), false,
          `${dimension}: even identical restored values cannot authorize stale revocation`);
          fixture.release!();
          assert.equal(await pending, fixture.acceptedAccess,
            `${dimension}/${obsoleteStatus}: only a refresh performed after the generation change can return a token`);
          assert.equal(fixture.requests, 2, "The obsolete response is discarded and the current grant is refreshed once");
          const after = (await getOAuthCredentials(userID, "google", abaID))!;
          assert.equal(after.syncStatus, "active");
          assert.equal(after.scope, before.scope);
          assert.equal(await decryptToken(after.refreshToken), fixture.acceptedRefresh);
          assert.equal(after.syncReadGeneration, restored.syncReadGeneration,
            "An obsolete response neither revokes nor narrows the restored grant; its ordinary fresh rotation preserves the generation");
        } finally {
          fixture.release?.();
          await pending.catch(() => undefined);
          abaRefreshes.delete(refreshToken);
        }
      }
    }

    // A new caller must not coalesce with a pre-ABA request even when every
    // credential value used by the old coalescing key is identical again.
    const independentID = `aba-independent-${suffix}`, independentRefresh = `aba.refresh-${independentID}`;
    await db.insert(account).values({
      id: `row-${independentID}`, accountId: independentID, providerId: "google", userId: userID,
      scope: "https://www.googleapis.com/auth/calendar.events", accessToken: "aba.expired-access",
      accessTokenExpiresAt: new Date(0), refreshToken: independentRefresh,
    });
    let independentStarted!: () => void;
    const independentReady = new Promise<void>(resolve => { independentStarted = resolve; });
    const independentFixture = {
      started: independentStarted, requests: 0, obsoleteStatus: 400,
      obsoletePayload: { error: "invalid_grant" },
      acceptedAccess: "independent-current-access", acceptedRefresh: "independent-current-refresh",
      release: undefined as (() => void) | undefined,
    };
    abaRefreshes.set(independentRefresh, independentFixture);
    const obsoletePending = getOAuthAccessToken("google", userID, independentID, config);
    let currentPending: Promise<string> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await independentReady;
      const where = eq(account.id, `row-${independentID}`);
      await db.update(account).set({ refreshToken: null }).where(where);
      await db.update(account).set({ refreshToken: independentRefresh }).where(where);
      currentPending = getOAuthAccessToken("google", userID, independentID, config);
      const currentFinished = await Promise.race([
        currentPending.then(() => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 5000); }),
      ]);
      assert.equal(currentFinished, true, "A restored grant refreshes independently before the obsolete HTTP response is released");
      assert.equal(await currentPending, independentFixture.acceptedAccess);
      assert.equal(independentFixture.requests, 2);
      independentFixture.release!();
      assert.equal(await obsoletePending, independentFixture.acceptedAccess,
        "An obsolete invalid_grant re-reads the current token without revoking the restored grant");
      assert.equal((await getOAuthCredentials(userID, "google", independentID))?.syncStatus, "active");
    } finally {
      clearTimeout(timeout);
      independentFixture.release?.();
      await Promise.all([obsoletePending.catch(() => undefined), currentPending?.catch(() => undefined)]);
      abaRefreshes.delete(independentRefresh);
    }

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

  console.log("provider OAuth lifecycle integration self-check: lifecycle, six delayed ABA races, generation-isolated refresh coalescing and routine rotation OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
