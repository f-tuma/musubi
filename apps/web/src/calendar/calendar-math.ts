import { isCalendarTask } from "@musubi/calendar";
import type { Event, Settings } from "@musubi/types";
import { dayKey, eventDayDate } from "@musubi/calendar/layout";

const MONDAY_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SUNDAY_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getWeekdayLabels(weekStartsOn: Settings["weekStartsOn"]) {
  return weekStartsOn === "sunday" ? SUNDAY_WEEKDAYS : MONDAY_WEEKDAYS;
}

export function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function getMonthLabel(anchor: Date): string {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(anchor);
}

export function getLongDateLabel(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    weekday: "long",
    year: "numeric",
  }).format(date);
}

function timeFormatter(timeFormat: Settings["timeFormat"]) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    hour12: timeFormat === "12h",
    minute: "2-digit",
  });
}

export function getEventTimeLabel(
  event: Event,
  timeFormat: Settings["timeFormat"] = "24h",
): string {
  if (event.isAllDay) {
    return "All day";
  }

  return timeFormatter(timeFormat).format(event.start);
}

export function getEventRangeLabel(
  event: Event,
  timeFormat: Settings["timeFormat"] = "24h",
): string {
  if (event.isAllDay) {
    return "All day";
  }

  const formatter = timeFormatter(timeFormat);
  if (isCalendarTask(event)) return formatter.format(event.start);

  return `${formatter.format(event.start)} – ${formatter.format(event.end)}`;
}

export function getEventDateLabel(event: Event): string {
  if (!event.isAllDay) {
    // The real end instant, not the exclusive last cell: 10:00 to the next
    // midnight still ends on the next date.
    const startLabel = getLongDateLabel(event.start);
    return event.end > event.start && dayKey(event.end) !== dayKey(event.start)
      ? `${startLabel} – ${getLongDateLabel(event.end)}`
      : startLabel;
  }

  const start = eventDayDate(event.start, true);
  const parsedEnd = eventDayDate(event.end, true);
  const lastDay = parsedEnd >= start ? parsedEnd : start;
  const startLabel = getLongDateLabel(start);

  return dayKey(lastDay) === dayKey(start)
    ? startLabel
    : `${startLabel} – ${getLongDateLabel(lastDay)}`;
}
