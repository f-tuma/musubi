import { z } from "zod";
import { UserSchema } from "./user";
import { EventSchema } from "./event";

export const CalendarSchema = z.object({
  id: z.string(),
  creatorID: z.string(),
  name: z.string(),
  color: z.string(),
  members: z.array(UserSchema),
  invite: z.string(),
  role: z.string().nullish(), // requesting user's role: owner | editor | viewer
  // external sync origin — null/absent for native Musubi calendars
  provider: z.string().nullish(),
  accountId: z.string().nullish(),
  accountLabel: z.string().nullish(),
  serverUrl: z.string().nullish(), // caldav only — icloud.com host = Apple Calendar
});

// Which icon/name to show for a calendar's sync origin ("apple" is caldav
// pointed at iCloud — same protocol, different branding).
export function providerFlavor(cal: Pick<Calendar, "provider" | "serverUrl">): string | null {
  if (cal.provider === "caldav" && cal.serverUrl?.includes("icloud.com")) return "apple";
  return cal.provider ?? null;
}

export type Calendar = z.infer<typeof CalendarSchema>;

export const CalendarWithEventsSchema = CalendarSchema.extend({
  events: z.array(EventSchema),
});

export type CalendarWithEvents = z.infer<typeof CalendarWithEventsSchema>;
