import { rrulestr } from 'rrule'
import type { ICalendarEventBase } from './interfaces'

/**
 * Expand events that carry an RRULE string into individual occurrences within
 * [rangeStart, rangeEnd]. Non-recurring events pass through unchanged.
 *
 * Occurrence ids are synthetic: "<originalId>_<startTimestamp>" — stable across
 * renders for the same occurrence so React list keys don't thrash.
 *
 * Example RRULE strings:
 *   "FREQ=WEEKLY;BYDAY=MO,WE,FR"
 *   "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=12"
 *   "FREQ=DAILY;INTERVAL=2;UNTIL=20251231T000000Z"
 */
export function expandRecurringEvents<T extends ICalendarEventBase>(
  events: T[],
  rangeStart: Date,
  rangeEnd: Date,
): T[] {
  const result: T[] = []

  for (const event of events) {
    if (!event.recurrence) {
      result.push(event)
      continue
    }

    try {
      const duration = event.end.getTime() - event.start.getTime()
      // rrulestr handles both "RRULE:FREQ=..." and bare "FREQ=..." formats.
      // Passing dtstart anchors the series to the event's own start so the
      // recurrence doesn't drift when the rrule string has no DTSTART line.
      const rule = rrulestr(event.recurrence, { dtstart: event.start })
      const occurrences = rule.between(rangeStart, rangeEnd, true /* inclusive */)

      for (const start of occurrences) {
        result.push({
          ...event,
          id: `${event.id ?? 'r'}_${start.getTime()}`,
          start,
          end: new Date(start.getTime() + duration),
        })
      }
    } catch {
      // Malformed rrule — fall back to treating the event as non-recurring.
      result.push(event)
    }
  }

  return result
}
