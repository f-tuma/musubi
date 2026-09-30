import { TaskSchema } from "@musubi/types";
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
  await useApi().forkTask(task, "destination");
  expect(h.fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe(h.fetch.mock.calls[0][1].headers["Idempotency-Key"]);
  expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({ calendarID: "destination", expectedRevision: 4, expectedProviderReadRetiredGeneration: 2 });
  await useApi().forkTask(task, "destination");
  expect(h.fetch.mock.calls[2][1].headers["Idempotency-Key"]).not.toBe(h.fetch.mock.calls[1][1].headers["Idempotency-Key"]);
});
it("does not reuse an unacknowledged attempt for a different server or actor", async () => {
  h.fetch.mockResolvedValue({ error: { status: 503, message: "Lost response" } });
  await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  h.actor = "other"; await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  h.url = "https://other.test"; await expect(useApi().forkTask(task, "destination")).rejects.toThrow();
  expect(new Set(h.fetch.mock.calls.map(([, init]) => init.headers["Idempotency-Key"])).size).toBe(3);
});
it("treats committed access-loss as success without restoring the copied private task", async () => {
  h.fetch.mockResolvedValue({ data: { task: null, localCommitted: true } });
  expect(await useApi().forkTask(task, "destination")).toBeNull();
});
