import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarSchema, EventSchema, TaskSchema, type Event, type Task } from "@musubi/types";
import { civilToInstant } from "@musubi/calendar";
import { buildWidgetSnapshot, serializeWidgetSnapshot, WIDGET_BUDGET, widgetUtf8Bytes } from "./widgetSnapshot";

const calendar = CalendarSchema.parse({
  id: "home", creatorID: "owner", name: "Home", color: "#B3A48A", members: [], role: "owner",
});
const mirror = { ...calendar, id: "mirror", name: "Work", color: "#7A8BA3" };
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function event(value: number, changes: Partial<Event> = {}): Event {
  return { ...EventSchema.parse({
    id: id(value), creatorID: "owner", organizer: "owner", title: `Event ${value}`,
    color: calendar.color, calendars: [calendar.id], isCanceled: false, isAllDay: false,
    start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z",
  }), ...changes };
}
function task(value: number, changes: Partial<Task> = {}): Task {
  return { ...TaskSchema.parse({
    id: id(value), creatorID: "owner", calendarID: calendar.id,
    originCalendarID: calendar.id, calendarIDs: [calendar.id], revision: 1,
    title: `Task ${value}`,
  }), ...changes };
}
type Input = Parameters<typeof buildWidgetSnapshot>[0];
function snapshot(changes: Partial<Input> = {}) {
  return buildWidgetSnapshot({
    scope: "opaque-account", lifecycle: 3, generation: 7, now: new Date("2026-10-05T12:00:00Z"),
    timeZone: "UTC", timeFormat: "24h", weekStartsOn: "monday",
    events: [], calendars: [calendar, mirror], tasks: [],
    eventsReady: true, eventsError: false, eventsLastSyncAt: 123,
    tasksReady: true, tasksState: "ready", tasksLastSyncAt: 456,
    ...changes,
  });
}
afterEach(() => vi.unstubAllEnvs());

