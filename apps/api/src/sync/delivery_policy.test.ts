import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { createDeliveryAttempt, DeliveryAttemptInterrupted, deliveryRetryDelayMs, deliveryNextAttemptAt, withDeliveryDeadline } from "./delivery_policy";

async function main() {
  assert.equal(deliveryRetryDelayMs(1, undefined, 0), 1500);
  assert.equal(deliveryRetryDelayMs(1, undefined, 1), 2500);
  assert.equal(deliveryRetryDelayMs(99, undefined, 1), 3_600_000);
  assert.equal(deliveryRetryDelayMs(1, 7_200_000, 0), 7_200_000, "server minimum is not capped by client backoff");
  assert.equal(deliveryRetryDelayMs(1, Infinity, 0), 1500);
  assert.equal(deliveryRetryDelayMs(1, -10, 0), 1500);
  assert.ok(Number.isFinite(deliveryNextAttemptAt(1, Number.MAX_VALUE).getTime()));
  assert.throws(() => createDeliveryAttempt(async () => true, { timeoutMs: Infinity }), RangeError);

  let renewals = 0;
  const hanging = createDeliveryAttempt(async () => { renewals++; return true; }, { timeoutMs: 35, heartbeatMs: 5 });
  try {
    await assert.rejects(hanging.run(() => new Promise<never>(() => {})), error =>
      error instanceof DeliveryAttemptInterrupted && error.reason === "timeout");
    assert.equal(hanging.signal.aborted, true);
    const stoppedAt = renewals;
    await wait(20);
    assert.equal(renewals, stoppedAt, "a hung adapter cannot renew its lease after deadline");
  } finally { hanging.dispose(); }

  const lost = createDeliveryAttempt(async () => false, { timeoutMs: 1000, heartbeatMs: 5 });
  try {
    await assert.rejects(lost.run(() => new Promise<never>(() => {})), error =>
      error instanceof DeliveryAttemptInterrupted && error.reason === "lease-lost");
  } finally { lost.dispose(); }

  let finishRenewals = 0;
  const finished = createDeliveryAttempt(async () => { finishRenewals++; return true; }, { timeoutMs: 1000, heartbeatMs: 5 });
  assert.equal(await finished.run(async () => 42), 42);
  finished.dispose();
  await wait(15);
  assert.equal(finishRenewals, 0, "successful attempt clears its heartbeat");
  let preflightSignal: AbortSignal | undefined;
  await assert.rejects(withDeliveryDeadline(signal => {
    preflightSignal = signal;
    return new Promise<never>(() => {});
  }, { timeoutMs: 10 }), error => error instanceof DeliveryAttemptInterrupted && error.reason === "timeout");
  assert.equal(preflightSignal?.aborted, true, "authorization preview has a deadline even without a durable lease");
  console.log("delivery policy: bounded hangs, lease loss, cleanup, shared backoff and Retry-After passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
