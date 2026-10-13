import { createHash } from "node:crypto";
import { SyncOperationEnvelopeSchema, SyncDeliveryReceiptSchema, type SyncOperationEnvelope, type SyncDeliveryReceipt } from "@musubi/types";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import type { ReferenceAdmission, ReferenceCapture, ReferenceContent, ReferenceContentPatch, ReferenceDeleteAdmission } from "./model.js";

function ownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"));
}
function text(value: unknown): value is string { return typeof value === "string" && value.length <= 2_000_000; }
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validateContent(value: ReferenceContent): ReferenceContent {
  if (!ownRecord(value) || Object.keys(value).sort().join(",") !== "beginsAt,endsAt,name,notes,place" || !text(value.name) ||
    ![value.notes, value.place].every(item => item === null || text(item)) || !instant(value.beginsAt) || !instant(value.endsAt) || value.beginsAt > value.endsAt)
    throw new Error("Invalid reference content");
  return value;
}
export function validatePatch(value: ReferenceContentPatch): ReferenceContentPatch {
  if (!ownRecord(value) || !Object.keys(value).length || Object.keys(value).some(key => !["name", "notes", "place"].includes(key)) ||
    Object.entries(value).some(([key, item]) => key === "name" ? !text(item) : item !== null && !text(item))) throw new Error("Invalid reference content patch");
  return value;
}
export function projection(content: ReferenceContent): Record<string, string | boolean | null> {
  validateContent(content);
  return { title: content.name, start: content.beginsAt, end: content.endsAt, isAllDay: false,
    description: content.notes, location: content.place, recurrence: null };
}
export function admissionFingerprint(input: ReferenceAdmission): string {
  validatePatch(input.patch);
  if (![input.bindingId, input.commandId, input.operationId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048) ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("Invalid reference admission identity");
  return createHash("sha256").update(JSON.stringify([input.bindingId, input.expectedRevision, input.operationId,
    Object.entries(input.patch).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}
export function acceptedEnvelope(input: ReferenceAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarId: string; eventId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  const body: Record<string, string | null> = {};
  if (Object.hasOwn(input.patch, "name")) body.summary = content.name;
  if (Object.hasOwn(input.patch, "notes")) body.description = content.notes;
  if (Object.hasOwn(input.patch, "place")) body.location = content.place;
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1",
    operation: { kind: "event", action: "update", version: 1 }, serializer: { id: "google-personal-event", version: 1 },
    commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: projection(content) }, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body } } });
  if (!parseNativeWritePlanV1(envelope.serializer, "update", "event", envelope.nativePlan.data) ||
    !matchesPinnedProjectionV1(envelope.serializer, "update", envelope.admittedProjection.data, envelope.nativePlan.data)) throw new Error("Reference admission codec disagreement");
  return envelope;
}
export function initialReceipt(envelope: SyncOperationEnvelope): SyncDeliveryReceipt {
  return SyncDeliveryReceiptSchema.parse({ profile: "sync-profile-v1", operationId: envelope.operationId,
    local: { kind: "committed", hostObjectId: envelope.hostObjectId, revision: String(envelope.acceptedRevision) },
    provider: { kind: "not-dispatched" }, remote: { kind: "unobserved" }, notification: { kind: "not-requested" } });
}
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  return ownRecord(a) && ownRecord(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && jsonEqual(value, b[key]));
}
export function strongEtag(value: unknown): value is string { return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value); }

/** Action-prefixed fingerprint cannot alias an UPDATE command. */
export function deleteAdmissionFingerprint(input: ReferenceDeleteAdmission): string {
  if (![input.bindingId, input.commandId, input.operationId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048) ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("Invalid reference DELETE admission identity");
  return createHash("sha256").update(JSON.stringify(["delete", input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedDeleteEnvelope(input: ReferenceDeleteAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarId: string; eventId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1",
    operation: { kind: "event", action: "delete", version: 1 }, serializer: { id: "google-personal-event", version: 1 },
    commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: projection(content) }, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: null } } });
  if (!parseNativeWritePlanV1(envelope.serializer, "delete", "event", envelope.nativePlan.data) ||
    !matchesPinnedProjectionV1(envelope.serializer, "delete", envelope.admittedProjection.data, envelope.nativePlan.data)) throw new Error("Reference DELETE admission codec disagreement");
  return envelope;
}