describe("covered widget projection", () => {
  it("keeps five historic daily families ready below the stored row cap", () => {
    const result = snapshot({ events: Array.from({ length: 5 }, (_, index) => event(index + 1, {
      isAllDay: index % 2 === 0, recurrence: "FREQ=DAILY",
      start: new Date(index % 2 === 0 ? "2020-01-01T00:00:00Z" : "2020-01-01T10:00:00Z"),
      end: new Date(index % 2 === 0 ? "2020-01-01T00:00:00Z" : "2020-01-01T11:00:00Z"),
      ...(index % 2 === 0 ? { timeModel: { kind: "all-day" as const } } : {}),
    })) });
    expect(result.events).toHaveLength(2130);
    expect(result.events.length).toBeLessThan(WIDGET_BUDGET.events);
    expect(new Set(result.events.map(item => item.id)).size).toBe(5);
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true, truncated: false });
  });

  it("keeps tomorrow after more than 64 early events, including a later native repaint", () => {
    const result = snapshot({ events: [
      ...Array.from({ length: 80 }, (_, index) => event(index + 1)),
      event(100, { title: "Tomorrow", start: new Date("2026-10-06T10:00:00Z"), end: new Date("2026-10-06T11:00:00Z") }),
    ] });
    expect(result.events).toHaveLength(81);
    expect(result.events.filter(item => item.end >= Date.parse("2026-10-06T08:00:00Z"))
      .map(item => item.title)).toEqual(["Tomorrow"]);
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true, truncated: false });
  });

  it("bounds forty years of all-day references while retaining true bar endpoints", () => {
    const result = snapshot({ events: [event(1, {
      isAllDay: true, timeModel: { kind: "all-day" },
      start: new Date("2000-01-01T00:00:00Z"), end: new Date("2040-12-31T00:00:00Z"),
    })] });
    expect(result.events[0]).toMatchObject({ startKey: "2000-01-01", endKey: "2040-12-31" });
    expect(result.calendarDays.length).toBeLessThanOrEqual(WIDGET_BUDGET.days);
    expect(result.calendarDays[0].date).toBe("2026-09-01");
    expect(result.calendarDays.at(-1)?.date).toBe("2027-10-31");
    expect(result.calendarDays.every(day => day.eventKeys.length === 1)).toBe(true);
    expect(result.eventsStatus.complete).toBe(true);
  });

  it("uses the explicit consumer zone and excludes timed midnight after a DST day", () => {
    vi.stubEnv("TZ", "America/New_York");
    const zone = "Europe/Prague";
    const result = snapshot({ timeZone: zone, now: new Date("2026-03-29T12:00:00Z"), events: [event(1, {
      start: civilToInstant("2026-03-29T00:00:00.000", zone, "explicit")!,
      end: civilToInstant("2026-03-30T00:00:00.000", zone, "explicit")!,
    })] });
    expect(result.events[0].end - result.events[0].start).toBe(23 * 60 * 60 * 1000);
    expect(result.events[0]).toMatchObject({ startKey: "2026-03-29", endKey: "2026-03-29" });
    expect(result.calendarDays.map(day => day.date)).toEqual(["2026-03-29"]);
  });

  it("re-expands floating recurrences in the requested zone through DST", () => {
    const definition = event(1, {
      start: new Date("2026-03-28T09:00:00Z"), end: new Date("2026-03-28T10:00:00Z"),
      timeModel: { kind: "floating", startLocal: "2026-03-28T09:00:00.000", endLocal: "2026-03-28T10:00:00.000" },
      recurrence: "FREQ=DAILY;COUNT=3",
    });
    const result = snapshot({ timeZone: "Europe/Prague", now: new Date("2026-03-28T00:00:00Z"), events: [definition] });
    expect(result.events.map(item => new Date(item.start).toISOString())).toEqual([
      "2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z", "2026-03-30T07:00:00.000Z",
    ]);
    expect(new Set(result.events.map(item => item.key)).size).toBe(3);
    expect(result.events.every(item => item.id === definition.id)).toBe(true);
  });

  it("expands legacy timed wall clocks and EXDATE in an explicit zone across DST", () => {
    vi.stubEnv("TZ", "UTC");
    const result = snapshot({ timeZone: "Europe/Prague", now: new Date("2026-03-28T00:00:00Z"),
      events: [event(1, {
        start: new Date("2026-03-28T08:00:00Z"), end: new Date("2026-03-28T09:00:00Z"),
        recurrence: "RRULE:FREQ=DAILY;COUNT=3\nEXDATE:20260330T070000Z",
      })] });
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true });
    expect(result.events.map(item => new Date(item.start).toISOString())).toEqual([
      "2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z",
    ]);
    expect(result.events.map(item => item.startKey)).toEqual(["2026-03-28", "2026-03-29"]);
  });

  it("gives simultaneous events distinct stable keys without replacing canonical IDs", () => {
    const events = [event(1), event(2), event(3, { isAllDay: true,
      start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-05T00:00:00Z") }),
    event(4, { isAllDay: true,
      start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-05T00:00:00Z") })];
    const result = snapshot({ events });
    expect(new Set(result.events.map(item => item.key)).size).toBe(4);
    expect(new Set(result.events.map(item => item.id))).toEqual(new Set(events.map(item => item.id)));
    expect(snapshot({ events: [...events].reverse() }).events.map(item => item.key))
      .toEqual(result.events.map(item => item.key));
  });

  it("applies cancellation exceptions before filtering display rows", () => {
    const series = event(1, { isAllDay: true, timeModel: { kind: "all-day" },
      start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-05T00:00:00Z"),
      recurrence: "FREQ=DAILY;COUNT=3" });
    const cancelled = event(2, { isAllDay: true, timeModel: { kind: "all-day" },
      seriesID: series.id, originalStart: { kind: "date", value: "2026-10-06" },
      start: new Date("2026-10-06T00:00:00Z"), end: new Date("2026-10-06T00:00:00Z"), isCanceled: true });
    expect(snapshot({ events: [series, cancelled] }).events.map(item => item.startKey).sort())
      .toEqual(["2026-10-05", "2026-10-07"]);
    expect(snapshot({ events: [{ ...series, isCanceled: true }, { ...cancelled, isCanceled: false }] }).events)
      .toEqual([]);
  });

  it("keeps a moved unreadable exception's replacement effect without exposing its content", () => {
    const series = event(1, { isAllDay: true, timeModel: { kind: "all-day" },
      start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-05T00:00:00Z"),
      recurrence: "FREQ=DAILY;COUNT=3" });
    const moved = event(2, { isAllDay: true, timeModel: { kind: "all-day" },
      seriesID: series.id, originalStart: { kind: "date", value: "2026-10-06" },
      start: new Date("2026-10-20T00:00:00Z"), end: new Date("2026-10-20T00:00:00Z"),
      calendars: ["removed-calendar"], title: "PRIVATE MOVED TITLE" });
    const result = snapshot({ events: [series, moved] });
    expect(result.events.map(item => item.startKey).sort()).toEqual(["2026-10-05", "2026-10-07"]);
    expect(serializeWidgetSnapshot(result)).not.toContain("PRIVATE MOVED TITLE");
  });

  it("projects only display fields and readable memberships", () => {
    const hidden = task(2, { title: "No membership", calendarIDs: ["removed-calendar"] });
    const result = snapshot({
      events: [event(1, { description: "PRIVATE DESCRIPTION", organizer: "PRIVATE EMAIL", url: "PRIVATE URL" }),
        event(2, { title: "Private calendar", calendars: ["removed-calendar"] })],
      tasks: [task(1, { description: "PRIVATE TASK DESCRIPTION", url: "PRIVATE TASK URL" }), hidden],
    });
    expect(result.events.map(item => item.title)).toEqual(["Event 1"]);
    expect(result.tasks.map(item => item.id)).toEqual([id(1)]);
    const serialized = serializeWidgetSnapshot(result);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("No membership");
  });

  it("uses the first readable calendar's appearance when origin and earlier membership are unreadable", () => {
    const result = snapshot({ calendars: [mirror], events: [event(1, {
      originCalendarID: "removed-origin", calendars: ["removed-first", mirror.id],
      color: "#PRIVATE", title: "Readable mirrored event",
    })] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      color: mirror.color, calendarName: mirror.name, calendarIds: [mirror.id],
    });
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true });
  });

  it("publishes membership removal even if an unrelated unreadable family is malformed", () => {
    const result = snapshot({ calendars: [], events: [event(1, { recurrence: "FREQ=INVALID" })] });
    expect(result.events).toEqual([]);
    expect(result.calendarDays).toEqual([]);
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true, preservePrevious: false });
  });

  it("does not let an unreadable malformed or dense family fail a readable independent event", () => {
    for (const recurrence of ["FREQ=INVALID", "FREQ=SECONDLY"]) {
      const result = snapshot({ events: [event(1), event(2, { calendars: ["removed-calendar"], recurrence,
        start: new Date("1990-01-01T10:00:00Z"), end: new Date("1990-01-01T11:00:00Z") })] });
      expect(result.events.map(item => item.id)).toEqual([id(1)]);
      expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true, preservePrevious: false });
    }
  });
});

