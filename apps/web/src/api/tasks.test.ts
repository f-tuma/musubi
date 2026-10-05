import { TaskForkAttempts } from "@musubi/calendar";
import { TaskSchema, TASK_FORK_NOT_COMMITTED_CODE } from "@musubi/types";
import { afterEach, expect, it, vi } from "vitest";
import { createTask, updateTask, linkTask, forkTask, removeTask } from "./resources";
import { taskForkAttempts } from "./task-fork-attempts";

afterEach(() => vi.unstubAllGlobals());
const task = TaskSchema.parse({ id: "11111111-1111-4111-8111-111111111111", calendarID: "22222222-2222-4222-8222-222222222222", creatorID: "owner", revision: 7, title: "Shared task", providerReadRetiredGeneration: 3 });
const copyAttempt = { operationId: "copy-attempt", sourceTaskID: task.id, request: {
  calendarID: task.calendarID, expectedRevision: 7, expectedProviderReadRetiredGeneration: 3,
} };
function json(data: unknown) { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }
it("encodes explicit revisioned task PATCH content without membership metadata", async () => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => json({ task: { ...task, revision: 8 }, localCommitted: true }));
  vi.stubGlobal("fetch", fetch);
  const saved = await updateTask(task.id, { calendarID: task.calendarID, title: "New title", isAllDay: false, status: "in-process", percentComplete: 30, priority: 1, expectedRevision: 7, expectedProviderReadRetiredGeneration: 3 });
  const init = fetch.mock.calls[0]![1] as RequestInit;
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(init.body as string)).toEqual({ expectedRevision: 7, expectedProviderReadRetiredGeneration: 3, patch: { title: "New title", isAllDay: false, status: "in-process", percentComplete: 30, priority: 1 } });
  expect(saved?.revision).toBe(8);
});
it("fails closed before a request when a cached task lacks its canonical revision", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(updateTask(task.id, { calendarID: task.calendarID, title: task.title, isAllDay: false, status: "needs-action", percentComplete: 0, priority: 0 })).rejects.toThrow(/revision/);
  expect(() => removeTask({ ...task, revision: undefined })).toThrow(/revision/);
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps link, fork and unlink independent of task content and carries the privacy fence", async () => {
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); return json(init.method === "DELETE" ? { id: task.id, revision: 8, removed: false, task, localCommitted: true } : { task, localCommitted: true }); }));
  await linkTask(task, task.calendarID); await forkTask(copyAttempt); await removeTask(task, task.calendarID);
  expect(new Headers(requests[1]!.headers).get("Idempotency-Key")).toBe("copy-attempt");
  expect(requests.map(init => JSON.parse(init.body as string))).toEqual([
    { calendarID: task.calendarID, expectedRevision: 7, expectedProviderReadRetiredGeneration: 3 },
    { calendarID: task.calendarID, expectedRevision: 7, expectedProviderReadRetiredGeneration: 3 },
    { unlinkCalendarID: task.calendarID, expectedRevision: 7, expectedProviderReadRetiredGeneration: 3 },
  ]);
});
it("unwraps a locally committed create without inventing successful provider delivery", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ task, localCommitted: true, delivery: { taskId: task.id, localRevision: 7, targets: [] } })));
  expect(await createTask({ ...task })).toEqual(task);
});

it("uses only the additive mutation namespace while retaining task reads", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => json(init.method === "DELETE" ? { id: task.id, revision: 8, removed: true, task: null, localCommitted: true } : { task, localCommitted: true }));
  vi.stubGlobal("fetch", fetch);
  await createTask(task);
  await updateTask(task.id, { ...task, expectedRevision: 7 });
  await linkTask(task, task.calendarID);
  await forkTask(copyAttempt);
  await removeTask(task);
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    "/api/v1/task-mutations", `/api/v1/task-mutations/${task.id}`,
    `/api/v1/task-mutations/${task.id}/link`, `/api/v1/task-mutations/${task.id}/fork`,
    `/api/v1/task-mutations/${task.id}`,
  ]);
});
it("never falls back to legacy create when an older API lacks task mutations", async () => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ error: "NotFound", message: "Task mutations are unavailable on this server." }), { status: 404, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(createTask(task)).rejects.toThrow("Task mutations are unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/task-mutations");
});

