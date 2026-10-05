import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CachedEvent } from "./eventsCache";
import * as projector from "./widgetSnapshot";

const fixture = vi.hoisted(() => ({
  events: [] as CachedEvent[], lifecycle: 0,
  calendars: [{ id: "calendar", name: "Home", color: "#c8553d" }],
  snapshot: vi.fn(async (_snapshot: string) => true),
  begin: vi.fn(async (_scope: string) => 1), clear: vi.fn(async () => {}),
  foreground: undefined as undefined | ((state: string) => void),
  listeners: new Set<(state: { events: CachedEvent[] }, previous: { events: CachedEvent[] }) => void>(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: {
  currentState: "active", addEventListener: (_event: string, listener: (state: string) => void) => {
    fixture.foreground = listener; return { remove: () => { fixture.foreground = undefined; } };
  },
} }));
vi.mock("@/modules/musubi-agenda-widget", () => ({ default: {
  updateSnapshot: fixture.snapshot, beginSession: fixture.begin, clearSnapshot: fixture.clear,
} }));
vi.mock("@/store/useEventsStore", () => ({
  getEventLifecycle: () => fixture.lifecycle,
  useEventsStore: {
    getState: () => ({ events: fixture.events }),
    subscribe: (listener: (state: { events: CachedEvent[] }, previous: { events: CachedEvent[] }) => void) => {
      fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
    },
  },
}));
vi.mock("@/store/useCalendarsStore", () => ({ useCalendarsStore: {
  getState: () => ({ calendars: fixture.calendars }),
  subscribe: () => () => {},
} }));
vi.mock("@/store/useSettingsStore", () => ({ useSettingsStore: {
  getState: () => ({ timeFormat: "24h", weekStartsOn: "monday" }), subscribe: () => () => {},
} }));
const { startAgendaWidgetSync, clearAgendaWidget } = await import("./agendaWidget");
const { resetWidgetData, widgetCalendarsLoaded, widgetEventsLoaded, widgetEventsFailed } = await import("@/store/useWidgetDataStore");
const { useTasksStore, emptyTaskCollection } = await import("@/store/useTasksStore");
let stop = () => {};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  fixture.events = []; fixture.lifecycle = 0;
  fixture.snapshot.mockReset().mockResolvedValue(true);
  fixture.begin.mockReset().mockResolvedValue(1); fixture.clear.mockClear(); resetWidgetData();
  useTasksStore.setState({ ...emptyTaskCollection });
});
afterEach(async () => { stop(); await clearAgendaWidget(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const start = async () => { stop = startAgendaWidgetSync("account"); await vi.advanceTimersByTimeAsync(120); };
function event(id: string, start = new Date("2026-09-08T00:00:00Z"), end = start): CachedEvent {
  return { id, creatorID: "owner", organizer: "owner", title: id, color: "red", calendars: ["calendar"],
    isCanceled: false, hasAttendees: false, isAllDay: true, start, end };
}

it.each(["UTC", "Europe/Prague", "America/New_York"])("keeps inclusive all-day dates and exclusive timed midnight in %s", async timezone => {
  vi.stubEnv("TZ", timezone);
  fixture.events = [event("today"), event("span", new Date("2026-09-07T00:00:00Z"), new Date("2026-09-08T00:00:00Z")),
    { ...event("timed", new Date(2026, 8, 9, 23), new Date(2026, 8, 10)), isAllDay: false }];
  widgetEventsLoaded(Date.now()); await start();
  expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  const snapshot = JSON.parse(fixture.snapshot.mock.calls[0][0]);
  expect(snapshot.version).toBe(2); expect(snapshot.scope).toBe("account");
  const events = new Map<string, { id: string; endKey: string }>(snapshot.events.map((item: { key: string }) => [item.key, item]));
  const days = new Map<string, string[]>(snapshot.calendarDays.map((day: { date: string; eventKeys: string[] }) => [day.date, day.eventKeys]));
  for (const day of ["2026-09-07", "2026-09-08"])
    expect(days.get(day)?.some(key => events.get(key)?.id === "span" && events.get(key)?.endKey === "2026-09-08")).toBe(true);
  expect(days.get("2026-09-09")?.some(key => events.get(key)?.id === "timed")).toBe(true);
  expect(days.get("2026-09-10")?.some(key => events.get(key)?.id === "timed") ?? false).toBe(false);
});

it("does not replace the last widget with empty data when hydration failed", async () => {
  widgetEventsFailed(); await start();
  expect(fixture.begin).toHaveBeenCalledWith("account"); expect(fixture.snapshot).not.toHaveBeenCalled();
  widgetEventsLoaded(Date.now()); await vi.advanceTimersByTimeAsync(120);
  expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fixture.snapshot.mock.calls[0][0]).eventsStatus).toMatchObject({ state: "ready", complete: true });
});

it("waits for known calendar membership before publishing cached tasks independently", async () => {
  widgetEventsFailed();
  useTasksStore.setState({ scope: "account", ready: true, status: "cached", tasks: [] });
  await start();
  expect(fixture.snapshot).not.toHaveBeenCalled();
  widgetCalendarsLoaded(); await vi.advanceTimersByTimeAsync(120);
  const snapshot = JSON.parse(fixture.snapshot.mock.calls[0][0]);
  expect(snapshot.readableCalendarIds).toEqual(["calendar"]);
  expect(snapshot.eventsStatus).toMatchObject({ state: "error", preservePrevious: true });
  expect(snapshot.tasksStatus).toMatchObject({ state: "ready", preservePrevious: false });
});

it("publishes an authorization barrier even when calendar hydration is unavailable", async () => {
  widgetEventsFailed();
  useTasksStore.setState({ scope: "account", ready: false, status: "unauthorized", tasks: [] });
  await start();
  const snapshot = JSON.parse(fixture.snapshot.mock.calls[0][0]);
  expect(snapshot.readableCalendarIds).toEqual([]);
  expect(snapshot.tasksStatus).toMatchObject({ state: "unavailable", preservePrevious: false });
});

it("skips identical foreground redraws but rebuckets after a timezone change", async () => {
  vi.stubEnv("TZ", "Europe/Prague"); fixture.events = [{ ...event("timed", new Date("2026-09-08T00:30:00Z")), isAllDay: false }];
  widgetEventsLoaded(Date.now()); await start();
  fixture.foreground?.("active"); await vi.advanceTimersByTimeAsync(120);
  expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  vi.stubEnv("TZ", "America/New_York"); await vi.advanceTimersByTimeAsync(60_120);
  expect(fixture.snapshot).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fixture.snapshot.mock.calls[1][0]).events[0].startKey).toBe("2026-09-07");
});

