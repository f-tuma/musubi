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
    // Multi-line input (EXDATE, …) makes rrulestr return an RRuleSet, which
    // IGNORES the dtstart option — the series would anchor to "now". Embed a
    // DTSTART line instead (also truncates to seconds, so EXDATE stamps match
    // occurrences exactly).
    rule = recurrence.includes('\n') && !/DTSTART/.test(recurrence)
      ? rrulestr(`DTSTART:${toICalUTC(dtstart)}\n${recurrence}`)
      : rrulestr(recurrence, { dtstart })
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
// ── Recurrence editing helpers ───────────────────────────────────────────────
// Stored format: a bare RRULE ("FREQ=DAILY") or, once exceptions exist,
// multi-line iCal ("RRULE:FREQ=DAILY\nEXDATE:20260705T120000Z") — rrulestr
// parses both; multi-line REQUIRES the RRULE: prefix.

const toICalUTC = (d: Date) =>
  d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** Split stored recurrence into the bare RRULE and any extra lines (EXDATE, …). */
export function splitRecurrence(recurrence: string | null | undefined): { rrule: string; extras: string[] } {
  if (!recurrence) return { rrule: '', extras: [] }
  const lines = recurrence.split('\n').map((l) => l.trim()).filter(Boolean)
  const rruleLine = lines.find((l) => /^(RRULE:)?FREQ=/.test(l)) ?? ''
  return {
    rrule: rruleLine.replace(/^RRULE:/, ''),
    extras: lines.filter((l) => l !== rruleLine),
  }
}

/** Rebuild the stored string; multi-line output gets explicit prefixes. */
export function joinRecurrence(rrule: string | null, extras: string[]): string | null {
  if (!rrule) return null
  if (extras.length === 0) return rrule
  return [`RRULE:${rrule}`, ...extras].join('\n')
}

/** "Delete this event": exclude one occurrence via EXDATE. */
export function excludeOccurrence(recurrence: string, occurrenceStart: Date): string {
  const { rrule, extras } = splitRecurrence(recurrence)
  // A new EXDATE line each time — never merged into an existing one, which
  // may carry params (TZID from Google) our UTC stamp must not join.
  return joinRecurrence(rrule, [...extras, `EXDATE:${toICalUTC(occurrenceStart)}`])!
}

/** "Delete this and following": end the series just before this occurrence. */
export function endSeriesBefore(recurrence: string, occurrenceStart: Date): string {
  const { rrule, extras } = splitRecurrence(recurrence)
  const until = toICalUTC(new Date(occurrenceStart.getTime() - 1000))
  // UNTIL and COUNT are mutually exclusive — drop both before adding ours.
  const parts = rrule.split(';').filter((p) => !/^(UNTIL|COUNT)=/.test(p))
  return joinRecurrence([...parts, `UNTIL=${until}`].join(';'), extras)!
}

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
