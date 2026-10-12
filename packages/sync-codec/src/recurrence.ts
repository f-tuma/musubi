import ICAL from "ical.js";
import { EventWriteError } from "@musubi/types";
import { recurrenceDateValues } from "./recurrence_dates";
function utcMidnight(t: {year:number;month:number;day:number}) { return new Date(Date.UTC(t.year,t.month-1,t.day)); }
export function allDayTime(d: Date) {
  return ICAL.Time.fromData({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    isDate: true,
  });
}

function recurrenceDate(time: ICAL.Time) {
  const date = time.isDate ? utcMidnight(time) : time.toJSDate();
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function recurrenceFrom(component: ICAL.Component): string | null {
  const rrule = component.getFirstProperty("rrule")?.getFirstValue();
  if (!rrule) {
    if (component.name === "vevent" && ["rdate", "exdate"].some(name => component.hasProperty(name))) throw new EventWriteError("recurrence", "unsupported", "Dated recurrence requires a representable recurrence rule.");
    return null;
  }
  const lines = new Set<string>([`RRULE:${rrule.toString()}`]);
  for (const propertyName of ["exdate", "rdate"] as const) {
    for (const property of component.getAllProperties(propertyName)) {
      for (const time of property.getValues() as ICAL.Time[]) {
        if (component.name === "vevent" && time.isDate) {
          if (!(component.getFirstPropertyValue("dtstart") as ICAL.Time)?.isDate) throw new EventWriteError("recurrence", "unsupported", "DATE recurrence requires an all-day event.");
          const line = `${propertyName.toUpperCase()};VALUE=DATE:${time.toICALString()}`;
          recurrenceDateValues(line);
          lines.add(line);
        } else lines.add(`${propertyName.toUpperCase()}:${recurrenceDate(time)}`);
      }
    }
  }

  return [...lines].join("\n");
}
export function addRecurrence(
  component: ICAL.Component,
  recurrence: string | null | undefined,
  isAllDay: boolean,
) {
  if (!recurrence) return;
  for (const line of recurrence.split("\n")) {
    if (/^(RRULE:)?FREQ=/.test(line)) {
      component.addPropertyWithValue(
        "rrule",
        ICAL.Recur.fromString(line.replace(/^RRULE:/, "")),
      );
    } else if (/^(EXDATE|RDATE);VALUE=DATE:/i.test(line)) {
      if (!isAllDay) throw new EventWriteError("recurrence", "unsupported", "DATE recurrence requires an all-day event.");
      recurrenceDateValues(line);
      component.addProperty(ICAL.Property.fromString(line));
    } else if (/^(EXDATE|RDATE):/.test(line)) {
      const [propertyName, values] = line.split(":", 2) as [
        "EXDATE" | "RDATE",
        string,
      ];
      for (const value of values.split(",")) {
        const match = value.match(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
        );
        if (!match) throw new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");
        const date = new Date(
          Date.UTC(
            +match[1],
            +match[2] - 1,
            +match[3],
            +match[4],
            +match[5],
            +match[6],
          ),
        );
        if (date.getUTCFullYear() !== +match[1] || date.getUTCMonth() + 1 !== +match[2] || date.getUTCDate() !== +match[3] || date.getUTCHours() !== +match[4] || date.getUTCMinutes() !== +match[5] || date.getUTCSeconds() !== +match[6]) throw new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");
        component.addPropertyWithValue(
          propertyName.toLowerCase(),
          isAllDay ? allDayTime(date) : ICAL.Time.fromJSDate(date, true),
        );
      }
    } else if (/^(EXDATE|RDATE)[;:]/i.test(line)) {
      throw new EventWriteError("recurrence", "unsupported", "Unsupported or invalid recurrence date.");
    }
  }
}
