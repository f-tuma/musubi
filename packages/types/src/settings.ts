import { z } from "zod";

export const CalendarViewSchema = z.enum(["week", "month", "day", "schedule"]);
export type CalendarView = z.infer<typeof CalendarViewSchema>;

export const SettingsSchema = z.object({
  showKanji: z.boolean(),
  notificationsOnByDefault: z.boolean(),
  defaultCalendarView: CalendarViewSchema,
  weekStartsOn: z.enum(["monday", "sunday"]),
  timeLocale: z.enum(["en-UK", "cs-CZ"]),
  theme: z.enum(["system", "dark", "light"]).default("system"),
  // optional (not defaulted): an omitted field must never reset the flag
  onboarded: z.boolean().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
