import { z } from "zod";
import {
  SYNC_PROFILE_V1,
  SyncFamilyKindSchema,
  SyncOperationSchema,
  SyncProfileSchema,
  SyncProviderIdSchema,
  SyncRoleSchema,
  SyncWriteGuaranteeSchema,
  type SyncCapabilityContext,
  type SyncWriteGuarantee,
} from "@musubi/types";

/** Describes existing endpoint boundaries. This inventory is not an authority
 * resolver and is deliberately not wired into admission or provider dispatch.
 * Specialized recurrence, meeting, RSVP, reminder and move transports keep
 * their own evidence/feature gates; absence here does not remove those writers.
 */
export const CurrentSyncEndpointProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]+-v1$/),
  profile: SyncProfileSchema,
  provider: SyncProviderIdSchema,
  family: SyncFamilyKindSchema.extract(["personal-single", "task"]),
  operation: SyncOperationSchema.extract(["create", "update", "delete"]),
  endpoint: z.string().min(1),
  requiredScopes: z.array(z.string().min(1)),
  /** Every item is a prerequisite, not evidence supplied by this manifest. */
  requiredEvidence: z.array(z.string().min(1)).min(1),
  roles: z.array(SyncRoleSchema.exclude(["reader", "unknown", "attendee"])).min(1),
  validator: z.enum(["none", "strong-etag", "native-weak-etag", "resource-must-not-exist"]),
  support: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("profiled"), guarantee: SyncWriteGuaranteeSchema }).strict(),
    z.object({
      kind: z.literal("unsupported-portability"),
      reason: z.enum(["conditional-write-unproven", "unsafe-uncertain-create"]),
      /** Existing home methods are not silently relabelled as proven CAS. */
      legacyBehavior: z.string().min(1),
    }).strict(),
  ]),
  createIdentity: z.object({
    kind: z.enum(["google-client-id", "dav-operation-url-uid", "graph-transaction-id", "dav-task-url-uid", "provider-assigned"]),
    binding: z.enum(["operation", "host-object", "response-address"]),
    evidence: z.string().min(1),
  }).strict().optional(),
  recovery: z.object({
    policy: z.enum(["observe-before-same-identity-create", "observe-before-conditional-retry", "observe-only", "legacy-only-unproven"]),
    evidence: z.array(z.string().min(1)).min(1),
  }).strict(),
  restrictions: z.array(z.string().min(1)).min(1),
  /** Repository paths to implementation and bounded evidence, not live certification. */
  sources: z.array(z.string().regex(/^(?:apps|packages|docs)\/[a-zA-Z0-9_./-]+\.(?:ts|md)$/)).min(1),
  primaryReferences: z.array(z.url()).default([]),
}).strict().superRefine((value, ctx) => {
  if ((value.operation === "create") !== (value.createIdentity !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["createIdentity"], message: "Only CREATE has a create identity contract" });
  }
  if (value.support.kind === "profiled" && value.support.guarantee.kind === "read-only") {
    ctx.addIssue({ code: "custom", path: ["support", "guarantee"], message: "A write endpoint cannot claim a read-only guarantee" });
  }
});
export type CurrentSyncEndpointProfile = z.infer<typeof CurrentSyncEndpointProfileSchema>;

const googleEvents = "https://www.googleapis.com/auth/calendar.events";
const googleTasks = "https://www.googleapis.com/auth/tasks";
const admission = ["Current captured connection/collection and host admission authority; source/privacy retirement and live lease remain host fences."];
const personal = ["Only this generic personal single-event path; known civil time models, recurrence and meetings use separate specialized transports."];
const task = ["A secondary recurring-task projection is refused; richer canonical fields and home authority remain host owned."];
const conditionalRecovery = ["Observe accepted projected content or scoped absence before retry; never adopt a newer validator or retry a 412 unconditionally."];
const taskConditionalRecovery = ["Observe accepted patch or scoped absence before retry; retain the accepted baseline and exact validator, never silently rebase."];
const eventSources = ["apps/api/src/sync/event_delivery.ts", "docs/sync/event-write-boundary.md"];
const taskSources = ["apps/api/src/sync/task_delivery.ts", "docs/sync/shared-tasks.md"];

