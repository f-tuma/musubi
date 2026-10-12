import assert from "node:assert/strict";
import { nonOverlapping } from "../scheduling";
import {
  DELIVERY_RECOVERY_INTERVAL_MS,
  runDeliveryRecovery,
  startExternalBackground,
  type ExternalBackgroundOptions,
} from "./background";

async function main() {
  for (const mode of ["independent", "legacy", "disabled"] as const) {
    for (const pullIntervalMin of [0, 5]) {
      let pulls = 0;
      let recoveries = 0;
      const intervals: { tick(): void; intervalMs: number }[] = [];
      const state = startExternalBackground({ pullIntervalMin, deliveryRecoveryMode: mode }, {
        runPull: async () => { pulls++; },
        runDeliveryRecovery: async () => { recoveries++; },
        every: (tick, intervalMs) => { intervals.push({ tick, intervalMs }); },
      });
      const recoveryEnabled = mode === "independent" || (mode === "legacy" && pullIntervalMin > 0);
      assert.deepEqual(state, { pullEnabled: pullIntervalMin > 0, deliveryRecoveryEnabled: recoveryEnabled });
      assert.equal(recoveries, recoveryEnabled ? 1 : 0, "recovery starts at boot when enabled");
      assert.equal(pulls, 0, "provider polling retains its delayed first tick");
      assert.deepEqual(intervals.map(({ intervalMs }) => intervalMs), [
        ...(recoveryEnabled ? [DELIVERY_RECOVERY_INTERVAL_MS] : []),
        ...(pullIntervalMin > 0 ? [300_000] : []),
      ]);
      for (const interval of intervals) interval.tick();
      assert.equal(recoveries, recoveryEnabled ? 2 : 0);
      assert.equal(pulls, pullIntervalMin > 0 ? 1 : 0);
    }
  }

  // Retained work is external to the process-local scheduler. Simulate a stop
  // after admission and a fresh process against that same retained queue.
  const retained: string[] = [];
  const delivered: string[] = [];
  let pulls = 0;
  function boot(options: ExternalBackgroundOptions) {
    const intervals: (() => void)[] = [];
    const recovery = async () => { delivered.push(...retained.splice(0)); };
    startExternalBackground(options, {
      runPull: async () => { pulls++; },
      runDeliveryRecovery: recovery,
      every: (tick) => { intervals.push(tick); },
    });
    return { intervals, recovery };
  }
  boot({ pullIntervalMin: 0, deliveryRecoveryMode: "independent" });
  retained.push("accepted-before-stop");
  const restarted = boot({ pullIntervalMin: 0, deliveryRecoveryMode: "independent" });
  assert.deepEqual(delivered, ["accepted-before-stop"], "restart recovers without a provider pull or client wakeup");
  assert.equal(pulls, 0);
  retained.push("accepted-after-restart");
  restarted.intervals[0]!();
  assert.deepEqual(delivered, ["accepted-before-stop", "accepted-after-restart"]);

  retained.push("retained-legacy");
  boot({ pullIntervalMin: 0, deliveryRecoveryMode: "legacy" });
  assert.deepEqual(retained, ["retained-legacy"], "legacy poll=0 retains the historical recovery pause");
  const disabled = boot({ pullIntervalMin: 5, deliveryRecoveryMode: "disabled" });
  assert.deepEqual(retained, ["retained-legacy"]);
  await disabled.recovery();
  assert.deepEqual(retained, [], "disabling the schedule does not disable a request wakeup");

  const attempted: string[] = [];
  const failures: string[] = [];
  await runDeliveryRecovery([
    { family: "events", run: async () => { attempted.push("events"); throw new Error("database unavailable"); } },
    { family: "tasks", run: async () => { attempted.push("tasks"); } },
    { family: "outlook_moves", run: async () => { attempted.push("outlook_moves"); throw new Error("unavailable"); } },
  ], (family) => { failures.push(family); });
  assert.deepEqual(attempted, ["events", "tasks", "outlook_moves"]);
  assert.deepEqual(failures, ["events", "outlook_moves"]);

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  let skipped = 0;
  const pending: Promise<unknown>[] = [];
  const ticks: (() => void)[] = [];
  const recovery = nonOverlapping(async () => {
    runs++;
    if (runs === 1) await blocked;
  }, () => { skipped++; });
  startExternalBackground({ pullIntervalMin: 0, deliveryRecoveryMode: "independent" }, {
    runPull: async () => assert.fail("polling is off"),
    runDeliveryRecovery: () => {
      const run = recovery();
      pending.push(run);
      return run;
    },
    every: (tick) => { ticks.push(tick); },
  });
  ticks[0]!();
  assert.equal(runs, 1);
  assert.equal(skipped, 1, "the scheduled boot drain cannot overlap a timer tick");
  release();
  await Promise.all(pending);
  ticks[0]!();
  await Promise.all(pending);
  assert.equal(runs, 2);

  console.log("external background: independent/legacy/disabled schedules, retained restart work, family isolation and non-overlap passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
