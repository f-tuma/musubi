import { beforeEach, expect, it, vi } from "vitest";
import { TaskSchema } from "@musubi/types";
import { cacheDeleteTasks, cacheGetTasks, cacheSetTasks } from "./tasksCache";
const h = vi.hoisted(() => ({ rows: new Map<string, string>() }));
vi.mock("./db", () => ({ sqlite: {
  getFirstSync: (_sql: string, key: string) => h.rows.has(key) ? { value: h.rows.get(key) } : null,
  withTransactionSync: (transaction: () => void) => transaction(),
  runSync: (sql: string, key: string, value?: string) => {
    if (sql.startsWith("DELETE")) h.rows.delete(key);
    else h.rows.set(key, value!);
  },
} }));
const task = TaskSchema.parse({ id: "canonical", creatorID: "owner", calendarID: "home", title: "Offline task", revision: 4, providerReadRetiredGeneration: 2, start: "2026-10-06T09:00:00Z", due: "2026-10-06T12:00:00Z", capabilities: { edit: false, delete: false, link: false, fork: true, unlinkCalendarIDs: ["mirror"] }, originCalendarID: null, calendarIDs: ["mirror"] });
beforeEach(() => h.rows.clear());
it("round-trips dates, canonical membership, capabilities and authority without crossing scopes", () => {
  cacheSetTasks("server-a:actor-a", [task], 100);
  expect(cacheGetTasks("server-a:actor-a")).toEqual({ tasks: [task], lastSyncedAt: 100 });
  expect(cacheGetTasks("server-a:actor-b")).toBeNull();
  expect(cacheGetTasks("server-b:actor-a")).toBeNull();
});
it("preserves an authoritative empty snapshot and deletes only its scope", () => {
  cacheSetTasks("a", [], 100); cacheSetTasks("b", [task], 200);
  expect(cacheGetTasks("a")).toEqual({ tasks: [], lastSyncedAt: 100 });
  cacheDeleteTasks("a");
  expect(cacheGetTasks("a")).toBeNull(); expect(cacheGetTasks("b")?.tasks).toEqual([task]);
});
it("refuses unsupported or malformed saved collections instead of calling them empty", () => {
  h.rows.set("task-collection:a", JSON.stringify({ version: 2, tasks: [], lastSyncedAt: 100 }));
  expect(() => cacheGetTasks("a")).toThrow();
  h.rows.set("task-collection:a", JSON.stringify({ version: 1, tasks: [{ ...task, due: "invalid" }], lastSyncedAt: 100 }));
  expect(() => cacheGetTasks("a")).toThrow();
});
