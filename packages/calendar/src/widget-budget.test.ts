import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { ICalendarEventBase } from "./interfaces";
import { EventExpansionError, expandRecurringEvents } from "./recurrence";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function event(value: number, changes: Partial<ICalendarEventBase> = {}): ICalendarEventBase {
  return { id: id(value), title: `Event ${value}`, isAllDay: true,
    start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z"), ...changes };
}
const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-10-10T23:59:59Z");
const options = { consumerTimeZone: "UTC", maxCandidates: 5, maxOccurrences: 20, strict: true };
const budgetExceeded = (error: unknown) =>
  error instanceof EventExpansionError && error.reason === "recurrence-budget-exceeded";

// RRuleSet's result callback runs after exclusions. Candidate work must remain
// bounded even when the set delivers no result to that callback.
assert.throws(() => expandRecurringEvents([event(1, {
  recurrence: "RRULE:FREQ=DAILY;COUNT=20\nEXRULE:FREQ=DAILY;COUNT=20",
})], from, to, options), budgetExceeded,
"Excluded positive-rule candidates consume the budget before set filtering");
assert.throws(() => expandRecurringEvents([event(1, {
  recurrence: "RRULE:FREQ=DAILY;COUNT=1\nEXRULE:FREQ=DAILY;COUNT=20",
})], from, to, options), budgetExceeded,
"Dense exclusion rules consume candidate work independently of positive results");
assert.throws(() => expandRecurringEvents([event(1, {
  recurrence: "RRULE:FREQ=DAILY;COUNT=3\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=3",
})], from, to, options), budgetExceeded,
"Each positive rule consumes shared work before overlapping results are deduplicated");
assert.throws(() => expandRecurringEvents([event(1, {
  recurrence: "RDATE:20261001T000000Z,20261002T000000Z,20261003T000000Z,20261004T000000Z,20261005T000000Z,20261006T000000Z\nEXDATE:20261001T000000Z,20261002T000000Z,20261003T000000Z,20261004T000000Z,20261005T000000Z,20261006T000000Z",
})], from, to, options), budgetExceeded,
"Explicit inclusion and exclusion dates consume work even when all results are excluded");

const included = expandRecurringEvents([event(1, {
  recurrence: "RRULE:FREQ=DAILY;COUNT=5\nEXRULE:FREQ=DAILY;INTERVAL=2;COUNT=3\nRDATE:20261008T000000Z,20261020T000000Z\nEXDATE:20261002T000000Z",
})], from, to, { ...options, maxCandidates: 20 });
assert.deepEqual(included.map(item => item.start.toISOString()), [
  "2026-10-04T00:00:00.000Z", "2026-10-08T00:00:00.000Z",
], "A bounded set preserves normal EXRULE/EXDATE/RDATE filtering and window clipping");
assert.deepEqual(expandRecurringEvents([event(1, {
  recurrence: "RRULE:FREQ=DAILY;COUNT=3\nEXRULE:FREQ=DAILY;COUNT=3",
})], from, to, { ...options, maxCandidates: 20 }), [],
"A sufficiently budgeted fully excluded finite set remains a successful empty expansion");
assert.throws(() => expandRecurringEvents([event(1, {
  recurrence: `FREQ=DAILY${" ".repeat(16_384)}`,
})], from, to, options), (error: unknown) =>
  error instanceof EventExpansionError && error.reason === "recurrence-too-large",
"Bounded legacy expansion limits recurrence text before parsing it");

// Run the pathological unbounded case in a killable subprocess. A regression
// must fail promptly rather than hanging the whole calendar test command.
const excludedDense = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
  import { EventExpansionError, expandRecurringEvents } from ${JSON.stringify(new URL("./recurrence.ts", import.meta.url).href)};
  try {
    expandRecurringEvents([{ id: "excluded-dense", title: "Hidden", isAllDay: true,
      start: new Date("1990-01-01T00:00:00Z"), end: new Date("1990-01-01T00:00:00Z"),
      recurrence: "RRULE:FREQ=DAILY\\nEXRULE:FREQ=DAILY" }],
      new Date("2026-10-01T00:00:00Z"), new Date("2026-10-10T23:59:59Z"),
      { consumerTimeZone: "UTC", strict: true, maxCandidates: 5, maxOccurrences: 20 });
    throw new Error("Expected candidate exhaustion before the excluded set was enumerated");
  } catch (error) {
    if (!(error instanceof EventExpansionError) || error.reason !== "recurrence-budget-exceeded") throw error;
    process.stdout.write("bounded excluded set");
  }
`], { timeout: 3000, encoding: "utf8" });
assert.ifError(excludedDense.error);
assert.equal(excludedDense.status, 0, excludedDense.stderr);
assert.equal(excludedDense.stdout, "bounded excluded set");

// These hourly rules previously looped inside rrule without ever invoking its
// candidate callback. Validate rejection under a deadline, including the
// bounded non-strict legacy entry point.
for (const recurrence of ["FREQ=HOURLY", "FREQ=HOURLY;BYHOUR=25", "INTERVAL=2;FREQ=HOURLY;BYHOUR=9"]) {
  const rejectedHourly = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { EventExpansionError, expandRecurringEvents } from ${JSON.stringify(new URL("./recurrence.ts", import.meta.url).href)};
    try {
      expandRecurringEvents([{ id: "hourly", title: "Filter", isAllDay: false,
        start: new Date("2026-10-01T08:00:00Z"), end: new Date("2026-10-01T09:00:00Z"),
        recurrence: ${JSON.stringify(recurrence)} }],
        new Date("2026-10-01T00:00:00Z"), new Date("2026-10-10T23:59:59Z"),
        { consumerTimeZone: "UTC", maxCandidates: 5, maxOccurrences: 20 });
      throw new Error("Expected bounded hourly rejection");
    } catch (error) {
      if (!(error instanceof EventExpansionError) || error.reason !== "subdaily-recurrence-not-supported") throw error;
      process.stdout.write("unsupported hourly rule");
    }
  `], { timeout: 3000, encoding: "utf8" });
  assert.ifError(rejectedHourly.error);
  assert.equal(rejectedHourly.status, 0, rejectedHourly.stderr);
  assert.equal(rejectedHourly.stdout, "unsupported hourly rule");
}

