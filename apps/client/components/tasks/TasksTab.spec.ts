import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { CalendarSchema, TaskSchema } from "@musubi/types";
import TasksTab from "../../app/(tabs)/tasks";
import { resetTaskCollection } from "@/services/taskCollection";

const h = vi.hoisted(() => ({
  actor: "owner", key: undefined as string | undefined, slots: [] as unknown[], index: 0, focus: undefined as undefined | (() => void | (() => void)),
  effects: [] as { deps?: readonly unknown[]; cleanup?: () => void }[], effectIndex: 0,
  params: {} as { taskId?: string; widgetRefresh?: string; tasksWidgetId?: string }, setParams: vi.fn(),
  api: { getTasks: vi.fn(), syncProviderCalendars: vi.fn(), createTask: vi.fn() },
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
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useDebugValue: () => {},
  useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => {
    const index = h.effectIndex++;
    const previous = h.effects[index];
    if (deps && previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => value === previous.deps?.[i])) return;
    previous?.cleanup?.();
    h.effects[index] = { deps, cleanup: effect() || undefined };
  },
  useCallback: (callback: unknown) => callback,
}));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", RefreshControl: "RefreshControl", ScrollView: "ScrollView", Text: "Text", View: "View" }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void | (() => void)) => { h.focus = callback; },
  useLocalSearchParams: () => h.params,
  router: { setParams: (params: typeof h.params) => { h.setParams(params); Object.assign(h.params, params); } },
}));
vi.mock("@expo/vector-icons", () => ({ Feather: "Feather" }));
vi.mock("@/components/tasks/TaskEditorModal", () => ({ TaskEditorModal: "TaskEditorModal" }));
vi.mock("@/components/tasks/TaskDetailModal", () => ({ TaskDetailModal: "TaskDetailModal" }));
vi.mock("@/components/calendar/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("@/components/calendar/CalendarFilterBar", () => ({ CalendarFilterBar: "CalendarFilterBar" }));
vi.mock("@/components/calendar/CalendarWidgetSettingsModal", () => ({ default: "CalendarWidgetSettingsModal" }));
vi.mock("@/components/ui/Tap", () => ({ Tap: "Tap" }));
vi.mock("@/components/ui/OptionPicker", () => ({ OptionPicker: "OptionPicker" }));
vi.mock("@/components/ui/Empty", () => ({ Empty: "Empty" }));
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/constants/theme", () => ({ colors: {}, fonts: {}, styles: {} }));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ apiUrl: "https://example.test", authClient: { useSession: () => ({ data: { user: { id: h.actor } } }) } }) }));
vi.mock("@/services/api", () => ({ useApi: () => h.api }));
vi.mock("@/lib/network", async original => ({ ...await original<typeof import("@/lib/network")>(), userFacingError: (error: Error) => error.message }));
vi.mock("@/store/useSettingsStore", () => ({ useSettingsStore: (selector: (state: { dateFormat: string; timeFormat: string }) => unknown) => selector({ dateFormat: "ymd", timeFormat: "24h" }) }));
vi.mock("@/store/useCalendarsStore", () => {
  const getState = () => ({ calendars: [calendar], activeCals: new Set([calendar.id]), toggleCal: vi.fn() });
  return { useCalendarsStore: Object.assign((selector?: (state: ReturnType<typeof getState>) => unknown) => selector ? selector(getState()) : getState(), { getState, subscribe: () => () => {} }) };
});
vi.mock("@/store/useEventsStore", () => ({ getEventLifecycle: () => 0, useEventsStore: { subscribe: () => () => {} } }));
vi.mock("@/services/tasksCache", () => ({ cacheGetTasks: () => null, cacheSetTasks: () => {}, cacheDeleteTasks: () => {} }));
vi.mock("@/store/useTasksStore", async original => {
  const module = await original<typeof import("@/store/useTasksStore")>();
  // Render harness reads the real collection; Zustand's React adapter is outside
  // Vitest's React mock and needs no hooks for these explicit harness renders.
  return { ...module, useTasksStore: Object.assign(() => module.useTasksStore.getState(), module.useTasksStore) };
});

const calendar = CalendarSchema.parse({ role: "owner", id: "google", creatorID: "owner", name: "Google Tasks", provider: "google", supportsTasks: true, color: "red", members: [] });
const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: calendar.id, title: "QA from Google" });
type Props = { children?: ReactNode; refreshControl?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void; onRefresh?: () => void; refreshing?: boolean; onSave?: (draft: unknown) => Promise<void>; task?: typeof task; widgetId?: number | null; kind?: string; onClose?: () => void };
function nodes(node: ReactNode): { type: unknown; props: Props }[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [{ type: node.type, props: node.props }, ...nodes(node.props.children), ...nodes(node.props.refreshControl)];
}
function render() {
  const screen = TasksTab();
  if (screen.key !== h.key) {
    h.effects.forEach(effect => effect.cleanup?.()); h.effects = [];
    h.key = screen.key ?? undefined; h.slots = [];
  }
  h.index = 0; h.effectIndex = 0;
  return (screen.type as () => ReactNode)();
}
function refresh(kind: "button" | "gesture" = "button") {
  const tree = nodes(render());
  if (kind === "button") tree.find(node => node.props.accessibilityLabel === "Refresh tasks")!.props.onPress!();
  else tree.find(node => node.type === "RefreshControl")!.props.onRefresh!();
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
beforeEach(() => {
  h.effects.forEach(effect => effect.cleanup?.()); h.effects = []; h.effectIndex = 0;
  resetTaskCollection(); h.params = {};
  h.actor = "owner"; h.key = undefined; h.slots = []; h.index = 0; h.focus = undefined;
  vi.resetAllMocks();
  h.api.getTasks.mockResolvedValue([]);
  h.api.syncProviderCalendars.mockResolvedValue(undefined);
});

it("loads the saved snapshot on focus without a redundant provider sync", async () => {
  render(); h.focus!(); await settle();
  expect(h.api.getTasks).toHaveBeenCalledOnce();
  expect(h.api.syncProviderCalendars).not.toHaveBeenCalled();
});

it.each(["button", "gesture"] as const)("waits for provider changes before reading tasks on %s refresh", async kind => {
  const sync = deferred();
  h.api.syncProviderCalendars.mockReturnValue(sync.promise);
  h.api.getTasks.mockResolvedValue([task]);
  render(); await settle(); h.api.getTasks.mockClear();
  refresh(kind);
  expect(h.api.syncProviderCalendars).toHaveBeenCalledOnce();
  expect(h.api.getTasks).not.toHaveBeenCalled();
  expect(nodes(render()).find(node => node.type === "RefreshControl")!.props.refreshing).toBe(true);
  sync.resolve(); await settle();
  expect(h.api.getTasks).toHaveBeenCalledOnce();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(true);
  expect(nodes(render()).find(node => node.type === "RefreshControl")!.props.refreshing).toBe(false);
});

it("keeps existing tasks and shows the error when provider refresh fails", async () => {
  h.api.getTasks.mockResolvedValue([task]);
  render(); h.focus!(); await settle();
  h.api.getTasks.mockClear();
  h.api.syncProviderCalendars.mockRejectedValue(new Error("Connection unavailable"));
  refresh(); await settle();
  expect(h.api.getTasks).not.toHaveBeenCalled();
  const tree = nodes(render());
  expect(tree.some(node => node.props.children === task.title)).toBe(true);
  expect(tree.find(node => node.props.accessibilityRole === "alert")!.props.children).toBe("Connection unavailable");
  expect(tree.find(node => node.type === "RefreshControl")!.props.refreshing).toBe(false);
});

it("finishes a provider refresh for the shared collection after leaving the task screen", async () => {
  render(); h.focus!(); await settle(); h.api.getTasks.mockClear();
  const sync = deferred(); h.api.syncProviderCalendars.mockReturnValue(sync.promise);
  refresh(); sync.resolve(); await settle();
  expect(h.api.getTasks).toHaveBeenCalledOnce();
});

it("ignores an older provider refresh after a newer refresh has completed", async () => {
  render(); await settle(); h.api.getTasks.mockClear();
  const old = deferred(); h.api.syncProviderCalendars.mockReturnValueOnce(old.promise);
  h.api.getTasks.mockResolvedValue([task]);
  refresh(); refresh(); await settle(); old.resolve(); await settle();
  expect(h.api.getTasks).toHaveBeenCalledOnce();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(true);
});


it("renders a canonical mirror once and keeps completion read-only without home access", async () => {
  const mirror = { ...task, calendarID: "private-home", originCalendarID: null, calendarIDs: [calendar.id], revision: 2, capabilities: { edit: false, delete: false, link: false, fork: true, unlinkCalendarIDs: [calendar.id] } };
  h.api.getTasks.mockResolvedValue([mirror, mirror]);
  render(); h.focus!(); await settle();
  const tree = nodes(render());
  expect(tree.filter(node => node.props.children === task.title)).toHaveLength(1);
  expect(tree.find(node => node.props.accessibilityLabel?.startsWith("Change status of"))!.props.disabled).toBe(true);
  expect(tree.some(node => Array.isArray(node.props.children) && node.props.children.includes(calendar.name))).toBe(true);
});

it("drops the old actor's snapshot immediately and ignores an old in-flight read", async () => {
  h.api.getTasks.mockResolvedValue([task]);
  render(); h.focus!(); await settle();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(true);
  let resolve!: (tasks: typeof task[]) => void;
  h.api.getTasks.mockReturnValueOnce(new Promise<typeof task[]>(done => { resolve = done; }));
  refresh("gesture"); await settle();
  h.actor = "new-actor";
  h.api.getTasks.mockResolvedValue([]);
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(false);
  resolve([task]); await settle();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(false);
});


it("clears previously readable private task text when the authorized read is rejected", async () => {
  h.api.getTasks.mockResolvedValue([task]);
  render(); h.focus!(); await settle();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(true);
  h.api.getTasks.mockRejectedValue(new Error("403: Membership removed"));
  refresh("gesture"); await settle();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(false);
  expect(nodes(render()).find(node => node.props.accessibilityRole === "alert")!.props.children).toBe("403: Membership removed");
});

it("keeps a create receipt while the shared collection refreshes its remaining tasks", async () => {
  h.api.getTasks.mockResolvedValue([]);
  render(); h.focus!(); await settle();
  nodes(render()).find(node => node.props.accessibilityLabel === "Create task")!.props.onPress!();
  let resolve!: (tasks: typeof task[]) => void;
  h.api.getTasks.mockReturnValueOnce(new Promise<typeof task[]>(done => { resolve = done; }));
  refresh("gesture"); await settle();
  expect(nodes(render()).find(node => node.type === "RefreshControl")!.props.refreshing).toBe(true);
  const created = { ...task, revision: 1 };
  h.api.createTask.mockResolvedValue(created);
  h.api.getTasks.mockResolvedValue([created]);
  const editor = nodes(render()).find(node => node.type === "TaskEditorModal")!;
  await editor.props.onSave!({ ...created, calendarID: calendar.id });
  const tree = nodes(render());
  await settle();
  expect(tree.some(node => node.props.children === task.title)).toBe(true);
  resolve([]); await settle();
  expect(nodes(render()).some(node => node.props.children === task.title)).toBe(true);
});

it("opens a canonical widget task after data loads and consumes it on close", async () => {
  h.params = { taskId: task.id, widgetRefresh: "1" }; h.api.getTasks.mockResolvedValue([task]);
  expect(nodes(render()).some(node => node.type === "TaskDetailModal")).toBe(false);
  await settle(); const tree = nodes(render());
  const detail = tree.find(node => node.type === "TaskDetailModal")!;
  expect(detail.props.task?.id).toBe(task.id);
  expect(h.params.taskId).toBe(task.id);
  expect(h.setParams).toHaveBeenCalledWith({ widgetRefresh: "" });
  expect(h.api.syncProviderCalendars).toHaveBeenCalledOnce();
  expect(tree.some(node => node.props.children === task.title)).toBe(true);
  detail.props.onClose!();
  expect(h.setParams).toHaveBeenCalledWith({ taskId: "" });
  expect(nodes(render()).some(node => node.type === "TaskDetailModal")).toBe(false);
  h.params = { taskId: task.id };
  expect(nodes(render()).find(node => node.type === "TaskDetailModal")?.props.task?.id).toBe(task.id);
});

it("lets a new widget link replace an already opened task", async () => {
  const second = { ...task, id: "second", title: "Second task" };
  h.api.getTasks.mockResolvedValue([task, second]);
  render(); await settle();
  nodes(render()).find(node => node.props.accessibilityLabel === `Open task: ${task.title}`)!.props.onPress!();
  expect(nodes(render()).find(node => node.type === "TaskDetailModal")?.props.task?.id).toBe(task.id);
  h.params = { taskId: second.id };
  const detail = nodes(render()).find(node => node.type === "TaskDetailModal")!;
  expect(detail.props.task?.id).toBe(second.id);
  detail.props.onClose!();
  expect(nodes(render()).some(node => node.type === "TaskDetailModal")).toBe(false);
});

it("opens the Tasks widget calendar picker independently of app filters", async () => {
  h.params = { tasksWidgetId: "42" }; render();
  const picker = nodes(render()).find(node => node.type === "CalendarWidgetSettingsModal")!;
  expect(picker.props).toMatchObject({ widgetId: 42, kind: "tasks" });
  expect(h.params.tasksWidgetId).toBe("42");
  picker.props.onClose!();
  expect(h.setParams).toHaveBeenCalledWith({ tasksWidgetId: "" });
  expect(nodes(render()).find(node => node.type === "CalendarWidgetSettingsModal")?.props.widgetId).toBeNull();
  h.params = { tasksWidgetId: "42" };
  expect(nodes(render()).find(node => node.type === "CalendarWidgetSettingsModal")?.props.widgetId).toBe(42);
});
