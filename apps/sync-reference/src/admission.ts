import { createHash } from "node:crypto";
import { strictCaldavResourceURL, caldavPersonalCreateIdentityV1 } from "@musubi/provider-caldav";
import { SyncOperationEnvelopeSchema, SyncDeliveryReceiptSchema, type SyncOperationEnvelope, type SyncDeliveryReceipt } from "@musubi/types";
import { encodeEventV1, parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import type { ReferenceAdmission, ReferenceCapture, ReferenceContent, ReferenceContentPatch, ReferenceDeleteAdmission, ReferenceCreateAdmission, ReferenceGraphDeleteAdmission, ReferenceCaldavDeleteAdmission, ReferenceGraphCreateAdmission, ReferenceCaldavCreateAdmission } from "./model.js";

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
/** Graph's original weak validator is a preflight comparison, never strong CAS. */
export function graphDeleteEtag(value: unknown): value is string { return typeof value === "string" && /^W\/"[\x21\x23-\x7e\x80-\xff]+"$/.test(value); }
export const REFERENCE_GRAPH_DELETE_PROFILE = "microsoft-personal-event-delete-v1";
export const REFERENCE_GRAPH_CREATE_PROFILE = "microsoft-personal-event-create-v1";
export function graphCreateAdmissionFingerprint(input: ReferenceGraphCreateAdmission): string {
  // The real encoder requires a UUID transactionId. This new reference-only
  // admission restriction does not change opaque runtime or old operation IDs.
  deleteAdmissionFingerprint(input); referenceCreateOperationID(input.operationId);
  return createHash("sha256").update(JSON.stringify([REFERENCE_GRAPH_CREATE_PROFILE, input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedGraphCreateEnvelope(input: ReferenceGraphCreateAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  graphCreateAdmissionFingerprint(input); validateContent(content);
  const encoded = encodeEventV1("microsoft", { id: host.objectId, creatorID: "reference", organizer: "", title: content.name, color: "",
    start: new Date(content.beginsAt), end: new Date(content.endsAt), calendars: [], isCanceled: false, isAllDay: false,
    hasAttendees: false, description: content.notes, location: content.place, recurrence: null }, undefined,
  { action: "create", operationId: input.operationId, acceptedAt: "2026-01-01T00:00:00.000Z" });
  const plan = parseNativeWritePlanV1(encoded.serializer, "create", "event", encoded.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !plan.body || plan.body.transactionId !== input.operationId || Object.hasOwn(plan.body, "id") ||
    !matchesPinnedProjectionV1(encoded.serializer, "create", encoded.admittedProjection.data, plan)) throw new Error("Reference Graph CREATE codec disagreement");
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    serializer: encoded.serializer, commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "microsoft", connectionId: host.connectionId, collectionId: host.calendarId, resourceId: null },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
}
export const REFERENCE_CALDAV_DELETE_PROFILE = "caldav-personal-event-delete-v1";
export const REFERENCE_CALDAV_CREATE_PROFILE = "caldav-personal-event-create-v1";
/** Original intent UUID fixes both the native URL and UID; never an attempt ID. */
export function referenceCaldavCreateIdentity(calendarUrl: string, operationId: string): { resourceUrl: string; uid: string } {
  const identity = caldavPersonalCreateIdentityV1(calendarUrl, referenceCreateOperationID(operationId));
  if (!identity || !caldavDeleteAddress(calendarUrl, identity.resourceUrl)) throw new Error("Invalid reference CalDAV CREATE target");
  return identity;
}
export function caldavCreateAdmissionFingerprint(input: ReferenceCaldavCreateAdmission): string {
  deleteAdmissionFingerprint(input); referenceCreateOperationID(input.operationId);
  return createHash("sha256").update(JSON.stringify([REFERENCE_CALDAV_CREATE_PROFILE, input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedCaldavCreateEnvelope(input: ReferenceCaldavCreateAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarUrl: string; resourceUrl: string; uid: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  caldavCreateAdmissionFingerprint(input); validateContent(content);
  const identity = referenceCaldavCreateIdentity(host.calendarUrl, input.operationId);
  if (identity.resourceUrl !== host.resourceUrl || identity.uid !== host.uid) throw new Error("Reference CalDAV CREATE reservation disagrees with operation identity");
  const encoded = encodeEventV1("caldav", { id: host.objectId, creatorID: "reference", organizer: "", title: content.name, color: "",
    start: new Date(content.beginsAt), end: new Date(content.endsAt), calendars: [], isCanceled: false, isAllDay: false,
    hasAttendees: false, description: content.notes, location: content.place, recurrence: null }, undefined,
  // Event CREATE does not encode acceptedAt into its resource; the serializer
  // requires this inert context field, not a host/provider evidence timestamp.
  { action: "create", operationId: input.operationId, acceptedAt: "2026-01-01T00:00:00.000Z" });
  const saved = projection(content), plan = parseNativeWritePlanV1(encoded.serializer, "create", "event", encoded.nativePlan.data);
  if (!plan || plan.planKind !== "caldav-properties" || plan.uid !== identity.uid || !jsonEqual(encoded.admittedProjection.data, saved) ||
    !matchesPinnedProjectionV1(encoded.serializer, "create", saved, plan)) throw new Error("Reference CalDAV CREATE content loses wire precision");
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    serializer: encoded.serializer, commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "caldav", connectionId: host.connectionId, collectionId: host.calendarUrl, resourceId: identity.resourceUrl },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: { data: saved }, nativePlan: encoded.nativePlan });
}

export function caldavUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\r\n\0]/.test(value);
}
/** Strict reference address: exact canonical HTTPS collection and direct child.
 * DNS/public-address enforcement remains the provider transport's responsibility. */
export function caldavDeleteAddress(calendarUrl: unknown, resourceUrl: unknown): boolean {
  if (typeof calendarUrl !== "string" || typeof resourceUrl !== "string" || calendarUrl.length > 2048 || resourceUrl.length > 2048) return false;
  try {
    const calendar = new URL(calendarUrl), resource = strictCaldavResourceURL(calendarUrl, resourceUrl);
    return calendar.protocol === "https:" && calendar.href === calendarUrl && resource.href === resourceUrl;
  } catch { return false; }
}
export function caldavDeleteAdmissionFingerprint(input: ReferenceCaldavDeleteAdmission): string {
  deleteAdmissionFingerprint(input);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operationId)) throw new Error("Invalid reference CalDAV DELETE identity");
  return createHash("sha256").update(JSON.stringify([REFERENCE_CALDAV_DELETE_PROFILE, input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedCaldavDeleteEnvelope(input: ReferenceCaldavDeleteAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarUrl: string; resourceUrl: string; uid: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  caldavDeleteAdmissionFingerprint(input); validateContent(content);
  if (!caldavUid(host.uid) || !caldavDeleteAddress(host.calendarUrl, host.resourceUrl)) throw new Error("Invalid reference CalDAV DELETE target");
  // Adapt this host's own content at the existing portable serializer boundary.
  // No Musubi rows, clocks, memberships or credentials participate in encoding.
  const encoded = encodeEventV1("caldav", { id: host.objectId, creatorID: "reference", organizer: "", title: content.name, color: "",
    start: new Date(content.beginsAt), end: new Date(content.endsAt), calendars: [], isCanceled: false, isAllDay: false,
    hasAttendees: false, description: content.notes, location: content.place, recurrence: null }, undefined,
  // The existing codec requires this context field but DELETE does not encode
  // it into its plan/resource. A fixed inert value keeps this pure adapter free
  // of clocks; it is never provider or receipt evidence.
  { action: "delete", operationId: input.operationId, uid: host.uid, acceptedAt: "2026-01-01T00:00:00.000Z" });
  const saved = projection(content);
  if (!jsonEqual(encoded.admittedProjection.data, saved) || !matchesPinnedProjectionV1(encoded.serializer, "delete", saved, encoded.nativePlan.data))
    throw new Error("Reference CalDAV DELETE content loses wire precision");
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "delete", version: 1 },
    serializer: encoded.serializer, commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "caldav", connectionId: host.connectionId, collectionId: host.calendarUrl, resourceId: host.resourceUrl },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: { data: saved }, nativePlan: encoded.nativePlan });
}

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

/** The existing v1 identity is tied to the operation, never the attempt or a clock. */
export function referenceCreateOperationID(operationId: string): string {
  if (typeof operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId))
    throw new Error("Invalid reference CREATE identity");
  return operationId;
}
export function referenceCreateEventID(operationId: string): string {
  return `musubi${referenceCreateOperationID(operationId).replace(/-/g, "")}`;
}
export function createAdmissionFingerprint(input: ReferenceCreateAdmission): string {
  referenceCreateEventID(input.operationId);
  if (![input.bindingId, input.commandId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048) ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("Invalid reference CREATE admission identity");
  return createHash("sha256").update(JSON.stringify(["create", input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedCreateEnvelope(input: ReferenceCreateAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarId: string; eventId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  const eventId = referenceCreateEventID(input.operationId);
  if (eventId !== host.eventId) throw new Error("Reference CREATE reservation disagrees with operation identity");
  const saved = projection(content);
  const body = { id: eventId, summary: content.name, description: content.notes, location: content.place,
    start: { dateTime: content.beginsAt }, end: { dateTime: content.endsAt }, recurrence: null,
    extendedProperties: { private: { musubiOperationID: input.operationId } } };
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1",
    operation: { kind: "event", action: "create", version: 1 }, serializer: { id: "google-personal-event", version: 1 },
    commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: saved }, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body } } });
  if (!parseNativeWritePlanV1(envelope.serializer, "create", "event", envelope.nativePlan.data) ||
    !matchesPinnedProjectionV1(envelope.serializer, "create", saved, envelope.nativePlan.data)) throw new Error("Reference CREATE admission codec disagreement");
  return envelope;
}
export function graphDeleteAdmissionFingerprint(input: ReferenceGraphDeleteAdmission): string {
  // Prefix distinguishes this admitted guarded profile from conditional Google DELETE.
  deleteAdmissionFingerprint(input);
  return createHash("sha256").update(JSON.stringify([REFERENCE_GRAPH_DELETE_PROFILE, input.bindingId, input.expectedRevision, input.operationId])).digest("hex");
}
export function acceptedGraphDeleteEnvelope(input: ReferenceGraphDeleteAdmission, content: ReferenceContent, host: {
  objectId: string; connectionId: string; calendarId: string; eventId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1",
    operation: { kind: "event", action: "delete", version: 1 }, serializer: { id: "microsoft-personal-event", version: 1 },
    commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "microsoft", connectionId: host.connectionId, collectionId: host.calendarId, resourceId: host.eventId },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: projection(content) }, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: null } } });
  if (!parseNativeWritePlanV1(envelope.serializer, "delete", "event", envelope.nativePlan.data) ||
    !matchesPinnedProjectionV1(envelope.serializer, "delete", envelope.admittedProjection.data, envelope.nativePlan.data)) throw new Error("Reference Graph DELETE admission codec disagreement");
  return envelope;
}
