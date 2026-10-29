import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderDispatchDeferred } from "@musubi/sync-runtime";

process.env.ENVIRONMENT = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unused";
process.env.BETTER_AUTH_URL = "http://localhost:7531";
process.env.BETTER_AUTH_SECRET = "local-coordinator-diagnostic-test-secret";

test("actual coordinator reports execution context through the bounded logger port", async () => {
  const { logger } = await import("@musubi/config");
  const { db, SyncReadWorkChanged } = await import("@musubi/db");
  const { initializeSyncWorkCoordinator, runCapabilityProviderWork, stopSyncWorkCoordinator } = await import("./work_coordinator");
  const errorSink = logger.error, infoSink = logger.info;
  const logs: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  logger.error = (event, fields) => { logs.push({ level: "error", event, fields }); };
  logger.info = (event, fields) => { logs.push({ level: "info", event, fields }); };
  initializeSyncWorkCoordinator({ families: [], async execute() { assert.fail("No durable work is selected"); } });
  try {
    const failures = [
      new SyncReadWorkChanged("captured-binding-mismatch"),
      new ProviderDispatchDeferred({ reason: "credit", retryAtMs: 12345, blockedDimensions: [] }),
      Object.assign(new Error("Private SQL SELECT secret FROM https://private.example.test/token"), {
        privateUserID: "private-user", privatePayload: "private-payload",
      }),
    ];
    for (const error of failures) {
      await assert.rejects(runCapabilityProviderWork("caldav", async () => { throw error; }), caught => caught === error);
      // The capability result can reject before its host reports the failure.
      for (let turns = 0; logs.length <= failures.indexOf(error) && turns < 20; turns++) await Promise.resolve();
    }
    assert.equal(logs.length, 3);
    assert.deepEqual(logs.map(log => [log.level, log.event, log.fields?.phase, log.fields?.family, log.fields?.reason]), [
      ["error", "sync.work.failed", "execute", "pull", "read-work-changed"],
      ["info", "sync.work.deferred", "execute", "pull", "deferred"],
      ["error", "sync.work.failed", "execute", "pull", "unknown"],
    ]);
    assert.equal(logs[0]!.fields?.readFence, "captured-binding-mismatch");
    assert.equal(logs[1]!.fields?.deferralReason, "credit");
    assert.match(logs[2]!.fields?.messageFingerprint as string, /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(logs);
    for (const secret of ["Private SQL", "private.example", "private-user", "private-payload", "accountId", "stack"])
      assert(!serialized.includes(secret), secret);
    assert.equal(db.$client.totalCount, 0, "An empty candidate family set never connects to the deliberately unreachable DB");
  } finally {
    stopSyncWorkCoordinator(); logger.error = errorSink; logger.info = infoSink;
    await db.$client.end();
  }
});
