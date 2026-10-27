import {
  CalendarSchema,
  EventSchema,
  InviteSchema,
  PageDocumentSchema,
  RemindersDocumentSchema,
  SettingsDocumentSchema,
  SettingsSchema,
  TaskSchema,
} from "@musubi/types";
import { z } from "zod";

export const CalendarsResponseSchema = z.array(CalendarSchema);
export const ImportedCalendarSchema = CalendarSchema.extend({
  imported: z.number().int().nonnegative(),
});

export const AttendeeSchema = z.object({
  id: z.string(),
  image: z.string().nullish(),
  name: z.string(),
  status: z.enum(["declined", "going", "maybe"]),
});

export const AttendeesResponseSchema = z.array(AttendeeSchema);

export const EventsResponseSchema = z.object({
  deletedIds: z.array(z.string()),
  events: z.array(EventSchema),
  serverTime: z.string(),
});
export const TasksResponseSchema = z.object({ tasks: z.array(TaskSchema) });

export const RemoveEventResponseSchema = z.object({
  calendars: z.array(z.string()),
  id: z.string(),
  removed: z.boolean(),
  revision: z.number().int().positive().optional(),
  event: EventSchema.optional(),
});

export const SettingsResponseSchema = SettingsSchema;
export const SettingsDocumentResponseSchema = SettingsDocumentSchema;

export const RemindersResponseSchema = RemindersDocumentSchema;

export const PageResponseSchema = PageDocumentSchema;
export const PagesResponseSchema = z.array(PageDocumentSchema);

export const CalendarMemberSchema = z.object({
  id: z.string(),
  image: z.string().nullish(),
  name: z.string(),
  role: z.string(),
});
export const CalendarMembersResponseSchema = z.array(CalendarMemberSchema);
export const InvitesResponseSchema = z.array(InviteSchema);

export type CalendarMember = z.infer<typeof CalendarMemberSchema>;

// What an invite reveals before anyone commits: labels and a 30-day agenda.
export const InvitePreviewSchema = z.object({
  color: z.string(),
  events: z.array(
    z
      .object({
        end: z.coerce.date(),
        id: z.string(),
        isAllDay: z.boolean(),
        start: z.coerce.date(),
        title: z.string(),
      })
      .loose(),
  ),
  id: z.string(),
  members: z.array(
    z.object({
      id: z.string(),
      image: z.string().nullish(),
      name: z.string(),
    }),
  ),
  name: z.string(),
});

export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

export const FederationConnectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  remoteUserID: z.string(),
  server: z.string(),
});
export const FederationConnectionsResponseSchema = z.array(
  FederationConnectionSchema,
);

export type FederationConnection = z.infer<typeof FederationConnectionSchema>;

/**
 * What the server can push to, for the signed-in reader alone.
 *
 * Fingerprints, never endpoints: a push endpoint is a capability URL, and a
 * browser identifies itself here by hashing the one it already holds.
 */
export const PushSubscriptionsSchema = z
  .object({
    subscriptions: z
      .array(
        z
          .object({
            fingerprint: z.string(),
            // Set on every successful send, and never null: the column is
            // NOT NULL with a default.
            lastSeenAt: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const ServerCapabilitiesSchema = z
  .object({
    email: z.boolean().default(false),
    minClientVersion: z.string().optional(),
    // What the server is running. Optional, because a server older than the
    // field simply says nothing and the tab has nothing to compare against.
    version: z.string().optional(),
    socials: z.array(z.string()).default([]),
    // Providers a BROWSER can finish. Narrower than `socials`, which also counts
    // the phone's native flows. Absent on an API older than this field, and the
    // login screen falls back accordingly.
    socialsWeb: z.array(z.string()).optional(),
    syncProviders: z.array(z.string()).default([]),
    googleAvailability: z.boolean().default(false),
    // VAPID public key, or null on a server with no push keys. Absent entirely
    // on an API older than this field, which means the same thing.
    pushPublicKey: z.string().nullish(),
  })
  .loose();

export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export type EventsResponse = z.infer<typeof EventsResponseSchema>;
export type Attendee = z.infer<typeof AttendeeSchema>;
export type ImportedCalendar = z.infer<typeof ImportedCalendarSchema>;
export type RemoveEventResponse = z.infer<typeof RemoveEventResponseSchema>;
