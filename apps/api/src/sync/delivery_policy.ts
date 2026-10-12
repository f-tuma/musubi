/** One bounded attempt for both delivery queues. The durable outbox, rather
 * than a timer in this process, owns subsequent retries. */
export const DELIVERY_ATTEMPT_TIMEOUT_MS = 45_000;
export const DELIVERY_LEASE_HEARTBEAT_MS = 20_000;

export class DeliveryAttemptInterrupted extends Error {
  constructor(readonly reason: "timeout" | "lease-lost" | "finished") {
    super(`Delivery attempt ${reason}.`);
    this.name = "DeliveryAttemptInterrupted";
  }
}

export type DeliveryAttemptOptions = { timeoutMs?: number; heartbeatMs?: number };

export function validateDeliveryAttemptOptions(options: DeliveryAttemptOptions) {
  const timeoutMs = options.timeoutMs ?? DELIVERY_ATTEMPT_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? DELIVERY_LEASE_HEARTBEAT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
      !Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > 2_147_483_647) {
    throw new RangeError("Delivery timers must be positive finite timer durations.");
  }
  return { timeoutMs, heartbeatMs };
}

export function createDeliveryAttempt(
  renewLease: (() => Promise<boolean>) | undefined,
  options: DeliveryAttemptOptions = {},
) {
  const { timeoutMs, heartbeatMs } = validateDeliveryAttemptOptions(options);
  const controller = new AbortController();
  const signal = controller.signal;
  let heartbeatBusy = false;
  const abort = (reason: DeliveryAttemptInterrupted["reason"]) => controller.abort(new DeliveryAttemptInterrupted(reason));
  const interrupted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const timeout = setTimeout(() => abort("timeout"), timeoutMs);
  const heartbeat = renewLease && setInterval(() => {
    if (heartbeatBusy || signal.aborted) return;
    heartbeatBusy = true;
    void Promise.resolve().then(renewLease).then(ok => { if (!ok) abort("lease-lost"); }, () => abort("lease-lost"))
      .finally(() => { heartbeatBusy = false; });
  }, heartbeatMs);
  heartbeat?.unref();
  return {
    signal,
    // Race also bounds an adapter which accidentally ignores cancellation.
    // Executors must check signal again before mutation and acknowledgement.
    run<T>(work: () => Promise<T>): Promise<T> {
      return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), interrupted]);
    },
    dispose() {
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      abort("finished");
    },
  };
}

/** Authorization previews happen before durable admission and own no lease.
 * They still need a deadline, including OAuth/discovery inside the adapter. */
export async function withDeliveryDeadline<T>(work: (signal: AbortSignal) => Promise<T>, options: DeliveryAttemptOptions = {}) {
  const attempt = createDeliveryAttempt(undefined, options);
  try { return await attempt.run(() => work(attempt.signal)); }
  finally { attempt.dispose(); }
}

/** Retry-After is a lower bound, including when it exceeds our backoff cap.
 * Invalid hints cannot produce an immediate hot retry or an invalid Date. */
export function deliveryRetryDelayMs(attempts: number, retryAfterMs?: number, random = Math.random()) {
  const attempt = Number.isFinite(attempts) ? Math.max(0, Math.min(attempts, 12)) : 12;
  const jitter = 0.75 + Math.max(0, Math.min(Number.isFinite(random) ? random : 0.5, 1)) * 0.5;
  const backoff = Math.min(3_600_000, 1_000 * 2 ** attempt * jitter);
  const hint = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  return Math.max(hint, backoff);
}

export function deliveryNextAttemptAt(attempts: number, retryAfterMs?: number, now = Date.now()) {
  return new Date(Math.min(8.64e15, now + deliveryRetryDelayMs(attempts, retryAfterMs)));
}
