import type { Event } from "@musubi/types";
import { assignSpanLanes, eventDayKeys } from "@musubi/calendar/layout";
import { toDateKey } from "./date-key";

export type CalendarLaneSpan = {
  durationDays: number;
  endCol: number;
  event: Event;
  id: string;
  kind: "event";
  lane: number;
  startCol: number;
};

function visibleRange(keys: string[], columns: Map<string, number>) {
  const visible = keys
    .map((key) => columns.get(key))
    .filter((column): column is number => column !== undefined);
  return visible.length
    ? { endCol: Math.max(...visible), startCol: Math.min(...visible) }
    : undefined;
}

export function visibleLaneLimit(laneCount: number, capacity: number) {
  return laneCount > capacity ? Math.max(0, capacity - 1) : capacity;
}

/** Stable interval lanes for one visible week. */
export function calendarLaneSpans(
  events: Event[],
  days: Date[],
  includeTimed = false,
): CalendarLaneSpan[] {
  const columns = new Map(days.map((day, index) => [toDateKey(day), index]));
  const spans: CalendarLaneSpan[] = [];
  const seenEvents = new Set<string>();

  for (const event of events) {
    if ((!event.isAllDay && !includeTimed) || seenEvents.has(event.id))
      continue;
    seenEvents.add(event.id);
    // Timed events cover every local day they touch, end exclusive, the way
    // the time grid and the multi-week blocks draw them.
    const keys = eventDayKeys(event, 3660);
    const range = visibleRange(keys, columns);
    if (!range) continue;
    spans.push({
      ...range,
      durationDays: keys.length,
      event,
      id: `event:${event.id}`,
      kind: "event",
      lane: 0,
    });
  }

  return assignSpanLanes(spans, (left, right) => {
    const duration = right.durationDays - left.durationDays;
    if (duration) return duration;
    return left.id.localeCompare(right.id);
  });
}
