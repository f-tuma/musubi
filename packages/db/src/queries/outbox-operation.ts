import { decodeSyncOperationPayload } from "@musubi/types";
import type { EventOutboxRow } from "./event-outbox";
import type { TaskOutboxRow } from "./task-outbox";

/** Persisted identity only: decoding never reads a current source, projects an
 * object or calls a provider. Future codec availability cannot change identity.
 */
export function decodeEventOutboxOperation(row: EventOutboxRow) {
  return decodeSyncOperationPayload(row.payload, {
    kind: "event", action: row.action, operationId: row.id, commandId: row.mutationID,
    hostObjectId: row.eventID, provider: row.provider, connectionId: row.accountID,
    collectionId: row.externalCalendarID, resourceId: row.externalEventID,
    acceptedRevision: row.revision, predecessorOperationId: row.predecessorID,
  });
}

export function decodeTaskOutboxOperation(row: TaskOutboxRow) {
  return decodeSyncOperationPayload(row.payload, {
    kind: "task", action: row.action, operationId: row.id, commandId: row.mutationID,
    hostObjectId: row.taskID, provider: row.provider, connectionId: row.accountID,
    collectionId: row.externalCalendarID, resourceId: row.externalTaskID,
    acceptedRevision: row.revision, predecessorOperationId: row.predecessorID,
  });
}
