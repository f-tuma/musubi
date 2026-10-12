import { z } from "zod";
import { CivilDateTimeSchema, EventTimeZoneSchema, OccurrenceStartSchema } from "./event_time";

/** Semantic profile only. An operation envelope has its own schema/serializer version. */
export const SYNC_PROFILE_V1 = "sync-profile-v1" as const;
export const SyncProfileSchema = z.literal(SYNC_PROFILE_V1);
export function classifySyncProfile(value: unknown): "supported" | "unsupported" {
  return value === SYNC_PROFILE_V1 ? "supported" : "unsupported";
}

const OpaqueIdSchema = z.string().min(1).max(2048);
export const SyncConnectionIdSchema = OpaqueIdSchema.brand<"SyncConnectionId">();
export const SyncCollectionIdSchema = OpaqueIdSchema.brand<"SyncCollectionId">();
export const SyncHostObjectIdSchema = OpaqueIdSchema.brand<"SyncHostObjectId">();
export const SyncFamilyIdSchema = OpaqueIdSchema.brand<"SyncFamilyId">();
export const SyncCommandIdSchema = OpaqueIdSchema.brand<"SyncCommandId">();
export const SyncOperationIdSchema = OpaqueIdSchema.brand<"SyncOperationId">();
export const SyncAttemptIdSchema = OpaqueIdSchema.brand<"SyncAttemptId">();
export const SyncSourceEpochSchema = z.object({
  sourceId: OpaqueIdSchema,
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type SyncSourceEpoch = z.infer<typeof SyncSourceEpochSchema>;
export const SyncProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const SyncProviderLocatorSchema = z.object({
  provider: SyncProviderIdSchema,
  connectionId: SyncConnectionIdSchema,
  collectionId: SyncCollectionIdSchema,
  /** Exact resource address/native ID; neither a UID nor a display name. */
  resourceId: OpaqueIdSchema,
}).strict();
export type SyncProviderLocator = z.infer<typeof SyncProviderLocatorSchema>;

export function scopedProviderLocatorKey(locator: SyncProviderLocator): string {
  const value = SyncProviderLocatorSchema.parse(locator);
  return JSON.stringify([value.provider, value.connectionId, value.collectionId, value.resourceId]);
}

export const SyncOccurrenceIdentitySchema = z.object({
  familyId: SyncFamilyIdSchema,
  originalStart: OccurrenceStartSchema,
}).strict();
export type SyncOccurrenceIdentity = z.infer<typeof SyncOccurrenceIdentitySchema>;
export function syncOccurrenceKey(identity: SyncOccurrenceIdentity): string {
  const value = SyncOccurrenceIdentitySchema.parse(identity);
  return JSON.stringify([value.familyId, value.originalStart.kind, value.originalStart.value]);
}

export const SyncObjectIdentitySchema = z.object({
  hostObjectId: SyncHostObjectIdSchema,
  locator: SyncProviderLocatorSchema,
  /** Correlation evidence only; the same UID can exist in many connections. */
  uid: OpaqueIdSchema.optional(),
  familyId: SyncFamilyIdSchema.optional(),
  occurrence: SyncOccurrenceIdentitySchema.optional(),
}).strict().refine(value => value.occurrence == null || value.occurrence.familyId === value.familyId, {
  message: "An occurrence must identify its containing family",
});
export const SyncOperationIdentitySchema = z.object({
  commandId: SyncCommandIdSchema,
  operationId: SyncOperationIdSchema,
  /** Changes for each attempt; operationId stays stable across recovery. */
  attemptId: SyncAttemptIdSchema.optional(),
}).strict();
export type SyncObjectIdentity = z.infer<typeof SyncObjectIdentitySchema>;
export type SyncOperationIdentity = z.infer<typeof SyncOperationIdentitySchema>;

export const SyncInstantSchema = OccurrenceStartSchema.options[0].shape.value;
const InstantIntervalSchema = z.object({
  start: SyncInstantSchema,
  end: SyncInstantSchema,
}).strict().refine(value => value.start <= value.end, { message: "End instant precedes start" });

export const SyncDateIntervalSchema = z.object({
  startDate: z.iso.date(),
  endDateExclusive: z.iso.date(),
}).strict().refine(value => value.startDate < value.endDateExclusive, {
  message: "DATE interval requires an exclusive end after its start",
});
export type SyncDateInterval = z.infer<typeof SyncDateIntervalSchema>;
export const MusubiInclusiveDateIntervalSchema = z.object({
  startDate: z.iso.date(),
  endDateInclusive: z.iso.date(),
}).strict().refine(value => value.startDate <= value.endDateInclusive, {
  message: "Inclusive end date precedes start",
});
export type MusubiInclusiveDateInterval = z.infer<typeof MusubiInclusiveDateIntervalSchema>;

function shiftDate(value: string, days: 1 | -1): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  // Out-of-profile extended years fail explicitly, rather than wrap or truncate.
  return z.iso.date().parse(date.toISOString().split("T")[0]);
}
export function musubiInclusiveDatesToSync(value: MusubiInclusiveDateInterval): SyncDateInterval {
  const parsed = MusubiInclusiveDateIntervalSchema.parse(value);
  return SyncDateIntervalSchema.parse({
    startDate: parsed.startDate, endDateExclusive: shiftDate(parsed.endDateInclusive, 1),
  });
}
export function syncDatesToMusubiInclusive(value: SyncDateInterval): MusubiInclusiveDateInterval {
  const parsed = SyncDateIntervalSchema.parse(value);
  return MusubiInclusiveDateIntervalSchema.parse({
    startDate: parsed.startDate, endDateInclusive: shiftDate(parsed.endDateExclusive, -1),
  });
}

export const SyncTimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("zoned"),
    timeZone: EventTimeZoneSchema,
    startLocal: CivilDateTimeSchema,
    endLocal: CivilDateTimeSchema,
    /** Preserve provider-observed fold/gap instants; never re-resolve silently. */
    resolved: InstantIntervalSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("floating"),
    startLocal: CivilDateTimeSchema,
    endLocal: CivilDateTimeSchema,
  }).strict().refine(value => value.startLocal <= value.endLocal, {
    message: "Floating end precedes start",
  }),
  z.object({ kind: z.literal("date"), ...SyncDateIntervalSchema.shape }).strict()
    .refine(value => value.startDate < value.endDateExclusive, {
      message: "DATE interval requires an exclusive end after its start",
    }),
  z.object({
    kind: z.literal("legacy-unknown"),
    /** Existing instants are preserved without inventing a zone or DATE meaning. */
    observed: InstantIntervalSchema,
  }).strict(),
]);
export type SyncTime = z.infer<typeof SyncTimeSchema>;

