import { EventExpansionError, expandKnownTimeEvents } from "./time-expansion"
export { EventExpansionError } from "./time-expansion"
import { RRuleSet, rrulestr } from 'rrule'
import type { ICalendarEventBase } from './interfaces'
import { joinRecurrence, splitRecurrence } from './rrule-editor'
import { civilToInstant, instantToCivil } from './time-zone'
import { validateBoundedLegacyRule } from './recurrence-validation'

export { joinRecurrence, splitRecurrence } from './rrule-editor'

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

/**
 * "This and following": the rule the split-off series carries.
 *
 * UNTIL is an absolute date, so it survives a split untouched. COUNT does not —
 * both halves would otherwise claim the full count — so it is reduced by the
 * occurrences the original half keeps.
 */
export function remainderRule(
  recurrence: string,
  seriesStart: Date,
  occurrenceStart: Date,
): string {
  const { rrule, extras } = splitRecurrence(recurrence)
  const count = /COUNT=(\d+)/.exec(rrule)
  if (!count) return joinRecurrence(rrule, extras)!

  const kept = getRule(recurrence, seriesStart).between(
    seriesStart,
    new Date(occurrenceStart.getTime() - 1000),
    true /* inclusive */,
  ).length
  const remaining = Math.max(1, Number(count[1]) - kept)
  return joinRecurrence(rrule.replace(/COUNT=\d+/, `COUNT=${remaining}`), extras)!
}

// ── Wall-clock recurrence (the floating frame) ────────────────────────────────
// "Every weekday at 09:00" means 09:00 on both sides of a daylight-saving
// change — RFC 5545 evaluates a rule in the event's local time, and Google
// Calendar behaves that way. `rrule` does its arithmetic on the UTC fields of a
// Date, so expanding a stored instant directly keeps the *instant* of day and
// moves the clock: a 09:00 event became 10:00 the moment Europe sprang forward.
//
// So the anchor, the window and the rule's own stamps are shifted into a frame
// where the local wall clock IS the UTC field rrule iterates on, and each
// occurrence is shifted back into a real instant afterwards. The shift is
// per-Date, so occurrences on either side of the change come back at the same
// wall clock with different offsets — which is the whole point.
//
// Legacy records use the consumer's explicit zone when provided, otherwise
// the machine's local zone. Two people in different zones anchor a series differently
// after a change that only one of their zones makes. Fixing that needs a
// timezone on the event, not a different frame here.
function toFloating(date: Date, zone?: string): Date {
  if (zone) return new Date(`${instantToCivil(date, zone)}Z`)
  return new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ),
  )
}

function fromFloating(date: Date, zone?: string): Date {
  if (zone) return civilToInstant(date.toISOString().slice(0, -1), zone, "explicit")!
  // A wall clock that does not exist (02:30 on a spring-forward day) lands on
  // the next real minute, which is what a calendar should do with it.
  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  )
}

/**
 * The same rule with its absolute stamps read as wall clock.
 *
 * UNTIL and EXDATE are written in UTC (`toICalUTC`), so inside the floating
 * frame they would sit an offset away from the occurrences they are meant to
 * bound or cancel — a deleted occurrence would quietly come back after a DST
 * change. Stamps carrying a TZID are left alone: they are already somebody's
 * wall clock, and rrule reads them the same way this frame does.
 */
function floatingRecurrence(recurrence: string, zone?: string): string {
  const shift = (stamp: string) => toICalUTC(toFloating(new Date(fromICalUTC(stamp)), zone))

  return recurrence
    .split('\n')
    .map((line) =>
      /^(EXDATE|RDATE)/i.test(line) && !/TZID=/i.test(line)
        ? line.replace(/\d{8}T\d{6}Z/g, shift)
        : line.replace(/UNTIL=(\d{8}T\d{6}Z)/i, (_, stamp: string) => `UNTIL=${shift(stamp)}`),
    )
    .join('\n')
}

const fromICalUTC = (stamp: string) =>
  `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`

