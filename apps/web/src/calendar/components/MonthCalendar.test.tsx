import { cleanup, render, within } from "@testing-library/react";
import type { Event } from "@musubi/types";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MonthCalendar } from "./MonthCalendar";
import { fixtureCalendars, fixtureEvents } from "../fixtures";

// The details surface is not under test here; the chip it wraps is.
vi.mock("./EventDetailsPopover", () => ({ EventDetailsPopover: ({ children }: { children: ReactNode }) => children }));
afterEach(cleanup);

function timed(id: string, start: string, end: string): Event {
  return { ...fixtureEvents[0]!, calendars: ["personal"], end: new Date(end), id, isAllDay: false, originCalendarID: "personal", recurrence: null, start: new Date(start), title: `Multi-day event ${id}` };
}

function renderMonth(events: Event[], anchor = "2026-11-15", weekStartsOn: "monday" | "sunday" = "monday") {
  const props: ComponentProps<typeof MonthCalendar> = { anchor: new Date(`${anchor}T12:00:00`), calendars: fixtureCalendars, events, timeFormat: "24h", weekStartsOn, getEventMaster: event => event, onForkEvent: vi.fn(), onLinkEvent: vi.fn(), onMonthChange: vi.fn(), onNotice: vi.fn(), onRemoveEvent: vi.fn(), onSetAttendance: vi.fn(), onUpdateEvent: vi.fn(), user: { id: "alex", name: "Alex" } };
  return render(<MonthCalendar {...props} />);
}

function chips(view: ReturnType<typeof render>, id: string) {
  return [...view.container.querySelectorAll<HTMLElement>(`[data-event-id="${id}"]`)].map(chip => {
    const cell = chip.closest<HTMLElement>("[data-day-key]")!;
    return {
      after: chip.hasAttribute("data-continues-after"),
      before: chip.hasAttribute("data-continues-before"),
      day: cell.dataset.dayKey,
      time: chip.querySelector("[data-event-time]")?.textContent ?? null,
      title: chip.querySelector("[data-event-title]")?.textContent ?? "",
    };
  });
}

it("draws a timed multi-day event on every day it touches, with its time only on the real start day", () => {
  const view = renderMonth([timed("week", "2026-11-09T10:00:00", "2026-11-15T16:00:00")]);
  expect(chips(view, "week")).toEqual([
    { after: true, before: false, day: "2026-11-09", time: "10:00", title: "Multi-day event week" },
    ...["10", "11", "12", "13", "14"].map(day => ({ after: true, before: true, day: `2026-11-${day}`, time: null, title: "" })),
    { after: false, before: true, day: "2026-11-15", time: null, title: "" },
  ]);
  const range = "Monday, November 9, 2026 – Sunday, November 15, 2026, 10:00 – 16:00";
  for (const chip of view.container.querySelectorAll('[data-event-id="week"]')) {
    expect(chip.getAttribute("aria-label")).toContain(range);
  }
  for (const day of ["09", "12", "15"]) {
    expect(view.container.querySelector(`[data-day-key="2026-11-${day}"]`)?.getAttribute("aria-label")).toMatch(/, 1 calendar item$/);
  }
  expect(view.container.querySelector('[data-day-key="2026-11-16"]')?.getAttribute("aria-label")).toMatch(/, 0 calendar items$/);
});

it("restarts the title without a time where a span wraps into the next row", () => {
  const view = renderMonth([timed("week", "2026-11-09T10:00:00", "2026-11-15T16:00:00")], "2026-11-15", "sunday");
  const placed = chips(view, "week");
  expect(placed.map(chip => chip.day)).toEqual(["09", "10", "11", "12", "13", "14", "15"].map(day => `2026-11-${day}`));
  expect(placed.at(-1)).toEqual({ after: false, before: false, day: "2026-11-15", time: null, title: "Multi-day event week" });
});

it("covers an overnight event's next day but not a day it ends on at midnight", () => {
  const view = renderMonth([
    timed("overnight", "2026-11-10T23:00:00", "2026-11-11T01:00:00"),
    timed("midnight", "2026-11-18T10:00:00", "2026-11-19T00:00:00"),
    timed("instant", "2026-11-20T09:00:00", "2026-11-20T09:00:00"),
  ]);
  expect(chips(view, "overnight").map(({ day, time }) => [day, time])).toEqual([["2026-11-10", "23:00"], ["2026-11-11", null]]);
  expect(chips(view, "midnight").map(({ day, time }) => [day, time])).toEqual([["2026-11-18", "10:00"]]);
  expect(chips(view, "instant").map(({ day, time }) => [day, time])).toEqual([["2026-11-20", "09:00"]]);
});

it("clips a long timed event to the visible grid and folds it into More with the other day items", () => {
  const view = renderMonth([
    timed("season", "2026-09-01T10:00:00", "2026-12-31T16:00:00"),
    ...["a", "b", "c"].map(id => timed(id, "2026-11-12T09:00:00", "2026-11-12T10:00:00")),
  ]);
  // The November grid runs Oct 26 – Dec 6: every one of its 42 cells.
  expect(chips(view, "season")).toHaveLength(42);
  const crowded = view.container.querySelector<HTMLElement>('[data-day-key="2026-11-12"]')!;
  expect(crowded.getAttribute("aria-label")).toMatch(/, 4 calendar items$/);
  expect(within(crowded).getByRole("button", { name: "+2 more" })).toBeTruthy();
});