export const SyncRecurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single") }).strict(),
  z.object({
    kind: z.literal("series"), familyId: SyncFamilyIdSchema,
    /** Preserved RFC property values; parsing these does not grant write support. */
    rules: z.array(z.string().min(1).max(8192)),
    inclusions: z.array(OccurrenceStartSchema),
    exclusions: z.array(OccurrenceStartSchema),
    overrides: z.array(z.object({
      originalStart: OccurrenceStartSchema,
      cancelled: z.boolean(),
      time: SyncTimeSchema.optional(),
    }).strict()),
    completeness: z.enum(["complete", "partial", "unknown"]),
  }).strict(),
  z.object({
    kind: z.literal("unrepresented"), familyId: SyncFamilyIdSchema,
    reason: z.string().min(1).max(255),
  }).strict(),
]);
export type SyncRecurrence = z.infer<typeof SyncRecurrenceSchema>;

export const SyncOperationSchema = z.enum([
  "list", "read", "create", "update", "delete", "rsvp", "organizer-update", "move", "split-following",
]);
export const SyncRoleSchema = z.enum(["personal-owner", "organizer", "attendee", "shared-writer", "reader", "unknown"]);
export const SyncFamilyKindSchema = z.enum([
  "personal-single", "recurring-master", "recurring-occurrence", "recurring-following", "meeting", "task", "unknown",
]);
export const SyncCapabilityContextSchema = z.object({
  locator: SyncProviderLocatorSchema,
  sourceEpoch: SyncSourceEpochSchema,
  operation: SyncOperationSchema,
  role: SyncRoleSchema,
  scopeKnowledge: z.enum(["known", "unknown"]),
  grantedScopes: z.array(z.string().min(1).max(2048)),
  family: SyncFamilyKindSchema,
}).strict();
export type SyncCapabilityContext = z.infer<typeof SyncCapabilityContextSchema>;

