import { decodeSyncOperationPayload, SyncOperationCaptureSchema, type SyncOperationEnvelope } from "@musubi/types";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import type { EventOutboxRow } from "./event-outbox";
import type { TaskOutboxRow } from "./task-outbox";

/** Registered version 1 only, with semantic native-plan and captured-host
 * identity validation. Availability never grants current write authority.
 */
function supports(envelope: SyncOperationEnvelope, row: EventOutboxRow | TaskOutboxRow) {
  const capture = SyncOperationCaptureSchema.safeParse(row.payload.operationCapture);
  if (!capture.success || capture.data.sourceId !== row.externalCalendarLinkID ||
      envelope.sourceEpoch.sourceId !== capture.data.sourceId || envelope.sourceEpoch.generation !== capture.data.writeGeneration ||
      envelope.privacyEpoch !== capture.data.privacyEpoch) return false;
  const plan = parseNativeWritePlanV1(envelope.serializer, envelope.operation.action, envelope.operation.kind, envelope.nativePlan.data);
  if (!plan || !matchesPinnedProjectionV1(envelope.serializer, envelope.operation.action,
      envelope.admittedProjection.data, envelope.nativePlan.data)) return false;
  if (plan.planKind === "caldav-properties" && row.icalUid && row.action !== "create" && plan.uid !== row.icalUid) return false;
  if (row.action === "create") {
    if ((row.provider === "microsoft" || row.provider === "google" && "taskID" in row) &&
        envelope.locator.resourceId !== null) return false;
    if (plan.planKind === "json-body" && "eventID" in row) {
      if (row.provider === "google") {
        const id = `musubi${row.id.toLowerCase().replace(/-/g, "")}`;
        if (plan.body?.id !== id || envelope.locator.resourceId !== id) return false;
        const properties = plan.body.extendedProperties as { private?: { musubiOperationID?: string } };
        if (properties?.private?.musubiOperationID !== row.id.toLowerCase()) return false;
      } else if (row.provider === "microsoft" && plan.body?.transactionId !== row.id.toLowerCase()) return false;
    }
    if (plan.planKind === "caldav-properties") {
      const uid = "eventID" in row ? `musubi-${row.id.toLowerCase()}` : row.taskID;
      if (plan.uid !== uid || envelope.locator.resourceId !== `${row.externalCalendarID.replace(/\/?$/, "/")}${uid}.ics`) return false;
    }
  }
  const projection = envelope.admittedProjection.data;
  if ("eventID" in row) {
    const keys = ["title", "start", "end", "isAllDay", "description", "location", "recurrence"];
    if (Object.keys(projection).some(key => !keys.includes(key)) || typeof projection.title !== "string" ||
        typeof projection.start !== "string" || !Number.isFinite(Date.parse(projection.start)) ||
        typeof projection.end !== "string" || !Number.isFinite(Date.parse(projection.end)) ||
        typeof projection.isAllDay !== "boolean" ||
        [projection.description, projection.location, projection.recurrence].some(value => value !== null && typeof value !== "string")) return false;
  } else if (plan.planKind === "json-body" && row.action !== "delete") {
    // A task plan retains its full admitted native target; later patch selection
    // must not substitute values from a current projector.
    if (!plan.body || Object.keys(projection).length !== Object.keys(plan.body).length ||
        Object.entries(plan.body).some(([key, value]) => JSON.stringify(projection[key]) !== JSON.stringify(value))) return false;
  }
  return true;
}
function captureBinding(row: EventOutboxRow | TaskOutboxRow) {
  const captured = SyncOperationCaptureSchema.safeParse(row.payload.operationCapture);
  return captured.success ? { sourceEpoch: { sourceId: captured.data.sourceId, generation: captured.data.writeGeneration },
    privacyEpoch: captured.data.privacyEpoch } : {};
}
export function decodeEventOutboxOperation(row: EventOutboxRow) {
  return decodeSyncOperationPayload(row.payload, {
    kind: "event", action: row.action, operationId: row.id, commandId: row.mutationID,
    hostObjectId: row.eventID, provider: row.provider, connectionId: row.accountID,
    collectionId: row.externalCalendarID, resourceId: row.externalEventID,
    acceptedRevision: row.revision, predecessorOperationId: row.predecessorID, ...captureBinding(row),
  }, { supports: envelope => supports(envelope, row) });
}
export function decodeTaskOutboxOperation(row: TaskOutboxRow) {
  return decodeSyncOperationPayload(row.payload, {
    kind: "task", action: row.action, operationId: row.id, commandId: row.mutationID,
    hostObjectId: row.taskID, provider: row.provider, connectionId: row.accountID,
    collectionId: row.externalCalendarID, resourceId: row.externalTaskID,
    acceptedRevision: row.revision, predecessorOperationId: row.predecessorID, ...captureBinding(row),
  }, { supports: envelope => supports(envelope, row) });
}
