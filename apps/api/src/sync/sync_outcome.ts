import { providerDeferral, type BudgetDeferral } from "@musubi/sync-runtime";
import { isTransientSyncError, providerAuthErrorFields } from "./errors";

export class SyncWorkDeferred extends Error {
  constructor(readonly retryAtMs: number) {
    super("Synchronization is pending a later opportunity."); this.name = "SyncWorkDeferred";
  }
}
export type SyncDeferralReason = BudgetDeferral["reason"] | "queued-read";
export type SyncRunOutcome = "success" | "failed" | "deferred";
type SyncStage = "account" | "discovery";
type SyncFailure = { stage: SyncStage; provider: string; accountId?: string; error: unknown };

/** Only explicit scheduler control flow is deferred. Names, messages and
 * transient provider/network failures do not confer this classification. */
export function syncDeferral(error: unknown): { reason: SyncDeferralReason; retryAtMs: number } | undefined {
  if (error instanceof SyncWorkDeferred && Number.isSafeInteger(error.retryAtMs) && error.retryAtMs >= 0 && error.retryAtMs <= 253_402_300_799_999)
    return { reason: "queued-read", retryAtMs: error.retryAtMs };
  return providerDeferral(error);
}

export async function observeSyncRun<T>(provider: string, run: () => Promise<T>,
  record: (provider: string, outcome: SyncRunOutcome, seconds: number) => void,
  nowMs: () => number = () => performance.now()): Promise<T> {
  const started = nowMs();
  try {
    const result = await run();
    record(provider, "success", (nowMs() - started) / 1000);
    return result;
  } catch (error) {
    record(provider, syncDeferral(error) ? "deferred" : "failed", (nowMs() - started) / 1000);
    throw error;
  }
}

export type SyncFailureObserver = {
  failure(stage: SyncStage, provider: string): void;
  deferred(stage: SyncStage, provider: string, reason: SyncDeferralReason): void;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
};
/** Shared by scheduled and strict account synchronization. Deferral preserves
 * the caller's original rejection and records no successful work or failure. */
export function observeSyncFailure(failure: SyncFailure, userID: string, observer: SyncFailureObserver) {
  const { stage, provider, accountId, error } = failure;
  const deferred = syncDeferral(error);
  if (deferred) {
    observer.deferred(stage, provider, deferred.reason);
    observer.log("info", stage === "discovery" ? "sync.provider.deferred" : "sync.account.deferred",
      { provider, reason: deferred.reason, retryAtMs: deferred.retryAtMs });
    return;
  }
  observer.failure(stage, provider);
  // A real network/provider failure is still a failure when the poll can retry
  // it. Keep its existing warning severity rather than hiding it as deferred.
  observer.log(isTransientSyncError(error) ? "warn" : "error",
    stage === "discovery" ? "sync.provider.failed" : "sync.account.failed",
    { provider, userId: userID, ...(accountId ? { accountId } : {}), error, ...providerAuthErrorFields(error) });
}