describe("canonical task projection", () => {
  it("deduplicates mirrors by revision/retirement and keeps deliberate forks distinct", () => {
    const latest = task(1, { revision: 4, providerReadRetiredGeneration: 7,
      calendarIDs: [calendar.id, mirror.id], title: "Canonical latest" });
    const result = snapshot({ tasks: [latest,
      { ...latest, revision: 3, title: "Older revision" },
      { ...latest, providerReadRetiredGeneration: 6, title: "Retired read" },
      { ...latest, id: id(2) },
      task(3, { status: "completed" }), task(4, { status: "cancelled" })] });
    expect(result.tasks.map(item => item.id)).toEqual([id(1), id(2)]);
    expect(result.tasks.every(item => item.title === "Canonical latest")).toBe(true);
    expect(result.tasks[0].calendarIds).toEqual([calendar.id, mirror.id]);
  });

  it("opens both synthetic markers through the canonical task ID", () => {
    const canonical = task(1, { start: new Date("2026-10-05T10:00:00Z"), due: new Date("2026-10-06T10:00:00Z") });
    const result = snapshot({ tasks: [canonical] });
    expect(result.events).toHaveLength(2);
    expect(result.events.every(item => item.id === canonical.id && item.taskId === canonical.id)).toBe(true);
    expect(new Set(result.events.map(item => item.key)).size).toBe(2);
    expect(result.events.map(item => item.key).every(key => key.startsWith(`calendar-task:${canonical.id}:`))).toBe(true);
  });

  it("places timed deadline markers on the consumer date rather than the machine date", () => {
    vi.stubEnv("TZ", "Europe/Prague");
    const result = snapshot({ timeZone: "America/Los_Angeles", tasks: [task(1, {
      due: new Date("2026-10-06T00:30:00Z"), isAllDay: false,
    })] });
    expect(result.events[0]).toMatchObject({ allDay: true, startKey: "2026-10-05", endKey: "2026-10-05", taskId: id(1) });
    expect(result.calendarDays.map(day => day.date)).toEqual(["2026-10-05"]);
  });
});

