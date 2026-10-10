import assert from "node:assert/strict";
import { recurrenceNumericRanges, validateBoundedLegacyRule } from "./recurrence-validation";

const validate = (text: string) => validateBoundedLegacyRule(text, reason => { throw new Error(reason); });
const rejected = (reason: string) => (error: unknown) => error instanceof Error && error.message === reason;

for (const frequency of ["YEARLY", "MONTHLY", "WEEKLY", "DAILY"]) {
  validate(`FREQ=${frequency};INTERVAL=1;COUNT=2`);
  validate(`INTERVAL=2;FREQ=${frequency};COUNT=3`);
}
validate("DTSTART:20261001T080000Z\r\nRRULE:INTERVAL=2;FREQ=DAILY;BYHOUR=8,9\r\nEXRULE:FREQ=WEEKLY;BYDAY=MO,TU;WKST=SU\r\nEXDATE:20261002T080000Z\r\nRDATE:20261003T080000Z");
validate("RRULE:FREQ=DAILY;BYHOUR=8,\r\n 9;X-UNKNOWN=library-handles-this");
validate("RDATE:20261003T080000Z\nEXDATE:20261003T080000Z");
validate("FREQ=YEARLY;BYDAY=MO,+1TU,-53WE;WKST=MO;COUNT=9007199254740991");

for (const [name, [min, max, withoutZero]] of Object.entries(recurrenceNumericRanges)) {
  validate(`FREQ=YEARLY;${name}=${min},${max}`);
  for (const value of [String(min - 1), String(max + 1), "0.5", "NaN", "Infinity", "", "1,,2", "2=3"])
    assert.throws(() => validate(`FREQ=DAILY;${name}=${value}`), rejected("invalid-recurrence-field-value"), `${name}=${value}`);
  if (withoutZero) assert.throws(() => validate(`FREQ=DAILY;${name}=0`), rejected("invalid-recurrence-field-value"));
}
for (const name of ["INTERVAL", "COUNT"]) {
  for (const value of ["0", "-1", "1.5", "9007199254740992", "NaN", "Infinity", "", "2=3"])
    assert.throws(() => validate(`FREQ=DAILY;${name}=${value}`), rejected("invalid-recurrence-field-value"));
}
for (const value of ["0MO", "54MO", "-54MO", "1.5MO", "XX", "MO,", "MO=TU"])
  assert.throws(() => validate(`FREQ=YEARLY;BYDAY=${value}`), rejected("invalid-recurrence-field-value"));
for (const value of ["MOO", "MO,TU", "1MO", "", "MO=TU"])
  assert.throws(() => validate(`FREQ=DAILY;WKST=${value}`), rejected("invalid-recurrence-field-value"));
for (const text of ["COUNT=3", "RRULE:COUNT=3", "EXRULE:COUNT=3", "FREQ=", "FREQ=DAILY;FREQ=WEEKLY"])
  assert.throws(() => validate(text), rejected("invalid-recurrence-fields"));
assert.throws(() => validate("FREQ=UNKNOWN"), rejected("invalid-recurrence-field-value"));
assert.throws(() => validate("RRULE:FREQ=DAILY;BYHOUR=\r\n 25"), rejected("invalid-recurrence-field-value"));
for (const frequency of ["HOURLY", "MINUTELY", "SECONDLY"]) {
  for (const prefix of ["", "RRULE:", "EXRULE:"]) {
    assert.throws(() => validate(`${prefix}INTERVAL=2;FREQ=${frequency}`), rejected("subdaily-recurrence-not-supported"));
  }
}
assert.throws(() => validate("RRULE:FREQ=DAILY\nEXRULE:FREQ=HOURLY;BYHOUR=25"), rejected("subdaily-recurrence-not-supported"));

console.log("Bounded legacy validation rejects unsafe frequencies and malformed numeric filters: OK");