export const SyncValidatorKindSchema = z.enum(["etag", "change-key", "sequence", "resource-must-not-exist"]);
export const SyncValidatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("etag"), value: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("change-key"), value: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("sequence"), value: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("resource-must-not-exist") }).strict(),
]);
export type SyncValidator = z.infer<typeof SyncValidatorSchema>;

export const SyncWriteGuaranteeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read-only") }).strict(),
  z.object({
    kind: z.literal("conditional"), validatorKind: SyncValidatorKindSchema,
    /** Verified endpoint/operation profile, not inferred from a response ETag. */
    endpointProfile: OpaqueIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("guarded-preflight"), validatorKind: SyncValidatorKindSchema,
    endpointProfile: OpaqueIdSchema, race: z.literal("read-write-gap"),
    uncertainReplay: z.literal("observe-only"),
  }).strict(),
  z.object({
    kind: z.literal("provider-idempotency"), endpointProfile: OpaqueIdSchema,
    keyScope: z.enum(["connection", "collection"]), uncertainReplay: z.literal("same-key"),
  }).strict(),
  z.object({
    kind: z.literal("non-idempotent-action"), endpointProfile: OpaqueIdSchema,
    uncertainReplay: z.literal("observe-only"),
  }).strict(),
]);
export type SyncWriteGuarantee = z.infer<typeof SyncWriteGuaranteeSchema>;

export const SyncCapabilityDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("allowed"), context: SyncCapabilityContextSchema,
    profile: SyncProfileSchema, guarantee: SyncWriteGuaranteeSchema,
  }).strict(),
  z.object({
    kind: z.literal("denied"), context: SyncCapabilityContextSchema,
    reason: z.enum(["insufficient-scope", "read-only", "organizer-required", "source-retired", "identity-unverified"]),
  }).strict(),
  z.object({
    kind: z.literal("unknown"), context: SyncCapabilityContextSchema,
    reason: z.enum(["permission-unknown", "provider-behavior-unverified", "family-evidence-incomplete"]),
  }).strict(),
  z.object({
    kind: z.literal("unsupported"), context: SyncCapabilityContextSchema,
    reason: z.enum(["unsupported-operation", "unsupported-time-model", "unsupported-recurrence", "conditional-write-unproven", "unsafe-uncertain-create"]),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind !== "allowed") return;
  const read = value.context.operation === "read" || value.context.operation === "list";
  if (read !== (value.guarantee.kind === "read-only")) {
    ctx.addIssue({ code: "custom", path: ["guarantee"], message: "Read and write guarantees are distinct" });
  }
  if (!read && (value.context.scopeKnowledge === "unknown" || value.context.role === "unknown" ||
    value.context.role === "reader" || value.context.family === "unknown")) {
    ctx.addIssue({ code: "custom", path: ["context"], message: "Unknown write permission cannot be allowed" });
  }
});
export type SyncCapabilityDecision = z.infer<typeof SyncCapabilityDecisionSchema>;

export const SyncReadScopeSchema = z.object({
  provider: SyncProviderIdSchema,
  connectionId: SyncConnectionIdSchema,
  collectionId: SyncCollectionIdSchema,
  sourceEpoch: SyncSourceEpochSchema,
  /** Includes filters, read profile, family selection and access/discovery shape. */
  configurationFingerprint: OpaqueIdSchema,
}).strict();
export type SyncReadScope = z.infer<typeof SyncReadScopeSchema>;
export function syncReadScopeKey(scope: SyncReadScope): string {
  const value = SyncReadScopeSchema.parse(scope);
  return JSON.stringify([value.provider, value.connectionId, value.collectionId,
    value.sourceEpoch.sourceId, value.sourceEpoch.generation, value.configurationFingerprint]);
}

