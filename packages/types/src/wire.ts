import { z } from "zod";
import { AnnouncementsResponseSchema } from "./announcement";
import { CalendarInvitePreviewSchema, CalendarSchema } from "./calendar";
import {
  EventSchema,
  EventCreateRequestSchema,
  EventPatchRequestSchema,
  EventDeleteRequestSchema,
  EventUnlinkRequestSchema,
  EventLinkRequestSchema,
  EventForkRequestSchema,
  EventTimeEditRequestSchema,
  ScopeEditIntentSchema,
} from "./event";
import { InviteSchema } from "./invite";
import { EventDeliveryInboxSchema, EventDeliverySchema, EventDeliveryConflictSchema, ResolveEventDeliveryRequestSchema } from "./event_delivery";
import { PageDocumentSchema } from "./pages";
import {
  PutReminderRequestSchema,
  RemindersDocumentSchema,
} from "./reminder";
import {
  PatchSettingsRequestSchema,
  SettingsDocumentSchema,
  SettingsSchema,
} from "./settings";
import { UserSchema } from "./user";
import { PRODUCT_VERSION } from "./version";
import {
  TaskSchema, TaskListResponseSchema, TaskCreateSchema, TaskPatchRequestSchema,
  TaskLinkRequestSchema, TaskForkRequestSchema, TaskDeleteRequestSchema, TaskReplaceRequestSchema,
  TaskMutationResponseSchema, TaskDeleteResponseSchema, TaskDeliverySchema,
  TaskDeliveryInboxSchema, TaskClientUpgradeRequiredSchema,
} from "./task";

/**
 * Which way a document crosses the wire, because "breaking" is not symmetric.
 *
 * A response the server sends may gain fields — a client ignores what it does
 * not know — but may not lose one or start omitting it. A request the server
 * accepts may gain OPTIONAL fields only: a new required field rejects every
 * client built before it, and so does tightening what is already there.
 */
export type WireDirection = "read" | "write";

export const WIRE_CONTRACT: Record<
  string,
  { direction: WireDirection; schema: z.ZodType }
> = {
  AnnouncementsResponse: {
    direction: "read",
    schema: AnnouncementsResponseSchema,
  },
  Calendar: { direction: "read", schema: CalendarSchema },
  CalendarInvitePreview: {
    direction: "read",
    schema: CalendarInvitePreviewSchema,
  },
  Event: { direction: "read", schema: EventSchema },
  EventDeliveryInbox: { direction: "read", schema: EventDeliveryInboxSchema },
  EventDelivery: { direction: "read", schema: EventDeliverySchema },
  EventDeliveryConflict: { direction: "read", schema: EventDeliveryConflictSchema },
  ResolveEventDeliveryRequest: { direction: "write", schema: ResolveEventDeliveryRequestSchema },
  EventCreateRequest: { direction: "write", schema: EventCreateRequestSchema },
  EventPatchRequest: { direction: "write", schema: EventPatchRequestSchema },
  EventTimeEditRequest: { direction: "write", schema: EventTimeEditRequestSchema },
  EventDeleteRequest: { direction: "write", schema: EventDeleteRequestSchema },
  EventUnlinkRequest: { direction: "write", schema: EventUnlinkRequestSchema },
  EventLinkRequest: { direction: "write", schema: EventLinkRequestSchema },
  EventForkRequest: { direction: "write", schema: EventForkRequestSchema },
  ScopeEditIntent: { direction: "write", schema: ScopeEditIntentSchema },
  Invite: { direction: "read", schema: InviteSchema },
  PageDocument: { direction: "read", schema: PageDocumentSchema },
  PatchSettingsRequest: {
    direction: "write",
    schema: PatchSettingsRequestSchema,
  },
  PutReminderRequest: { direction: "write", schema: PutReminderRequestSchema },
  RemindersDocument: { direction: "read", schema: RemindersDocumentSchema },
  Settings: { direction: "read", schema: SettingsSchema },
  SettingsDocument: { direction: "read", schema: SettingsDocumentSchema },
  User: { direction: "read", schema: UserSchema },
  Task: { direction: "read", schema: TaskSchema },
  TaskListResponse: { direction: "read", schema: TaskListResponseSchema },
  TaskCreateRequest: { direction: "write", schema: TaskCreateSchema },
  TaskPatchRequest: { direction: "write", schema: TaskPatchRequestSchema },
  TaskReplaceRequest: { direction: "write", schema: TaskReplaceRequestSchema },
  TaskLinkRequest: { direction: "write", schema: TaskLinkRequestSchema },
  TaskForkRequest: { direction: "write", schema: TaskForkRequestSchema },
  TaskDeleteRequest: { direction: "write", schema: TaskDeleteRequestSchema },
  TaskMutationResponse: { direction: "read", schema: TaskMutationResponseSchema },
  TaskDeleteResponse: { direction: "read", schema: TaskDeleteResponseSchema },
  TaskDelivery: { direction: "read", schema: TaskDeliverySchema },
  TaskDeliveryInbox: { direction: "read", schema: TaskDeliveryInboxSchema },
  TaskClientUpgradeRequired: { direction: "read", schema: TaskClientUpgradeRequiredSchema },
};

export type WireSnapshot = {
  documents: Record<string, { direction: WireDirection; schema: unknown }>;
  /** The release this shape was promised at. Bumped only by a re-baseline. */
  version: string;
};

/**
 * The current shape of every document above, as JSON Schema.
 *
 * Always the INPUT shape, for readers as much as writers: what travels is
 * JSON, and the question this file answers is whether the JSON one side sends
 * still parses on the other. `z.coerce.date()` is the clearest case — its
 * output is a `Date`, which no wire carries and no JSON Schema can describe,
 * while its input is the string that actually goes over the socket.
 */
export function wireSnapshot(): WireSnapshot {
  const documents: WireSnapshot["documents"] = {};
  for (const [name, entry] of Object.entries(WIRE_CONTRACT)) {
    documents[name] = {
      direction: entry.direction,
      schema: describe(entry.schema),
    };
  }
  return { documents, version: PRODUCT_VERSION };
}

function describe(schema: z.ZodType): z.core.JSONSchema.JSONSchema {
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (context) => {
      // `z.coerce.date()` parses to a `Date`, which no JSON Schema can name and
      // no socket carries. What it accepts is the timestamp string, so that is
      // what the contract records.
      if (context.zodSchema._zod.def.type === "date") {
        Object.assign(context.jsonSchema, {
          format: "date-time",
          type: "string",
        });
      }
    },
  });

  // `unrepresentable: "any"` turns anything the converter cannot describe into
  // `{}`, which compares equal to every future shape — the document would be
  // waved through for the rest of its life. Better to fail here and either
  // teach `override` about the type or keep it off the wire.
  assertNothingEmpty(json, "");
  return json;
}

function assertNothingEmpty(node: unknown, path: string) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNothingEmpty(item, `${path}[${index}]`));
    return;
  }
  if (!node || typeof node !== "object") return;

  const entries = Object.entries(node as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(
      `Wire contract: ${path || "<root>"} came out as an empty schema. ` +
        "Teach `override` in packages/types/src/wire.ts how to describe it.",
    );
  }
  for (const [key, value] of entries) {
    assertNothingEmpty(value, path ? `${path}.${key}` : key);
  }
}
