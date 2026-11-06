import type { Event } from "@musubi/types";
import {
  addMonthPages,
  getMonthGrid,
  segmentEventsByDay,
} from "@musubi/calendar/layout";
import { describe, expect, it } from "vitest";
import {
  getEventDateLabel,
  getEventRangeLabel,
  getMonthLabel,
  parseDateKey,
} from "./calendar-math";
import { toDateKey } from "./date-key";

function allDayEvent(start: string, end: string): Event {
  return {
    calendars: ["studio"],
    color: "#7a8ba3",
    creatorID: "alex",
    description: null,
    end: new Date(end),
    hasAttendees: false,
    id: "multi-day",
    isAllDay: true,
    isCanceled: false,
    location: null,
    organizer: "alex@example.com",
    originCalendarID: "studio",
    recurrence: null,
    start: new Date(start),
    title: "Studio retreat",
    url: null,
  };
}

describe("calendar month math", () => {
  it("builds a six-week Monday-first grid", () => {
    const grid = getMonthGrid(parseDateKey("2026-07-26"), "monday");

    expect(grid).toHaveLength(42);
    expect(toDateKey(grid[0]!)).toBe("2026-06-29");
    expect(toDateKey(grid[41]!)).toBe("2026-08-09");
  });

  it("honors a Sunday-first calendar preference", () => {
    const grid = getMonthGrid(parseDateKey("2026-07-26"), "sunday");

    expect(toDateKey(grid[0]!)).toBe("2026-06-28");
    expect(toDateKey(grid[41]!)).toBe("2026-08-08");
  });

  it("moves between calendar months without day overflow", () => {
    expect(toDateKey(addMonthPages(parseDateKey("2026-07-31"), 1))).toBe(
      "2026-08-01",
    );
  });

  it("formats the visible month for the toolbar", () => {
    expect(getMonthLabel(parseDateKey("2026-07-26"))).toBe("July 2026");
  });

  it("expands UTC-midnight all-day ranges with an inclusive end date", () => {
    const buckets = segmentEventsByDay(
      [
        allDayEvent(
          "2026-07-17T00:00:00Z",
          "2026-07-21T00:00:00Z",
        ),
      ],
      parseDateKey("2026-07-01"),
      parseDateKey("2026-08-01"),
    );

    expect([...buckets.keys()]).toEqual([
      "2026-07-17",
      "2026-07-18",
      "2026-07-19",
      "2026-07-20",
      "2026-07-21",
    ]);
    expect(buckets.get("2026-07-17")?.[0]).toMatchObject({
      continuesAfter: true,
      continuesBefore: false,
    });
    expect(buckets.get("2026-07-19")?.[0]).toMatchObject({
      continuesAfter: true,
      continuesBefore: true,
    });
    expect(buckets.get("2026-07-21")?.[0]).toMatchObject({
      continuesAfter: false,
      continuesBefore: true,
    });
  });

  it("keeps an inclusive one-day all-day event on its date only", () => {
    const buckets = segmentEventsByDay([
      allDayEvent("2026-07-03T00:00:00Z", "2026-07-03T00:00:00Z"),
    ]);

    expect([...buckets.keys()]).toEqual(["2026-07-03"]);
  });
});

describe("event date labels", () => {
  const timed = (start: string, end: string): Event => ({
    ...allDayEvent(start, end),
    end: new Date(end),
    isAllDay: false,
    start: new Date(start),
    title: "Multi-day event",
  });

  it.each([
    ["a multi-day timed event", "2026-11-09T10:00:00", "2026-11-15T16:00:00", "Monday, November 9, 2026 – Sunday, November 15, 2026"],
    ["an overnight event", "2026-08-10T23:00:00", "2026-08-11T01:00:00", "Monday, August 10, 2026 – Tuesday, August 11, 2026"],
    ["an end at next midnight", "2026-08-10T10:00:00", "2026-08-11T00:00:00", "Monday, August 10, 2026 – Tuesday, August 11, 2026"],
    ["a same-day event", "2026-08-10T10:00:00", "2026-08-10T11:00:00", "Monday, August 10, 2026"],
    ["a zero-length event", "2026-08-10T10:00:00", "2026-08-10T10:00:00", "Monday, August 10, 2026"],
    ["an end before its start", "2026-08-10T10:00:00", "2026-08-09T10:00:00", "Monday, August 10, 2026"],
  ])("names the real local start and end dates of %s", (_label, start, end, expected) => {
    expect(getEventDateLabel(timed(start, end))).toBe(expected);
  });

  it("keeps all-day labels and the time range unchanged", () => {
    expect(getEventDateLabel(allDayEvent("2026-07-17T00:00:00Z", "2026-07-21T00:00:00Z"))).toBe(
      "Friday, July 17, 2026 – Tuesday, July 21, 2026",
    );
    expect(getEventDateLabel(allDayEvent("2026-07-03T00:00:00Z", "2026-07-03T00:00:00Z"))).toBe(
      "Friday, July 3, 2026",
    );
    expect(getEventRangeLabel(timed("2026-11-09T10:00:00", "2026-11-15T16:00:00"))).toBe("10:00 – 16:00");
  });
});
