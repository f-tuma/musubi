import { createElement, isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { CalendarSchema, TaskSchema, type Task } from "@musubi/types";
import { useTaskRefreshStore } from "@/store/useTaskRefreshStore";
import { useCalendarTasks } from "./useCalendarTasks";
import { resetTaskCollection } from "@/services/taskCollection";

const h = vi.hoisted(() => ({
  actor: "owner", url: "https://home.test", slots: [] as unknown[], index: 0,
  effects: [] as { deps?: readonly unknown[]; cleanup?: () => void }[], effectIndex: 0,
  focus: undefined as undefined | (() => void | (() => void)),
  api: { getTasks: vi.fn(), setTaskStatus: vi.fn(), setTaskPriority: vi.fn(), syncProviderCalendars: vi.fn() },
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = h.index++;
    const slots = h.slots;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  },
  useRef: (initial: unknown) => { const index = h.index++; return h.slots[index] ??= { current: initial }; },
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useDebugValue: () => {},
  useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => {
    const index = h.effectIndex++;
    const previous = h.effects[index];
    if (deps && previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => value === previous.deps?.[i])) return;
    previous?.cleanup?.();
    h.effects[index] = { deps, cleanup: effect() || undefined };
  },
}));
vi.mock("expo-router", () => ({ useFocusEffect: (callback: () => void | (() => void)) => { h.focus = callback; } }));
vi.mock("@/services/api", () => ({ useApi: () => h.api }));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ apiUrl: h.url, authClient: { useSession: () => ({ data: { user: { id: h.actor } } }) } }) }));
vi.mock("@/store/useCalendarsStore", () => ({ useCalendarsStore: Object.assign((selector: (state: { calendars: typeof calendars }) => unknown) => selector({ calendars }), { getState: () => ({ calendars }), subscribe: () => () => {} }) }));
vi.mock("@/store/useEventsStore", () => ({ getEventLifecycle: () => 0, useEventsStore: { subscribe: () => () => {} } }));
vi.mock("@/services/tasksCache", () => ({ cacheGetTasks: () => null, cacheSetTasks: () => {}, cacheDeleteTasks: () => {} }));
vi.mock("@/store/useTasksStore", async original => {
  const module = await original<typeof import("@/store/useTasksStore")>();
  return { ...module, useTasksStore: Object.assign(() => module.useTasksStore.getState(), module.useTasksStore) };
});
vi.mock("@/components/tasks/TaskDetailModal", () => ({ TaskDetailModal: "TaskDetailModal" }));
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/network", () => ({ isAuthorizationError: (error: Error) => /^40[13]/.test(error.message), userFacingError: (error: Error) => error.message }));

const calendars = [CalendarSchema.parse({ role: "owner", id: "home", creatorID: "owner", name: "Home", color: "red", members: [] })];
const task = TaskSchema.parse({ id: "task", revision: 1, creatorID: "owner", calendarID: "home", title: "Original task", due: new Date("2026-10-06T00:00:00Z") });
const other = TaskSchema.parse({ id: "other", revision: 1, creatorID: "owner", calendarID: "home", title: "Created on another device", due: new Date("2026-10-06T00:00:00Z") });
const saved = { ...task, revision: 2, status: "completed" as const };
function CalendarTasksHarness() {
  return createElement<{ result: ReturnType<typeof useCalendarTasks> }>("HookResult", { result: useCalendarTasks() });
}
function render() { h.index = 0; h.effectIndex = 0; return CalendarTasksHarness().props.result; }
function details(result: ReturnType<typeof useCalendarTasks>) {
  expect(isValidElement(result.detail)).toBe(true);
  return (result.detail as ReactElement<{ onStatus: (status: string) => void }>).props;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function openTask() {
  let result = render(); h.focus!(); await settle(); result = render();
  result.open(result.items.find(item => item.calendarTask.id === task.id)!);
  return render();
}
beforeEach(() => {
  for (const effect of h.effects) effect.cleanup?.();
  h.effects = []; h.effectIndex = 0; h.slots = []; h.index = 0; h.actor = "owner"; h.url = "https://home.test";
  resetTaskCollection();
  vi.clearAllMocks(); h.api.getTasks.mockResolvedValue([task]);
});

it("reloads an invalidation received during completion once the mutation is acknowledged", async () => {
  const pending = deferred<Task>();
  h.api.setTaskStatus.mockReturnValue(pending.promise);
  details(await openTask()).onStatus("completed");
  h.api.getTasks.mockResolvedValue([saved, other]);
  useTaskRefreshStore.getState().refresh();
  expect(h.api.getTasks).toHaveBeenCalledTimes(1);
  pending.resolve(saved); await settle();
  expect(h.api.getTasks).toHaveBeenCalledTimes(2);
  expect(render().items.map(item => item.calendarTask.title)).toContain(other.title);
});

it("flushes to the current actor/server after a switch without restoring old private rows", async () => {
  const pending = deferred<Task>();
  h.api.setTaskStatus.mockReturnValue(pending.promise);
  let result = await openTask();
  details(result).onStatus("completed");
  h.focus!();
  h.actor = "other-actor"; h.url = "https://other.test";
  h.api.getTasks.mockResolvedValue([other]);
  result = render(); h.focus!();
  expect(result.items).toHaveLength(0);
  pending.resolve(saved); await settle();
  result = render();
  expect(h.api.getTasks).toHaveBeenCalledTimes(2);
  expect(result.items.map(item => item.calendarTask.id)).toEqual([other.id]);
});

it("removes an already open task after an authorized refresh loses its membership", async () => {
  await openTask();
  h.api.getTasks.mockRejectedValue(new Error("403: Membership removed"));
  useTaskRefreshStore.getState().refresh(); await settle();
  const result = render();
  expect(result.items).toHaveLength(0);
  expect(result.detail).toBeNull();
});
