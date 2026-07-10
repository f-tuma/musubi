// Minimal iCalendar (.ics) VEVENT reader — enough to prefill the composer when
// the user opens a shared invite/file with Musubi. NOT a full RFC 5545 parser:
// first VEVENT only, no TZID math (floating/local times taken as-is), no
// VALARM/RRULE import.
// ponytail: covers the common "open this .ics" case; add TZID + RRULE if imports need them.

export type ICSDraft = {
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  description?: string;
  location?: string;
};

// RFC 5545 line folding: a CRLF/CR followed by a space or tab continues the prior line.
function unfold(raw: string): string[] {
  return raw.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

// TEXT values escape these; undo them.
function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

// DTSTART;TZID=…;VALUE=DATE:20260708  or  DTSTART:20260708T140000Z
function parseDate(value: string): { date: Date; allDay: boolean } {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { date: new Date(value), allDay: false };
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (!hh) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)), allDay: false };
  return { date: new Date(+y, +mo - 1, +d, +hh, +mm, +ss), allDay: false };
}

export function parseICS(raw: string): ICSDraft | null {
  const lines = unfold(raw);
  let title = "", description = "", location = "";
  let start: { date: Date; allDay: boolean } | null = null;
  let end: { date: Date; allDay: boolean } | null = null;
  let inEvent = false;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { inEvent = true; continue; }
    if (line === "END:VEVENT") break;
    if (!inEvent) continue;

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(";")[0].toUpperCase();
    const value = line.slice(colon + 1);

    if (name === "SUMMARY") title = unescapeText(value);
    else if (name === "DESCRIPTION") description = unescapeText(value);
    else if (name === "LOCATION") location = unescapeText(value);
    else if (name === "DTSTART") start = parseDate(value);
    else if (name === "DTEND") end = parseDate(value);
  }

  if (!start || isNaN(start.date.getTime())) return null;
  const endDate = end && !isNaN(end.date.getTime())
    ? end.date
    : new Date(start.date.getTime() + (start.allDay ? 86400000 : 3600000));

  return {
    title: title || "Untitled",
    start: start.date,
    end: endDate,
    isAllDay: start.allDay,
    description: description || undefined,
    location: location || undefined,
  };
}
