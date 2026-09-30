import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { CalendarSchema, TaskSchema } from "@musubi/types";
import TasksTab from "../../app/(tabs)/tasks";

const h = vi.hoisted(() => ({
  actor: "owner", key: undefined as string | undefined, slots: [] as unknown[], index: 0, focus: undefined as undefined | (() => () => void),
  api: { getTasks: vi.fn(), syncProviderCalendars: vi.fn() },
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
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
}));
vi.mock("react-native", () => ({ ActivityIndicator: "ActivityIndicator", RefreshControl: "RefreshControl", ScrollView: "ScrollView", Text: "Text", View: "View" }));
vi.mock("expo-router", () => ({ useFocusEffect: (callback: () => () => void) => { h.focus = callback; } }));
vi.mock("@expo/vector-icons", () => ({ Feather: "Feather" }));
vi.mock("@/components/tasks/TaskEditorModal", () => ({ TaskEditorModal: "TaskEditorModal" }));
vi.mock("@/components/tasks/TaskDetailModal", () => ({ TaskDetailModal: "TaskDetailModal" }));
vi.mock("@/components/calendar/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("@/components/calendar/CalendarFilterBar", () => ({ CalendarFilterBar: "CalendarFilterBar" }));
vi.mock("@/components/ui/Tap", () => ({ Tap: "Tap" }));
vi.mock("@/components/ui/OptionPicker", () => ({ OptionPicker: "OptionPicker" }));
vi.mock("@/components/ui/Empty", () => ({ Empty: "Empty" }));
vi.mock("@/components/ui/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/constants/theme", () => ({ colors: {}, fonts: {}, styles: {} }));
vi.mock("@/contexts/ServerContext", () => ({ useServer: () => ({ apiUrl: "https://example.test", authClient: { useSession: () => ({ data: { user: { id: h.actor } } }) } }) }));
vi.mock("@/services/api", () => ({ useApi: () => h.api }));
vi.mock("@/lib/network", async original => ({ ...await original<typeof import("@/lib/network")>(), userFacingError: (error: Error) => error.message }));
vi.mock("@/store/useSettingsStore", () => ({ useSettingsStore: (selector: (state: { dateFormat: string; timeFormat: string }) => unknown) => selector({ dateFormat: "ymd", timeFormat: "24h" }) }));
vi.mock("@/store/useCalendarsStore", () => ({ useCalendarsStore: () => ({ calendars: [calendar], activeCals: new Set([calendar.id]) }) }));

const calendar = CalendarSchema.parse({ id: "google", creatorID: "owner", name: "Google Tasks", provider: "google", supportsTasks: true, color: "red", members: [] });
const task = TaskSchema.parse({ id: "task", creatorID: "owner", calendarID: calendar.id, title: "QA from Google" });
type Props = { children?: ReactNode; refreshControl?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean; onPress?: () => void; onRefresh?: () => void; refreshing?: boolean };
function nodes(node: ReactNode): { type: unknown; props: Props }[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [{ type: node.type, props: node.props }, ...nodes(node.props.children), ...nodes(node.props.refreshControl)];
}
function render() {
  const screen = TasksTab();
  if (screen.key !== h.key) { h.key = screen.key ?? undefined; h.slots = []; }
  h.index = 0;
  return (screen.type as () => ReactNode)();
}
function refresh(kind: "button" | "gesture" = "button") {
  const tree = nodes(render());
  if (kind === "button") tree.find(node => node.props.accessibilityLabel === "Refresh tasks")!.props.onPress!();
  else tree.find(node => node.type === "RefreshControl")!.props.onRefresh!();
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => {
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

it("ignores a provider refresh that finishes after leaving the screen", async () => {
  render(); const leave = h.focus!(); await settle(); h.api.getTasks.mockClear();
  const sync = deferred(); h.api.syncProviderCalendars.mockReturnValue(sync.promise);
  refresh(); leave(); sync.resolve(); await settle();
  expect(h.api.getTasks).not.toHaveBeenCalled();
});

it("ignores an older provider refresh after a newer refresh has completed", async () => {
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
