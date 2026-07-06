import { z } from "zod";

export const CalendarViewSchema = z.enum(["week", "month", "day", "schedule"]);
export type CalendarView = z.infer<typeof CalendarViewSchema>;

export const SettingsSchema = z.object({
  showKanji: z.boolean(),
  notificationsOnByDefault: z.boolean(),
  defaultCalendarView: CalendarViewSchema,
  weekStartsOn: z.enum(["monday", "sunday"]),
  // how times render (12-hour with AM/PM vs 24-hour) and the order dates are written
  timeFormat: z.enum(["12h", "24h"]),
  dateFormat: z.enum(["dmy", "mdy", "ymd"]),
  theme: z.enum(["system", "dark", "light"]).default("system"),
  // optional (not defaulted): an omitted field must never reset the flag
  onboarded: z.boolean().optional(),
  // user-chosen calendar order (flat id list); optional for the same reason
  calendarOrder: z.array(z.string()).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