assert.deepEqual(expandRecurringEvents([event(1, {
  recurrence: "INTERVAL=2;FREQ=DAILY;COUNT=3",
})], from, to, { ...options, maxCandidates: 20 }).map(item => item.start.toISOString()), [
  "2026-10-01T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-10-05T00:00:00.000Z",
], "Bare legacy rule field order preserves valid expansion");
for (const recurrence of ["FREQ=DAILY;BYHOUR=25", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;COUNT=-1", "RRULE:COUNT=3"]) {
  assert.throws(() => expandRecurringEvents([event(1, { recurrence })], from, to, { ...options, strict: false }),
    (error: unknown) => error instanceof EventExpansionError && error.reason.startsWith("invalid-recurrence-"),
    "Bounded legacy fields are validated before iteration, even without strict mode");
}

// An old dense legacy rule must be stopped before it reaches the requested
// window. Returning [] after rrule has enumerated decades defeats the budget.
assert.throws(() => expandRecurringEvents([event(1, {
  start: new Date("1990-01-01T00:00:00Z"), end: new Date("1990-01-01T00:00:00Z"),
  recurrence: "FREQ=DAILY",
})], from, to, options), budgetExceeded);

// The known-time path's callback must count candidates skipped before the
// window too. No COUNT is necessary to trigger bounded reconstruction.
assert.throws(() => expandRecurringEvents([event(1, {
  timeModel: { kind: "all-day" },
  start: new Date("1990-01-01T00:00:00Z"), end: new Date("1990-01-01T00:00:00Z"),
  recurrence: "FREQ=DAILY",
})], from, to, options), budgetExceeded);

for (const known of [false, true]) {
  assert.throws(() => expandRecurringEvents([1, 2, 3].map(value => event(value, {
    recurrence: "FREQ=DAILY;COUNT=3", ...(known ? { timeModel: { kind: "all-day" } } : {}),
  })), from, to, options), budgetExceeded,
  "A projection candidate budget is shared across recurring families");
}
assert.throws(() => expandRecurringEvents([
  event(1, { timeModel: { kind: "all-day" }, recurrence: "FREQ=DAILY;COUNT=3" }),
  event(2, { recurrence: "FREQ=DAILY;COUNT=3" }),
], from, to, options), budgetExceeded,
"Known and legacy paths share a single projection candidate budget");

const occurrenceExceeded = (error: unknown) =>
  error instanceof EventExpansionError && error.reason === "occurrence-budget-exceeded";
assert.throws(() => expandRecurringEvents([
  event(1, { timeModel: { kind: "all-day" } }), event(2), event(3),
], from, to, { ...options, maxOccurrences: 2 }), occurrenceExceeded,
"Non-recurring rows consume the same occurrence budget as recurrence results");
assert.throws(() => expandRecurringEvents([
  event(1, { timeModel: { kind: "all-day" }, recurrence: "FREQ=DAILY;COUNT=2" }),
  event(2, { recurrence: "FREQ=DAILY;COUNT=2" }),
], from, to, { ...options, maxCandidates: 100, maxOccurrences: 3 }), occurrenceExceeded,
"Known and legacy occurrence results share the collection budget");

for (const limit of [0, -1, 0.5, NaN, Infinity]) {
  assert.throws(() => expandRecurringEvents([], from, to, { maxCandidates: limit }), RangeError);
  assert.throws(() => expandRecurringEvents([], from, to, { maxOccurrences: limit }), RangeError);
}
assert.throws(() => expandRecurringEvents([event(1, {
  start: new Date(NaN), end: new Date(NaN),
})], from, to, options), EventExpansionError,
"Strict projections reject malformed standalone legacy dates instead of dropping them");
assert.throws(() => expandRecurringEvents([event(1, {
  start: new Date("2026-10-02T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z"),
})], from, to, options), EventExpansionError,
"Strict projections reject reversed legacy ranges");

console.log("Widget expansion budgets bound old candidates and combined result collections: OK");
