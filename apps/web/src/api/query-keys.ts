export type EventRangeInput = {
  calendarIds: readonly string[];
  end: Date;
  filterFingerprint: string;
  serverOrigin: string;
  start: Date;
  userId: string;
};

function sorted(values: readonly string[]) {
  return [...values].sort();
}

export const queryKeys = {
  delivery: (serverOrigin: string, userId: string, connectionId?: string) =>
    ["delivery", serverOrigin, userId, connectionId ?? "home"] as const,

  session: (serverOrigin: string) => ["session", serverOrigin] as const,

  settings: (serverOrigin: string, userId: string) =>
    ["settings", serverOrigin, userId] as const,

  announcements: (serverOrigin: string, userId: string) =>
    ["announcements", serverOrigin, userId] as const,

  calendars: (serverOrigin: string, userId: string) =>
    ["calendars", serverOrigin, userId] as const,

  pages: (serverOrigin: string, userId: string) =>
    ["pages", serverOrigin, userId] as const,

  tasks: (serverOrigin: string, userId: string) =>
    ["tasks", serverOrigin, userId] as const,

  reminders: (serverOrigin: string, userId: string) =>
    ["reminders", serverOrigin, userId] as const,

  federated: (serverOrigin: string, userId: string) =>
    ["federated", serverOrigin, userId] as const,

  members: (serverOrigin: string, userId: string, calendarId: string) =>
    ["members", serverOrigin, userId, calendarId] as const,

  invites: (serverOrigin: string, userId: string, calendarId: string) =>
    ["invites", serverOrigin, userId, calendarId] as const,

  attendees: (serverOrigin: string, userId: string, eventId: string) =>
    ["attendees", serverOrigin, userId, eventId] as const,

  eventRange: (input: EventRangeInput) =>
    [
      "events",
      input.serverOrigin,
      input.userId,
      sorted(input.calendarIds),
      input.start.toISOString(),
      input.end.toISOString(),
      input.filterFingerprint,
    ] as const,
};

export function getServerOrigin() {
  return typeof window === "undefined" ? "same-origin" : window.location.origin;
}
