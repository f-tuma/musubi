import { EventWriteError } from "@musubi/types";

const invalid = () => new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");

/** Validate before ICAL normalization can truncate or normalize an invalid DATE. */
export function recurrenceDateValues(line: string): string[] {
  const match = /^(?:RDATE|EXDATE);VALUE=DATE:([0-9,]+)$/i.exec(line);
  if (!match) throw invalid();
  return match[1].split(",").map(value => {
    if (!/^\d{8}$/.test(value)) throw invalid();
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    const date = new Date(iso + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw invalid();
    return iso;
  });
}
