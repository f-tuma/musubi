import { db } from "..";
import type { DbTransaction } from "./calendars";
import { lockUserLifecycle } from "./calendar-lifecycle";
import { ackSyncReadWorkInTransaction, assertSyncReadWorkCurrentInTransaction, type SyncReadWorkCapture } from "./sync-read-work";

/** Ephemeral cancellation accompanies the immutable durable capture. The signal
 * is never serialized, stored, or accepted as source/claim authority. */
export type SyncReadWorkExecution = Readonly<{
  capture: SyncReadWorkCapture;
  signal: AbortSignal;
  /** Host-only watchdog progress; never serialized or source authority. */
  progress?: () => void;
}>;

function reportProgress(execution: SyncReadWorkExecution | undefined) {
  // Progress is a watchdog notification, never authority or a COMMIT outcome.
  try { execution?.progress?.(); } catch { /* A notifier cannot relabel committed effects. */ }
}

/** Discovery has no cursor. Collection ACK belongs in its cursor/apply unit. */
export function ackSyncDiscoveryWork(execution: SyncReadWorkExecution) {
  const capture = structuredClone(execution.capture), signal = execution.signal;
  if (capture.binding.stream !== "discovery") throw new TypeError("Collection reads require atomic checkpoint ACK.");
  return db.transaction(async tx => {
    signal.throwIfAborted();
    await lockUserLifecycle(tx, [capture.binding.userID], "shared");
    await ackSyncReadWorkInTransaction(tx, capture, { lockLifecycle: false });
    signal.throwIfAborted();
  }).then(result => { reportProgress(execution); return result; });
}

/** Reuse an existing DB-only import/reconciliation callback. Its own calendar,
 * family and canonical locks precede the final claim/source/DB-clock guard.
 * A refusal rolls back this transaction, including writes before a lock wait. */
export function withSyncReadTransaction<T>(
  execution: SyncReadWorkExecution | undefined,
  run: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const capture = execution && structuredClone(execution.capture);
  const signal = execution?.signal;
  return db.transaction(async tx => {
    signal?.throwIfAborted();
    if (capture) await lockUserLifecycle(tx, [capture.binding.userID],
      capture.binding.stream === "discovery" ? "exclusive" : "shared");
    const result = await run(tx);
    signal?.throwIfAborted();
    if (capture) await assertSyncReadWorkCurrentInTransaction(tx, capture, { lockLifecycle: false });
    signal?.throwIfAborted();
    return result;
  }).then(result => { reportProgress(execution); return result; });
}
