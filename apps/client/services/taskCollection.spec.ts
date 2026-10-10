import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CalendarSchema, TaskSchema, type Calendar, type Task } from "@musubi/types";
import { useTaskRefreshStore } from "@/store/useTaskRefreshStore";
import { useTasksStore } from "@/store/useTasksStore";
import { resetWidgetData, widgetCalendarsLoaded } from "@/store/useWidgetDataStore";
import { acceptTaskMutation, refreshTasks, resetTaskCollection, runTaskMutation, startTaskCollectionSync, taskCollectionScope } from "./taskCollection";

const h = vi.hoisted(() => ({
  lifecycle: 0, calendars: [] as Calendar[],
  eventListeners: new Set<(state: { events: unknown[] }, previous: { events: unknown[] }) => void>(),
  calendarListeners: new Set<(state: { calendars: Calendar[] }, previous: { calendars: Calendar[] }) => void>(),
  cached: new Map<string, { tasks: Task[]; lastSyncedAt: number | null }>(),
  writes: vi.fn(), deletes: vi.fn(),
}));
vi.mock("@/store/useEventsStore", () => ({
  getEventLifecycle: () => h.lifecycle,
  useEventsStore: { subscribe: (listener: typeof h.eventListeners extends Set<infer T> ? T : never) => {
    h.eventListeners.add(listener); return () => h.eventListeners.delete(listener);
  } },
}));
vi.mock("@/store/useCalendarsStore", () => ({ useCalendarsStore: {
  getState: () => ({ calendars: h.calendars }),
  subscribe: (listener: typeof h.calendarListeners extends Set<infer T> ? T : never) => {
    h.calendarListeners.add(listener); return () => h.calendarListeners.delete(listener);
  },
} }));
vi.mock("./tasksCache", () => ({
  cacheGetTasks: (scope: string) => h.cached.get(scope) ?? null,
  cacheSetTasks: (scope: string, tasks: Task[], lastSyncedAt: number | null) => {
    h.writes(scope, tasks); h.cached.set(scope, { tasks, lastSyncedAt });
  },
  cacheDeleteTasks: (scope: string) => { h.deletes(scope); h.cached.delete(scope); },
}));
vi.mock("@/lib/network", () => ({
  isAuthorizationError: (error: Error) => /^40[13]/.test(error.message),
  userFacingError: (error: Error) => error.message,
}));

