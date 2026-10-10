import { expect, it } from "vitest";
import { resolveEventTimeEdit } from "@musubi/calendar";
import { EventSchema } from "@musubi/types";
import { resolveWidgetEventLink } from "./widgetEventLink";

const id = "00000000-0000-4000-8000-000000000001";
const childId = "00000000-0000-4000-8000-000000000002";
const readable = new Set(["home"]);
const master = EventSchema.parse({
  id, creatorID: "owner", organizer: "owner", title: "Daily meeting", calendars: ["home"], color: "red", isCanceled: false,
  recurrence: "FREQ=DAILY;COUNT=4", revision: 2,
  ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague",
    startLocal: "2026-03-28T09:00:00.000", endLocal: "2026-03-28T10:00:00.000" }),
});
const later = Date.parse("2026-03-30T07:00:00.000Z");
const moved = EventSchema.parse({
  ...master, id: childId, seriesID: id, recurrence: null, revision: 3,
  originalStart: { kind: "instant", value: "2026-03-30T07:00:00.000Z" },
  ...resolveEventTimeEdit({ kind: "zoned", timeZone: "Europe/Prague",
    startLocal: "2026-03-31T14:00:00.000", endLocal: "2026-03-31T16:00:00.000" }),
});
const resolve = (events = [master], sourceId = id, start = String(later)) =>
  resolveWidgetEventLink(events, readable, sourceId, start, "America/New_York");

it("opens the linked canonical occurrence with its civil time across DST", () => {
  const selected = resolve()!;
  expect(selected.start.toISOString()).toBe("2026-03-30T07:00:00.000Z");
  expect(selected.end.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  expect(selected.occurrenceIdentity).toEqual({ seriesId: id, originalStart: { kind: "instant", value: selected.start.toISOString() } });
  expect(selected.timeModel).toMatchObject({ kind: "zoned", timeZone: "Europe/Prague", startLocal: "2026-03-30T09:00:00.000" });
});

it("resolves an old synthetic link through the same authoritative family", () => {
  expect(resolve([master], `${id}_${later}`)?.start.getTime()).toBe(later);
});

it("resolves a legacy recurrence without borrowing the master's initial date", () => {
  const legacy = { ...master, timeModel: null, start: new Date("2026-03-28T09:00:00Z"), end: new Date("2026-03-28T10:00:00Z") };
  const selected = resolveWidgetEventLink([legacy], readable, id, String(Date.parse("2026-03-30T09:00:00Z")), "UTC")!;
  expect(selected.start.toISOString()).toBe("2026-03-30T09:00:00.000Z");
  expect(selected.id).toBe(`${id}_${selected.start.getTime()}`);
});

it("resolves a long-running daily series while retaining the candidate bound", () => {
  const longRunning = EventSchema.parse({ ...master, recurrence: "FREQ=DAILY",
    ...resolveEventTimeEdit({ kind: "zoned", timeZone: "UTC",
      startLocal: "1990-01-01T09:00:00.000", endLocal: "1990-01-01T10:00:00.000" }),
  });
  const stamp = Date.parse("2026-10-05T09:00:00Z");
  const selected = resolveWidgetEventLink([longRunning], readable, id, String(stamp), "UTC")!;
  expect(selected.start.getTime()).toBe(stamp);
  expect(selected.occurrenceIdentity?.originalStart.value).toBe("2026-10-05T09:00:00.000Z");
});

it.each([childId, id])("opens the actual moved exception linked by %s", sourceId => {
  const selected = resolve([master, moved], sourceId, String(moved.start.getTime()))!;
  expect(selected.id).toBe(childId);
  expect(selected.start).toEqual(moved.start);
  expect(selected.end).toEqual(moved.end);
  expect(selected.originalStart).toEqual(moved.originalStart);
  expect(selected.occurrenceIdentity).toEqual({ seriesId: id, originalStart: moved.originalStart });
  expect(resolve([master, moved])).toBeUndefined();
});

it("does not reopen a cancelled occurrence or its master's original slot", () => {
  const cancelled = { ...moved, isCanceled: true };
  expect(resolve([master, cancelled])).toBeUndefined();
  expect(resolve([master, cancelled], childId, String(moved.start.getTime()))).toBeUndefined();
});

it("does not resurrect an unreadable moved exception before filtering membership", () => {
  const privateException = { ...moved, calendars: ["removed"] };
  expect(resolve([master, privateException])).toBeUndefined();
  expect(resolve([master, privateException], childId, String(moved.start.getTime()))).toBeUndefined();
  expect(resolve([{ ...master, calendars: ["removed"] }])).toBeUndefined();
});

it("rejects missing, stale or malformed links instead of fabricating an event", () => {
  expect(resolve([], id)).toBeUndefined();
  expect(resolve([master], "missing")).toBeUndefined();
  for (const stamp of ["", "invalid", "Infinity", "9007199254740991", String(later + 60000)])
    expect(resolve([master], id, stamp)).toBeUndefined();
});

it("keeps direct standalone links available without an occurrence timestamp", () => {
  const standalone = { ...master, recurrence: null };
  expect(resolveWidgetEventLink([standalone], readable, id, undefined, "UTC")).toBe(standalone);
  expect(resolveWidgetEventLink([{ ...standalone, isCanceled: true }], readable, id, undefined, "UTC")).toBeUndefined();
});
