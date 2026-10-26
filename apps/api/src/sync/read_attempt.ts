/** Pulls can page complete inventories without a total page/time cap. Bound
 * lack of progress, not the sum of legitimate pages and explicit quota waits. */
export type ReadAttemptClock = {
  nowMs(): number;
  schedule(run: () => void, delayMs: number): () => void;
};
export type ReadAttemptOptions = {
  idleTimeoutMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
  clock?: ReadAttemptClock;
};
export class ReadAttemptInterrupted extends Error {
  constructor(readonly reason: "idle" | "lease-lost" | "cancelled" | "finished") {
    super(`Sync read attempt ${reason}.`); this.name = "ReadAttemptInterrupted";
  }
}

export function createReadAttempt(renew: () => Promise<boolean>, options: ReadAttemptOptions = {}) {
  const idleTimeoutMs = options.idleTimeoutMs ?? 90_000;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  for (const value of [idleTimeoutMs, heartbeatMs])
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new RangeError("Invalid read attempt timers.");
  const clock = options.clock ?? {
    nowMs: () => performance.now(),
    schedule(run: () => void, delayMs: number) {
      const timer = setTimeout(run, delayMs); timer.unref(); return () => clearTimeout(timer);
    },
  };
  const controller = new AbortController();
  let active = true, renewing = false, pauses = 0;
  let cancelIdle: (() => void) | undefined, cancelHeartbeat: (() => void) | undefined;
  const interrupt = (reason: ReadAttemptInterrupted["reason"]) => {
    if (!controller.signal.aborted) controller.abort(new ReadAttemptInterrupted(reason));
  };
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  void interrupted.catch(() => {});
  function guard() {
    if (!active) throw new ReadAttemptInterrupted("finished");
    controller.signal.throwIfAborted();
  }
  function progress() {
    if (!active || controller.signal.aborted) return;
    cancelIdle?.(); cancelIdle = undefined;
    if (!pauses) cancelIdle = clock.schedule(() => interrupt("idle"), idleTimeoutMs);
  }
  function heartbeat() {
    if (!active || controller.signal.aborted) return;
    if (!renewing) {
      renewing = true;
      void Promise.resolve().then(() => { guard(); return renew(); })
        .then(ok => { if (!ok) interrupt("lease-lost"); }, () => interrupt("lease-lost"))
        .finally(() => { renewing = false; });
    }
    cancelHeartbeat = clock.schedule(heartbeat, heartbeatMs);
  }
  const externalAbort = () => interrupt("cancelled");
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  progress(); cancelHeartbeat = clock.schedule(heartbeat, heartbeatMs);
  return {
    signal: controller.signal,
    guard,
    progress,
    /** Only explicit quota/permit waiting pauses the idle timer. Renewal and
     * external cancellation stay active; callers resume before more DB/HTTP. */
    pause() {
      guard(); pauses++; cancelIdle?.(); cancelIdle = undefined;
      let resumed = false;
      return () => { if (resumed) return; resumed = true; pauses--; progress(); };
    },
    run<T>(work: () => Promise<T>): Promise<T> {
      return Promise.race([Promise.resolve().then(() => { guard(); return work(); }), interrupted]);
    },
    dispose() {
      active = false; cancelIdle?.(); cancelHeartbeat?.();
      options.signal?.removeEventListener("abort", externalAbort); interrupt("finished");
    },
  };
}