const home = CalendarSchema.parse({ id: "home", creatorID: "owner", name: "Home", color: "red", role: "owner", members: [] });
const mirror = { ...home, id: "mirror", role: "viewer" as const };
const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: "home", title: "Private task", revision: 2, providerReadRetiredGeneration: 3, due: "2026-10-06T00:00:00Z" });
const other = { ...task, id: "other", title: "Another task" };
const scope = taskCollectionScope("https://home.test", "owner")!;
const api = { getTasks: vi.fn<() => Promise<Task[]>>(), syncProviderCalendars: vi.fn<() => Promise<void>>() };
const stops: (() => void)[] = [];
function start(targetScope = scope) { stops.push(startTaskCollectionSync(targetScope, api)); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
beforeEach(() => {
  resetTaskCollection(); resetWidgetData(); h.cached.clear(); h.calendars = [home, mirror]; h.lifecycle++;
  vi.clearAllMocks(); api.getTasks.mockResolvedValue([task]); api.syncProviderCalendars.mockResolvedValue();
});
afterEach(() => { stops.splice(0).forEach(stop => stop()); resetTaskCollection(); });

it("hydrates the exact actor/server cache and keeps it on a cold offline read", async () => {
  h.cached.set(scope, { tasks: [task], lastSyncedAt: 100 });
  h.cached.set(taskCollectionScope("https://other.test", "owner")!, { tasks: [other], lastSyncedAt: 200 });
  api.getTasks.mockRejectedValue(new Error("Offline"));
  start();
  expect(useTasksStore.getState()).toMatchObject({ tasks: [task], ready: true, status: "cached", lastSyncedAt: 100 });
  await settle();
  expect(useTasksStore.getState()).toMatchObject({ tasks: [task], ready: true, status: "error", error: "Offline", lastSyncedAt: 100, refreshing: false });
});

it("keeps a scoped task cache while offline calendar membership is still unknown", async () => {
  h.calendars = [];
  h.cached.set(scope, { tasks: [task], lastSyncedAt: 100 });
  api.getTasks.mockRejectedValue(new Error("Offline"));
  start(); widgetCalendarsLoaded(); await settle();
  expect(useTasksStore.getState()).toMatchObject({ tasks: [task], ready: true, status: "error" });
  expect(h.cached.get(scope)?.tasks).toEqual([task]);
});

it("prunes a cold cached private home once fresh calendars confirm only its mirror", async () => {
  const linked = { ...task, originCalendarID: home.id, calendarIDs: [home.id, mirror.id],
    description: "Private home notes", capabilities: { edit: true, delete: true, link: true, fork: true, unlinkCalendarIDs: [mirror.id] } };
  h.calendars = [];
  h.cached.set(scope, { tasks: [linked], lastSyncedAt: 100 });
  api.getTasks.mockRejectedValue(new Error("Offline"));
  start(); await settle();
  const previous = { calendars: h.calendars }; h.calendars = [mirror];
  for (const listener of h.calendarListeners) listener({ calendars: h.calendars }, previous);
  widgetCalendarsLoaded(true);
  expect(useTasksStore.getState()).toMatchObject({ tasks: [], ready: true, status: "error" });
  expect(h.cached.has(scope)).toBe(false);
  expect(acceptTaskMutation(scope, task.id, { ...linked, revision: 3 })).toBe(false);
  await settle();
  expect(useTasksStore.getState()).toMatchObject({ tasks: [], ready: true, status: "error" });
  expect(h.cached.has(scope)).toBe(false);
  expect(acceptTaskMutation(scope, "unrelated-task", null)).toBe(true);
  expect(useTasksStore.getState().status).toBe("error");
  expect(h.cached.has(scope)).toBe(false);
  resetTaskCollection(); start(); await settle();
  expect(useTasksStore.getState()).toMatchObject({ tasks: [], ready: false, status: "error" });
  expect(h.cached.has(scope)).toBe(false);
});

it("reconciles a cached private home when calendar authority precedes the task consumer", async () => {
  const linked = { ...task, originCalendarID: home.id, calendarIDs: [home.id, mirror.id] };
  h.calendars = [mirror]; widgetCalendarsLoaded(true);
  h.cached.set(scope, { tasks: [linked], lastSyncedAt: 100 });
  api.getTasks.mockRejectedValue(new Error("Offline"));
  start();
  expect(useTasksStore.getState()).toMatchObject({ tasks: [], ready: true, status: "error" });
  expect(h.cached.has(scope)).toBe(false);
  await settle();
  expect(useTasksStore.getState().tasks).toEqual([]);
});

it("recovers a current redacted mirror from a fresh task read after cold home pruning", async () => {
  const linked = { ...task, originCalendarID: home.id, calendarIDs: [home.id, mirror.id], description: "Private notes" };
  h.calendars = []; h.cached.set(scope, { tasks: [linked], lastSyncedAt: 100 });
  api.getTasks.mockRejectedValue(new Error("Offline")); start(); await settle();
  const redacted = { ...task, originCalendarID: null, calendarIDs: [mirror.id], description: undefined,
    capabilities: { edit: false, delete: false, link: false, fork: false, unlinkCalendarIDs: [] } };
  api.getTasks.mockResolvedValue([redacted]);
  h.calendars = [mirror]; widgetCalendarsLoaded(true); await settle();
  expect(useTasksStore.getState().tasks).toEqual([redacted]);
  expect(useTasksStore.getState().status).toBe("ready");
  expect(h.cached.get(scope)?.tasks).toEqual([redacted]);
});

it("distinguishes a successfully cached empty collection from never loaded data", async () => {
  h.cached.set(scope, { tasks: [], lastSyncedAt: 100 }); api.getTasks.mockRejectedValue(new Error("Offline"));
  start(); await settle();
  expect(useTasksStore.getState().ready).toBe(true);
  resetTaskCollection(); h.cached.clear(); start(); await settle();
  expect(useTasksStore.getState()).toMatchObject({ ready: false, status: "error", tasks: [] });
});

it("refreshes task invalidation with no mounted task screen and coalesces duplicate consumers", async () => {
  start(); start(); await settle(); expect(api.getTasks).toHaveBeenCalledTimes(1);
  api.getTasks.mockResolvedValue([task, other]);
  useTaskRefreshStore.getState().refresh(); await settle();
  expect(api.getTasks).toHaveBeenCalledTimes(2);
  expect(useTasksStore.getState().tasks.map(row => row.id)).toEqual([task.id, other.id]);
});

it("does not let an old actor read or receipt populate the next actor's collection/cache", async () => {
  const oldRead = deferred<Task[]>(); api.getTasks.mockReturnValueOnce(oldRead.promise); start();
  const nextScope = taskCollectionScope("https://home.test", "another-actor")!;
  api.getTasks.mockResolvedValue([other]); start(nextScope); await settle();
  oldRead.resolve([task]); await settle();
  expect(acceptTaskMutation(scope, task.id, task)).toBe(false);
  expect(useTasksStore.getState()).toMatchObject({ scope: nextScope, tasks: [other] });
  expect(h.writes.mock.calls.every(([savedScope]) => savedScope === nextScope)).toBe(true);
});

it("uses the existing account lifecycle to clear rows and reject a delayed mutation", async () => {
  start(); await settle(); const mutation = deferred<Task>();
  const saving = runTaskMutation(scope, api, task.id, () => mutation.promise);
  h.lifecycle++;
  for (const listener of [...h.eventListeners]) listener({ events: [] }, { events: [task] });
  const writes = h.writes.mock.calls.length;
  mutation.resolve({ ...task, revision: 3 });
  expect(await saving).toBeNull();
  expect(useTasksStore.getState()).toMatchObject({ scope: null, ready: false, tasks: [] });
  expect(h.writes).toHaveBeenCalledTimes(writes);
});

it("clears private memory when the last consumer leaves and fences its delayed read", async () => {
  const leave = startTaskCollectionSync(scope, api); await settle();
  const oldRead = deferred<Task[]>(); api.getTasks.mockReturnValueOnce(oldRead.promise);
  const reading = refreshTasks(scope, api);
  leave();
  expect(useTasksStore.getState()).toMatchObject({ scope: null, ready: false, tasks: [] });
  expect(h.cached.get(scope)?.tasks).toEqual([task]);
  const writes = h.writes.mock.calls.length;
  oldRead.resolve([other]); await reading;
  expect(useTasksStore.getState()).toMatchObject({ scope: null, ready: false, tasks: [] });
  expect(h.writes).toHaveBeenCalledTimes(writes);
});

it("holds invalidations during a mutation, accepts its receipt, then reloads other task changes", async () => {
  start(); await settle(); const mutation = deferred<Task>();
  const saving = runTaskMutation(scope, api, task.id, () => mutation.promise);
  const completed = { ...task, revision: 3, status: "completed" as const };
  api.getTasks.mockResolvedValue([completed, other]); useTaskRefreshStore.getState().refresh();
  expect(api.getTasks).toHaveBeenCalledTimes(1);
  mutation.resolve(completed); await saving; await settle();
  expect(api.getTasks).toHaveBeenCalledTimes(2);
  expect(useTasksStore.getState().tasks).toEqual([completed, other]);
});

it("rejects an older in-flight read after a committed receipt or access-loss receipt", async () => {
  start(); await settle(); const oldRead = deferred<Task[]>(); api.getTasks.mockReturnValueOnce(oldRead.promise);
  const reading = refreshTasks(scope, api); await settle();
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 3 })).toBe(true);
  oldRead.resolve([task]); await reading;
  expect(useTasksStore.getState().tasks[0].revision).toBe(3);
  expect(acceptTaskMutation(scope, task.id, null)).toBe(true);
  expect(useTasksStore.getState().tasks).toEqual([]);
  expect(h.cached.get(scope)?.tasks).toEqual([]);
});

