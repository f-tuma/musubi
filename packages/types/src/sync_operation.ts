import { z } from "zod";
import {
  SyncCommandIdSchema, SyncHostObjectIdSchema, SyncOperationIdSchema,
  SyncProfileSchema, SyncProviderIdSchema, SyncProviderLocatorSchema, SyncSourceEpochSchema,
} from "./sync_protocol";

/** JSON values only: no implicit toJSON, getters, cycles, undefined or nonfinite numbers. */
export type SyncJsonValue = null | boolean | number | string | SyncJsonValue[] | { [key: string]: SyncJsonValue };
export type SyncJsonObject = { [key: string]: SyncJsonValue };
const MAX_JSON_NODES = 10_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_STRING_UNITS = 2_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Bounds apply to codec data, never silently truncate an admitted plan. */
function isBoundedJson(value: unknown, rejectCredentialFields = false, applyLimits = true): value is SyncJsonValue {
  const active = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  let stringUnits = 0;
  try {
    while (stack.length) {
      const item = stack.pop()!;
      if (item.exit) { active.delete(item.value as object); continue; }
      nodes++;
      if (applyLimits && (nodes > MAX_JSON_NODES || item.depth > MAX_JSON_DEPTH)) return false;
      const current = item.value;
      if (current === null || typeof current === "boolean") continue;
      if (typeof current === "number") { if (!Number.isFinite(current)) return false; continue; }
      if (typeof current === "string") {
        stringUnits += current.length;
        if (applyLimits && stringUnits > MAX_JSON_STRING_UNITS) return false;
        continue;
      }
      if (typeof current !== "object" || active.has(current)) return false;
      if (!Array.isArray(current) && !isPlainRecord(current)) return false;
      if (Object.getOwnPropertySymbols(current).length) return false;
      active.add(current);
      stack.push({ value: current, depth: item.depth, exit: true });
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Array.prototype && prototype !== null) return false;
        // Sparse arrays and custom array properties do not faithfully encode as JSON.
        if (Object.keys(descriptors).length !== current.length + 1) return false;
        for (let index = current.length - 1; index >= 0; index--) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
          stack.push({ value: descriptor.value, depth: item.depth + 1 });
        }
      } else {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (!("value" in descriptor) || !descriptor.enumerable) return false;
          stringUnits += key.length;
          if ((applyLimits && stringUnits > MAX_JSON_STRING_UNITS) || (rejectCredentialFields && isCredentialField(key))) return false;
          stack.push({ value: descriptor.value, depth: item.depth + 1 });
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return ["authorization", "accesstoken", "refreshtoken", "clientsecret", "password",
    "credential", "credentials", "cookie", "cookies", "apikey", "headers"].includes(normalized);
}
export const SyncJsonValueSchema = z.custom<SyncJsonValue>(value => isBoundedJson(value), "Expected bounded, lossless JSON data");
export const SyncJsonObjectSchema = z.custom<SyncJsonObject>(value => isPlainRecord(value) && isBoundedJson(value), "Expected bounded JSON object");
const SyncCodecDataSchema = z.custom<SyncJsonObject>(
  value => isPlainRecord(value) && isBoundedJson(value, true),
  "Expected bounded codec JSON without credential/header fields",
);