it("reconciles a lost fork response with frozen source fences after refresh, then permits an intentional new copy", async () => {
  let sequence = 0;
  const attempts = new TaskForkAttempts(() => `copy-${++sequence}`);
  const initial = attempts.get("home/owner", task, task.calendarID);
  const savedCopy = { ...task, id: "33333333-3333-4333-8333-333333333333", revision: 1 };
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Lost response"))
    .mockImplementation(async () => json({ task: savedCopy, localCommitted: true }));
  vi.stubGlobal("fetch", fetch);
  await expect(forkTask(initial)).rejects.toThrow("Lost response");
  const refreshedSource = { ...task, revision: 8, providerReadRetiredGeneration: 4, title: "Source changed" };
  const retry = attempts.get("home/owner", refreshedSource, task.calendarID);
  expect(await forkTask(retry)).toEqual(savedCopy);
  const requests = fetch.mock.calls.map(([, init]) => init as RequestInit);
  expect(new Headers(requests[1]!.headers).get("Idempotency-Key")).toBe(initial.operationId);
  expect(JSON.parse(requests[1]!.body as string)).toEqual(initial.request);
  attempts.acknowledge(retry.operationId);
  const next = attempts.get("home/owner", refreshedSource, task.calendarID);
  await forkTask(next);
  expect(next.operationId).not.toBe(initial.operationId);
  expect(next.request).toEqual({ calendarID: task.calendarID, expectedRevision: 8, expectedProviderReadRetiredGeneration: 4 });
});

it("permits a fresh intentional fork after a terminal server noncommit proof", async () => {
  let sequence = 0;
  const attempts = new TaskForkAttempts(() => `rejected-copy-${++sequence}`);
  const initial = attempts.get("home/owner", task, task.calendarID);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Source changed; no copy saved", code: TASK_FORK_NOT_COMMITTED_CODE, localCommitted: false }), { status: 409, headers: { "content-type": "application/json" } }))
    .mockImplementation(async () => json({ task, localCommitted: true }));
  vi.stubGlobal("fetch", fetch);
  await expect(forkTask(initial).catch(error => { attempts.acknowledgeRejection(initial.operationId, error); throw error; })).rejects.toThrow("Source changed");
  const next = attempts.get("home/owner", { ...task, revision: 8 }, task.calendarID);
  expect(await forkTask(next)).toEqual(task);
  expect(next.operationId).not.toBe(initial.operationId); expect(next.request.expectedRevision).toBe(8);
});

it("keeps the app-owned fork intent across navigation and server/actor round trips", async () => {
  const initial = taskForkAttempts.get("navigation/home/owner", task, task.calendarID);
  const otherActor = taskForkAttempts.get("navigation/home/other", task, task.calendarID);
  const otherServer = taskForkAttempts.get("navigation/other/owner", task, task.calendarID);
  expect(otherActor.operationId).not.toBe(initial.operationId);
  expect(otherServer.operationId).not.toBe(initial.operationId);
  const afterNavigation = taskForkAttempts.get("navigation/home/owner", { ...task, revision: 8 }, task.calendarID);
  expect(afterNavigation).toBe(initial);
  vi.stubGlobal("fetch", vi.fn(async () => json({ task, localCommitted: true })));
  expect(await forkTask(afterNavigation)).toEqual(task);
  taskForkAttempts.acknowledge(afterNavigation.operationId);
  expect(taskForkAttempts.get("navigation/home/owner", task, task.calendarID).operationId).not.toBe(initial.operationId);
});