it("rejects delayed direct edit and link receipts after an authoritative disappearance", async () => {
  start(); await settle();
  api.getTasks.mockResolvedValue([]); await refreshTasks(scope, api);
  const writes = h.writes.mock.calls.length;
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 3, title: "Late edit" })).toBe(false);
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 4, calendarIDs: [home.id, mirror.id], originCalendarID: home.id })).toBe(false);
  expect(useTasksStore.getState().tasks).toEqual([]);
  expect(h.cached.get(scope)?.tasks).toEqual([]);
  expect(h.writes).toHaveBeenCalledTimes(writes);
});

it("a null deletion receipt fences a concurrent positive receipt even with a higher revision", async () => {
  start(); await settle();
  expect(acceptTaskMutation(scope, task.id, null)).toBe(true);
  const writes = h.writes.mock.calls.length;
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 99 })).toBe(false);
  expect(useTasksStore.getState().tasks).toEqual([]);
  expect(h.cached.get(scope)?.tasks).toEqual([]);
  expect(h.writes).toHaveBeenCalledTimes(writes);
});

it("only a later authoritative readable collection recovers a disappeared identity", async () => {
  start(); await settle();
  api.getTasks.mockResolvedValue([]); await refreshTasks(scope, api);
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 3 })).toBe(false);
  const recovered = { ...task, revision: 4 };
  api.getTasks.mockResolvedValue([recovered]); await refreshTasks(scope, api);
  expect(useTasksStore.getState().tasks).toEqual([recovered]);
  expect(acceptTaskMutation(scope, task.id, { ...recovered, revision: 5 })).toBe(true);
  expect(h.cached.get(scope)?.tasks[0].revision).toBe(5);
});

