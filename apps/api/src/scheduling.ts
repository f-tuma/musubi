import { withMonitor } from "@sentry/node";

export type ScheduledRunResult = "completed" | "skipped";

/**
 * Prevent one process-local scheduled task from overlapping itself.
 *
 * This is deliberately not distributed coordination. Musubi's API singleton
 * lock keeps one process active per database; this guard handles the separate
 * case where one run lasts longer than its own interval.
 */
export function nonOverlapping(
  task: () => Promise<void>,
  onSkipped: () => void,
) {
  let running = false;

  return async (): Promise<ScheduledRunResult> => {
    if (running) {
      onSkipped();
      return "skipped";
    }

    running = true;
    try {
      await task();
      return "completed";
    } finally {
      running = false;
    }
  };
}

/**
 * Report every run as a cron check-in, so a job that stops running, hangs or
 * fails opens an issue in Rustrak/Sentry. A no-op without SENTRY_DSN. The task
 * logs its own failure before rethrowing, so the rejection ends here.
 */
export function monitored(slug: string, everyMinutes: number, task: () => Promise<void>) {
  const minutes = Math.max(1, Math.ceil(everyMinutes));
  return () => withMonitor(slug, task, {
    schedule: { type: "interval", value: minutes, unit: "minute" },
    // One tick skipped by nonOverlapping is a slow run, not a missed one.
    checkinMargin: minutes,
    maxRuntime: 30,
  }).catch(() => {});
}
