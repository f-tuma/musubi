import { getUserRoleForCalendar } from "@musubi/db";
import { CalendarAction, ForbiddenError, can } from "@musubi/types";

// Server-side authorization gate. Throws 403 if the user's role on the calendar
// doesn't permit the action. This is the real boundary — the client UI gating is
// only cosmetic.
export async function assertCan(userID: string, calendarID: string, action: CalendarAction) {
  const role = await getUserRoleForCalendar(userID, calendarID);
  if (!can(role, action)) {
    throw new ForbiddenError(`You don't have permission to ${action} on this calendar.`);
  }
}
