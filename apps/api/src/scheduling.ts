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
