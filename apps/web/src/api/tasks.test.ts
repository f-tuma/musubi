import { TaskSchema } from "@musubi/types";
import { afterEach, expect, it, vi } from "vitest";
import { createTask, updateTask, linkTask, forkTask, removeTask } from "./resources";

afterEach(() => vi.unstubAllGlobals());
const task = TaskSchema.parse({ id: "11111111-1111-4111-8111-111111111111", calendarID: "22222222-2222-4222-8222-222222222222", creatorID: "owner", revision: 7, title: "Shared task", providerReadRetiredGeneration: 3 });
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
  await linkTask(task, task.calendarID); await forkTask(task, task.calendarID, "copy-attempt"); await removeTask(task, task.calendarID);
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