describe("budgets and unavailable sections", () => {
  it("marks the event cap incomplete while prioritizing future over old rows", () => {
    const result = snapshot({ events: [
      event(1, { title: "Old", start: new Date("2026-09-01T10:00:00Z"), end: new Date("2026-09-01T11:00:00Z") }),
      ...Array.from({ length: WIDGET_BUDGET.events }, (_, index) => event(index + 2, {
        start: new Date("2026-10-06T10:00:00Z"), end: new Date("2026-10-06T11:00:00Z"),
      })),
    ] });
    expect(result.events).toHaveLength(WIDGET_BUDGET.events);
    expect(result.events.some(item => item.title === "Old")).toBe(false);
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: false, truncated: true });
  });

  it("caps long-span references and never leaves an unresolved day reference", () => {
    const result = snapshot({ events: Array.from({ length: 90 }, (_, index) => event(index + 1, {
      isAllDay: true, timeModel: { kind: "all-day" },
      start: new Date("2000-01-01T00:00:00Z"), end: new Date("2040-12-31T00:00:00Z"),
    })) });
    expect(result.calendarDays.reduce((total, day) => total + day.eventKeys.length, 0))
      .toBeLessThanOrEqual(WIDGET_BUDGET.references);
    expect(result.eventsStatus).toMatchObject({ complete: false, truncated: true });
    const keys = new Set(result.events.map(item => item.key));
    expect(result.calendarDays.every(day => day.eventKeys.every(key => keys.has(key)))).toBe(true);
  });

  it("marks the task cap independently of an authoritative empty event section", () => {
    const result = snapshot({ tasks: Array.from({ length: WIDGET_BUDGET.tasks + 1 }, (_, index) => task(index + 1)) });
    expect(result.tasks).toHaveLength(WIDGET_BUDGET.tasks);
    expect(result.tasksStatus).toMatchObject({ state: "ready", complete: false, truncated: true });
    expect(result.eventsStatus).toMatchObject({ state: "ready", complete: true, truncated: false });
  });

  it("bounds UTF-8 bytes and removes day references for byte-trimmed events", () => {
    const result = snapshot({ events: Array.from({ length: 1500 }, (_, index) => event(index + 1, { title: "漢".repeat(256) })) });
    const serialized = serializeWidgetSnapshot(result);
    expect(widgetUtf8Bytes(serialized)).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(widgetUtf8Bytes(serialized)).toBeLessThanOrEqual(WIDGET_BUDGET.bytes);
    expect(result.events.length).toBeLessThan(1500);
    expect(result.eventsStatus).toMatchObject({ complete: false, truncated: true });
    const kept = new Set(result.events.map(item => item.key));
    expect(result.calendarDays.every(day => day.eventKeys.every(key => kept.has(key)))).toBe(true);
  });

  it("bounds task-only UTF-8 data and marks only its task section incomplete", () => {
    const result = snapshot({ tasks: Array.from({ length: 1500 }, (_, index) => task(index + 1, { title: "漢".repeat(256) })) });
    const serialized = serializeWidgetSnapshot(result);
    expect(widgetUtf8Bytes(serialized)).toBeLessThanOrEqual(WIDGET_BUDGET.bytes);
    expect(result.tasks.length).toBeLessThan(1500);
    expect(result.tasksStatus).toMatchObject({ complete: false, truncated: true });
    expect(result.eventsStatus.complete).toBe(true);
  });

  it("counts surrogate pairs and unpaired surrogates like a native UTF-8 encoder", () => {
    for (const text of ["", "ASCII", "漢字", "🗓️", "\ud800", "A\udfffZ"]) {
      expect(widgetUtf8Bytes(text)).toBe(Buffer.byteLength(text, "utf8"));
    }
  });

  it("retains event data independently of a failed task section", () => {
    const result = snapshot({ events: [event(1)], tasks: [], tasksReady: false, tasksState: "error" });
    expect(result.events).toHaveLength(1);
    expect(result.eventsStatus.complete).toBe(true);
    expect(result.tasksStatus).toMatchObject({ state: "error", complete: false });
  });

  it("preserves unloaded scoped cache but purges explicitly unavailable tasks", () => {
    const cold = snapshot({ eventsReady: false, tasksReady: false, tasksState: "loading" });
    expect(cold.eventsStatus).toMatchObject({ state: "loading", complete: false, preservePrevious: true });
    expect(cold.tasksStatus).toMatchObject({ state: "loading", complete: false, preservePrevious: true });
    const denied = snapshot({ tasksReady: false, tasksState: "unavailable", events: [event(1)] });
    expect(denied.tasksStatus).toMatchObject({ state: "unavailable", complete: false, preservePrevious: false });
    expect(denied.tasks).toEqual([]);
    expect(denied.events).toHaveLength(1);
  });

  it("marks failed expansion as an error rather than a successful empty calendar", () => {
    const result = snapshot({ events: [event(1, { recurrence: "FREQ=INVALID" })] });
    expect(result.eventsStatus).toMatchObject({ state: "error", complete: false });
    expect(result.events).toEqual([]);
  });

  it("marks old dense recurrence budget exhaustion as incomplete instead of empty success", () => {
    const result = snapshot({ events: [event(1, {
      start: new Date("1990-01-01T10:00:00Z"), end: new Date("1990-01-01T11:00:00Z"),
      recurrence: `FREQ=DAILY;BYHOUR=${Array.from({ length: 24 }, (_, hour) => hour).join(",")};BYMINUTE=0,30`,
    })] });
    expect(result.eventsStatus).toMatchObject({ state: "error", complete: false, truncated: true });
  });

  it("marks unsupported subdaily recurrence as a projection error rather than an empty success", () => {
    const result = snapshot({ events: [event(1, { recurrence: "FREQ=HOURLY;BYHOUR=25" })] });
    expect(result.events).toEqual([]);
    expect(result.eventsStatus).toMatchObject({ state: "error", complete: false, preservePrevious: true });
  });

  it("rejects malformed legacy event dates without claiming an authoritative empty result", () => {
    const result = snapshot({ events: [event(1, { start: new Date(NaN), end: new Date(NaN) })] });
    expect(result.eventsStatus).toMatchObject({ state: "error", complete: false });
  });

  it("rejects malformed task dates independently of valid events", () => {
    const result = snapshot({ events: [event(1)], tasks: [task(1, { due: new Date(NaN) })] });
    expect(result.tasksStatus).toMatchObject({ state: "error", complete: false });
    expect(result.events).toHaveLength(1);
    expect(result.eventsStatus.complete).toBe(true);
  });
});