const OpaqueStringSchema = z.string().min(1).max(2048);
const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SyncOperationKindSchema = z.enum(["event", "task"]);
export const SyncOperationActionSchema = z.enum(["create", "update", "delete"]);
export const SyncOperationEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  profileVersion: SyncProfileSchema,
  operation: z.object({
    kind: SyncOperationKindSchema, action: SyncOperationActionSchema, version: z.literal(1),
  }).strict(),
  serializer: z.object({ id: OpaqueStringSchema, version: RevisionSchema }).strict(),
  commandId: SyncCommandIdSchema,
  operationId: SyncOperationIdSchema,
  hostObjectId: SyncHostObjectIdSchema,
  /** Native address when known; null retains an unresolved creation/dependency honestly. */
  locator: SyncProviderLocatorSchema.extend({ resourceId: OpaqueStringSchema.nullable() }).strict(),
  predecessorOperationId: SyncOperationIdSchema.optional(),
  sourceEpoch: SyncSourceEpochSchema,
  acceptedRevision: RevisionSchema,
  privacyEpoch: OpaqueStringSchema,
  allowedSideEffects: z.array(z.enum(["provider-content-write", "provider-notification"])).min(1).max(2)
    .refine(value => value.includes("provider-content-write") && new Set(value).size === value.length,
      "Side effects require one content write and no duplicates"),
  /** Exact admitted normalized projection; immutable and already serialized as JSON. */
  admittedProjection: z.object({ data: SyncCodecDataSchema }).strict(),
  /** Codec-owned data, not an HTTP request/header/credential transport escape hatch. */
  nativePlan: z.object({ kind: z.literal("codec-data"), data: SyncCodecDataSchema }).strict(),
}).strict();
export type SyncOperationEnvelope = z.infer<typeof SyncOperationEnvelopeSchema>;

/** Format recognition only. NONE of these IDs has a registered dispatch codec here. */
export const SYNC_OPERATION_SERIALIZER_FORMATS = [
  { id: "google-personal-event", version: 1, provider: "google", kind: "event" },
  { id: "microsoft-personal-event", version: 1, provider: "microsoft", kind: "event" },
  { id: "caldav-personal-event", version: 1, provider: "caldav", kind: "event" },
  { id: "google-task", version: 1, provider: "google", kind: "task" },
  { id: "microsoft-task", version: 1, provider: "microsoft", kind: "task" },
  { id: "caldav-task", version: 1, provider: "caldav", kind: "task" },
] as const;

export const SyncOperationRowBindingSchema = z.object({
  kind: SyncOperationKindSchema,
  action: SyncOperationActionSchema,
  operationId: OpaqueStringSchema,
  commandId: OpaqueStringSchema,
  hostObjectId: OpaqueStringSchema,
  provider: SyncProviderIdSchema,
  connectionId: OpaqueStringSchema,
  collectionId: OpaqueStringSchema,
  resourceId: OpaqueStringSchema.nullable(),
  acceptedRevision: RevisionSchema,
  predecessorOperationId: OpaqueStringSchema.nullable().optional(),
  /** Only supply evidence already captured by admission; do not invent a current epoch. */
  sourceEpoch: SyncSourceEpochSchema.optional(),
  privacyEpoch: OpaqueStringSchema.optional(),
}).strict();
export type SyncOperationRowBinding = z.infer<typeof SyncOperationRowBindingSchema>;

const LegacyJsonObjectSchema = z.custom<SyncJsonObject>(
  value => isPlainRecord(value) && isBoundedJson(value, false, false),
  "Expected lossless legacy JSON object",
);
export const SyncLegacyTaskDispatchProjectionSchema = z.object({
  version: z.literal(1),
  projection: LegacyJsonObjectSchema,
  patch: LegacyJsonObjectSchema,
  baseline: LegacyJsonObjectSchema.nullable(),
  errorCode: z.string().min(1).optional(),
}).strict();
export type SyncLegacyTaskDispatchProjection = z.infer<typeof SyncLegacyTaskDispatchProjectionSchema>;

export const SYNC_OPERATION_BLOCK_CODES = [
  "operation-payload-malformed",
  "operation-envelope-malformed",
  "operation-envelope-schema-unsupported",
  "operation-envelope-profile-unsupported",
  "delivery-serializer-unavailable",
  "operation-envelope-binding-mismatch",
  "operation-envelope-codec-unavailable",
  "task-dispatch-projection-malformed",
  "task-dispatch-projection-version-unsupported",
] as const;
export type SyncOperationBlockCode = (typeof SYNC_OPERATION_BLOCK_CODES)[number];
export function isSyncOperationBlockCode(value: unknown): value is SyncOperationBlockCode {
  return typeof value === "string" && (SYNC_OPERATION_BLOCK_CODES as readonly string[]).includes(value);
}
export type SyncOperationDecodeResult =
  | { kind: "legacy-v0"; payload: Record<string, unknown> }
  | { kind: "blocked"; code: SyncOperationBlockCode };

