import { z } from "zod";

export const EventSchema = z.object({
  id: z.string(),
  creatorID: z.string(),
  organizer: z.string(),
  title: z.string(),
  color: z.string(),
  start: z.coerce.date(),
  end: z.coerce.date(),
  calendars: z.array(z.string()),
  originCalendarID: z.string().nullish(), // home calendar — governs edit rights
  isCanceled: z.boolean(),
  isAllDay: z.boolean(),
  // Attendance toggle — hides/shows the attendee UI. Non-destructive: flipping
  // it off keeps event_users rows, re-enabling shows the same people again.
  hasAttendees: z.boolean().default(false),
  description: z.string().nullish(),
  location: z.string().nullish(),
  recurrence: z.string().nullish(),
  url: z.string().nullish(),
});

export type Event = z.infer<typeof EventSchema>;
