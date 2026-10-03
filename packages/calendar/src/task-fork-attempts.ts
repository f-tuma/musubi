import type { Task } from "@musubi/types";
import { EventMutationError, requireTaskRevision, TASK_FORK_NOT_COMMITTED_CODE } from "@musubi/types";

export type TaskForkAttempt = Readonly<{
  operationId: string;
  sourceTaskID: string;
  request: Readonly<{
    calendarID: string;
    expectedRevision: number;
    expectedProviderReadRetiredGeneration: number;
  }>;
}>;

/** Pending intent identity and its original source fences survive refresh. No
 * title, body, or private membership snapshot is retained. */
export class TaskForkAttempts {
  private attempts = new Map<string, TaskForkAttempt>();
  constructor(private readonly newId: () => string) {}
  get(scope: string, task: Task, calendarID: string): TaskForkAttempt {
    const key = JSON.stringify([scope, task.id, calendarID]);
    let attempt = this.attempts.get(key);
    if (!attempt) {
      attempt = Object.freeze({ operationId: this.newId(), sourceTaskID: task.id,
        request: Object.freeze({ calendarID, expectedRevision: requireTaskRevision(task),
          expectedProviderReadRetiredGeneration: task.providerReadRetiredGeneration ?? 0 }) });
      this.attempts.set(key, attempt);
    }
    return attempt;
  }
  acknowledgeRejection(operationId: string, error: unknown) {
    // Only the server's serialized terminal proof releases an unknown intent.
    // A generic conflict, malformed result or transport error retains its key.
    if (error instanceof EventMutationError && !error.localCommitted && error.code === TASK_FORK_NOT_COMMITTED_CODE)
      this.acknowledge(operationId);
  }
  acknowledge(operationId: string) {
    for (const [key, attempt] of this.attempts) if (attempt.operationId === operationId) this.attempts.delete(key);
  }
}