it("reuses expanded rows for a new sync timestamp and identical foreground data", async () => {
  const build = vi.spyOn(projector, "buildWidgetSnapshot");
  fixture.events = [event("cached")]; widgetEventsLoaded(Date.now()); await start();
  fixture.foreground?.("active"); await vi.advanceTimersByTimeAsync(120);
  expect(build).toHaveBeenCalledTimes(1);
  widgetEventsLoaded(Date.now()); await vi.advanceTimersByTimeAsync(120);
  expect(build).toHaveBeenCalledTimes(1);
  expect(fixture.snapshot).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fixture.snapshot.mock.calls[1][0]).eventsStatus.lastSyncAt).toBe(Date.now() - 120);
  fixture.events = [event("changed")]; fixture.foreground?.("active"); await vi.advanceTimersByTimeAsync(120);
  expect(build).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fixture.snapshot.mock.calls[2][0]).events[0].title).toBe("changed");
});

it("serializes a pending write before clear and rejects stopped-session updates", async () => {
  let release!: (accepted: boolean) => void;
  fixture.snapshot.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
  fixture.events = [event("old")]; widgetEventsLoaded(Date.now()); await start();
  const cleared = clearAgendaWidget();
  expect(fixture.clear).not.toHaveBeenCalled();
  fixture.events = [event("late")]; fixture.foreground?.("active");
  release(true); await cleared; await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.clear).toHaveBeenCalledTimes(1); expect(fixture.snapshot).toHaveBeenCalledTimes(1);
  widgetEventsLoaded(Date.now()); stop = startAgendaWidgetSync("new-account"); await vi.advanceTimersByTimeAsync(120);
  expect(JSON.parse(fixture.snapshot.mock.calls[1][0]).scope).toBe("new-account");
});

it("cannot publish an old lifecycle after account reset", async () => {
  widgetEventsLoaded(Date.now()); stop = startAgendaWidgetSync("account"); fixture.lifecycle++;
  await vi.advanceTimersByTimeAsync(120);
  expect(fixture.snapshot).not.toHaveBeenCalled();
});
