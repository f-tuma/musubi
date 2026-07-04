import { Calendar, Event } from "@musubi/types";
import { colors } from "@/constants/theme";

// Event display color follows its origin (home) calendar, live — so recoloring a
// calendar recolors its events. Falls back to the first linked calendar, then a
// neutral, when the origin calendar isn't loaded.
export function eventColor(event: Event, calendarById: Map<string, Calendar>): string {
  const originId = event.originCalendarID ?? event.calendars[0];
  return calendarById.get(originId ?? "")?.color
    ?? calendarById.get(event.calendars[0] ?? "")?.color
    ?? colors.fg4;
}