type Definition = Omit<CurrentSyncEndpointProfile, "profile" | "support" | "roles" | "primaryReferences"> & {
  roles: readonly CurrentSyncEndpointProfile["roles"][number][];
  guarantee?: SyncWriteGuarantee;
  legacyBehavior?: string;
  unsupportedReason?: "conditional-write-unproven" | "unsafe-uncertain-create";
  primaryReferences?: string[];
};
function define(value: Definition): CurrentSyncEndpointProfile {
  const { guarantee, legacyBehavior, unsupportedReason, ...fields } = value;
  return CurrentSyncEndpointProfileSchema.parse({
    ...fields, profile: SYNC_PROFILE_V1,
    support: guarantee ? { kind: "profiled", guarantee } : {
      kind: "unsupported-portability", reason: unsupportedReason ?? "conditional-write-unproven", legacyBehavior,
    },
  });
}
function conditional(endpointProfile: string, validatorKind: "etag" | "resource-must-not-exist" = "etag"): SyncWriteGuarantee {
  return { kind: "conditional", validatorKind, endpointProfile };
}
function singleSend(endpointProfile: string): SyncWriteGuarantee {
  return { kind: "non-idempotent-action", endpointProfile, uncertainReplay: "observe-only" };
}

const definitions: Definition[] = [
  {
    id: "google-personal-event-create-v1", provider: "google", family: "personal-single", operation: "create",
    endpoint: "POST /calendar/v3/calendars/{calendarId}/events", requiredScopes: [googleEvents], roles: ["personal-owner", "shared-writer"], validator: "none",
    requiredEvidence: [...admission, "Fresh calendarList accessRole is owner or writer; the refreshed OAuth grant still has the calendar events write scope."],
    unsupportedReason: "unsafe-uncertain-create",
    legacyBehavior: "Existing event delivery uses exact client ID/private marker, retained deletion evidence and scoped absence before same-identity recovery. This descriptor preserves that implementation but does not certify portable provider idempotency.",
    createIdentity: { kind: "google-client-id", binding: "operation", evidence: "Persisted operation UUID derives musubi{UUID-without-hyphens}; private musubiOperationID must match the same operation." },
    recovery: { policy: "legacy-only-unproven", evidence: ["Existing legacy recovery GETs the exact derived ID and requires active content plus exact private operation marker; retained deletion or 410 is conflict. Only scoped absence reaches the existing same-identity path."] },
    restrictions: [...personal, "Google's insert reference disclaims guaranteed ID collision detection at creation. Client ID guidance is not portable exactly-once or atomic collision proof."], sources: ["apps/api/src/sync/adapters/google.ts", "apps/api/src/sync/event_create_identity.ts", "docs/sync/event-create-recovery.md", ...eventSources],
    primaryReferences: ["https://developers.google.com/workspace/calendar/api/guides/create-events", "https://developers.google.com/workspace/calendar/api/v3/reference/events/insert"],
  },
  ...(["update", "delete"] as const).map(operation => ({
    id: `google-personal-event-${operation}-v1`, provider: "google", family: "personal-single" as const, operation,
    endpoint: `${operation === "update" ? "PATCH" : "DELETE"} /calendar/v3/calendars/{calendarId}/events/{eventId}`,
    requiredScopes: [googleEvents], roles: ["personal-owner", "shared-writer"] as const, validator: "strong-etag" as const,
    requiredEvidence: [...admission, "Fresh calendarList owner/writer grant and exact accepted strong ETag; organizer self evidence for update. Guest-notifying organizer copies use explicit organizer actions."],
    guarantee: conditional(`google-personal-event-${operation}-v1`),
    recovery: { policy: "observe-before-conditional-retry" as const, evidence: conditionalRecovery },
    restrictions: [...personal, "The adapter's separate attendee-copy DELETE behavior is outside this personal-only profile."],
    sources: ["apps/api/src/sync/adapters/google.ts", ...eventSources],
  })),
  {
    id: "google-task-create-v1", provider: "google", family: "task", operation: "create",
    endpoint: "POST /tasks/v1/lists/{listId}/tasks", requiredScopes: [googleTasks], roles: ["personal-owner"], validator: "none",
    requiredEvidence: [...admission, "Verified Google Tasks list identity and Tasks grant after token refresh."],
    guarantee: singleSend("google-task-create-v1"),
    createIdentity: { kind: "provider-assigned", binding: "response-address", evidence: "Only a captured successful response supplies the task address; no client-assigned task ID is assumed." },
    recovery: { policy: "observe-only", evidence: ["A captured response address may be read and its accepted projection compared; an uncertain CREATE without an address is never posted again."] },
    restrictions: [...task, "Assigned Docs/Spaces tasks are excluded. Google projects two states and a scheduled due day, not exact deadline time."],
    sources: ["apps/api/src/sync/adapters/google.ts", "apps/api/src/sync/task_write.test.ts", ...taskSources],
  },
  ...(["update", "delete"] as const).map(operation => ({
    id: `google-task-${operation}-v1`, provider: "google", family: "task" as const, operation,
    endpoint: `${operation === "update" ? "PATCH" : "DELETE"} /tasks/v1/lists/{listId}/tasks/{taskId}`,
    requiredScopes: [googleTasks], roles: ["personal-owner"] as const, validator: "strong-etag" as const,
    requiredEvidence: [...admission, "Tasks grant after refresh, verified list/task identity, no assignmentInfo, current accepted projection baseline and exact strong ETag."],
    guarantee: conditional(`google-task-${operation}-v1`),
    recovery: { policy: "observe-before-conditional-retry" as const, evidence: taskConditionalRecovery },
    restrictions: [...task, "Only title, notes, two-state status and date-only due fields are projected."],
    sources: ["apps/api/src/sync/adapters/google.ts", "apps/api/src/sync/task_write.test.ts", ...taskSources],
  })),
  {
    id: "microsoft-personal-event-create-v1", provider: "microsoft", family: "personal-single", operation: "create",
    endpoint: "POST /v1.0/me/calendars/{calendarId}/events", requiredScopes: ["Calendars.ReadWrite"], roles: ["personal-owner", "shared-writer"], validator: "none",
    requiredEvidence: [...admission, "Fresh calendar canEdit=true and calendar write grant after token refresh."],
    guarantee: singleSend("microsoft-personal-event-create-v1"),
    createIdentity: { kind: "graph-transaction-id", binding: "operation", evidence: "The persisted operation UUID is transactionId correlation; Graph supplies the native event ID. No infinite deduplication window is assumed." },
    recovery: { policy: "observe-only", evidence: ["Complete bounded scoped listing must prove one matching transactionId and accepted content; zero matches or incomplete/ambiguous evidence never authorizes another POST."] },
    restrictions: personal, sources: ["apps/api/src/sync/adapters/microsoft.ts", "apps/api/src/sync/event_create_identity.ts", "docs/sync/event-create-recovery.md", ...eventSources],
  },
  {
    id: "microsoft-personal-event-update-v1", provider: "microsoft", family: "personal-single", operation: "update",
    endpoint: "PATCH /v1.0/me/calendars/{calendarId}/events/{eventId}", requiredScopes: ["Calendars.ReadWrite"], roles: ["personal-owner"], validator: "native-weak-etag",
    requiredEvidence: [...admission, "calendar.canEdit and owner equal /me identity; full native personal singleInstance, not draft/cancelled, no attendees, recurrence, parent or online meeting; exact native W/\"...\" @odata.etag."],
    guarantee: conditional("microsoft-personal-event-update-v1"),
    recovery: { policy: "observe-before-conditional-retry", evidence: conditionalRecovery },
    restrictions: [...personal, "Only changed title/notes/location; local color is no-op. Time edits and shared/delegated calendar updates are excluded. Native changeKey is not an ETag substitute.", "Conditional PATCH proof is bounded to the recorded personal-account endpoint probe; this is not universal Graph CAS certification."],
    sources: ["apps/api/src/sync/adapters/microsoft_event_content.ts", "apps/api/src/sync/adapters/microsoft_event_content.test.ts", "docs/audits/outlook-event-cas-20260921.md", ...eventSources],
  },
  {
    id: "microsoft-personal-event-delete-v1", provider: "microsoft", family: "personal-single", operation: "delete",
    endpoint: "DELETE /v1.0/me/calendars/{calendarId}/events/{eventId}", requiredScopes: ["Calendars.ReadWrite"], roles: ["personal-owner"], validator: "native-weak-etag",
    requiredEvidence: [...admission, "Owned writable calendar, complete personal single-event shape and exact native @odata.etag checked immediately before DELETE."],
    guarantee: { kind: "guarded-preflight", validatorKind: "etag", endpointProfile: "microsoft-personal-event-delete-v1", race: "read-write-gap", uncertainReplay: "observe-only" },
    recovery: { policy: "observe-only", evidence: ["A lost/ambiguous DELETE only reads afterward. Presence remains unconfirmed even at the same version; verified absence settles it. A new explicit resolution intent may send only on its first attempt."] },
    restrictions: [...personal, "Graph ignored stale If-Match in the recorded probe; a concurrent edit after the last GET can still be deleted. The header is best effort, not CAS.", "No shared/delegated calendar deletion, meeting cancellation, permanent deletion or blind replay."],
    sources: ["apps/api/src/sync/adapters/microsoft_event_content.ts", "apps/api/src/sync/adapters/microsoft_event_delete.test.ts", "docs/audits/outlook-guarded-delete-20260921.md", ...eventSources],
  },
  {
    id: "microsoft-task-create-v1", provider: "microsoft", family: "task", operation: "create",
    endpoint: "POST /v1.0/me/todo/lists/{listId}/tasks", requiredScopes: ["Tasks.ReadWrite"], roles: ["personal-owner"], validator: "none",
    requiredEvidence: [...admission, "Tasks grant after token refresh, exact To Do list identity and home/independent-copy destination; no secondary live projection."],
    guarantee: singleSend("microsoft-task-create-v1"),
    createIdentity: { kind: "provider-assigned", binding: "response-address", evidence: "A captured successful response supplies the native task ID; no client-generated task identity is assumed." },
    recovery: { policy: "observe-only", evidence: ["Only a captured response address and matching accepted projection allow recovery. An uncertain unaddressed CREATE is never posted again."] },
    restrictions: [...task, "Secondary live CREATE is refused even for an owned list; this profile describes existing home/independent-copy behavior."],
    sources: ["apps/api/src/sync/adapters/microsoft.ts", "apps/api/src/sync/adapters/microsoft_task_write.test.ts", ...taskSources],
  },
  ...(["update", "delete"] as const).map(operation => ({
    id: `microsoft-task-${operation}-v1`, provider: "microsoft", family: "task" as const, operation,
    endpoint: `${operation === "update" ? "PATCH" : "DELETE"} /v1.0/me/todo/lists/{listId}/tasks/{taskId}`,
    requiredScopes: ["Tasks.ReadWrite"], roles: ["personal-owner"] as const, validator: "native-weak-etag" as const,
    requiredEvidence: [...admission, "A response ETag or preflight comparison cannot prove To Do conditional-write enforcement."],
    legacyBehavior: "Existing home methods preserve their prior native ETag/If-Match strategy. This descriptor does not disable them or claim safe portable CAS; secondary writes remain refused.",
    recovery: { policy: "legacy-only-unproven" as const, evidence: ["The existing home executor retains its own recovery behavior. No portable conditional or observe-only guarantee is inferred from it."] },
    restrictions: [...task, "Portable UPDATE/DELETE and all secondary live writes are excluded pending endpoint-specific conditional-write proof."],
    sources: ["apps/api/src/sync/adapters/microsoft.ts", "apps/api/src/sync/adapters/microsoft_task_write.test.ts", ...taskSources],
  })),
  {
    id: "caldav-personal-event-create-v1", provider: "caldav", family: "personal-single", operation: "create",
    endpoint: "PUT {capturedCollectionURL}/musubi-{operationUUID}.ics", requiredScopes: [], roles: ["personal-owner", "shared-writer"], validator: "resource-must-not-exist",
    requiredEvidence: [...admission, "Exact collection DAV all/write/bind privilege; unknown or missing ACL is refused in this generic path."],
    guarantee: conditional("caldav-personal-event-create-v1", "resource-must-not-exist"),
    createIdentity: { kind: "dav-operation-url-uid", binding: "operation", evidence: "Persisted operation UUID fixes resource URL and UID musubi-{operationUUID}; create uses If-None-Match: *." },
    recovery: { policy: "observe-before-same-identity-create", evidence: ["GET exact derived URL and require matching UID plus active admitted projection; retained deletion blocks recreation. Only verified absence permits another conditional PUT at the same address."] },
    restrictions: [...personal, "This profile does not extend iCloud missing-ACL compatibility from separate specialized personal-content transports."],
    sources: ["apps/api/src/sync/adapters/caldav.ts", "apps/api/src/sync/event_create_identity.ts", "apps/api/src/sync/caldav_privileges.ts", "docs/sync/event-create-recovery.md", ...eventSources],
  },
  ...(["update", "delete"] as const).map(operation => ({
    id: `caldav-personal-event-${operation}-v1`, provider: "caldav", family: "personal-single" as const, operation,
    endpoint: `${operation === "update" ? "PUT" : "DELETE"} {capturedResourceURL}`,
    requiredScopes: [], roles: ["personal-owner", "shared-writer"] as const, validator: "strong-etag" as const,
    requiredEvidence: [...admission, operation === "update" ? "Exact resource DAV all/write/write-content privilege and complete accepted UID/strong ETag resource; preserving component patch." : "Exact collection DAV all/write/unbind privilege and accepted UID/strong ETag resource.", "If ORGANIZER exists, self principal identity must be proven; organizer meetings and ambiguous shared attendee identity are refused."],
    guarantee: conditional(`caldav-personal-event-${operation}-v1`),
    recovery: { policy: "observe-before-conditional-retry" as const, evidence: conditionalRecovery },
    restrictions: [...personal, "Preserve provider-owned properties/components and native zones. This generic profile has no missing-ACL fallback."],
    sources: ["apps/api/src/sync/adapters/caldav.ts", "apps/api/src/sync/caldav_privileges.ts", ...eventSources],
  })),
  {
    id: "caldav-task-create-v1", provider: "caldav", family: "task", operation: "create",
    endpoint: "PUT {capturedCollectionURL}/{taskUUID}.ics", requiredScopes: [], roles: ["personal-owner", "shared-writer"], validator: "resource-must-not-exist",
    requiredEvidence: [...admission, "Connected account ownership, verified VTODO collection, exact collection DAV read and all/write/bind privilege."],
    guarantee: conditional("caldav-task-create-v1", "resource-must-not-exist"),
    createIdentity: { kind: "dav-task-url-uid", binding: "host-object", evidence: "Canonical task UUID fixes URL filename and UID; PUT uses If-None-Match: *. This differs from event operation-derived identity." },
    recovery: { policy: "observe-only", evidence: ["Read deterministic task URL, verify UID and accepted projection. Existing executor keeps absent or mismatching uncertain CREATE unconfirmed rather than sending another PUT."] },
    restrictions: [...task, "Task timestamps project at wire second precision; canonical precision remains unchanged."],
    sources: ["apps/api/src/sync/adapters/caldav.ts", "apps/api/src/sync/caldav_privileges.ts", "apps/api/src/sync/task_write.test.ts", ...taskSources],
  },
  ...(["update", "delete"] as const).map(operation => ({
    id: `caldav-task-${operation}-v1`, provider: "caldav", family: "task" as const, operation,
    endpoint: `${operation === "update" ? "PUT" : "DELETE"} {capturedResourceURL}`,
    requiredScopes: [], roles: ["personal-owner", "shared-writer"] as const, validator: "strong-etag" as const,
    requiredEvidence: [...admission, "Connected account ownership, verified VTODO support and explicit DAV read privilege.", operation === "update" ? "Exact resource all/write/write-content privilege; scoped URL/UID and exact accepted strong ETag plus projection baseline." : "Exact collection all/write/unbind privilege; scoped URL/UID and exact accepted strong ETag."],
    guarantee: conditional(`caldav-task-${operation}-v1`),
    recovery: { policy: "observe-before-conditional-retry" as const, evidence: taskConditionalRecovery },
    restrictions: [...task, "Preserve native alarms, unrelated properties/components and zones when patching the resource."],
    sources: ["apps/api/src/sync/adapters/caldav.ts", "apps/api/src/sync/caldav_privileges.ts", "apps/api/src/sync/task_write.test.ts", ...taskSources],
  })),
];

export const CURRENT_SYNC_ENDPOINT_PROFILES: readonly CurrentSyncEndpointProfile[] = Object.freeze(definitions.map(define));

/** Exact descriptive lookup only. The caller must still prove every runtime
 * role/scope/native/source prerequisite through the existing host/adapter gates.
 * Missing/unknown profiles and unlisted families never fall back to a generic writer.
 */
export function findCurrentSyncEndpointProfile(
  selector: Pick<SyncCapabilityContext, "family" | "operation"> & {
    provider: SyncCapabilityContext["locator"]["provider"];
    profile: unknown;
  },
): CurrentSyncEndpointProfile | undefined {
  if (selector.profile !== SYNC_PROFILE_V1) return undefined;
  return CURRENT_SYNC_ENDPOINT_PROFILES.find(value => value.provider === selector.provider &&
    value.family === selector.family && value.operation === selector.operation);
}
