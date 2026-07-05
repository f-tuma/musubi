// Calendar roles & permissions — single source of truth, shared by server
// (authorization) and client (UI gating).
export type CalendarRole = "owner" | "editor" | "viewer";

export type CalendarAction =
  | "editCalendar"   // rename, recolor, ... the calendar itself
  | "deleteCalendar"
  | "manageMembers"  // change roles / remove members
  | "editEvents"     // create / update / delete events
  | "invite";

const PERMISSIONS: Record<CalendarRole, CalendarAction[]> = {
  owner: ["editCalendar", "deleteCalendar", "manageMembers", "editEvents", "invite"],
  editor: ["editEvents", "invite"],
  viewer: [],
};

export function can(role: CalendarRole | string | null | undefined, action: CalendarAction): boolean {
  if (!role || !(role in PERMISSIONS)) return false;
  return PERMISSIONS[role as CalendarRole].includes(action);
}
