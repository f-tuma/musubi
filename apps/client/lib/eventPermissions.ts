import { Calendar, Event, can } from "@musubi/types";

// Same rule the server enforces (assertCanEditEvent): the origin calendar
// governs edits; with no origin, any linked calendar the user can edit in
// counts. Mirrors EventDetailModal's gating.
export function canEditEvent(event: Event, calendars: Calendar[]): boolean {
  if (event.originCalendarID) {
    return can(calendars.find(c => c.id === event.originCalendarID)?.role, "editEvents");
  }
  return event.calendars.some(id => can(calendars.find(c => c.id === id)?.role, "editEvents"));
}
