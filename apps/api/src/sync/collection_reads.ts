import { syncDeferral } from "./sync_outcome";

/** One physical account has a bounded queue and a single executing lane.
 * Await collections in order, but still visit every durable request after a
 * refusal. A pending child is never an ACK, nor can it hide a genuine failure. */
export async function awaitCollectionReads<T>(
  requests: readonly T[],
  read: (request: T) => Promise<{ changedCalendarIDs: readonly string[] }>,
): Promise<string[]> {
  const changed = new Set<string>();
  let failed = false,
    failure: unknown,
    deferred: { error: unknown; retryAtMs: number } | undefined;
  for (const request of requests) {
    try {
      for (const id of (await read(request)).changedCalendarIDs)
        changed.add(id);
    } catch (error) {
      const pending = syncDeferral(error);
      if (pending) {
        if (!deferred || pending.retryAtMs < deferred.retryAtMs)
          deferred = { error, retryAtMs: pending.retryAtMs };
      } else if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  if (deferred) throw deferred.error;
  return [...changed];
}
