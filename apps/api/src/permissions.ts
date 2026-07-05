import { getEventCalendars, getEventOrigin, getUserRoleForCalendar } from "@musubi/db";
import { CalendarAction, ForbiddenError, NotFoundError, can } from "@musubi/types";

// Server-side authorization gate. Throws 403 if the user's role on the calendar
// doesn't permit the action. This is the real boundary — the client UI gating is
// only cosmetic.
export async function assertCan(userID: string, calendarID: string, action: CalendarAction) {
  const role = await getUserRoleForCalendar(userID, calendarID);
  if (!can(role, action)) {
    throw new ForbiddenError(`You don't have permission to ${action} on this calendar.`);
  }
}

// Non-throwing check — for when you need to branch on permission rather than
// reject the whole request (e.g. unlink only the calendars the user can edit).
export async function canDo(userID: string, calendarID: string, action: CalendarAction): Promise<boolean> {
  const role = await getUserRoleForCalendar(userID, calendarID);
  return can(role, action);
}

// Event-scoped gate for editing an event's SHARED content. A shared event lives
// in many calendars, so editing is governed by its home (origin) calendar — not
// whichever calendar the user is looking at. See ownership model.
export async function assertCanEditEvent(userID: string, eventID: string) {
  const origin = await getEventOrigin(eventID);
  if (!origin) throw new NotFoundError("Event not found...");

  if (origin.originCalendarID) {
    await assertCan(userID, origin.originCalendarID, "editEvents");
    return;
  }
  // No home calendar (legacy event, or origin was deleted → SET NULL): the creator
  // or an editor of any calendar it still lives in may edit.
  if (userID === origin.creatorID) return;
  for (const cal of await getEventCalendars(eventID)) {
    if (await canDo(userID, cal, "editEvents")) return;
  }
  throw new ForbiddenError("You don't have permission to edit this event.");
}
