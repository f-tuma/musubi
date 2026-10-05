import type { Task } from "@musubi/types";
import type { TaskProjection } from "./adapter";
import { strongEventEtag } from "./event_write";

export type ProviderTaskWriteCode = "task-provider-conflict" | "task-version-unavailable" | "task-write-failed" | "task-conditional-write-unsupported" | "task-recurrence-projection-unsupported" | "task-source-read-only" | "task-create-unconfirmed" | "task-projection-unavailable";
export class ProviderTaskWriteError extends Error {
  constructor(readonly code: ProviderTaskWriteCode, readonly outcome: "not-written" | "unconfirmed" = "not-written", readonly providerStatus?: number) {
    super(`Task delivery: ${code}.`);
    this.name = "ProviderTaskWriteError";
  }
}
export function requireTaskEtag(value: unknown) {
  const tag = strongEventEtag(value);
  if (!tag) throw new ProviderTaskWriteError("task-version-unavailable");
  return tag;
}
export function assertTaskEtag(expected: unknown, current: unknown) {
  if (requireTaskEtag(expected) !== requireTaskEtag(current)) throw new ProviderTaskWriteError("task-provider-conflict");
}
export function assertTaskMutationResponse(response: Response) {
  if ([200, 201, 204].includes(response.status)) return;
  throw new ProviderTaskWriteError(response.status === 412 ? "task-provider-conflict" : "task-write-failed", response.ok || response.status >= 500 ? "unconfirmed" : "not-written", response.status);
}
export function jsonTaskProjection(value: TaskProjection): TaskProjection {
  return JSON.parse(JSON.stringify(value));
}
export function diffTaskProjection(before: TaskProjection, after: TaskProjection): TaskProjection {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
}
export function sameTaskProjection(before: TaskProjection, after: TaskProjection) {
  return Object.keys(diffTaskProjection(before, after)).length === 0 && Object.keys(diffTaskProjection(after, before)).length === 0;
}
export function canonicalTaskProjection(task: Pick<Task, "title" | "description" | "status" | "start" | "due" | "isAllDay" | "completedAt" | "percentComplete" | "priority" | "recurrence" | "relatedTo" | "sequence" | "url">): TaskProjection {
  return jsonTaskProjection({ title: task.title, description: task.description ?? null, status: task.status, start: task.start ?? null, due: task.due ?? null, isAllDay: task.isAllDay, completedAt: task.completedAt ?? null, percentComplete: task.percentComplete, priority: task.priority, recurrence: task.recurrence ?? null, relatedTo: task.relatedTo ?? null, sequence: task.sequence, url: task.url ?? null });
}
