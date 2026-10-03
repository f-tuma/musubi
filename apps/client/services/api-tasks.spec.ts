import { TaskSchema, TASK_FORK_NOT_COMMITTED_CODE } from "@musubi/types";
import { beforeEach, expect, it, vi } from "vitest";
import { useApi } from "./api";
const h = vi.hoisted(() => ({ fetch: vi.fn(), actor: "owner", url: "https://home.test" }));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ apiUrl: h.url, authClient: { $fetch: h.fetch, getSession: async () => ({ data: { user: { id: h.actor } } }) } }) }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("@/services/federation", () => ({ setHomeRequester: vi.fn(), remoteForCalendar: () => null }));
vi.mock("@/services/notifications", () => ({ setReminderWriter: vi.fn() }));
vi.mock("@/lib/signOut", () => ({ notifySessionExpired: vi.fn() }));
vi.mock("@/lib/network", () => ({ fetchWithTimeout: vi.fn() }));
const task = TaskSchema.parse({ id: "11111111-1111-4111-8111-111111111111", calendarID: "22222222-2222-4222-8222-222222222222", creatorID: "owner", revision: 4, title: "Share safely", providerReadRetiredGeneration: 2 });
beforeEach(() => { vi.resetAllMocks(); h.actor = "owner"; h.url = "https://home.test"; });
it("retains a failed fork attempt across API and modal recreation, then releases it on acknowledgement", async () => {
  h.fetch.mockResolvedValueOnce({ error: { status: 503, message: "Lost response" } }).mockResolvedValue({ data: { task, localCommitted: true } });
  await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  const refreshedSource = { ...task, revision: 5, providerReadRetiredGeneration: 3, title: "Changed after commit" };
  expect(await useApi().forkTask(refreshedSource, "destination")).toEqual(task);
  expect(h.fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(h.fetch.mock.calls[0][1].headers["Idempotency-Key"]);
  expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({ calendarID: "destination", expectedRevision: 4, expectedProviderReadRetiredGeneration: 2 });
  await useApi().forkTask(refreshedSource, "destination");
  expect(h.fetch.mock.calls[2][1].headers["Idempotency-Key"]).not.toBe(h.fetch.mock.calls[1][1].headers["Idempotency-Key"]);
  expect(JSON.parse(h.fetch.mock.calls[2][1].body)).toEqual({ calendarID: "destination", expectedRevision: 5, expectedProviderReadRetiredGeneration: 3 });
});
it("does not reuse an unacknowledged attempt for a different server or actor", async () => {
  h.fetch.mockResolvedValue({ error: { status: 503, message: "Lost response" } });
  await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  h.actor = "other"; await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  h.url = "https://other.test"; await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  expect(new Set(h.fetch.mock.calls.map(([, init]) => init.headers["Idempotency-Key"])).size).toBe(3);
  h.actor = "owner"; h.url = "https://home.test";
  await expect(useApi().forkTask({ ...task, revision: 5 }, "destination")).rejects.toThrow();
  expect(h.fetch.mock.calls[3][1].headers["Idempotency-Key"]).toBe(h.fetch.mock.calls[0][1].headers["Idempotency-Key"]);
  expect(JSON.parse(h.fetch.mock.calls[3][1].body).expectedRevision).toBe(4);
});
it("treats committed access-loss as success without restoring the copied private task", async () => {
  h.fetch.mockResolvedValue({ data: { task: null, localCommitted: true } });
  expect(await useApi().forkTask(task, "destination")).toBeNull();
});

it("uses only revisioned mutation paths, independent of the released product version", async () => {
  h.fetch.mockResolvedValue({ data: { task, localCommitted: true } });
  const api = useApi();
  await api.createTask(task); await api.updateTask(task, task);
  await api.linkTask(task, task.calendarID); await api.forkTask(task, task.calendarID);
  await api.setTaskPriority(task, 3); await api.setTaskStatus(task, "completed");
  h.fetch.mockResolvedValue({ data: { id: task.id, revision: 5, removed: true, task: null, localCommitted: true } });
  await api.removeTask(task);
  expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://home.test/api/v1/task-mutations", `https://home.test/api/v1/task-mutations/${task.id}`,
    `https://home.test/api/v1/task-mutations/${task.id}/link`, `https://home.test/api/v1/task-mutations/${task.id}/fork`,
    ...Array(3).fill(`https://home.test/api/v1/task-mutations/${task.id}`),
  ]);
});
it("keeps a new create draft uncommitted when an old API lacks its mutation URL", async () => {
  h.fetch.mockResolvedValue({ error: { status: 404, message: "Task mutations are unavailable on this server." } });
  await expect(useApi().createTask(task)).rejects.toThrow("Task mutations are unavailable");
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.fetch.mock.calls[0][0]).toBe("https://home.test/api/v1/task-mutations");
});

it("releases only a server-proven terminal noncommit so a refreshed intentional copy can proceed", async () => {
  h.fetch.mockResolvedValueOnce({ error: { status: 409, error: "Source changed; no copy saved", message: "Source changed", code: TASK_FORK_NOT_COMMITTED_CODE, localCommitted: false } })
    .mockResolvedValue({ data: { task, localCommitted: true } });
  await expect(useApi().forkTask(task, "rejected-destination")).rejects.toThrow();
  const refreshedSource = { ...task, revision: 5, providerReadRetiredGeneration: 3 };
  expect(await useApi().forkTask(refreshedSource, "rejected-destination")).toEqual(task);
  expect(h.fetch.mock.calls[1][1].headers["Idempotency-Key"]).not.toBe(h.fetch.mock.calls[0][1].headers["Idempotency-Key"]);
  expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({ calendarID: "rejected-destination", expectedRevision: 5, expectedProviderReadRetiredGeneration: 3 });
});
it("retains frozen intent after a generic conflict without terminal noncommit proof", async () => {
  h.fetch.mockResolvedValueOnce({ error: { status: 409, error: "Unknown conflict", message: "Conflict", code: "task-source-changed", localCommitted: false } })
    .mockResolvedValue({ data: { task, localCommitted: true } });
  await expect(useApi().forkTask(task, "uncertain-destination")).rejects.toThrow();
  await useApi().forkTask({ ...task, revision: 5 }, "uncertain-destination");
  expect(h.fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(h.fetch.mock.calls[0][1].headers["Idempotency-Key"]);
  expect(JSON.parse(h.fetch.mock.calls[1][1].body).expectedRevision).toBe(4);
});
