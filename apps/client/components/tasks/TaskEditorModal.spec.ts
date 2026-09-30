import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarSchema, TaskSchema, type Task } from "@musubi/types";
import { TaskEditorModal } from "./TaskEditorModal";

const h = vi.hoisted(() => ({
  slots: [] as unknown[], index: 0, platform: "android", timeFormat: "24h", save: vi.fn(), close: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = h.index++;
    if (!(index in h.slots)) h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [h.slots[index], (value: unknown) => { h.slots[index] = typeof value === "function" ? value(h.slots[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = h.index++;
    return h.slots[index] ??= { current: initial };
  },
}));
vi.mock("react-native", () => ({
  Platform: { get OS() { return h.platform; } },
  ScrollView: "ScrollView", Switch: "Switch", Text: "Text", TextInput: "TextInput", View: "View",
}));
vi.mock("@/components/ui/DateTimePicker", () => ({ DateTimePicker: "DateTimePicker" }));
vi.mock("@expo/vector-icons", () => ({ Feather: "Feather" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@/components/ui/ModalPortal", () => ({ ModalPortal: "ModalPortal" }));
vi.mock("@/components/ui/BottomSheetFrame", () => ({ BottomSheetFrame: "BottomSheetFrame" }));
vi.mock("@/components/calendar/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("@/components/ui/Btn", () => ({ Btn: "Btn" }));
vi.mock("@/components/ui/Tap", () => ({ Tap: "Tap" }));
vi.mock("@/hooks/useModalAnimation", () => ({ useModalAnimation: (_visible: boolean, close: () => void) => ({ handleClose: close }) }));
vi.mock("@/constants/theme", () => ({ colors: {}, fonts: {}, styles: {} }));
vi.mock("@/store/useSettingsStore", () => ({
  useSettingsStore: (selector: (state: { dateFormat: string; timeFormat: string }) => unknown) => selector({ dateFormat: "ymd", timeFormat: h.timeFormat }),
}));
vi.mock("@/lib/network", () => ({ userFacingError: (_error: unknown, fallback: string) => fallback }));

const google = CalendarSchema.parse({ role: "owner", id: "google", creatorID: "owner", name: "Google Tasks", color: "red", provider: "google", supportsTasks: true, members: [] });
const personal = CalendarSchema.parse({ role: "owner", id: "personal", creatorID: "owner", name: "Personal", color: "red", members: [] });
type Props = {
  children?: ReactNode; header?: ReactNode; accessibilityLabel?: string; label?: string;
  value?: Date; presentation?: string; is24Hour?: boolean;
  onPress: () => void; onChangeText: (value: string) => void;
  onValueChange: (...args: unknown[]) => void;
};
function nodes(node: ReactNode): { type: unknown; props: Props }[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [{ type: node.type, props: node.props }, ...nodes(node.props.header), ...nodes(node.props.children)];
}
function render(task?: Task, calendarID = google.id) {
  h.index = 0;
  return TaskEditorModal({ task, calendarID, calendars: [google, personal], onSave: h.save, onClose: h.close });
}
function control(tree: ReactNode, label: string) {
  const node = nodes(tree).find(node => node.props.accessibilityLabel === label || node.props.label === label);
  expect(node, `Missing control: ${label}`).toBeDefined();
  return node!.props;
}
function picker(tree: ReactNode) { return nodes(tree).find(node => node.type === "DateTimePicker")!.props; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => { h.slots = []; h.index = 0; h.platform = "android"; h.timeFormat = "24h"; vi.clearAllMocks(); h.save.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe.each(["Europe/Prague", "America/Los_Angeles"])("native task dates in %s", timezone => {
  beforeEach(() => vi.stubEnv("TZ", timezone));

  it.each([0, 8])("creates a date-only Google due date in month %s", async month => {
    expect(new Date(2026, 8, 25).getTimezoneOffset()).toBe(timezone === "Europe/Prague" ? -120 : 420);
    control(render(), "Task title").onChangeText("Book train tickets");
    control(render(), "due date").onPress();
    picker(render()).onValueChange({}, new Date(2026, month, 25));
    const tree = render();
    expect(nodes(tree).some(node => node.props.accessibilityLabel === "due time")).toBe(false);
    expect(nodes(tree).some(node => node.props.accessibilityLabel === "All-day task")).toBe(false);
    control(tree, "Create").onPress();
    await settle();
    expect(h.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: "Book train tickets", isAllDay: true, due: new Date(Date.UTC(2026, month, 25)),
    }));
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("preserves and clears the imported Google date", async () => {
    const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: google.id, title: "Tickets", due: new Date("2026-09-25T00:00:00Z"), isAllDay: true });
    control(render(task), "due date").onPress();
    const value = picker(render(task)).value!;
    expect([value.getFullYear(), value.getMonth(), value.getDate()]).toEqual([2026, 8, 25]);
    picker(render(task)).onValueChange({}, new Date(2026, 8, 26));
    control(render(task), "Save").onPress();
    await settle();
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ due: new Date("2026-09-26T00:00:00Z"), isAllDay: true }));
    h.slots = [];
    control(render(task), "Clear due").onPress();
    control(render(task), "Save").onPress();
    await settle();
    expect(h.save).toHaveBeenLastCalledWith(expect.objectContaining({ due: null }));
  });

  it("normalizes an older timed Google draft even when only its title changes", async () => {
    const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: google.id, title: "Tickets", due: new Date(2026, 8, 25), isAllDay: false });
    control(render(task), "Task title").onChangeText("Updated tickets");
    control(render(task), "Save").onPress();
    await settle();
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated tickets", due: new Date("2026-09-25T00:00:00Z"), isAllDay: true }));
  });

  it("keeps the day when switching a timed draft to Google and back", async () => {
    const draw = () => render(undefined, personal.id);
    control(draw(), "Task title").onChangeText("Tickets");
    control(draw(), "due date").onPress();
    picker(draw()).onValueChange({}, new Date(2026, 8, 25));
    expect(nodes(draw()).some(node => node.props.accessibilityLabel === "due time")).toBe(true);
    control(draw(), "Google Tasks calendar").onPress();
    control(draw(), "due date").onPress();
    expect(picker(draw()).value!.getDate()).toBe(25);
    picker(draw()).onValueChange({}, new Date(2026, 8, 25));
    control(draw(), "Personal calendar").onPress();
    control(draw(), "All-day task").onValueChange(false);
    expect(nodes(draw()).some(node => node.props.accessibilityLabel === "due time")).toBe(true);
    control(draw(), "Create").onPress();
    await settle();
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ calendarID: personal.id, due: new Date(2026, 8, 25), isAllDay: false }));
  });

  it("opens an empty all-day date on today in the local zone near UTC midnight", () => {
    vi.useFakeTimers();
    // In Prague this is still the previous UTC day; in Los Angeles it is already the next.
    const now = new Date(2026, 8, 25, timezone === "Europe/Prague" ? 0 : 23, 30);
    vi.setSystemTime(now);
    const task = TaskSchema.parse({ revision: 1, id: "task", creatorID: "owner", calendarID: personal.id, title: "Undated", isAllDay: true });
    control(render(task), "due date").onPress();
    const value = picker(render(task)).value!;
    expect([value.getFullYear(), value.getMonth(), value.getDate()]).toEqual([2026, 8, 25]);
  });
});

it.each(["android", "ios"])("keeps the native date picker presentation on %s", platform => {
  h.platform = platform;
  control(render(), "due date").onPress();
  expect(picker(render()).presentation).toBe(platform === "ios" ? "inline" : "dialog");
});

it.each(["12h", "24h"])("uses the app's %s setting for native task time entry", timeFormat => {
  h.timeFormat = timeFormat;
  const task = TaskSchema.parse({ revision: 1, id: "timed", creatorID: "owner", calendarID: personal.id, title: "Review", due: new Date(2026, 8, 25, 14, 30) });
  control(render(task), "due time").onPress();
  expect(picker(render(task)).is24Hour).toBe(timeFormat === "24h");
});

it("locks the open picker while saving, like the other task controls", () => {
  h.save.mockReturnValue(new Promise(() => {}));
  control(render(), "Task title").onChangeText("Tickets");
  control(render(), "due date").onPress();
  control(render(), "Create").onPress();
  expect(nodes(render()).some(node => node.type === "DateTimePicker")).toBe(false);
});
