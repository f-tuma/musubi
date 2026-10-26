import type { ExternalDeliveryRecoveryMode } from "@musubi/config";

export const DELIVERY_RECOVERY_INTERVAL_MS = 15_000;

export type ExternalBackgroundOptions = {
  pullIntervalMin: number;
  deliveryRecoveryMode: ExternalDeliveryRecoveryMode;
};

export function externalBackgroundPolicy(options: ExternalBackgroundOptions) {
  const pullEnabled = options.pullIntervalMin > 0;
  const deliveryRecoveryEnabled = options.deliveryRecoveryMode === "independent" ||
    (options.deliveryRecoveryMode === "legacy" && pullEnabled);
  return { pullEnabled, deliveryRecoveryEnabled };
}

/** Register independent schedules only after migration and singleton admission. */
export function startExternalBackground(
  options: ExternalBackgroundOptions,
  hooks: {
    // Runners own their fault boundary and non-overlap guard.
    runPull(): Promise<unknown>;
    runDeliveryRecovery(): Promise<unknown>;
    every(callback: () => void, intervalMs: number): void;
  },
) {
  const { pullEnabled, deliveryRecoveryEnabled } = externalBackgroundPolicy(options);

  if (deliveryRecoveryEnabled) {
    // A fresh process must recover retained work without waiting for its first
    // pull or for another client mutation to wake the executor.
    void hooks.runDeliveryRecovery();
    hooks.every(
      () => void hooks.runDeliveryRecovery(),
      DELIVERY_RECOVERY_INTERVAL_MS,
    );
  }
  if (pullEnabled) {
    hooks.every(() => void hooks.runPull(), options.pullIntervalMin * 60_000);
  }

  return { pullEnabled, deliveryRecoveryEnabled };
}

export type DeliveryRecoveryFamily = "events" | "tasks" | "outlook_moves";

/** A broken queue read in one family must not prevent the others recovering. */
export async function runDeliveryRecovery(
  drains: readonly {
    family: DeliveryRecoveryFamily;
    run(): Promise<unknown>;
  }[],
  onFailure: (family: DeliveryRecoveryFamily) => void,
) {
  for (const drain of drains) {
    try {
      await drain.run();
    } catch {
      onFailure(drain.family);
    }
  }
}
