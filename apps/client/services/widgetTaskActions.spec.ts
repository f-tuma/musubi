import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CalendarSchema, TaskSchema, type Calendar, type Task } from "@musubi/types";
import { completeWidgetTask } from "./widgetTaskActions";
import { resetTaskCollection, startTaskCollectionSync } from "./taskCollection";
import { useTasksStore } from "@/store/useTasksStore";
import { resetWidgetData } from "@/store/useWidgetDataStore";
const h = vi.hoisted(() => ({ lifecycle: 0, calendars: [] as Calendar[], claim: vi.fn(),
  listeners: new Set<(state: { calendars: Calendar[] }, previous: { calendars: Calendar[] }) => void>(),
}));
vi.mock("./agendaWidget", () => ({ consumeWidgetTaskCompletion: h.claim }));
vi.mock("@/store/useEventsStore", () => ({ getEventLifecycle: () => h.lifecycle, useEventsStore: { subscribe: () => () => {} } }));
vi.mock("@/store/useCalendarsStore", () => ({ useCalendarsStore: {
  getState: () => ({ calendars: h.calendars, loadCalendars: (calendars: Calendar[]) => {
    const previous = { calendars: h.calendars }; h.calendars = calendars;
    h.listeners.forEach(listener => listener({ calendars }, previous));
  } }),
  subscribe: (listener: (state: { calendars: Calendar[] }, previous: { calendars: Calendar[] }) => void) => {
    h.listeners.add(listener); return () => h.listeners.delete(listener);
  },
} }));
vi.mock("./tasksCache", () => ({ cacheGetTasks: () => null, cacheSetTasks: () => {}, cacheDeleteTasks: () => {} }));
vi.mock("@/lib/network", () => ({ isAuthorizationError: () => false, userFacingError: (error: Error) => error.message }));
const home = CalendarSchema.parse({ id: "home", creatorID: "owner", name: "Home", color: "red", role: "owner", members: [] });
const mirror = { ...home, id: "mirror", role: "owner" as const };
const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: "home", title: "Task", revision: 3, providerReadRetiredGeneration: 2 });
const scope = "current";
const ticket = { taskId: task.id, revision: 3, providerReadRetiredGeneration: 2, scope };
const api = { getTasks: vi.fn<() => Promise<Task[]>>(), getCalendars: vi.fn<() => Promise<Calendar[]>>(),
  setTaskStatus: vi.fn<(task: Task, status: string) => Promise<Task | null>>(), syncProviderCalendars: vi.fn<() => Promise<void>>() };
let stop = () => {};
async function settle() { for (let i = 0; i < 18; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  resetTaskCollection(); resetWidgetData(); h.lifecycle++; h.calendars = [home, mirror]; vi.resetAllMocks();
  h.claim.mockResolvedValue(ticket); api.getTasks.mockResolvedValue([task]); api.getCalendars.mockResolvedValue([home, mirror]);
  api.setTaskStatus.mockResolvedValue({ ...task, revision: 4, status: "completed" });
  stop = startTaskCollectionSync(scope, api); await settle();
});
afterEach(() => { stop(); resetTaskCollection(); });
it("reads current access and sends the fresh conditional task to the normal mutation path", async () => {
  expect(await completeWidgetTask(scope, task.id, "native-ticket", api)).toBe(true);
  expect(h.claim).toHaveBeenCalledWith("native-ticket", scope);
  expect(api.getCalendars).toHaveBeenCalledOnce();
  expect(api.setTaskStatus).toHaveBeenCalledWith(task, "completed");
  expect(useTasksStore.getState().tasks[0].status).toBe("completed");
});
it.each([null, { ...ticket, scope: "foreign" }, { ...ticket, taskId: "other" }])("rejects unissued replayed or mismatched tickets: %j", async claim => {
  h.claim.mockResolvedValue(claim);
  await expect(completeWidgetTask(scope, task.id, "bad", api)).rejects.toThrow("Refresh the widget");
  expect(api.getCalendars).not.toHaveBeenCalled(); expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it.each([{ revision: 4 }, { providerReadRetiredGeneration: 3 }, { status: "completed" as const }, { status: "cancelled" as const }])("does not complete a changed task from an old widget: %j", async patch => {
  api.getTasks.mockResolvedValue([{ ...task, ...patch }]);
  await expect(completeWidgetTask(scope, task.id, "ticket", api)).rejects.toThrow("has changed");
  expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it("honors a same-revision server capability revocation", async () => {
  api.getTasks.mockResolvedValue([{ ...task, capabilities: { edit: false, delete: false, link: false, fork: true, unlinkCalendarIDs: [] } }]);
  await expect(completeWidgetTask(scope, task.id, "ticket", api)).rejects.toThrow("read-only");
  expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it("does not infer completion rights from an editable mirror", async () => {
  api.getCalendars.mockResolvedValue([mirror]);
  api.getTasks.mockResolvedValue([{ ...task, calendarIDs: [mirror.id], originCalendarID: home.id }]);
  await expect(completeWidgetTask(scope, task.id, "ticket", api)).rejects.toThrow("read-only");
  expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it.each(["getTasks", "getCalendars"] as const)("keeps the saved task unchanged when %s fails", async method => {
  api[method].mockRejectedValue(new Error("Offline"));
  await expect(completeWidgetTask(scope, task.id, "ticket", api)).rejects.toThrow("Offline");
  expect(api.setTaskStatus).not.toHaveBeenCalled();
  expect(useTasksStore.getState().tasks[0].status).toBe("needs-action");
});
it("rejects a task removed by a current authoritative read", async () => {
  api.getTasks.mockResolvedValue([]);
  await expect(completeWidgetTask(scope, task.id, "ticket", api)).rejects.toThrow("has changed");
  expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it("does not write after an account reset during native ticket adoption", async () => {
  const pending = deferred<typeof ticket>(); h.claim.mockReturnValue(pending.promise);
  const completing = completeWidgetTask(scope, task.id, "ticket", api);
  h.lifecycle++; resetTaskCollection(); pending.resolve(ticket);
  expect(await completing).toBe(false); expect(api.getCalendars).not.toHaveBeenCalled(); expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it("does not publish access or mutate after switching accounts during the calendar read", async () => {
  const pending = deferred<Calendar[]>(); api.getCalendars.mockReturnValue(pending.promise);
  const completing = completeWidgetTask(scope, task.id, "ticket", api); await settle();
  h.lifecycle++; resetTaskCollection(); h.calendars = [];
  pending.resolve([home]); expect(await completing).toBe(false);
  expect(h.calendars).toEqual([]); expect(api.setTaskStatus).not.toHaveBeenCalled();
});
it("reports a failed mutation without optimistic completion", async () => {
  api.setTaskStatus.mockRejectedValue(new Error("Conflict"));
  await expect(completeWidgetTask(scope, task.id, "ticket", api)).rejects.toThrow("Conflict");
  expect(useTasksStore.getState().tasks[0].status).toBe("needs-action");
});
