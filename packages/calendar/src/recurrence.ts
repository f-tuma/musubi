import { rrulestr } from 'rrule'
import type { ICalendarEventBase } from './interfaces'

// Parsing an RRULE string is the expensive part of expansion, and expansion
// re-runs on every calendar swipe. Cache parsed rules so each unique
// (rrule, dtstart) pair is parsed once. Rules are immutable → reuse is safe.
// ponytail: unbounded Map, but keyed by distinct recurring events, so bounded
// in practice. Add an LRU only if a session edits thousands of distinct rules.
type ParsedRule = ReturnType<typeof rrulestr>
const ruleCache = new Map<string, ParsedRule>()

function getRule(recurrence: string, dtstart: Date): ParsedRule {
  const key = `${recurrence}@${dtstart.getTime()}`
  let rule = ruleCache.get(key)
  if (!rule) {
    rule = rrulestr(recurrence, { dtstart })
    ruleCache.set(key, rule)
  }
  return rule
}

/**
 * Expand events that carry an RRULE string into individual occurrences within
 * [rangeStart, rangeEnd]. Non-recurring events are kept only when they overlap
 * the range.
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
      // Keep only if it overlaps the window — an event years away shouldn't
      // flow through filter/enrich on every swipe. Overlap (not start-in-range)
      // so multi-day events spanning into the window from before it survive.
      if (event.end >= rangeStart && event.start <= rangeEnd) result.push(event)
      continue
    }

    try {
      const duration = event.end.getTime() - event.start.getTime()
      // rrulestr handles both "RRULE:FREQ=..." and bare "FREQ=..." formats.
      // Passing dtstart anchors the series to the event's own start so the
      // recurrence doesn't drift when the rrule string has no DTSTART line.
      const rule = getRule(event.recurrence, event.start)
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