it("disappearance fences preserve new task creation and distinct fork identities", async () => {
  start(); await settle();
  api.getTasks.mockResolvedValue([]); await refreshTasks(scope, api);
  const forked = { ...task, id: "forked", revision: 1 };
  expect(acceptTaskMutation(scope, task.id, forked)).toBe(true);
  const created = { ...task, id: "created", revision: 1 };
  expect(await runTaskMutation(scope, api, created.id, async () => created)).toEqual(created);
  expect(useTasksStore.getState().tasks).toEqual([forked, created]);
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 6 })).toBe(false);
});

it("deduplicates mirrors and preserves proven revision/retirement ordering", async () => {
  api.getTasks.mockResolvedValue([task, { ...task, revision: 1 }, { ...task, providerReadRetiredGeneration: 2 }, { ...task, providerReadRetiredGeneration: 4 }]);
  start(); await settle();
  expect(useTasksStore.getState().tasks).toEqual([{ ...task, providerReadRetiredGeneration: 4 }]);
  api.getTasks.mockResolvedValue([{ ...task, providerReadRetiredGeneration: 2 }]); await refreshTasks(scope, api);
  expect(useTasksStore.getState().tasks[0].providerReadRetiredGeneration).toBe(4);
});

it("accepts same-revision capability revocation from an authoritative read", async () => {
  const capabilities = { edit: true, delete: true, link: true, fork: true, unlinkCalendarIDs: [mirror.id] };
  api.getTasks.mockResolvedValue([{ ...task, capabilities }]); start(); await settle();
  api.getTasks.mockResolvedValue([{ ...task, capabilities: { ...capabilities, edit: false, delete: false, link: false } }]);
  await refreshTasks(scope, api);
  expect(useTasksStore.getState().tasks[0].capabilities?.edit).toBe(false);
  expect(acceptTaskMutation(scope, task.id, { ...task, capabilities })).toBe(true);
  expect(useTasksStore.getState().tasks[0].capabilities?.edit).toBe(false);
});

