import { z } from "zod";
import { NotificationEmailsSchema, ReminderRuleSchema } from "./reminder";

export const CalendarViewSchema = z.enum(["week", "month", "day", "schedule"]);
export type CalendarView = z.infer<typeof CalendarViewSchema>;

/**
 * An IANA zone name, checked by asking the platform rather than by pattern.
 * A reminder for an all-day event is a wall-clock time, so a zone the runtime
 * cannot resolve would silently move somebody's morning.
 */
export const TimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Not a time zone this runtime knows." },
  );

export const SettingsSchema = z.object({
  notificationsOnByDefault: z.boolean(),
  defaultCalendarView: CalendarViewSchema,
  weekStartsOn: z.enum(["monday", "sunday"]),
  // how times render (12-hour with AM/PM vs 24-hour) and the order dates are written
  timeFormat: z.enum(["12h", "24h"]),
  dateFormat: z.enum(["dmy", "mdy", "ymd"]),
  theme: z.enum(["system", "dark", "light"]).default("system"),
  // optional (not defaulted): an omitted field must never reset the flag
  onboarded: z.boolean().optional(),
  // labels under the bottom tab icons; optional so old clients can't reset it
  tabBarLabels: z.boolean().optional(),
  // user-chosen calendar order (flat id list); optional for the same reason
  calendarOrder: z.array(z.string()).optional(),
  // Where all-day reminders land on the clock. Optional so a client that has
  // never sent one cannot reset a zone another device already reported.
  timezone: TimezoneSchema.optional(),
  // The bottom of the reminder inheritance chain. Optional for the same reason;
  // the server keeps `notificationsOnByDefault` in step with it.
  defaultReminder: ReminderRuleSchema.optional(),
  // Emails about what other people did. Optional so an older client saving the
  // whole document cannot silence them by not knowing about them.
  notificationEmails: NotificationEmailsSchema.optional(),
  // Nejnovější zpráva o novinkách, kterou uživatel viděl. Prázdný řetězec =
  // ještě žádnou; klient v tom případě modal NEUKÁŽE a jen si značku nastaví,
  // aby nový účet (a v den nasazení každý stávající) nedostal celou historii
  // produktu naráz. Volitelné, aby ji starší klient ukládající celý dokument
  // nemohl shodit zpátky.
  lastSeenAnnouncement: z.string().max(64).optional(),
  // Project news has its own marker: old server-local announcements must not
  // hide shared updates. Optional without a default so an older client's PUT
  // cannot reset a marker it does not know about.
  lastSeenProjectNews: z.string().max(64).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = z
  .object({
    calendarOrder: z.array(z.string()).max(500).optional(),
    dateFormat: z.enum(["dmy", "mdy", "ymd"]).optional(),
    defaultCalendarView: CalendarViewSchema.optional(),
    defaultReminder: ReminderRuleSchema.optional(),
    lastSeenAnnouncement: z.string().max(64).optional(),
    lastSeenProjectNews: z.string().max(64).optional(),
    notificationEmails: NotificationEmailsSchema.optional(),
    notificationsOnByDefault: z.boolean().optional(),
    onboarded: z.boolean().optional(),
    tabBarLabels: z.boolean().optional(),
    theme: z.enum(["system", "dark", "light"]).optional(),
    timeFormat: z.enum(["12h", "24h"]).optional(),
    timezone: TimezoneSchema.optional(),
    weekStartsOn: z.enum(["monday", "sunday"]).optional(),
  })
  // NOT strict, deliberately. A field this server has never heard of is
  // stripped, not a reason to reject everything around it.
  //
  // The app updates from a store and a self-hosted server updates when its
  // admin gets round to it, so a client newer than its server is the ordinary
  // case rather than an edge one. Under `.strict()` a phone that had learned
  // about `timezone` lost its theme change too — the whole patch refused over
  // one field the server could simply have ignored.
  //
  // The emptiness check below runs AFTER stripping, so a patch consisting only
  // of fields this server does not know is still an error: there is genuinely
  // nothing to apply, and answering 200 would claim otherwise.
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Settings patch cannot be empty.",
  });

export const SettingsDocumentSchema = z
  .object({
    revision: z.number().int().positive(),
    updatedAt: z.coerce.date(),
    value: SettingsSchema,
  })
  .strict();

export const PatchSettingsRequestSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    patch: SettingsPatchSchema,
  })
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type SettingsDocument = z.infer<typeof SettingsDocumentSchema>;
export type PatchSettingsRequest = z.infer<
  typeof PatchSettingsRequestSchema
>;