export const SyncCoverageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("incremental") }).strict(),
  z.object({
    kind: z.literal("window"), fromInclusive: SyncInstantSchema, untilExclusive: SyncInstantSchema,
    /** Complete paging of this window still does not mean complete inventory. */
    complete: z.boolean(),
  }).strict().refine(value => value.fromInclusive < value.untilExclusive, { message: "Empty or inverted read window" }),
  z.object({ kind: z.literal("partial"), reason: z.enum(["pagination", "permissions", "filter", "provider-incomplete", "unknown"]) }).strict(),
  z.object({ kind: z.literal("collection-inventory-complete"), snapshotId: OpaqueIdSchema }).strict(),
]);
export type SyncCoverage = z.infer<typeof SyncCoverageSchema>;

export const SyncDeletionEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider-tombstone"), evidenceId: OpaqueIdSchema, nativeReadProfile: OpaqueIdSchema }).strict(),
  z.object({ kind: z.literal("conditional-delete-accepted"), operationId: SyncOperationIdSchema }).strict(),
  z.object({
    kind: z.literal("scoped-native-absence"), responseStatus: z.union([z.literal(404), z.literal(410)]),
    /** Adapter has established current resource-read authority; generic 404 is insufficient. */
    readAuthorityVerified: z.literal(true), nativeReadProfile: OpaqueIdSchema,
  }).strict(),
]);
export const SyncObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("present"), observationId: OpaqueIdSchema, locator: SyncProviderLocatorSchema,
    validator: SyncValidatorSchema.optional(), uid: OpaqueIdSchema.optional(),
    time: SyncTimeSchema.optional(), recurrence: SyncRecurrenceSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("resource-absent"), observationId: OpaqueIdSchema, locator: SyncProviderLocatorSchema,
    /** No permission to tombstone a host object or fan out provider DELETEs. */
    reason: z.enum(["window-removal", "inventory-absence", "access-retired", "unknown"]),
  }).strict(),
  z.object({
    kind: z.literal("deletion-proven"), observationId: OpaqueIdSchema, locator: SyncProviderLocatorSchema,
    evidence: SyncDeletionEvidenceSchema,
  }).strict(),
]);
export type SyncObservation = z.infer<typeof SyncObservationSchema>;

export const SyncReadBatchSchema = z.object({
  profile: SyncProfileSchema, scope: SyncReadScopeSchema,
  runId: OpaqueIdSchema, observations: z.array(SyncObservationSchema), coverage: SyncCoverageSchema,
  continuation: OpaqueIdSchema.optional(),
  /** Opaque and scope-bound; acceptance is atomic with apply or durable replayable staging. */
  checkpoint: OpaqueIdSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.coverage.kind === "collection-inventory-complete" ||
    (value.coverage.kind === "window" && value.coverage.complete)) && value.continuation != null) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "An unfinished page cannot certify complete inventory" });
  }
  for (const [index, observation] of value.observations.entries()) {
    if (observation.locator.provider !== value.scope.provider ||
      observation.locator.connectionId !== value.scope.connectionId ||
      observation.locator.collectionId !== value.scope.collectionId) {
      ctx.addIssue({ code: "custom", path: ["observations", index, "locator"], message: "Observation is outside the read scope" });
    }
  }
});
export type SyncReadBatch = z.infer<typeof SyncReadBatchSchema>;

/** A provider credential/receipt conveys no host write authority. */
export const SyncHostAuthoritySchema = z.object({
  hostId: OpaqueIdSchema, hostObjectId: SyncHostObjectIdSchema,
  expectedLocalRevision: OpaqueIdSchema.nullable(), privacyEpoch: OpaqueIdSchema,
  sourceScope: SyncReadScopeSchema,
}).strict();
export type SyncHostAuthority = z.infer<typeof SyncHostAuthoritySchema>;

