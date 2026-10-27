import { z } from "zod";
import { EventTimeEditSchema } from "./event_time";
import type { ProviderRsvpInstance } from "./provider-rsvp";
import type { Event } from "./event";
import { WireInstantSchema } from "./wire_primitives";
const time = EventTimeEditSchema.refine(
  (value) =>
    value.kind !== "floating" &&
    (value.kind !== "zoned" || value.startLocal < value.endLocal),
  "A named zone with a positive duration or all-day dates are required",
);
const common = z.object({
  operationID: z.uuid().transform((value) => value.toLowerCase()),
  calendarID: z.uuid(),
  eventID: z.uuid(),
  provider: z.literal("google"),
  sendUpdates: z.literal("all"),
});
const content = z.object({
  title: z.string().trim().min(1).max(1024),
  description: z.string().max(100_000).nullable(),
  location: z.string().max(4096).nullable(),
});
const guest = z
  .object({
    email: z.email().transform((value) => value.toLowerCase()),
    optional: z.boolean(),
  })
  .strict();
export const GoogleOrganizerRequestSchema = z
  .discriminatedUnion("action", [
    common
      .extend({
        action: z.literal("create"),
        content: content.strict(),
        time,
        guests: z
          .array(guest)
          .min(1)
          .max(100)
          .refine(
            (values) =>
              new Set(values.map((value) => value.email)).size ===
              values.length,
            "Duplicate guest",
          ),
        color: z.string().max(64),
      })
      .strict(),
    common
      .extend({
        action: z.literal("update"),
        scope: z.literal("occurrence").optional(),
        expectedInstanceVersion: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        expectedRevision: z.number().int().positive(),
        expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
        patch: content
          .partial()
          .extend({ time: time.optional() })
          .strict()
          .refine((value) => Object.keys(value).length > 0, "Choose a change"),
      })
      .strict(),
    common
      .extend({
        action: z.literal("delete"),
        scope: z.literal("occurrence").optional(),
        expectedInstanceVersion: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        expectedRevision: z.number().int().positive(),
        expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  ])
  .superRefine((request, ctx) => {
    if (request.action === "create") return;
    if (
      !!request.scope !== !!request.expectedInstanceVersion ||
      (request.scope === "occurrence" &&
        request.action === "update" &&
        request.patch.time !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "A bound occurrence requires its exact observation and supports content changes only.",
      });
  });
const organizerAddress = z.string().transform(value => value.toLowerCase())
  .refine(value => value.startsWith("mailto:") && z.email().safeParse(value.slice(7)).success, "Choose a valid organizer address");
const caldavCommon = common
  .omit({ provider: true, sendUpdates: true })
  .extend({
    provider: z.literal("caldav"),
    notificationPolicy: z.literal("server-invite"),
  });
export const CaldavOrganizerRequestSchema = z.discriminatedUnion("action", [
  caldavCommon
    .extend({
      action: z.literal("create"),
      organizerAddress: organizerAddress.optional(),
      content: content.strict(),
      time: time.refine(
        (value) =>
          value.kind === "all-day" ||
          (value.kind === "zoned" && value.timeZone === "UTC"),
        "CalDAV creation requires explicit UTC or all-day time",
      ),
      guests: z
        .array(guest)
        .min(1)
        .max(100)
        .refine(
          (values) =>
            new Set(values.map((value) => value.email)).size === values.length,
          "Duplicate guest",
        ),
      color: z.string().max(64),
    })
    .strict(),
  caldavCommon
    .extend({
      action: z.literal("update"),
      expectedRevision: z.number().int().positive(),
      expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
      patch: content
        .partial()
        .extend({ time: time.optional() })
        .strict()
        .refine(
          (value) => Object.keys(value).length > 0,
          "Choose a content change",
        ),
    })
    .strict(),
  caldavCommon
    .extend({
      action: z.literal("delete"),
      expectedRevision: z.number().int().positive(),
      expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
]);
const microsoftContentPatch = content.partial().extend({
  time: time.refine(value => (value.kind === "all-day" || value.kind === "zoned"), "Outlook occurrence changes require verified all-day dates or a series time zone").optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Choose a change");
const microsoftCreate = caldavCommon.extend({
  provider: z.literal("microsoft"),
  action: z.literal("create"),
  content: content.strict(),
  time: time.refine(value => value.kind === "all-day" || (value.kind === "zoned" && value.timeZone === "UTC"), "Outlook creation requires explicit UTC or all-day time"),
  guests: z.array(guest).min(1).max(100).refine(values => new Set(values.map(value => value.email)).size === values.length, "Duplicate guest"),
  color: z.string().max(64),
}).strict();
export const MicrosoftOrganizerRequestSchema = z.discriminatedUnion("action", [
  microsoftCreate,
  caldavCommon.extend({
    provider: z.literal("microsoft"), action: z.literal("update"),
    scope: z.enum(["occurrence", "series"]).optional(),
    expectedSeriesVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    expectedRevision: z.number().int().positive(),
    expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
    patch: microsoftContentPatch,
  }).strict(),
  caldavCommon.extend({
    provider: z.literal("microsoft"), action: z.literal("delete"),
    scope: z.enum(["occurrence", "series"]).optional(),
    expectedSeriesVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    expectedRevision: z.number().int().positive(),
    expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
]).superRefine((request, ctx) => {
  if (request.action === "update" && request.patch.time !== undefined && !request.scope)
    ctx.addIssue({ code: "custom", message: "Time changes require a bound Outlook occurrence or series." });
  if (request.action === "update" && request.scope === "series" && request.patch.time && request.patch.time.kind !== "zoned")
    ctx.addIssue({ code: "custom", message: "Whole-series time changes require the verified series zone." });
  if (request.action !== "create" && !!request.scope !== !!request.expectedSeriesVersion)
    ctx.addIssue({ code: "custom", message: "Recurring changes require their exact series observation." });
});
export const MicrosoftSeriesCancellationRequestSchema = caldavCommon.extend({
  provider: z.literal("microsoft"), action: z.literal("delete"),
  scope: z.enum(["occurrence", "series"]),
  expectedSeriesVersion: z.string().regex(/^[0-9a-f]{64}$/),
  expectedRevision: z.number().int().positive(),
  expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const MicrosoftOccurrenceContentRequestSchema = caldavCommon.extend({
  provider: z.literal("microsoft"), action: z.literal("update"),
  scope: z.literal("occurrence"),
  expectedSeriesVersion: z.string().regex(/^[0-9a-f]{64}$/),
  expectedRevision: z.number().int().positive(),
  expectedStateVersion: z.string().regex(/^[0-9a-f]{64}$/),
  patch: microsoftContentPatch,
}).strict();
export const MicrosoftRecurringContentRequestSchema = MicrosoftOccurrenceContentRequestSchema.extend({ scope: z.enum(["occurrence", "series"]) }).refine(request => request.scope !== "series" || !request.patch.time || request.patch.time.kind === "zoned", "Whole-series time changes require the verified series zone.");
export type MicrosoftRecurringContentRequest = z.infer<typeof MicrosoftRecurringContentRequestSchema>;
export type MicrosoftOccurrenceContentRequest = z.infer<typeof MicrosoftOccurrenceContentRequestSchema>;
export type MicrosoftSeriesCancellationRequest = z.infer<typeof MicrosoftSeriesCancellationRequestSchema>;
export type MicrosoftOrganizerRequest = z.infer<typeof MicrosoftOrganizerRequestSchema>;
export type GoogleOrganizerRequest = z.infer<
  typeof GoogleOrganizerRequestSchema
>;
export type CaldavOrganizerRequest = z.infer<
  typeof CaldavOrganizerRequestSchema
>;
export const ProviderOrganizerRequestSchema = z.discriminatedUnion("provider", [
  GoogleOrganizerRequestSchema,
  CaldavOrganizerRequestSchema,
  MicrosoftOrganizerRequestSchema,
]);
export type ProviderOrganizerRequest = z.infer<
  typeof ProviderOrganizerRequestSchema
>;
export const OrganizerDispatchSchema = z
  .object({
    kind: z.enum(["google-organizer-dispatch", "caldav-organizer-dispatch", "microsoft-organizer-dispatch"]),
    version: z.literal(1),
    startedAt: WireInstantSchema,
    acceptedAt: WireInstantSchema.optional(),
    cancellationTombstone: z
      .object({
        revision: z.number().int().positive(),
        deletedAt: WireInstantSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
/** Private immutable provider operation; never a Musubi attendance instruction. */
export type ProviderOrganizerIntent = {
  request: ProviderOrganizerRequest;
  baseline: Record<string, unknown> | null;
  desired: Record<string, unknown> | null;
  mappingID: string | null;
  sourceEvent: Event;
  instance?: ProviderRsvpInstance;
  sourceAccessRevision?: number;
  graphIdentity?: { oauthAccountID: string; graphUserID: string; calendarID: string; selfAddress: string };
  dispatch?: z.infer<typeof OrganizerDispatchSchema>;
};
export const ProviderOrganizerReceiptSchema = z
  .object({
    operationID: z.uuid(),
    eventID: z.uuid(),
    replayed: z.boolean(),
    status: z.string(),
    localCommitted: z.literal(true),
    notificationDelivery: z.literal("unknown"),
  })
  .strict();

export const ProviderOrganizerCalendarSchema = z.discriminatedUnion(
  "provider",
  [
    z.object({ provider: z.literal("microsoft"), calendarID: z.uuid(), notificationPolicy: z.literal("server-invite"), createTime: z.literal("utc-or-all-day"), actions: z.tuple([z.literal("create")]) }).strict(),
    z
      .object({
        provider: z.literal("google"),
        calendarID: z.uuid(),
        sendUpdates: z.literal("all"),
      })
      .strict(),
    z
      .object({
        provider: z.literal("caldav"),
        calendarID: z.uuid(),
        notificationPolicy: z.literal("server-invite"),
        createTime: z.literal("utc-or-all-day"),
        organizerAddresses: z.array(organizerAddress).min(1).max(100).optional(),
      })
      .strict(),
  ],
);

/** Explicit validation rejection before organizer admission is attempted. */
export class OrganizerAdmissionRejectedError extends Error {
  readonly organizerAdmissionRejected = true;
}