function block(code: SyncOperationBlockCode): SyncOperationDecodeResult {
  return { kind: "blocked", code };
}
function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function matchesRow(envelope: SyncOperationEnvelope, row: SyncOperationRowBinding): boolean {
  if (envelope.operation.kind !== row.kind || envelope.operation.action !== row.action ||
    envelope.operationId !== row.operationId || envelope.commandId !== row.commandId ||
    envelope.hostObjectId !== row.hostObjectId || envelope.acceptedRevision !== row.acceptedRevision ||
    envelope.locator.provider !== row.provider || envelope.locator.connectionId !== row.connectionId ||
    envelope.locator.collectionId !== row.collectionId) return false;
  // A CREATE can have a planned resource ID before the legacy row has a captured address.
  if (row.resourceId !== null && envelope.locator.resourceId !== row.resourceId) return false;
  if (envelope.predecessorOperationId !== (row.predecessorOperationId ?? undefined)) return false;
  if (row.resourceId === null && row.action !== "create" &&
      (!row.predecessorOperationId || envelope.locator.resourceId !== null)) return false;
  if (row.sourceEpoch && (row.sourceEpoch.sourceId !== envelope.sourceEpoch.sourceId ||
    row.sourceEpoch.generation !== envelope.sourceEpoch.generation)) return false;
  return row.privacyEpoch == null || envelope.privacyEpoch === row.privacyEpoch;
}

/** Decoder-before-encoder floor: every PRESENT envelope stays blocked/HOLD.
 * Call before any adapter preflight/GET or mutation. Never project or silently
 * downgrade unknown/present formats to the legacy path.
 */
export function decodeSyncOperationPayload(payload: unknown, inputBinding: SyncOperationRowBinding): SyncOperationDecodeResult {
  try {
    if (!isPlainRecord(payload)) return block("operation-payload-malformed");
    // Legacy identities retain their existing storage/runtime limits. New v1
    // bounds must not retroactively reject an otherwise unchanged legacy row.
    const binding = inputBinding;
    if (own(payload, "operationEnvelope")) {
      const parsedBinding = SyncOperationRowBindingSchema.safeParse(inputBinding);
      if (!parsedBinding.success) return block("operation-envelope-binding-mismatch");
      const binding = parsedBinding.data;
      const raw = ownData(payload, "operationEnvelope");
      if (!isPlainRecord(raw)) return block("operation-envelope-malformed");
      if (!own(raw, "schemaVersion") || !own(raw, "profileVersion")) return block("operation-envelope-malformed");
      if (ownData(raw, "schemaVersion") !== 1) return block("operation-envelope-schema-unsupported");
      if (!SyncProfileSchema.safeParse(ownData(raw, "profileVersion")).success) return block("operation-envelope-profile-unsupported");
      const parsed = SyncOperationEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return block("operation-envelope-malformed");
      const envelope = parsed.data;
      if (!matchesRow(envelope, binding)) return block("operation-envelope-binding-mismatch");
      const serializer = SYNC_OPERATION_SERIALIZER_FORMATS.find(format =>
        format.id === envelope.serializer.id && format.version === envelope.serializer.version);
      if (!serializer) return block("delivery-serializer-unavailable");
      if (serializer.provider !== envelope.locator.provider || serializer.kind !== envelope.operation.kind) {
        return block("operation-envelope-binding-mismatch");
      }
      return block("operation-envelope-codec-unavailable");
    }
    if (binding.kind === "task" && own(payload, "dispatchProjection")) {
      const projection = ownData(payload, "dispatchProjection");
      if (!isPlainRecord(projection) || !own(projection, "version")) return block("task-dispatch-projection-malformed");
      if (ownData(projection, "version") !== 1) return block("task-dispatch-projection-version-unsupported");
      if (!SyncLegacyTaskDispatchProjectionSchema.safeParse(projection).success) return block("task-dispatch-projection-malformed");
    }
    // Return the original data, including native field order/values; no upgrade or sanitizing rewrite.
    return { kind: "legacy-v0", payload };
  } catch {
    return block("operation-payload-malformed");
  }
}
