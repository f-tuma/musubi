import type { Task } from "@musubi/types";
import { requireTaskRevision } from "@musubi/types";

/** Only operation identifiers live here; no private task snapshots are retained. */
export class TaskForkAttempts {
  private scope?: string;
  private attempts = new Map<string, string>();
  constructor(private readonly newId: () => string) {}
  get(scope: string, task: Task, calendarID: string) {
    if (scope !== this.scope) { this.attempts.clear(); this.scope = scope; }
    const key = JSON.stringify([task.id, requireTaskRevision(task), task.providerReadRetiredGeneration ?? 0, calendarID]);
    let operationId = this.attempts.get(key);
    if (!operationId) { operationId = this.newId(); this.attempts.set(key, operationId); }
    return operationId;
  }
  acknowledge(operationId: string) {
    for (const [key, id] of this.attempts) if (id === operationId) this.attempts.delete(key);
  }
}
