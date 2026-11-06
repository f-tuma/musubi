import type { Event } from "@musubi/types";
import { describe, expect, it } from "vitest";
import { calendarLaneSpans, visibleLaneLimit } from "./all-day-lanes";

function days(from: string, count = 7) {
  const start = new Date(`${from}T12:00:00`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function allDayEvent(id: string, start: string, end: string): Event {
  return {
    calendars: ["calendar"],
    color: "#365a92",
    creatorID: "user",
    end: new Date(`${end}T00:00:00Z`),
    hasAttendees: false,
    id,
    isAllDay: true,
    isCanceled: false,
    organizer: "user@example.test",
    originCalendarID: "calendar",
    start: new Date(`${start}T00:00:00Z`),
    title: id,
  };
}

function timedEvent(id: string, start: string, end: string): Event {
  return {
    ...allDayEvent(id, start.slice(0, 10), end.slice(0, 10)),
    end: new Date(`${end}:00`),
    isAllDay: false,
    start: new Date(`${start}:00`),
  };
}

describe("calendar lane spans", () => {
  it("reserves the final visible row for +N without compacting lanes", () => {
    expect(visibleLaneLimit(3, 3)).toBe(3);
    expect(visibleLaneLimit(4, 3)).toBe(2);
  });
  it("keeps a long all-day event in one lane while space above is reused", () => {
    const spans = calendarLaneSpans(
      [
        allDayEvent("short", "2026-08-10", "2026-08-11"),
        allDayEvent("long", "2026-08-11", "2026-08-14"),
        allDayEvent("later", "2026-08-12", "2026-08-12"),
      ],
      days("2026-08-10"),
    );
    expect(spans.map((span) => ({ id: span.id, lane: span.lane }))).toEqual([
      { id: "event:short", lane: 0 },
      { id: "event:long", lane: 1 },
      { id: "event:later", lane: 0 },
    ]);
  });

  it.each([
    // [label, start, end, week start, expected visible columns, durationDays]
    ["multi-day timed event", "2026-11-09T10:00", "2026-11-15T16:00", "2026-11-09", [0, 6], 7],
    ["Sunday-first row before", "2026-11-09T10:00", "2026-11-15T16:00", "2026-11-08", [1, 6], 7],
    ["Sunday-first row after", "2026-11-09T10:00", "2026-11-15T16:00", "2026-11-15", [0, 0], 7],
    ["overnight", "2026-08-10T23:00", "2026-08-11T01:00", "2026-08-10", [0, 1], 2],
    ["exclusive midnight end", "2026-08-10T10:00", "2026-08-11T00:00", "2026-08-10", [0, 0], 1],
    ["starts at midnight", "2026-08-11T00:00", "2026-08-11T01:00", "2026-08-10", [1, 1], 1],
    ["zero length", "2026-08-12T09:00", "2026-08-12T09:00", "2026-08-10", [2, 2], 1],
    ["end before start", "2026-08-12T09:00", "2026-08-11T09:00", "2026-08-10", [2, 2], 1],
    ["DST fall back", "2026-10-24T22:00", "2026-10-26T02:00", "2026-10-19", [5, 6], 3],
    ["DST fall back, next row", "2026-10-24T22:00", "2026-10-26T02:00", "2026-10-26", [0, 0], 3],
    ["DST spring forward", "2027-03-27T22:00", "2027-03-28T03:30", "2027-03-22", [5, 6], 2],
    ["clipped at the row start", "2026-10-28T10:00", "2026-11-03T16:00", "2026-10-26", [2, 6], 7],
    ["clipped at the row end", "2026-10-28T10:00", "2026-11-03T16:00", "2026-11-02", [0, 1], 7],
    ["longer than 60 days", "2026-09-01T10:00", "2026-11-30T16:00", "2026-11-23", [0, 6], 91],
  ] as const)("spans a timed event over every local day it touches: %s", (_label, start, end, weekStart, [startCol, endCol], durationDays) => {
    const spans = calendarLaneSpans([timedEvent("timed", start, end)], days(weekStart), true);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ durationDays, endCol, startCol });
  });

  it("gives no span to a timed event outside the row, and none without includeTimed", () => {
    const event = timedEvent("timed", "2026-10-28T10:00", "2026-11-03T16:00");
    expect(calendarLaneSpans([event], days("2026-10-19"), true)).toEqual([]);
    expect(calendarLaneSpans([event], days("2026-10-26"))).toEqual([]);
  });

  it("packs timed spans into stable lanes with all-day bars", () => {
    const week = days("2026-11-09");
    const events = [
      timedEvent("same-day", "2026-11-11T12:00", "2026-11-11T13:00"),
      allDayEvent("retreat", "2026-11-10", "2026-11-12"),
      timedEvent("workshop", "2026-11-09T10:00", "2026-11-15T16:00"),
      // Expanded occurrences keep their own ids and are not deduped.
      timedEvent("series_1", "2026-11-13T22:00", "2026-11-14T02:00"),
      timedEvent("series_2", "2026-11-14T22:00", "2026-11-15T02:00"),
    ];
    const lanes = (spans: ReturnType<typeof calendarLaneSpans>) =>
      Object.fromEntries(spans.map((span) => [span.id, [span.lane, span.startCol, span.endCol]]));
    const expected = {
      "event:retreat": [1, 1, 3],
      "event:same-day": [2, 2, 2],
      "event:series_1": [1, 4, 5],
      "event:series_2": [2, 5, 6],
      "event:workshop": [0, 0, 6],
    };
    expect(lanes(calendarLaneSpans(events, week, true))).toEqual(expected);
    expect(lanes(calendarLaneSpans([...events].reverse(), week, true))).toEqual(expected);
  });

  it("repacks at a week boundary", () => {
    const long = allDayEvent("long", "2026-08-14", "2026-08-18");
    const blocker = allDayEvent("blocker", "2026-08-13", "2026-08-16");
    const firstWeek = calendarLaneSpans([long, blocker], days("2026-08-10"));
    const secondWeek = calendarLaneSpans([long, blocker], days("2026-08-17"));
    expect(firstWeek.find((span) => span.id === "event:long")?.lane).toBe(1);
    expect(secondWeek.find((span) => span.id === "event:long")?.lane).toBe(0);
  });
});
