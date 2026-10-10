import { RRule } from "rrule";
import {
  CivilDateTimeSchema,
  EventTimeModelSchema,
  OccurrenceStartSchema,
  occurrenceKey,
  type OccurrenceIdentity,
  type OccurrenceStart,
} from "@musubi/types";
import type { ICalendarEventBase } from "./interfaces";
import { civilToInstant, instantToCivil } from "./time-zone";
import { recurrenceNumericRanges } from "./recurrence-validation";

export class EventExpansionError extends Error {
  constructor(
    readonly eventId: string | undefined,
    readonly reason: string,
  ) {
    super(`Cannot expand event: ${reason}`);
    this.name = "EventExpansionError";
  }
}
const DAY = 86_400_000;
const MAX_CANDIDATES = 50_000;
const pseudo = (civil: string) => new Date(`${civil}Z`);
const civilOf = (date: Date) => date.toISOString().slice(0, -1);
const keyOf = (id: string, originalStart: OccurrenceStart) =>
  occurrenceKey({ seriesId: id, originalStart });

/** Internal known-model path. No implicit machine timezone or legacy inference. */
export function expandKnownTimeEvents<T extends ICalendarEventBase>(
  events: T[],
  from: Date,
  to: Date,
  consumerTimeZone?: string,
  includeAllNonRecurring = false,
  maxCandidates = MAX_CANDIDATES,
  maxOccurrences = Infinity,
  candidateBudget?: { remaining: number },
): T[] {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    to < from
  )
    throw new RangeError("Invalid expansion window");
  const result: T[] = [];
  const append = (event: T) => {
    if (result.length >= maxOccurrences)
      throw new EventExpansionError(event.id, "occurrence-budget-exceeded");
    result.push(event);
  };
  const exceptions = new Map<string, T>();
  const used = new Set<string>();
  const byId = new Map<string, T>();
  const fail = (event: T, reason: string): never => {
    throw new EventExpansionError(event.id, reason);
  };
  const overlaps = (start: Date, end: Date, allDay = false) =>
    allDay
      ? end.toISOString().slice(0, 10) >=
          instantToCivil(from, consumerTimeZone ?? "UTC").slice(0, 10) &&
        start.toISOString().slice(0, 10) <=
          instantToCivil(to, consumerTimeZone ?? "UTC").slice(0, 10)
      : end >= from && start <= to;
  for (const event of events) {
    if (!event.id || byId.has(event.id))
      fail(event, "missing-or-duplicate-definition-id");
    byId.set(event.id!, event);
    if (
      !!event.seriesID !== !!event.originalStart ||
      event.seriesID === event.id
    )
      fail(event, "invalid-occurrence-relationship");
    if (event.seriesID) {
      const key = keyOf(event.seriesID, event.originalStart!);
      if (exceptions.has(key)) fail(event, "duplicate-occurrence-identity");
      if (event.recurrence) fail(event, "nested-recurring-exception");
      exceptions.set(key, event);
    }
  }
  function frame(event: T) {
    const parsed = EventTimeModelSchema.parse(event.timeModel);
    if (parsed.kind === "legacy-unknown")
      return fail(event, "legacy-time-unresolved");
    if (
      !Number.isFinite(event.start.getTime()) ||
      !Number.isFinite(event.end.getTime()) ||
      event.end < event.start
    )
      fail(event, "invalid-event-range");
    if ((parsed.kind === "all-day") !== !!event.isAllDay)
      fail(event, "inconsistent-all-day-model");
    const zone = parsed.kind === "zoned" ? parsed.timeZone : consumerTimeZone;
    if (parsed.kind === "floating" && !zone)
      fail(event, "floating-consumer-zone-required");
    const localStart =
      parsed.kind === "all-day" ? civilOf(event.start) : parsed.startLocal;
    const localEnd =
      parsed.kind === "all-day" ? civilOf(event.end) : parsed.endLocal;
    if (
      parsed.kind === "all-day" &&
      (!localStart.endsWith("T00:00:00.000") ||
        !localEnd.endsWith("T00:00:00.000"))
    )
      fail(event, "all-day-must-use-dates");
    if (parsed.kind === "zoned") {
      for (const [date, civil] of [
        [event.start, localStart],
        [event.end, localEnd],
      ] as const) {
        if (
          instantToCivil(date, zone!) !== civil &&
          civilToInstant(civil, zone!, "explicit")?.getTime() !== date.getTime()
        )
          fail(event, "inconsistent-zoned-endpoint");
      }
    }
    const point = (civil: string, source: "explicit" | "recurrence") =>
      parsed.kind === "all-day"
        ? pseudo(civil)
        : civilToInstant(civil, zone!, source);
    const start =
      parsed.kind === "floating" ? point(localStart, "explicit")! : event.start;
    const end =
      parsed.kind === "floating" ? point(localEnd, "explicit")! : event.end;
    if (end < start) fail(event, "resolved-end-before-start");
    const duration =
      parsed.kind === "floating"
        ? pseudo(localEnd).getTime() - pseudo(localStart).getTime()
        : end.getTime() - start.getTime();
    const original = (civil: string, date: Date): OccurrenceStart =>
      parsed.kind === "zoned"
        ? { kind: "instant", value: date.toISOString() }
        : parsed.kind === "floating"
          ? { kind: "floating", value: civil }
          : { kind: "date", value: civil.slice(0, 10) };
    const endAt = (civil: string, date: Date) =>
      parsed.kind === "floating"
        ? point(
            civilOf(new Date(pseudo(civil).getTime() + duration)),
            "explicit",
          )!
        : new Date(date.getTime() + duration);
    return {
      model: parsed,
      zone,
      localStart,
      start,
      end,
      duration,
      point,
      original,
      endAt,
    };
  }
  function detached(event: T) {
    const parent = byId.get(event.seriesID!);
    if (parent?.seriesID) fail(event, "nested-exception-relationship");
    if (parent && !parent.recurrence)
      fail(event, "exception-parent-not-recurring");
    if (parent) {
      const pf = frame(parent);
      if (
        event.originalStart!.kind !== pf.original(pf.localStart, pf.start).kind
      )
        fail(event, "exception-time-kind-mismatch");
    }
    if (event.isCanceled || parent?.isCanceled) return;
    // A detached timed definition may have exact instants without evidence of
    // its current civil zone (for example a moved native Graph exception).
    // Keep that uncertainty; never borrow the parent's zone or expand a legacy
    // master. The explicit original instant still replaces its original slot.
    const model = EventTimeModelSchema.parse(event.timeModel);
    if (model.kind === "legacy-unknown") {
      if (event.isAllDay !== false || event.originalStart!.kind !== "instant")
        fail(event, "legacy-exception-time-kind-unresolved");
      if (!Number.isFinite(event.start.getTime()) ||
          !Number.isFinite(event.end.getTime()) || event.end < event.start)
        fail(event, "invalid-event-range");
      if (includeAllNonRecurring || overlaps(event.start, event.end))
        append({
          ...event,
          occurrenceIdentity: {
            seriesId: event.seriesID!,
            originalStart: OccurrenceStartSchema.parse(event.originalStart),
          },
        });
      return;
    }
    const f = frame(event);
    if (
      includeAllNonRecurring ||
      overlaps(f.start, f.end, f.model.kind === "all-day")
    )
      append({
        ...event,
        start: f.start,
        end: f.end,
        occurrenceIdentity: {
          seriesId: event.seriesID!,
          originalStart: OccurrenceStartSchema.parse(event.originalStart),
        },
      });
  }
  for (const event of events) {
    if (event.seriesID || event.isCanceled) continue;
    const f = frame(event);
    if (!event.recurrence) {
      if (
        includeAllNonRecurring ||
        overlaps(f.start, f.end, f.model.kind === "all-day")
      )
        append({ ...event, start: f.start, end: f.end });
      continue;
    }
    if (event.recurrence.length > 16_384) fail(event, "recurrence-too-large");
    const primary = f.original(f.localStart, f.start);
    const excluded = new Set<string>();
    const additions: {
      start: Date;
      civil: string;
      original: OccurrenceStart;
    }[] = [];
    let ruleText: string | undefined;
    let hasDtstart = false;
    function stamp(value: string, params = new Map<string, string>()) {
      value = value.toUpperCase();
      const tzid = params.get("TZID");
      const valueType = params.get("VALUE");
      if (valueType && !["DATE", "DATE-TIME"].includes(valueType))
        fail(event, "unsupported-recurrence-value");
      if (/^\d{8}$/.test(value)) {
        if (f.model.kind !== "all-day" || tzid || valueType === "DATE-TIME")
          fail(event, "recurrence-value-kind-mismatch");
        const original = OccurrenceStartSchema.parse({
          kind: "date",
          value: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
        });
        const civil = `${original.value}T00:00:00.000`;
        return { start: pseudo(civil), civil, original };
      }
      if (!/^\d{8}T\d{6}Z?$/.test(value) || valueType === "DATE")
        fail(event, "invalid-recurrence-timestamp");
      const civil = CivilDateTimeSchema.parse(
        `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`,
      );
      if (value.endsWith("Z")) {
        if (tzid || f.model.kind !== "zoned")
          fail(event, "recurrence-value-kind-mismatch");
        const start = pseudo(civil);
        return {
          start,
          civil: instantToCivil(start, f.zone!),
          original: f.original(civil, start),
        };
      }
      if (
        f.model.kind === "all-day" ||
        (f.model.kind === "zoned" && !tzid) ||
        (f.model.kind === "floating" && tzid)
      )
        fail(event, "recurrence-value-kind-mismatch");
      const start = civilToInstant(civil, tzid ?? f.zone!, "explicit")!;
      return {
        start,
        civil:
          f.model.kind === "zoned" ? instantToCivil(start, f.zone!) : civil,
        original: f.original(civil, start),
      };
    }
    for (const raw of event.recurrence
      .replace(/\r?\n[ \t]/g, "")
      .split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^FREQ=/i.test(line)) {
        if (ruleText) fail(event, "multiple-recurrence-rules");
        ruleText = line.toUpperCase();
        continue;
      }
      const match = /^([A-Z]+)((?:;[^:]+)*):(.*)$/i.exec(line);
      if (!match) fail(event, "invalid-recurrence-line");
      const [, rawName, parameters, values] = match!;
      const name = rawName.toUpperCase();
      if (name === "RRULE") {
        if (ruleText || parameters)
          fail(event, "multiple-or-parameterized-rule");
        ruleText = values.toUpperCase();
        continue;
      }
      if (!["DTSTART", "RDATE", "EXDATE"].includes(name))
        fail(event, "unsupported-recurrence-property");
      const params = new Map<string, string>();
      for (const p of parameters.split(";").filter(Boolean)) {
        const pair = p.split("=");
        pair[0] = pair[0].toUpperCase();
        if (
          pair.length !== 2 ||
          !pair[1] ||
          !["TZID", "VALUE"].includes(pair[0]) ||
          params.has(pair[0])
        )
          fail(event, "invalid-recurrence-parameter");
        params.set(
          pair[0],
          pair[0] === "VALUE"
            ? pair[1].toUpperCase()
            : pair[1].replace(/^"|"$/g, ""),
        );
      }
      for (const value of values.split(",")) {
        const parsed = stamp(value, params);
        const key = keyOf(event.id!, parsed.original);
        if (name === "RDATE") additions.push(parsed);
        else if (name === "EXDATE") excluded.add(key);
        else {
          if (hasDtstart || key !== keyOf(event.id!, primary))
            fail(event, "dtstart-model-mismatch");
          if (f.model.kind === "zoned") {
            if (
              value.toUpperCase().endsWith("Z")
                ? !["UTC", "Etc/UTC", "Etc/GMT", "GMT"].includes(f.zone!)
                : params.get("TZID") !== f.zone
            )
              fail(event, "dtstart-zone-mismatch");
          }
          hasDtstart = true;
        }
      }
    }
    const emitted = new Set<string>();
    function emit(start: Date, civil: string, original: OccurrenceStart) {
      const key = keyOf(event.id!, original);
      if (emitted.has(key)) return;
      emitted.add(key);
      const exception = exceptions.get(key);
      if (exception) {
        used.add(key);
        detached(exception);
        return;
      }
      if (excluded.has(key)) return;
      const end = f.endAt(civil, start);
      if (end < start) fail(event, "resolved-end-before-start");
      const stable =
        original.kind === "instant"
          ? start.getTime()
          : original.kind === "date"
            ? Date.parse(`${original.value}T00:00:00Z`)
            : pseudo(original.value).getTime();
      const occurrenceIdentity: OccurrenceIdentity = {
        seriesId: event.id!,
        originalStart: original,
      };
      if (overlaps(start, end, f.model.kind === "all-day"))
        append({
          ...event,
          id: `${event.id}_${stable}`,
          start,
          end,
          occurrenceIdentity,
          timeModel:
            f.model.kind === "all-day"
              ? f.model
              : {
                  ...f.model,
                  startLocal: civil,
                  endLocal:
                    f.model.kind === "floating"
                      ? civilOf(new Date(pseudo(civil).getTime() + f.duration))
                      : key === keyOf(event.id!, primary)
                        ? f.model.endLocal
                        : instantToCivil(end, f.zone!),
                },
        });
    }
    emit(f.start, f.localStart, primary);
    if (ruleText) {
      const fields = ruleText.split(";").map((part) => part.split("="));
      if (
        fields.some((pair) => pair.length !== 2 || !pair[1]) ||
        new Set(fields.map((pair) => pair[0])).size !== fields.length
      )
        fail(event, "invalid-recurrence-fields");
      const supported = new Set([
        "FREQ",
        "INTERVAL",
        "COUNT",
        "UNTIL",
        "WKST",
        "BYDAY",
        "BYMONTH",
        "BYMONTHDAY",
        "BYYEARDAY",
        "BYWEEKNO",
        "BYSETPOS",
        "BYHOUR",
        "BYMINUTE",
        "BYSECOND",
      ]);
      for (const [name, value] of fields) {
        if (!supported.has(name)) fail(event, "unsupported-recurrence-field");
        const range = recurrenceNumericRanges[name];
        if (
          range &&
          new Set(value.split(",").map(Number)).size !== value.split(",").length
        )
          fail(event, "duplicate-recurrence-field-value");

        if (
          range &&
          value
            .split(",")
            .some(
              (item) =>
                !/^[+-]?\d+$/.test(item) ||
                Number(item) < range[0] ||
                Number(item) > range[1] ||
                (range[2] && Number(item) === 0),
            )
        )
          fail(event, "invalid-recurrence-field-value");
        if (["COUNT", "INTERVAL"].includes(name) && !/^\d+$/.test(value))
          fail(event, "invalid-recurrence-field-value");
        if (name === "WKST" && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(value))
          fail(event, "invalid-recurrence-field-value");
        if (
          name === "BYDAY" &&
          value.split(",").some((item) => {
            const match = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
            return (
              !match ||
              (match[1] !== undefined &&
                (Number(match[1]) === 0 || Math.abs(Number(match[1])) > 53))
            );
          })
        )
          fail(event, "invalid-recurrence-field-value");
      }
      const timesPerDay = ["BYHOUR", "BYMINUTE", "BYSECOND"].reduce(
        (product, name) =>
          product *
          (fields.find(([key]) => key === name)?.[1].split(",").length ?? 1),
        1,
      );
      if (timesPerDay > 1_000) fail(event, "recurrence-density-exceeded");
      let parsed: ReturnType<typeof RRule.parseString>;
      try {
        parsed = RRule.parseString(ruleText);
      } catch {
        return fail(event, "invalid-recurrence-rule");
      }
      if (
        parsed.freq === undefined ||
        parsed.freq > RRule.DAILY ||
        parsed.freq < RRule.YEARLY
      )
        fail(event, "subdaily-recurrence-not-supported");
      if (
        parsed.interval != null &&
        (!Number.isSafeInteger(parsed.interval) || parsed.interval < 1)
      )
        fail(event, "invalid-recurrence-interval");
      const names = new Set(fields.map(([name]) => name));
      const byDay = fields.find(([name]) => name === "BYDAY")?.[1];
      if (
        (names.has("BYWEEKNO") && parsed.freq !== RRule.YEARLY) ||
        (names.has("BYYEARDAY") && parsed.freq !== RRule.YEARLY) ||
        (names.has("BYMONTHDAY") && parsed.freq === RRule.WEEKLY) ||
        (byDay &&
          /[0-9]/.test(byDay) &&
          (parsed.freq! > RRule.MONTHLY || names.has("BYWEEKNO"))) ||
        (names.has("BYSETPOS") &&
          ![...names].some(
            (name) => name.startsWith("BY") && name !== "BYSETPOS",
          )) ||
        (f.model.kind === "all-day" &&
          ["BYHOUR", "BYMINUTE", "BYSECOND"].some((name) => names.has(name)))
      )
        fail(event, "invalid-recurrence-combination");
      const count = parsed.count;
      if (
        count != null &&
        (!Number.isSafeInteger(count) || count < 1 || parsed.until)
      )
        fail(event, "invalid-recurrence-count");
      const untilText = fields.find((pair) => pair[0] === "UNTIL")?.[1];
      const until = untilText ? stamp(untilText) : undefined;
      if (until && primary.value > until.original.value)
        fail(event, "until-before-start");
      const anchor = pseudo(f.localStart);
      const millis = anchor.getUTCMilliseconds();
      const secondAnchor = new Date(anchor.getTime() - millis);
      const rule = new RRule(
        { ...parsed, dtstart: secondAnchor, count: null, until: null },
        true,
      );
      // DTSTART membership depends only on the first frequency period, not
      // INTERVAL. Jump beyond rrule's supported year range after that period
      // so impossible filters cannot scan thousands of years in this probe.
      const probe = new RRule(
        {
          ...parsed,
          dtstart: secondAnchor,
          count: null,
          until: null,
          interval: [10_000, 120_000, 530_000, 3_660_000][parsed.freq!],
        },
        true,
      );
      if (probe.after(secondAnchor, true)?.getTime() !== secondAnchor.getTime())
        fail(event, "dtstart-rule-mismatch");
      let valid = 1;
      let examined = 0;
      // Offset magnitudes are <24h. Padding bounds the search; Temporal still
      // resolves each candidate exactly (including non-hour transitions).
      const lookback = f.duration + (f.model.kind === "floating" ? 2 * DAY : 0);
      const lower =
        count != null
          ? secondAnchor
          : new Date(from.getTime() - lookback - DAY);
      const upper = new Date(
        Math.min(
          to.getTime() + DAY,
          until ? pseudo(until.civil).getTime() + DAY : Infinity,
        ),
      );
      // Count candidates before the visible window too: rrule otherwise
      // filters them internally before our callback and bypasses the budget.
      rule.between(secondAnchor, upper, true, (date) => {
        if (++examined > maxCandidates || (candidateBudget && --candidateBudget.remaining < 0))
          fail(event, "recurrence-budget-exceeded");
        if (date.getTime() === secondAnchor.getTime()) return true;
        if (count != null && valid >= count) return false;
        if (count == null && date < lower) return true;
        const civil = civilOf(new Date(date.getTime() + millis));
        const start = f.point(civil, "recurrence");
        if (!start) return true;
        const original = f.original(civil, start);
        if (until && original.value > until.original.value) return false;
        valid++;
        emit(start, civil, original);
        return true;
      });
    }
    for (const addition of additions)
      emit(addition.start, addition.civil, addition.original);
  }
  for (const [key, event] of exceptions) if (!used.has(key)) detached(event);
  return result.sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0),
  );
}
