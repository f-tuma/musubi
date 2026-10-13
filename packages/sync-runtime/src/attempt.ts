import type { RuntimeAttemptOptions } from "./ports";
export const SYNC_RUNTIME_TIMEOUT_MS = 45_000;
export const SYNC_RUNTIME_HEARTBEAT_MS = 20_000;
export class SyncRuntimeInterrupted extends Error {
  constructor(readonly reason: "timeout" | "lease-lost" | "cancelled" | "finished") {
    super(`Sync runtime attempt ${reason}.`); this.name = "SyncRuntimeInterrupted";
  }
}
export function validateRuntimeAttemptOptions(options: RuntimeAttemptOptions = {}) {
  const timeoutMs = options.timeoutMs ?? SYNC_RUNTIME_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? SYNC_RUNTIME_HEARTBEAT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
      !Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > 2_147_483_647)
    throw new RangeError("Sync runtime timer bounds are invalid.");
  return { timeoutMs, heartbeatMs, signal: options.signal };
}
/** One lifecycle per already-claimed attempt. A detached, signal-ignoring
 * transport is raced out; guard rejects every later capability invocation. */
export function createRuntimeAttempt(renew: (signal: AbortSignal) => Promise<boolean>, options: RuntimeAttemptOptions = {}) {
  const bounds = validateRuntimeAttemptOptions(options);
  const controller = new AbortController();
  let active = true, renewing = false;
  const interrupt = (reason: SyncRuntimeInterrupted["reason"]) => {
    if (!controller.signal.aborted) controller.abort(new SyncRuntimeInterrupted(reason));
  };
  const externalAbort = () => interrupt("cancelled");
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  // The race may be created after a pre-aborted signal; attach a rejection
  // handler immediately so interruption never becomes an unhandled promise.
  void interrupted.catch(() => {});
  const timeout = setTimeout(() => interrupt("timeout"), bounds.timeoutMs);
  const heartbeat = setInterval(() => {
    if (!active || renewing || controller.signal.aborted) return;
    renewing = true;
    void Promise.resolve().then(() => { guard(); return renew(controller.signal); }).then(ok => {
      if (!ok) interrupt("lease-lost");
    }, () => interrupt("lease-lost")).finally(() => { renewing = false; });
  }, bounds.heartbeatMs);
  bounds.signal?.addEventListener("abort", externalAbort, { once: true });
  if (bounds.signal?.aborted) externalAbort();
  function guard() {
    if (!active) throw new SyncRuntimeInterrupted("finished");
    controller.signal.throwIfAborted();
  }
  return {
    signal: controller.signal,
    guard,
    async run<T>(work: () => Promise<T>): Promise<T> {
      return Promise.race([Promise.resolve().then(() => { guard(); return work(); }), interrupted]);
    },
    close() {
      active = false; clearTimeout(timeout); clearInterval(heartbeat);
      bounds.signal?.removeEventListener("abort", externalAbort); interrupt("finished");
    },
  };
}