export function expandRecurringEvents<T extends ICalendarEventBase>(
  events: T[],
  rangeStart: Date,
  rangeEnd: Date,
  options: {
    consumerTimeZone?: string
    /** Agenda keeps standalone/detached events beyond the finite RRULE window. */
    includeAllNonRecurring?: boolean
    /** Optional budgets for persisted/background projections. Count candidates
     * before the requested window too, so an old dense series cannot block it. */
    maxCandidates?: number
    maxOccurrences?: number
    strict?: boolean
  } = {},
): T[] {
  const known = events.filter(event => event.seriesID || event.originalStart || (event.timeModel && event.timeModel.kind !== "legacy-unknown"))
  const knownSet = new Set(known)
  const definitions = new Map(events.map(event => [event.id, event]))
  for (const event of known) {
    const parent = event.seriesID ? definitions.get(event.seriesID) : undefined
    if (parent && !knownSet.has(parent))
      throw new EventExpansionError(event.id, "legacy-exception-parent-unresolved")
  }
  for (const limit of [options.maxCandidates, options.maxOccurrences]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new RangeError("Invalid recurrence budget")
  }
  const candidateBudget = options.maxCandidates === undefined ? undefined : { remaining: options.maxCandidates }
  const result: T[] = expandKnownTimeEvents(known, rangeStart, rangeEnd, options.consumerTimeZone, options.includeAllNonRecurring, options.maxCandidates, options.maxOccurrences, candidateBudget)
  const append = (event: T) => {
    if (result.length >= (options.maxOccurrences ?? Infinity))
      throw new EventExpansionError(event.id, "occurrence-budget-exceeded")
    result.push(event)
  }

  for (const event of events) {
    if (knownSet.has(event)) continue
    if (options.strict && (!Number.isFinite(event.start.getTime())
      || !Number.isFinite(event.end.getTime()) || event.end < event.start))
      throw new EventExpansionError(event.id, "invalid-legacy-event-time")
    if (!event.recurrence) {
      // Keep only if it overlaps the window — an event years away shouldn't
      // flow through filter/enrich on every swipe. Overlap (not start-in-range)
      // so multi-day events spanning into the window from before it survive.
      if (options.includeAllNonRecurring || (event.end >= rangeStart && event.start <= rangeEnd)) append(event)
      continue
    }

    try {
      if (options.maxCandidates !== undefined && event.recurrence.length > 16_384)
        throw new EventExpansionError(event.id, "recurrence-too-large")
      if (options.maxCandidates !== undefined)
        validateBoundedLegacyRule(event.recurrence, reason => {
          throw new EventExpansionError(event.id, reason)
        })
      const duration = event.end.getTime() - event.start.getTime()
      // All-day events are already timezone-invariant DATEs pinned to UTC
      // midnight (see `eventDay`), so they expand in the frame they are stored
      // in. Timed events are wall-clock and expand in the floating frame.
      const floating = !event.isAllDay
      const anchor = floating ? toFloating(event.start, options.consumerTimeZone) : event.start
      // rrulestr handles both "RRULE:FREQ=..." and bare "FREQ=..." formats.
      // Passing dtstart anchors the series to the event's own start so the
      // recurrence doesn't drift when the rrule string has no DTSTART line.
      const rule = getRule(
        floating ? floatingRecurrence(event.recurrence, options.consumerTimeZone) : event.recurrence,
        anchor,
      )
      // Search back by one occurrence duration so an event that starts before
      // the window but overlaps its leading edge is not lost.
      const searchStart = new Date(rangeStart.getTime() - Math.max(0, duration))
      const from = floating ? toFloating(searchStart, options.consumerTimeZone) : searchStart
      const to = floating ? toFloating(rangeEnd, options.consumerTimeZone) : rangeEnd
      let examined = 0
      const chargeCandidate = () => {
        if (++examined > options.maxCandidates! || --candidateBudget!.remaining < 0)
          throw new EventExpansionError(event.id, "recurrence-budget-exceeded")
      }
      const preflight = (part: ParsedRule): void => {
        if (part instanceof RRuleSet) {
          for (const _date of [...part.rdates(), ...part.exdates()]) chargeCandidate()
          for (const child of [...part.rrules(), ...part.exrules()]) preflight(child)
        } else {
          part.all(candidate => {
            chargeCandidate()
            return candidate <= to
          })
        }
      }
      const occurrences = options.maxCandidates === undefined
        ? rule.between(from, to, true /* inclusive */)
        : rule instanceof RRuleSet
          // A set's callback runs AFTER exclusions, so an excluded dense rule
          // may never reach it. Bound each positive/exclusion rule first, then
          // evaluate the set within the finite window with its usual semantics.
          ? (preflight(rule), rule.between(from, to, true /* inclusive */))
          : rule.all((candidate) => {
            chargeCandidate()
            return candidate <= to
          }).filter(candidate => candidate >= from)

      for (const occurrence of occurrences) {
        const start = floating ? fromFloating(occurrence, options.consumerTimeZone) : occurrence
        const end = new Date(start.getTime() + duration)
        if (end < rangeStart) continue
        append({
          ...event,
          id: `${event.id ?? 'r'}_${start.getTime()}`,
          start,
          end,
        })
      }
    } catch (error) {
      if (error instanceof EventExpansionError) throw error
      if (options.strict) throw new EventExpansionError(event.id, "invalid-legacy-recurrence")
      // Malformed rrule — fall back to treating the event as non-recurring.
      append(event)
    }
  }

  return result
}
