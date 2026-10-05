/** Ranges from the recurrence time-model contract; zero is invalid for signed
 * day/week/position ordinals but valid for clock fields. */
export const recurrenceNumericRanges: Readonly<Record<string, readonly [number, number, boolean]>> = {
  BYMONTH: [1, 12, false],
  BYMONTHDAY: [-31, 31, true],
  BYYEARDAY: [-366, 366, true],
  BYWEEKNO: [-53, 53, true],
  BYSETPOS: [-366, 366, true],
  BYHOUR: [0, 23, false],
  BYMINUTE: [0, 59, false],
  BYSECOND: [0, 59, false],
};

const supportedFrequencies = new Set(["YEARLY", "MONTHLY", "WEEKLY", "DAILY"]);
const subdailyFrequencies = new Set(["HOURLY", "MINUTELY", "SECONDLY"]);
const weekday = "(?:MO|TU|WE|TH|FR|SA|SU)";
const byDay = new RegExp(`^([+-]?\\d+)?${weekday}$`);
const weekStart = new RegExp(`^${weekday}$`);

/** Validate before bounded legacy iteration. Some subdaily filters never reach
 * rrule's candidate callback, so a callback budget cannot safely admit them.
 * Date properties and unknown rule fields keep the library's parsing semantics.
 */
export function validateBoundedLegacyRule(
  recurrenceText: string,
  fail: (reason: string) => never,
): void {
  for (const raw of recurrenceText.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(?:DTSTART|RDATE|EXDATE)(?:;[^:]*)?:/i.test(line)) continue;
    const body = /^(?:RRULE|EXRULE)(?:;[^:]*)?:(.*)$/i.exec(line)?.[1] ?? line;
    const fields = body.split(";").map(part => part.split("=").map(value => value.trim().toUpperCase()));
    const frequencies = fields.filter(([name]) => name === "FREQ");
    if (frequencies.length !== 1 || frequencies[0].length !== 2 || !frequencies[0][1])
      fail("invalid-recurrence-fields");
    const frequency = frequencies[0][1];
    if (subdailyFrequencies.has(frequency)) fail("subdaily-recurrence-not-supported");
    if (!supportedFrequencies.has(frequency)) fail("invalid-recurrence-field-value");

    for (const field of fields) {
      const [name, value] = field;
      if (["COUNT", "INTERVAL"].includes(name)) {
        if (field.length !== 2 || !/^\d+$/.test(value ?? "")
          || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
          fail("invalid-recurrence-field-value");
      }
      const range = recurrenceNumericRanges[name];
      if (range && (field.length !== 2 || (value ?? "").split(",").some(item =>
        !/^[+-]?\d+$/.test(item) || !Number.isSafeInteger(Number(item))
        || Number(item) < range[0] || Number(item) > range[1]
        || (range[2] && Number(item) === 0))))
        fail("invalid-recurrence-field-value");
      if (name === "BYDAY" && (field.length !== 2 || (value ?? "").split(",").some(item => {
        const match = byDay.exec(item);
        return !match || (match[1] !== undefined && (!Number.isSafeInteger(Number(match[1]))
          || Number(match[1]) === 0 || Math.abs(Number(match[1])) > 53));
      }))) fail("invalid-recurrence-field-value");
      if (name === "WKST" && (field.length !== 2 || !weekStart.test(value ?? "")))
        fail("invalid-recurrence-field-value");
    }
  }
}
