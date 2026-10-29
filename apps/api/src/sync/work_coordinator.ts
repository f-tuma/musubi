import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createFairWorkCoordinator, type WorkExecutionResult, type WorkPermit } from "@musubi/sync-runtime";
import * as database from "@musubi/db";
import type { SyncWorkFamily, SyncWorkReference } from "@musubi/db";
import { logger } from "@musubi/config";
import { describeSyncWorkFailure } from "./work_failure";

type AuxiliaryReference = { readonly auxiliary: true; readonly execute: (signal: AbortSignal) => Promise<void> };
type RuntimeReference = SyncWorkReference | AuxiliaryReference;
let coordinator: ReturnType<typeof createFairWorkCoordinator<RuntimeReference>> | undefined;
const currentPermit = new AsyncLocalStorage<WorkPermit>();
const currentController = new AsyncLocalStorage<AbortSignal>();
const auxiliary = new Map<string, Promise<unknown>>();

/** Called only by the composition root after migration and singleton admission.
 * Direct mutation wakeups and every enabled background family share this pool. */
export function initializeSyncWorkCoordinator(options: {
  families: readonly SyncWorkFamily[];
  execute(reference: SyncWorkReference, signal: AbortSignal): Promise<WorkExecutionResult>;
}) {
  if (coordinator) throw new Error("Sync work coordinator is already initialized.");
  const families = [...options.families];
  coordinator = createFairWorkCoordinator<RuntimeReference>({
    capacity: 4,
    host: {
      candidates: input => database.getSyncWorkCandidates({ ...input, families }),
      execute: (candidate, permit, signal) => currentController.run(signal, () => currentPermit.run(permit, async () => {
        if ("auxiliary" in candidate.hostRef) { signal.throwIfAborted(); await candidate.hostRef.execute(signal); return { kind: "settled" as const, changedCalendarIDs: [] }; }
        return options.execute(candidate.hostRef, signal);
      })),
      onFailure: (error, context) => {
        const { level, fields } = describeSyncWorkFailure(error, context);
        if (level === "warn") logger.info("sync.work.deferred", fields);
        else logger.error("sync.work.failed", fields);
      },
    },
  });
}

export const syncWorkCoordinatorEnabled = () => coordinator !== undefined;
export const currentSyncWorkSignal = () => currentController.getStore();
export function kickSyncWork() { coordinator?.kick(); }
export function stopSyncWorkCoordinator() { coordinator?.close(); coordinator = undefined; auxiliary.clear(); }

/** Ephemeral pool capability only. The caller must separately retain/revalidate
 * its real DB claim, source and cancellation when parking and resuming. */
export function currentSyncWorkParking(): ((retryAtMs: number, signal?: AbortSignal) => Promise<void>) | undefined {
  const permit = currentPermit.getStore();
  if (!permit || !coordinator) return;
  const owner = coordinator;
  return (retryAtMs, signal) => owner.park(permit, retryAtMs, signal);
}

/** Preserve every caller's scope/metrics context while sequencing all HTTP
 * leaves that inherit one work permit, including across nested SDK scopes. */
export function withSyncWorkHttpLeaf<T>(run: (assertCurrent: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const permit = currentPermit.getStore(), owner = coordinator;
  return permit && owner ? owner.runHttpLeaf(permit, AsyncLocalStorage.bind(run), signal) : run(() => {});
}

/** Waiter cancellation never cancels shared work. Reacquire fairly before continuing. */
export function awaitWithReleasedSyncPermit<T>(dependency: Promise<T>, signal?: AbortSignal): Promise<T> {
  const permit = currentPermit.getStore(), owner = coordinator;
  return permit && owner ? owner.parkUntil(permit, dependency, signal) : dependency;
}

/** Ephemeral refresh uses the same global/account pool and its own native deadline. */
function runProviderWork<T>(key: string, provider: "google" | "microsoft" | "caldav", physicalAccountRowID: string | undefined,
  run: (signal?: AbortSignal) => Promise<T>, isAuxiliary: boolean, deadline?: AbortSignal): Promise<T> {
  const existing = auxiliary.get(key); if (existing) return existing as Promise<T>;
  const owner = coordinator;
  if (!owner) {
    const controller = currentController.getStore(), signal = deadline && controller ? AbortSignal.any([deadline, controller]) : deadline ?? controller;
    signal?.throwIfAborted(); return run(signal);
  }
  const schedulingKey = `ephemeral:${key}`;
  const promise = (async () => {
    deadline?.throwIfAborted();
    const accountFairnessKey = physicalAccountRowID ? await database.getSyncPhysicalAccountFairnessKey(provider, physicalAccountRowID) : `provider-capability:${provider}`;
    deadline?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => { owner.cancel(schedulingKey, deadline!.reason); reject(deadline!.reason); };
      deadline?.addEventListener("abort", aborted, { once: true });
      void owner.submit({ key: schedulingKey, family: "pull", auxiliary: isAuxiliary, accountFairnessKey,
        laneKey: `${isAuxiliary ? "oauth-refresh" : "request"}:${accountFairnessKey}`, dueAtMs: Date.now(), orderKey: key, collisionKeys: [],
        hostRef: { auxiliary: true, async execute(controllerSignal) { try {
          const signal = deadline ? AbortSignal.any([deadline, controllerSignal]) : controllerSignal;
          signal.throwIfAborted(); resolve(await run(signal));
        } catch (error) { reject(error); throw error; } } },
      }).catch(reject).finally(() => deadline?.removeEventListener("abort", aborted));
    });
  })().finally(() => { if (auxiliary.get(key) === promise) auxiliary.delete(key); });
  auxiliary.set(key, promise); return promise;
}
export function runAuxiliaryProviderWork<T>(key: string, provider: "google" | "microsoft", physicalAccountRowID: string,
  run: (signal?: AbortSignal) => Promise<T>, deadline?: AbortSignal): Promise<T> {
  return runProviderWork(key, provider, physicalAccountRowID, run, true, deadline);
}
/** Direct authorized preflights/read capabilities enter the same regular account pool. */
export function runScopedProviderWork<T>(provider: "google" | "microsoft" | "caldav", physicalAccountRowID: string,
  run: (signal?: AbortSignal) => Promise<T>, deadline?: AbortSignal): Promise<T> {
  return runProviderWork(`request:${randomUUID()}`, provider, physicalAccountRowID, run, false, deadline);
}
/** Explicit application/preconnection scheduling group; never a physical account assertion. */
export function runCapabilityProviderWork<T>(provider: "google" | "microsoft" | "caldav", run: (signal?: AbortSignal) => Promise<T>, deadline?: AbortSignal): Promise<T> {
  return runProviderWork(`capability:${randomUUID()}`, provider, undefined, run, false, deadline);
}

/** Descriptor metadata only selects work. The real executor still claims it.
 * A future durable due time is an immediate deferral, never a sleeping worker. */
export async function submitSyncWork(reference: SyncWorkReference): Promise<WorkExecutionResult> {
  if (!coordinator) throw new Error("Sync work coordinator is not initialized.");
  const candidate = await database.getSyncWorkCandidate(reference);
  if (!candidate) return { kind: "skipped", reason: "retired" };
  if (candidate.dueAtMs > Date.now()) return { kind: "deferred", retryAtMs: candidate.dueAtMs, changedCalendarIDs: [] };
  return coordinator.submit(candidate);
}
