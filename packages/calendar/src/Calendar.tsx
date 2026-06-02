import React, { useMemo } from 'react';
import { Calendar as BigCalendar } from 'react-native-big-calendar';
import type { CalendarProps, ICalendarEventBase, Mode } from 'react-native-big-calendar';
import dayjs from 'dayjs';
import { expandRecurringEvents } from './recurrence';

export type RecurringCalendarEvent = ICalendarEventBase & {
  id?: string;
  recurrence?: string | null;
};

/**
 * Return a date window that fully covers the visible range for the given mode,
 * padded generously so that recurring events whose original start is just outside
 * the view still produce occurrences inside it.
 */
function getViewRange(mode: Mode = 'month', date: Date = new Date()): [Date, Date] {
  const d = dayjs(date);
  switch (mode) {
    case 'day':
      return [
        d.subtract(1, 'day').startOf('day').toDate(),
        d.add(2, 'day').endOf('day').toDate(),
      ];
    case '3days':
    case 'week':
      return [
        d.subtract(1, 'week').startOf('day').toDate(),
        d.add(2, 'week').endOf('day').toDate(),
      ];
    case 'schedule':
    case 'month':
    default:
      return [
        d.subtract(1, 'month').startOf('month').toDate(),
        d.add(2, 'month').endOf('month').toDate(),
      ];
  }
}

/**
 * Pre-compute a 'YYYY-MM-DD' → events lookup so BigCalendar's per-cell render
 * does an O(1) map lookup instead of filtering the full event array every time.
 * Multi-day events are added to every day's bucket they span.
 */
function buildEnrichedEvents<T extends ICalendarEventBase>(
  events: T[],
): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const event of events) {
    let cursor = dayjs(event.start).startOf('day');
    const endDay = dayjs(event.end).startOf('day');
    while (!cursor.isAfter(endDay)) {
      const key = cursor.format('YYYY-MM-DD');
      (map[key] ??= []).push(event);
      cursor = cursor.add(1, 'day');
    }
  }
  return map;
}

export function Calendar<T extends RecurringCalendarEvent>({
  events,
  date,
  mode,
  ...props
}: CalendarProps<T>) {
  const [rangeStart, rangeEnd] = useMemo(
    () => getViewRange(mode, date),
    [mode, date],
  );

  const expandedEvents = useMemo(
    () => expandRecurringEvents(events, rangeStart, rangeEnd),
    [events, rangeStart, rangeEnd],
  );

  const enrichedEventsByDate = useMemo(
    () => buildEnrichedEvents(expandedEvents),
    [expandedEvents],
  );

  return (
    <BigCalendar
      {...props}
      mode={mode}
      date={date}
      events={expandedEvents}
      enrichedEventsByDate={enrichedEventsByDate}
      enableEnrichedEvents={true}
    />
  );
}
