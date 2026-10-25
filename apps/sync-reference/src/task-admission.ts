import { createHash } from "node:crypto";
import { parseGoogleTaskProjection, diffGoogleTaskProjection, type GoogleTaskProjection } from "@musubi/provider-google";
import { encodeTaskV1, matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { SyncOperationEnvelopeSchema, TaskSchema, type SyncOperationEnvelope } from "@musubi/types";
import type { GoogleTaskSavedProjection } from "@musubi/sync-runtime";
import { strongEtag, jsonEqual } from "./admission.js";
import type { ReferenceCapture } from "./model.js";
import type { ReferenceTaskAdmission, ReferenceTaskContent, ReferenceTaskPatch } from "./task-model.js";

export const REFERENCE_TASK_UPDATE_PROFILE = "google-task-update-v1";
const contentKeys = ["name", "notes", "state", "dueAt", "importance"] as const;
/** Read exact own data once; accessors/symbols/extra fields never run or hide. */
export function taskFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) throw new Error("Invalid reference task input");
  const fields: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor && optional.includes(key)) continue;
    if (!descriptor || !("value" in descriptor)) throw new Error("Invalid reference task input");
    fields[key] = descriptor.value;
  }
  return fields;
}
export const taskIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048 && !value.includes("\0");
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 2_000_000 && !value.includes("\0");
export function taskInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validateTaskContent(value: unknown): ReferenceTaskContent {
  const fields = taskFields(value, contentKeys);
  if (!text(fields.name) || fields.notes !== null && !text(fields.notes) || !["todo", "doing", "done"].includes(fields.state as string) ||
    fields.dueAt !== null && !taskInstant(fields.dueAt) || !["low", "normal", "high"].includes(fields.importance as string)) throw new Error("Invalid reference task content");
  return fields as unknown as ReferenceTaskContent;
}
export function validateTaskPatch(value: unknown): ReferenceTaskPatch {
  const fields = taskFields(value, [], contentKeys);
  if (!Object.keys(fields).length) throw new Error("Invalid reference task patch");
  validateTaskContent({ name: "", notes: null, state: "todo", dueAt: null, importance: "normal", ...fields });
  return fields as ReferenceTaskPatch;
}
export function taskAdmissionFingerprint(input: ReferenceTaskAdmission): string {
  if (![input.bindingId, input.commandId, input.operationId].every(taskIdentity) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new Error("Invalid reference task admission identity");
  // The real existing codec requires this context. Only this new reference
  // helper/CLI narrows IDs; portable claimed UPDATE identities remain opaque.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operationId)) throw new Error("Invalid reference task operation UUID");
  const patch = validateTaskPatch(input.patch);
  return createHash("sha256").update(JSON.stringify([REFERENCE_TASK_UPDATE_PROFILE, input.bindingId, input.expectedRevision, input.operationId,
    Object.entries(patch).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}
/** This is the actual portable Task codec adapter, with no event times or DB. */
export function encodeReferenceTask(content: ReferenceTaskContent, objectId: string, operationId: string) {
  const value = validateTaskContent(content);
  const task = TaskSchema.parse({ id: objectId, creatorID: "reference", calendarID: "reference-task-home", title: value.name,
    description: value.notes, status: value.state === "done" ? "completed" : value.state === "doing" ? "in-process" : "needs-action",
    due: value.dueAt, priority: value.importance === "high" ? 1 : value.importance === "low" ? 9 : 5 });
  return encodeTaskV1("google", task, undefined, { action: "update", operationId, acceptedAt: "2026-01-01T00:00:00.000Z" });
}
export function taskSavedProjection(target: unknown, baseline: unknown): GoogleTaskSavedProjection {
  const projection = parseGoogleTaskProjection(target), accepted = parseGoogleTaskProjection(baseline);
  if (!projection || !accepted) throw new Error("Invalid reference task projection");
  const diff = diffGoogleTaskProjection(accepted, projection);
  const patch = Object.fromEntries(Object.keys(diff).sort().map(key => [key, diff[key as keyof typeof diff]]));
  return { projection, baseline: accepted, patch };
}
export function acceptedTaskEnvelope(input: ReferenceTaskAdmission, content: ReferenceTaskContent, host: {
  objectId: string; connectionId: string; taskListId: string; taskId: string; capture: ReferenceCapture;
}): SyncOperationEnvelope {
  taskAdmissionFingerprint(input);
  if (![host.objectId, host.connectionId, host.taskListId, host.taskId].every(taskIdentity) || host.taskListId === "@default") throw new Error("Invalid reference task target");
  const encoded = encodeReferenceTask(content, host.objectId, input.operationId);
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "update", version: 1 },
    serializer: encoded.serializer, commandId: input.commandId, operationId: input.operationId, hostObjectId: host.objectId,
    locator: { provider: "google", connectionId: host.connectionId, collectionId: host.taskListId, resourceId: host.taskId },
    sourceEpoch: { sourceId: input.bindingId, generation: host.capture.sourceGeneration }, acceptedRevision: host.capture.acceptedRevision,
    privacyEpoch: String(host.capture.privacyGeneration), allowedSideEffects: ["provider-content-write"], admittedProjection: encoded.admittedProjection, nativePlan: encoded.nativePlan });
  const plan = parseNativeWritePlanV1(envelope.serializer, "update", "task", envelope.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !jsonEqual(plan.body, envelope.admittedProjection.data) ||
    !matchesPinnedProjectionV1(envelope.serializer, "update", envelope.admittedProjection.data, plan)) throw new Error("Reference task codec disagreement");
  if (!parseGoogleTaskProjection(envelope.admittedProjection.data)) throw new Error("Invalid reference task projection");
  return envelope;
}
export function taskStrongEtag(value: unknown): value is string { return strongEtag(value) && value.length <= 2048; }
export function taskWriteAllowed(scope: string): boolean { return scope.split(/\s+/).includes("https://www.googleapis.com/auth/tasks"); }
export function validateTaskBaseline(value: unknown): GoogleTaskProjection {
  const parsed = parseGoogleTaskProjection(value); if (!parsed) throw new Error("Invalid reference task baseline"); return parsed;
}
