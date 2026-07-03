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
  // external sync origin — null/absent for native Musubi calendars
  provider: z.string().nullish(),
  accountId: z.string().nullish(),
  accountLabel: z.string().nullish(),
});

export type Calendar = z.infer<typeof CalendarSchema>;

export const CalendarWithEventsSchema = CalendarSchema.extend({
  events: z.array(EventSchema),
});

export type CalendarWithEvents = z.infer<typeof CalendarWithEventsSchema>;