export type SyncSourceRevalidation = { kind: "current" } | { kind: "changed" | "retired" };
export interface SyncApplyTransactionPort {
  /** Must run under the same lifecycle fence/transaction as applyBatch. */
  revalidateSource(scope: SyncReadScope): Promise<SyncSourceRevalidation>;
  /** Atomically reconciles observations and accepts checkpoint/staging; host owns ACL/privacy/CAS. */
  applyBatch(batch: SyncReadBatch): Promise<void>;
}
export interface SyncHostApplyPort {
  /** Serializes source retirement/config changes, rolls back all effects when body throws. */
  withSourceTransaction<T>(scope: SyncReadScope, body: (transaction: SyncApplyTransactionPort) => Promise<T>): Promise<T>;
}
export type SyncApplyResult = { kind: "applied" } | { kind: "rejected-source"; reason: "changed" | "retired" };
export async function applySyncReadBatch(host: SyncHostApplyPort, input: SyncReadBatch): Promise<SyncApplyResult> {
  const batch = SyncReadBatchSchema.parse(input);
  return host.withSourceTransaction(batch.scope, async transaction => {
    const source = await transaction.revalidateSource(batch.scope);
    if (source.kind !== "current") return { kind: "rejected-source", reason: source.kind };
    await transaction.applyBatch(batch);
    return { kind: "applied" };
  });
}

export const SyncErrorSchema = z.object({
  code: z.enum(["source-retired", "permission-denied", "capability-unknown", "unsupported-profile", "conflict", "rate-limited", "transport-failed", "uncertain-dispatch", "invalid-provider-data"]),
  retry: z.enum(["never", "after-delay", "after-reconnect", "observe-only"]),
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.retryAfterMs != null && value.retry !== "after-delay") {
    ctx.addIssue({ code: "custom", path: ["retryAfterMs"], message: "Retry delay is meaningful only for a delayed retry" });
  }
  if (value.code === "uncertain-dispatch" && value.retry !== "observe-only") {
    ctx.addIssue({ code: "custom", path: ["retry"], message: "Uncertain side effects require observation, not blind retry" });
  }
});
export type SyncError = z.infer<typeof SyncErrorSchema>;

export const SyncDeliveryReceiptSchema = z.object({
  profile: SyncProfileSchema, operationId: SyncOperationIdSchema, attemptId: SyncAttemptIdSchema.optional(),
  local: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("committed"), hostObjectId: SyncHostObjectIdSchema, revision: OpaqueIdSchema }).strict(),
    z.object({ kind: z.literal("not-committed") }).strict(),
  ]),
  provider: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not-dispatched") }).strict(),
    z.object({ kind: z.literal("pending") }).strict(),
    z.object({ kind: z.literal("accepted"), validator: SyncValidatorSchema.optional() }).strict(),
    z.object({ kind: z.literal("uncertain") }).strict(),
    z.object({ kind: z.literal("rejected"), error: SyncErrorSchema }).strict(),
  ]),
  remote: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unobserved") }).strict(),
    z.object({ kind: z.literal("confirmed"), observationId: OpaqueIdSchema }).strict(),
    z.object({ kind: z.literal("conflict"), observationId: OpaqueIdSchema }).strict(),
  ]),
  notification: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not-requested") }).strict(),
    z.object({ kind: z.literal("unknown") }).strict(),
    /** Upstream report, not recipient delivery/read proof. */
    z.object({ kind: z.literal("provider-reported"), outcome: z.enum(["queued", "sent", "failed"]) }).strict(),
  ]),
}).strict().refine(value => value.local.kind !== "not-committed" || (
  value.provider.kind === "not-dispatched" && value.remote.kind === "unobserved" && value.notification.kind === "not-requested"
), { message: "Unadmitted work cannot report downstream effects" });
export type SyncDeliveryReceipt = z.infer<typeof SyncDeliveryReceiptSchema>;