it("evicts cached private rows on authorization failure", async () => {
  h.cached.set(scope, { tasks: [task], lastSyncedAt: 100 }); api.getTasks.mockRejectedValue(new Error("403: Membership removed"));
  start(); await settle();
  expect(useTasksStore.getState()).toMatchObject({ ready: false, status: "unauthorized", tasks: [], lastSyncedAt: null });
  expect(h.cached.has(scope)).toBe(false);
  expect(acceptTaskMutation(scope, task.id, { ...task, revision: 3 })).toBe(false);
  expect(useTasksStore.getState()).toMatchObject({ ready: false, status: "unauthorized", tasks: [] });
  expect(h.cached.has(scope)).toBe(false);
});

it("rejects a delayed full-home receipt after home access is removed", async () => {
  const linked = { ...task, originCalendarID: home.id, calendarIDs: [home.id, mirror.id] };
  api.getTasks.mockResolvedValue([linked]); start(); await settle();
  const mutation = deferred<Task>();
  const saving = runTaskMutation(scope, api, task.id, () => mutation.promise);
  const redacted = { ...linked, originCalendarID: null, calendarIDs: [mirror.id], capabilities: {
    edit: false, delete: false, link: false, fork: false, unlinkCalendarIDs: [],
  } };
  api.getTasks.mockResolvedValue([redacted]);
  const previous = { calendars: h.calendars }; h.calendars = [mirror];
  for (const listener of h.calendarListeners) listener({ calendars: h.calendars }, previous);
  expect(useTasksStore.getState().tasks).toEqual([]);
  mutation.resolve({ ...linked, revision: 3 });
  expect(await saving).toBeNull(); await settle();
  expect(useTasksStore.getState().tasks).toEqual([redacted]);
  expect(h.cached.get(scope)?.tasks).toEqual([redacted]);
  expect(h.writes.mock.calls.some(([, tasks]) => tasks.some((row: Task) => row.revision === 3))).toBe(false);
});

it("does not restore a removed linked membership from a delayed receipt", async () => {
  const linked = { ...task, originCalendarID: home.id, calendarIDs: [home.id, mirror.id], capabilities: {
    edit: true, delete: true, link: true, fork: true, unlinkCalendarIDs: [mirror.id],
  } };
  api.getTasks.mockResolvedValue([linked]); start(); await settle();
  const refresh = deferred<Task[]>(); api.getTasks.mockReturnValue(refresh.promise);
  const previous = { calendars: h.calendars }; h.calendars = [home];
  for (const listener of h.calendarListeners) listener({ calendars: h.calendars }, previous);
  expect(acceptTaskMutation(scope, task.id, { ...linked, revision: 3 })).toBe(true);
  expect(useTasksStore.getState().tasks[0]).toMatchObject({ calendarIDs: [home.id], capabilities: { unlinkCalendarIDs: [] } });
  refresh.resolve([linked]); await settle();
  expect(useTasksStore.getState().tasks[0].calendarIDs).toEqual([home.id]);
});

it("drops a removed home immediately and fences pre-removal reads before fetching a redacted mirror", async () => {
  const linked = { ...task, originCalendarID: home.id, calendarIDs: [home.id, mirror.id] };
  api.getTasks.mockResolvedValue([linked]); start(); await settle();
  const oldRead = deferred<Task[]>(); api.getTasks.mockReturnValueOnce(oldRead.promise);
  const reading = refreshTasks(scope, api);
  const freshRead = deferred<Task[]>(); api.getTasks.mockReturnValueOnce(freshRead.promise);
  const previous = { calendars: h.calendars }; h.calendars = [mirror];
  for (const listener of h.calendarListeners) listener({ calendars: h.calendars }, previous);
  expect(useTasksStore.getState().tasks).toEqual([]);
  oldRead.resolve([linked]); await reading;
  expect(useTasksStore.getState().tasks).toEqual([]);
  const readable = { ...linked, originCalendarID: null, calendarIDs: [mirror.id], providerReadRetiredGeneration: 4 };
  freshRead.resolve([readable]); await settle();
  expect(useTasksStore.getState().tasks).toEqual([readable]);
});
