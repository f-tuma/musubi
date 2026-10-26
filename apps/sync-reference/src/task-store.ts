import type { Pool, PoolClient } from "pg";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import { googleTaskProjectionFromNative, parseGoogleTaskProjection, isStrictGoogleNativeTask, type GoogleTaskAccountSession } from "@musubi/provider-google";
import { supportsGoogleTaskUpdateEnvelope, supportsGoogleTaskDeleteEnvelope, supportsGoogleTaskCreateEnvelope, type RuntimeTaskNativeFacts, type RuntimeTaskCompletionEvidence, type GoogleTaskSavedProjection, type RuntimeTaskDeleteNativeFacts, type RuntimeTaskCreateNativeFacts, type GoogleTaskPredecessorAddress } from "@musubi/sync-runtime";
import { decodeSyncOperationPayload, SyncDeliveryReceiptSchema, SyncErrorSchema, SyncJsonObjectSchema, type SyncDeliveryReceipt, type SyncOperationRowBinding } from "@musubi/types";
import { assertCredentialKey, decryptCredential, encryptCredential } from "./crypto.js";
import { initialReceipt, jsonEqual } from "./admission.js";
import { ReferenceHoldError } from "./model.js";
import { acceptedTaskEnvelope, REFERENCE_TASK_UPDATE_PROFILE, taskAdmissionFingerprint, taskFields, taskIdentity, taskInstant, taskSavedProjection, taskStrongEtag, taskWriteAllowed, validateTaskBaseline, validateTaskContent, validateTaskPatch } from "./task-admission.js";
import type { ReferenceTaskAdmission, ReferenceTaskClaim, ReferenceTaskOperation, ReferenceTaskSeed } from "./task-model.js";
import { acceptedTaskDeleteEnvelope, REFERENCE_TASK_DELETE_PROFILE, taskDeleteAdmissionFingerprint, taskDeleteAcceptedStatus, taskDeleteResponseAbsenceStatus } from "./task-delete-admission.js";
import type { ReferenceTaskDeleteAdmission, ReferenceTaskDeleteClaim, ReferenceTaskDeleteOperation, ReferenceTaskDeleteObservation } from "./task-delete-model.js";
import { acceptedTaskCreateEnvelope, REFERENCE_TASK_CREATE_PROFILE, taskCreateAdmissionFingerprint, taskCreateAcceptedStatus } from "./task-create-admission.js";
import type { ReferenceTaskCreateSeed, ReferenceTaskCreateAdmission, ReferenceTaskCreateClaim, ReferenceTaskCreateOperation, ReferenceTaskCreateObservation, ReferenceTaskCreateResponse } from "./task-create-model.js";
import { taskOperationBinding, reserveTaskOperationIdentity, hasWaitingTaskIntent, enqueueTaskIntent, activateTaskIntent, inspectTaskIntent, taskPredecessorBasis, taskIntentsInstalled } from "./task-intent-store.js";
import type { ReferenceTaskQueuedUpdate, ReferenceTaskQueuedDelete, ReferenceTaskIntent, ReferenceTaskCompletion, ReferenceTaskResolutionBasis } from "./task-intent-model.js";
import { taskCompletion } from "./task-intent-admission.js";

type Row = Record<string, any>;
interface Locked { operation: Row; connection: Row; object: Row; binding: Row }
const receipt = (value: unknown) => SyncDeliveryReceiptSchema.parse(value);
type ClaimIdentity = Pick<ReferenceTaskClaim, "operationId" | "attemptId">;
function claimIdentity(claim: ClaimIdentity) {
  // The caller's stale/mutable DTO is never an authority source.
  const fields: Record<string, unknown> = {};
  for (const key of ["operationId", "attemptId"]) {
    const descriptor = Object.getOwnPropertyDescriptor(claim, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("Invalid reference task claim");
    fields[key] = descriptor.value;
  }
  if (!taskIdentity(fields.operationId) || !taskIdentity(fields.attemptId)) throw new Error("Invalid reference task claim");
  return fields as { operationId: string; attemptId: string };
}
function capture(op: Row) {
  return { acceptedRevision: Number(op.accepted_revision), connectionGeneration: Number(op.connection_generation), sourceGeneration: Number(op.source_generation),
    privacyGeneration: Number(op.privacy_generation), canonicalGeneration: Number(op.canonical_generation) };
}
const binding = (op: Row): SyncOperationRowBinding => taskOperationBinding(op);
function deleteBaseline(op: Row) {
  const decoded = decodeSyncOperationPayload(op.payload, binding(op), { supports: supportsGoogleTaskDeleteEnvelope });
  if (decoded.kind !== "pinned-v1" || op.provider !== "google" || op.action !== "delete" || op.endpoint_profile !== REFERENCE_TASK_DELETE_PROFILE ||
    !taskStrongEtag(op.accepted_etag) || op.saved_projection !== null || op.field_mask !== null) throw new ReferenceHoldError("task-delete-operation-unavailable");
  const plan = parseNativeWritePlanV1(decoded.envelope.serializer, "delete", "task", decoded.envelope.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || plan.body !== null || !matchesPinnedProjectionV1(decoded.envelope.serializer, "delete", decoded.envelope.admittedProjection.data, plan))
    throw new ReferenceHoldError("task-delete-operation-unavailable");
  validateTaskBaseline(decoded.envelope.admittedProjection.data);
  const proof = receipt(op.receipt), hasResponse = op.delete_acceptance_status != null || op.delete_response_absence_status != null;
  if (op.native_acceptance_status !== null || (proof.provider.kind === "accepted") !== hasResponse || proof.provider.kind === "accepted" && proof.provider.validator !== undefined)
    throw new ReferenceHoldError("task-delete-response-history-unavailable");
  return validateTaskBaseline(op.delete_accepted_baseline);
}
function savedProjection(op: Row): GoogleTaskSavedProjection {
  const decoded = decodeSyncOperationPayload(op.payload, binding(op), { supports: supportsGoogleTaskUpdateEnvelope });
  if (decoded.kind !== "pinned-v1" || op.provider !== "google" || op.action !== "update" || op.endpoint_profile !== REFERENCE_TASK_UPDATE_PROFILE)
    throw new ReferenceHoldError("task-operation-unavailable");
  const fields = taskFields(op.saved_projection, ["projection", "baseline", "patch"]);
  const expected = taskSavedProjection(decoded.envelope.admittedProjection.data, fields.baseline);
  if (!jsonEqual(fields, expected) || !jsonEqual(op.field_mask, Object.keys(expected.patch).sort()) || !taskStrongEtag(op.accepted_etag))
    throw new ReferenceHoldError("task-saved-projection-unavailable");
  return expected;
}
function createProjection(op: Row) {
  const decoded = decodeSyncOperationPayload(op.payload, binding(op), { supports: supportsGoogleTaskCreateEnvelope });
  if (decoded.kind !== "pinned-v1" || op.provider !== "google" || op.action !== "create" || op.endpoint_profile !== REFERENCE_TASK_CREATE_PROFILE ||
    op.task_id !== null || op.accepted_etag !== null || op.saved_projection !== null || op.field_mask !== null || op.delete_accepted_baseline !== null)
    throw new ReferenceHoldError("task-create-operation-unavailable");
  const plan = parseNativeWritePlanV1(decoded.envelope.serializer, "create", "task", decoded.envelope.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !jsonEqual(plan.body, decoded.envelope.admittedProjection.data) ||
    !matchesPinnedProjectionV1(decoded.envelope.serializer, "create", decoded.envelope.admittedProjection.data, plan)) throw new ReferenceHoldError("task-create-operation-unavailable");
  return validateTaskBaseline(decoded.envelope.admittedProjection.data);
}
function createResponse(op: Row): ReferenceTaskCreateResponse {
  let validator: unknown = null;
  try { if (op.create_candidate_validator !== null) validator = JSON.parse(op.create_candidate_validator); }
  catch { throw new ReferenceHoldError("task-create-response-unavailable"); }
  if (validator !== null && typeof validator !== "string" || op.create_acceptance_status !== null && !taskCreateAcceptedStatus(op.create_acceptance_status) ||
    op.create_candidate_id !== null && (!taskIdentity(op.create_candidate_id) || op.create_acceptance_status === null) || op.create_candidate_id === null && validator !== null)
    throw new ReferenceHoldError("task-create-response-unavailable");
  return { acceptedStatus: op.create_acceptance_status, responseAddress: op.create_candidate_id === null ? null : { taskId: op.create_candidate_id, validator: validator as string | null } };
}
/** A separate Task ledger; it never imports Musubi DB/auth/config or event rows. */
export class ReferenceTaskStore {
  constructor(readonly pool: Pool, private readonly credentialKey: string) { assertCredentialKey(credentialKey); }
  private async transaction<T>(body: (client: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); const client = await this.pool.connect();
    try {
      signal?.throwIfAborted(); await client.query("BEGIN"); const result = await body(client);
      signal?.throwIfAborted(); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  private async locked(client: PoolClient, operationId: string): Promise<Locked> {
    const first = (await client.query("SELECT * FROM reference_task_operations WHERE id=$1", [operationId])).rows[0];
    if (!first) throw new ReferenceHoldError("task-operation-missing");
    // Same order as event operations: private connection, canonical, binding, op.
    const connection = (await client.query("SELECT *,expires_at>clock_timestamp() AS credential_live FROM reference_connections WHERE id=$1 FOR UPDATE", [first.connection_id])).rows[0];
    const object = (await client.query("SELECT * FROM reference_task_objects WHERE id=$1 FOR UPDATE", [first.object_id])).rows[0];
    const target = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [first.binding_id])).rows[0];
    const operation = (await client.query("SELECT *,lease_until>clock_timestamp() AS lease_live FROM reference_task_operations WHERE id=$1 FOR UPDATE", [operationId])).rows[0];
    // SQL projections may have been evaluated before FOR UPDATE waited. Read
    // the database clock again only after all authority/operation locks exist.
    const clock = (await client.query("SELECT lease_until>clock_timestamp() AS lease_live,$2::timestamptz>clock_timestamp() AS credential_live FROM reference_task_operations WHERE id=$1", [operationId, connection?.expires_at])).rows[0];
    operation.lease_live = clock.lease_live; if (connection) connection.credential_live = clock.credential_live;
    return { connection, object, binding: target, operation };
  }
  private owned(rows: Locked, claim: { attemptId: string }): boolean {
    return rows.operation.status === "running" && rows.operation.lease_attempt_id === claim.attemptId && rows.operation.lease_live === true;
  }
  private current(rows: Locked, action: "update" | "delete" = "update", resolved?: ReferenceTaskResolutionBasis): boolean {
    const { connection: conn, object, binding: target, operation: op } = rows;
    return !!conn && !!object && !!target && conn.provider === "google" && conn.status === "active" && conn.credential_ciphertext != null && conn.credential_live === true && taskWriteAllowed(conn.scope) &&
      op.provider === "google" && op.action === action && op.endpoint_profile === (action === "delete" ? REFERENCE_TASK_DELETE_PROFILE : REFERENCE_TASK_UPDATE_PROFILE) && target.active &&
      (target.destination_lifecycle ?? "present") === "present" && object.canonical_lifecycle === (action === "delete" ? "tombstoned" : "active") &&
      Number(conn.generation) === Number(op.connection_generation) && Number(object.revision) === Number(op.accepted_revision) &&
      Number(object.privacy_generation) === Number(op.privacy_generation) && Number(object.lifecycle_generation) === Number(op.canonical_generation) && Number(target.source_generation) === (resolved?.effectiveSourceGeneration ?? Number(op.source_generation)) &&
      target.connection_id === op.connection_id && target.object_id === op.object_id && target.task_list_id === op.task_list_id && target.task_id === (resolved?.taskId ?? op.task_id) &&
      target.etag === op.accepted_etag && jsonEqual(target.baseline, action === "delete" ? op.delete_accepted_baseline : op.saved_projection?.baseline);
  }
  private async currentFor(client: PoolClient, rows: Locked, claim: ClaimIdentity, action: "update" | "delete" = "update"): Promise<boolean> {
    let resolved: ReferenceTaskResolutionBasis | undefined;
    if (rows.operation.predecessor_operation_id) {
      try { resolved = await taskPredecessorBasis(client, rows.operation, rows.binding); }
      catch (error) { if (error instanceof ReferenceHoldError) return false; throw error; }
      if (!jsonEqual(resolved, rows.operation.resolution_basis)) return false;
    }
    // An ancestry read can wait too. Current authority always uses a new DB clock.
    const clock = (await client.query("SELECT lease_until>clock_timestamp() AS lease_live,$2::timestamptz>clock_timestamp() AS credential_live FROM reference_task_operations WHERE id=$1", [rows.operation.id, rows.connection?.expires_at])).rows[0];
    rows.operation.lease_live = clock.lease_live; if (rows.connection) rows.connection.credential_live = clock.credential_live;
    return this.owned(rows, claim) && this.current(rows, action, resolved);
  }
  private predecessorAddress(rows: Locked, claim: ClaimIdentity): GoogleTaskPredecessorAddress | undefined {
    const basis = rows.operation.resolution_basis as ReferenceTaskResolutionBasis | null | undefined;
    return rows.operation.predecessor_operation_id && basis ? { kind: "predecessor-task-reference", operationId: rows.operation.id, attemptId: claim.attemptId,
      predecessorOperationId: basis.predecessorOperationId, evidenceOperationId: basis.evidenceOperationId, taskId: basis.taskId, validator: basis.validator,
      projectionBaseline: basis.projectionBaseline, witness: basis.witness } : undefined;
  }
  private async acknowledge(client: PoolClient, rows: Locked, claim: ClaimIdentity, completion: ReferenceTaskCompletion): Promise<void> {
    const captured = taskCompletion(completion);
    const result = Object.hasOwn(rows.operation, "completion_evidence")
      ? await client.query("UPDATE reference_task_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL,completion_evidence=$3 WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM reference_connections c WHERE c.id=reference_task_operations.connection_id AND c.expires_at>clock_timestamp())", [claim.operationId, claim.attemptId, captured])
      : await client.query("UPDATE reference_task_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM reference_connections c WHERE c.id=reference_task_operations.connection_id AND c.expires_at>clock_timestamp())", [claim.operationId, claim.attemptId]);
    if (result.rowCount !== 1) throw new TaskAckLeaseExpired();
  }
  async queueUpdate(input: ReferenceTaskQueuedUpdate, signal?: AbortSignal): Promise<ReferenceTaskIntent> {
    // Snapshot before acquiring a pool/lock; nested accessors are refused.
    const fields = taskFields(input, ["bindingId", "expectedRevision", "commandId", "operationId", "predecessorOperationId", "patch"]);
    const saved = { ...fields, patch: Object.freeze(validateTaskPatch(fields.patch)) } as unknown as ReferenceTaskQueuedUpdate;
    await this.transaction(client => enqueueTaskIntent(client, "update", saved), signal); return this.inspectIntent(saved.operationId);
  }
  async queueDelete(input: ReferenceTaskQueuedDelete, signal?: AbortSignal): Promise<ReferenceTaskIntent> {
    const saved = Object.freeze(taskFields(input, ["bindingId", "expectedRevision", "commandId", "operationId", "predecessorOperationId"])) as unknown as ReferenceTaskQueuedDelete;
    await this.transaction(client => enqueueTaskIntent(client, "delete", saved), signal); return this.inspectIntent(saved.operationId);
  }
  async inspectIntent(operationId: string): Promise<ReferenceTaskIntent> {
    const intent = await inspectTaskIntent(this.pool, operationId);
    return intent.status === "waiting" ? intent : { ...intent, execution: intent.action === "delete" ? await this.inspectDeleteOperation(operationId) : await this.inspectOperation(operationId) };
  }
  async intentExists(operationId: string): Promise<boolean> {
    if (!(await this.pool.query("SELECT to_regclass('reference_task_intents') IS NOT NULL AS ready")).rows[0].ready) return false;
    return !!(await this.pool.query("SELECT 1 FROM reference_task_intents WHERE id=$1", [operationId])).rowCount;
  }
  private currentCreate(rows: Locked): boolean {
    const { connection: conn, object, binding: target, operation: op } = rows;
    return !!conn && !!object && !!target && conn.provider === "google" && conn.status === "active" && conn.credential_ciphertext != null && conn.credential_live === true && taskWriteAllowed(conn.scope) &&
      op.provider === "google" && op.action === "create" && op.endpoint_profile === REFERENCE_TASK_CREATE_PROFILE && target.active && target.destination_lifecycle === "reserved" &&
      target.create_operation_id === op.id && target.create_profile === REFERENCE_TASK_CREATE_PROFILE && target.task_id === null && target.etag === null && target.baseline === null &&
      object.canonical_lifecycle === "active" && Number(conn.generation) === Number(op.connection_generation) && Number(object.revision) === Number(op.accepted_revision) &&
      Number(object.privacy_generation) === Number(op.privacy_generation) && Number(object.lifecycle_generation) === Number(op.canonical_generation) && Number(target.source_generation) === Number(op.source_generation) &&
      target.connection_id === op.connection_id && target.object_id === op.object_id && target.task_list_id === op.task_list_id;
  }
  async seedCreateBinding(supplied: ReferenceTaskCreateSeed): Promise<void> {
    const fields = taskFields(supplied, ["provider", "endpointProfile", "connectionId", "objectId", "bindingId", "taskListId", "operationId", "accessToken", "expiresAt", "scope", "content"], ["privacyLabel"]);
    const content = validateTaskContent(fields.content);
    if (fields.provider !== "google" || fields.endpointProfile !== REFERENCE_TASK_CREATE_PROFILE ||
      ![fields.connectionId, fields.objectId, fields.bindingId, fields.taskListId].every(taskIdentity) || fields.taskListId === "@default" ||
      typeof fields.accessToken !== "string" || !taskInstant(fields.expiresAt) || typeof fields.scope !== "string" || !taskWriteAllowed(fields.scope) ||
      fields.privacyLabel !== undefined && !taskIdentity(fields.privacyLabel)) throw new Error("Invalid reference task CREATE seed");
    taskCreateAdmissionFingerprint({ bindingId: fields.bindingId as string, commandId: "seed", operationId: fields.operationId as string, expectedRevision: 1 });
    encodeURIComponent(fields.taskListId as string);
    const input: Readonly<Record<string, unknown>> = Object.freeze({ ...fields, content: Object.freeze(content) });
    const encrypted = encryptCredential(this.credentialKey, input.connectionId as string, input.accessToken as string);
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,provider,scope,credential_ciphertext,expires_at) VALUES($1,'google',$2,$3,$4)", [input.connectionId, [...new Set((input.scope as string).split(/\s+/).filter(Boolean))].sort().join(" "), encrypted, input.expiresAt]);
      await client.query("INSERT INTO reference_task_objects(id,content,privacy_label) VALUES($1,$2,$3)", [input.objectId, input.content, input.privacyLabel ?? "private"]);
      await client.query(`INSERT INTO reference_task_bindings(id,connection_id,object_id,task_list_id,task_id,etag,baseline,destination_lifecycle,create_operation_id,create_profile)
        VALUES($1,$2,$3,$4,NULL,NULL,NULL,'reserved',$5,$6)`, [input.bindingId, input.connectionId, input.objectId, input.taskListId, input.operationId, REFERENCE_TASK_CREATE_PROFILE]);
    });
  }
  async admitCreate(supplied: ReferenceTaskCreateAdmission): Promise<ReferenceTaskCreateOperation> {
    const input = Object.freeze(taskFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceTaskCreateAdmission;
    const fingerprint = taskCreateAdmissionFingerprint(input);
    await this.transaction(async client => {
      const first = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!first) throw new ReferenceHoldError("task-binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [first.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_task_objects WHERE id=$1 FOR UPDATE", [first.object_id])).rows[0];
      const target = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_task_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [target.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("task-command-reused"); return; }
      await reserveTaskOperationIdentity(client, { operationId: input.operationId, commandId: input.commandId, connectionId: target.connection_id });
      const valid = conn && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid;
      if (!conn || conn.provider !== "google" || conn.status !== "active" || !conn.credential_ciphertext || !valid || !taskWriteAllowed(conn.scope) || !target.active || object.canonical_lifecycle !== "active") throw new ReferenceHoldError("task-source-unavailable");
      if (target.destination_lifecycle !== "reserved" || target.create_profile !== REFERENCE_TASK_CREATE_PROFILE || target.create_operation_id !== input.operationId ||
        target.task_id !== null || target.etag !== null || target.baseline !== null) throw new ReferenceHoldError("task-create-reservation-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("task-revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_task_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount || await hasWaitingTaskIntent(client, input.bindingId)) throw new ReferenceHoldError("task-causal-barrier");
      const epochs = { acceptedRevision: input.expectedRevision + 1, connectionGeneration: Number(conn.generation), sourceGeneration: Number(target.source_generation), privacyGeneration: Number(object.privacy_generation), canonicalGeneration: Number(object.lifecycle_generation) };
      const envelope = acceptedTaskCreateEnvelope(input, validateTaskContent(object.content), { objectId: object.id, connectionId: conn.id, taskListId: target.task_list_id, capture: epochs });
      await client.query("UPDATE reference_task_objects SET revision=$2 WHERE id=$1", [object.id, epochs.acceptedRevision]);
      await client.query(`INSERT INTO reference_task_operations(id,command_id,binding_id,object_id,connection_id,provider,endpoint_profile,action,task_list_id,task_id,
        accepted_revision,connection_generation,source_generation,privacy_generation,canonical_generation,accepted_etag,fingerprint,payload,saved_projection,field_mask,receipt)
        VALUES($1,$2,$3,$4,$5,'google',$6,'create',$7,NULL,$8,$9,$10,$11,$12,NULL,$13,$14,NULL,NULL,$15)`,
      [input.operationId, input.commandId, target.id, object.id, conn.id, REFERENCE_TASK_CREATE_PROFILE, target.task_list_id, epochs.acceptedRevision,
        epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, epochs.canonicalGeneration, fingerprint, { operationEnvelope: envelope }, initialReceipt(envelope)]);
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid) throw new ReferenceHoldError("task-source-unavailable");
    });
    const row = (await this.pool.query("SELECT id FROM reference_task_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId])).rows[0];
    return this.inspectCreateOperation(row.id);
  }
  async seedBinding(supplied: ReferenceTaskSeed): Promise<void> {
    const fields = taskFields(supplied, ["provider", "endpointProfile", "connectionId", "objectId", "bindingId", "taskListId", "taskId", "accessToken", "expiresAt", "scope", "content", "etag", "baseline"], ["privacyLabel"]);
    const content = validateTaskContent(fields.content), baseline = validateTaskBaseline(fields.baseline);
    if (fields.provider !== "google" || fields.endpointProfile !== REFERENCE_TASK_UPDATE_PROFILE ||
      ![fields.connectionId, fields.objectId, fields.bindingId, fields.taskListId, fields.taskId].every(taskIdentity) || fields.taskListId === "@default" ||
      typeof fields.accessToken !== "string" || !taskInstant(fields.expiresAt) || typeof fields.scope !== "string" || !taskWriteAllowed(fields.scope) ||
      !taskStrongEtag(fields.etag) || fields.privacyLabel !== undefined && !taskIdentity(fields.privacyLabel)) throw new Error("Invalid reference task seed");
    // Materialize exact private inputs before any connection/pool wait.
    const input: Readonly<Record<string, unknown>> = Object.freeze({ ...fields, content: Object.freeze(content), baseline: Object.freeze(baseline) });
    const encrypted = encryptCredential(this.credentialKey, input.connectionId as string, input.accessToken as string);
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,provider,scope,credential_ciphertext,expires_at) VALUES($1,'google',$2,$3,$4)", [input.connectionId, [...new Set((input.scope as string).split(/\s+/).filter(Boolean))].sort().join(" "), encrypted, input.expiresAt]);
      await client.query("INSERT INTO reference_task_objects(id,content,privacy_label) VALUES($1,$2,$3)", [input.objectId, input.content, input.privacyLabel ?? "private"]);
      await client.query("INSERT INTO reference_task_bindings(id,connection_id,object_id,task_list_id,task_id,etag,baseline) VALUES($1,$2,$3,$4,$5,$6,$7)", [input.bindingId, input.connectionId, input.objectId, input.taskListId, input.taskId, input.etag, input.baseline]);
    });
  }
  async admitUpdate(supplied: ReferenceTaskAdmission): Promise<ReferenceTaskOperation> {
    const fields = taskFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId", "patch"]);
    const input = Object.freeze({ ...fields, patch: Object.freeze(validateTaskPatch(fields.patch)) }) as unknown as ReferenceTaskAdmission;
    const fingerprint = taskAdmissionFingerprint(input);
    await this.transaction(async client => {
      const first = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!first) throw new ReferenceHoldError("task-binding-missing");
      const conn = (await client.query("SELECT *,expires_at>clock_timestamp() AS credential_live FROM reference_connections WHERE id=$1 FOR UPDATE", [first.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_task_objects WHERE id=$1 FOR UPDATE", [first.object_id])).rows[0];
      const target = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_task_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [target.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("task-command-reused"); return; }
      await reserveTaskOperationIdentity(client, { operationId: input.operationId, commandId: input.commandId, connectionId: target.connection_id });
      if (conn) conn.credential_live = (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid;
      if (!conn || conn.provider !== "google" || conn.status !== "active" || !conn.credential_ciphertext || !conn.credential_live || !taskWriteAllowed(conn.scope) || !target.active || (target.destination_lifecycle ?? "present") !== "present" || object.canonical_lifecycle !== "active") throw new ReferenceHoldError("task-source-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("task-revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_task_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount || await hasWaitingTaskIntent(client, input.bindingId)) throw new ReferenceHoldError("task-causal-barrier");
      if (!taskStrongEtag(target.etag)) throw new ReferenceHoldError("task-validator-unavailable");
      const content = validateTaskContent({ ...validateTaskContent(object.content), ...input.patch });
      const epochs = { acceptedRevision: input.expectedRevision + 1, connectionGeneration: Number(conn.generation), sourceGeneration: Number(target.source_generation), privacyGeneration: Number(object.privacy_generation), canonicalGeneration: Number(object.lifecycle_generation) };
      const envelope = acceptedTaskEnvelope(input, content, { objectId: object.id, connectionId: conn.id, taskListId: target.task_list_id, taskId: target.task_id, capture: epochs });
      const saved = taskSavedProjection(envelope.admittedProjection.data, target.baseline);
      // A no-op provider projection can still be a real richer canonical edit.
      await client.query("UPDATE reference_task_objects SET content=$2,revision=$3 WHERE id=$1", [object.id, content, epochs.acceptedRevision]);
      await client.query(`INSERT INTO reference_task_operations(id,command_id,binding_id,object_id,connection_id,provider,endpoint_profile,action,task_list_id,task_id,
        accepted_revision,connection_generation,source_generation,privacy_generation,canonical_generation,accepted_etag,fingerprint,payload,saved_projection,field_mask,receipt)
        VALUES($1,$2,$3,$4,$5,'google',$6,'update',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [input.operationId, input.commandId, target.id, object.id, conn.id, REFERENCE_TASK_UPDATE_PROFILE, target.task_list_id, target.task_id, epochs.acceptedRevision,
        epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, epochs.canonicalGeneration, target.etag, fingerprint, { operationEnvelope: envelope }, saved, Object.keys(saved.patch).sort(), initialReceipt(envelope)]);
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid) throw new ReferenceHoldError("task-source-unavailable");
    });
    const row = (await this.pool.query("SELECT id FROM reference_task_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId])).rows[0];
    return this.inspectOperation(row.id);
  }
  async admitDelete(supplied: ReferenceTaskDeleteAdmission): Promise<ReferenceTaskDeleteOperation> {
    const input = Object.freeze(taskFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceTaskDeleteAdmission;
    const fingerprint = taskDeleteAdmissionFingerprint(input);
    await this.transaction(async client => {
      const first = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!first) throw new ReferenceHoldError("task-binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [first.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_task_objects WHERE id=$1 FOR UPDATE", [first.object_id])).rows[0];
      const target = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_task_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [target.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("task-command-reused"); return; }
      await reserveTaskOperationIdentity(client, { operationId: input.operationId, commandId: input.commandId, connectionId: target.connection_id });
      const valid = conn && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid;
      if (!conn || conn.provider !== "google" || conn.status !== "active" || !conn.credential_ciphertext || !valid || !taskWriteAllowed(conn.scope) || !target.active || target.destination_lifecycle !== "present" || object.canonical_lifecycle !== "active") throw new ReferenceHoldError("task-source-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("task-revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_task_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount || await hasWaitingTaskIntent(client, input.bindingId)) throw new ReferenceHoldError("task-causal-barrier");
      if (!taskStrongEtag(target.etag)) throw new ReferenceHoldError("task-validator-unavailable");
      const baseline = validateTaskBaseline(target.baseline), content = validateTaskContent(object.content);
      const epochs = { acceptedRevision: input.expectedRevision + 1, connectionGeneration: Number(conn.generation), sourceGeneration: Number(target.source_generation), privacyGeneration: Number(object.privacy_generation), canonicalGeneration: Number(object.lifecycle_generation) + 1 };
      const envelope = acceptedTaskDeleteEnvelope(input, content, { objectId: object.id, connectionId: conn.id, taskListId: target.task_list_id, taskId: target.task_id, capture: epochs });
      await client.query("UPDATE reference_task_objects SET canonical_lifecycle='tombstoned' WHERE id=$1", [object.id]);
      await client.query(`INSERT INTO reference_task_operations(id,command_id,binding_id,object_id,connection_id,provider,endpoint_profile,action,task_list_id,task_id,
        accepted_revision,connection_generation,source_generation,privacy_generation,canonical_generation,accepted_etag,fingerprint,payload,saved_projection,field_mask,delete_accepted_baseline,receipt)
        VALUES($1,$2,$3,$4,$5,'google',$6,'delete',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,NULL,$17,$18)`,
      [input.operationId, input.commandId, target.id, object.id, conn.id, REFERENCE_TASK_DELETE_PROFILE, target.task_list_id, target.task_id, epochs.acceptedRevision,
        epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, epochs.canonicalGeneration, target.etag, fingerprint, { operationEnvelope: envelope }, baseline, initialReceipt(envelope)]);
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid) throw new ReferenceHoldError("task-source-unavailable");
    });
    const row = (await this.pool.query("SELECT id FROM reference_task_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId])).rows[0];
    return this.inspectDeleteOperation(row.id);
  }
  async operationAction(operationId: string): Promise<"create" | "update" | "delete"> {
    let row = (await this.pool.query("SELECT action,endpoint_profile FROM reference_task_operations WHERE id=$1", [operationId])).rows[0];
    if (!row && (await this.pool.query("SELECT to_regclass('reference_task_intents') IS NOT NULL AS ready")).rows[0].ready) {
      const intent = (await this.pool.query("SELECT action FROM reference_task_intents WHERE id=$1", [operationId])).rows[0];
      if (intent) row = { ...intent, endpoint_profile: "google-task-" + intent.action + "-v1" };
    }
    if (!row) throw new ReferenceHoldError("task-operation-missing");
    if (row.action === "update" && row.endpoint_profile === REFERENCE_TASK_UPDATE_PROFILE || row.action === "delete" && row.endpoint_profile === REFERENCE_TASK_DELETE_PROFILE || row.action === "create" && row.endpoint_profile === REFERENCE_TASK_CREATE_PROFILE) return row.action;
    throw new ReferenceHoldError("task-profile-unavailable");
  }
  async inspectDeleteOperation(operationId: string): Promise<ReferenceTaskDeleteOperation> {
    const op = (await this.pool.query(`SELECT o.*,t.content,t.revision,t.canonical_lifecycle,t.lifecycle_generation,b.active,b.source_generation AS binding_generation,b.task_id AS binding_task_id,b.etag,b.baseline,b.destination_lifecycle
      FROM reference_task_operations o JOIN reference_task_objects t ON t.id=o.object_id JOIN reference_task_bindings b ON b.id=o.binding_id WHERE o.id=$1`, [operationId])).rows[0];
    if (!op) throw new ReferenceHoldError("task-operation-missing");
    if (op.action !== "delete" || op.endpoint_profile !== REFERENCE_TASK_DELETE_PROFILE) throw new ReferenceHoldError("task-delete-port-required");
    return { operationId: op.id, commandId: op.command_id, bindingId: op.binding_id, objectId: op.object_id, provider: "google", endpointProfile: REFERENCE_TASK_DELETE_PROFILE, action: "delete", status: op.status,
      payload: op.payload, capture: capture(op), acceptedBaseline: op.delete_accepted_baseline, dispatchPossible: op.dispatch_possible,
      deleteResponse: { acceptedStatus: op.delete_acceptance_status, responseAbsenceStatus: op.delete_response_absence_status }, receipt: receipt(op.receipt), ...(op.predecessor_operation_id ? { predecessorOperationId: op.predecessor_operation_id, resolution: op.resolution_basis } : {}), ...(op.completion_evidence ? { completion: op.completion_evidence } : {}),
      canonical: { content: op.content, lifecycle: op.canonical_lifecycle, revision: Number(op.revision), generation: Number(op.lifecycle_generation) },
      binding: { taskListId: op.task_list_id, taskId: op.binding_task_id, active: op.active, sourceGeneration: Number(op.binding_generation), etag: op.etag, baseline: op.baseline, destinationLifecycle: op.destination_lifecycle },
      leaseAttemptId: op.lease_attempt_id, leaseUntil: op.lease_until?.toISOString() ?? null };
  }
  async prepareDelete(supplied: ClaimIdentity, signal?: AbortSignal) {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim, "delete")) throw new ReferenceHoldError("task-authority-changed");
      const predecessorAddress = this.predecessorAddress(locked, claim);
      return { acceptedEtag: locked.operation.accepted_etag as string, baseline: deleteBaseline(locked.operation), ...(predecessorAddress ? { predecessorAddress } : {}) };
    }, signal);
  }
  async getDeleteSession(supplied: ReferenceTaskDeleteClaim, signal?: AbortSignal): Promise<GoogleTaskAccountSession> {
    const claim = claimIdentity(supplied);
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim, "delete")) throw new ReferenceHoldError("task-authority-changed");
      deleteBaseline(locked.operation);
      return { connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation),
        accessToken: decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext), taskWriteAllowed: true };
    }, signal);
    await this.prepareDelete(claim, signal); return session;
  }
  async recordDeleteEvidence(supplied: ReferenceTaskDeleteClaim, value: RuntimeTaskDeleteNativeFacts, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(value, ["provider", "remote", "possibleDispatch"], ["acceptedStatus", "responseAbsenceStatus", "writerResult"]);
    const parsed = SyncJsonObjectSchema.safeParse(fields); if (!parsed.success) throw new ReferenceHoldError("invalid-task-delete-evidence");
    const facts = JSON.parse(JSON.stringify(parsed.data)) as unknown as RuntimeTaskDeleteNativeFacts;
    if (typeof facts.possibleDispatch !== "boolean" || !facts.provider || !facts.remote || !["not-dispatched", "accepted", "uncertain", "rejected"].includes(facts.provider.kind) || !["unobserved", "absent", "conflict"].includes(facts.remote.kind) ||
      facts.acceptedStatus !== undefined && !taskDeleteAcceptedStatus(facts.acceptedStatus) || facts.responseAbsenceStatus !== undefined && !taskDeleteResponseAbsenceStatus(facts.responseAbsenceStatus) ||
      (facts.acceptedStatus !== undefined || facts.responseAbsenceStatus !== undefined) && facts.provider.kind !== "accepted" || facts.provider.kind === "accepted" && facts.provider.validator !== null) throw new ReferenceHoldError("invalid-task-delete-evidence");
    if (facts.provider.kind === "rejected") SyncErrorSchema.parse(facts.provider.error);
    if (facts.remote.kind !== "unobserved" && !taskIdentity(facts.remote.observationId)) throw new ReferenceHoldError("invalid-task-delete-evidence");
    if (facts.remote.kind === "absent" && (facts.remote.read.kind !== "absent" || !taskDeleteResponseAbsenceStatus(facts.remote.read.status) || !["initial-read", "writer-read", "readback"].includes(facts.remote.source))) throw new ReferenceHoldError("invalid-task-delete-evidence");
    if (facts.writerResult !== undefined && (!facts.writerResult || (facts.writerResult.kind === "deleted" ? !taskDeleteAcceptedStatus(facts.writerResult.status) : facts.writerResult.kind !== "absent" || !taskDeleteResponseAbsenceStatus(facts.writerResult.status) || !["writer-read", "delete-response"].includes(facts.writerResult.source)))) throw new ReferenceHoldError("invalid-task-delete-evidence");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim)) return false;
      if (locked.operation.action !== "delete" || locked.operation.endpoint_profile !== REFERENCE_TASK_DELETE_PROFILE) throw new ReferenceHoldError("task-delete-evidence-port-required");
      if (facts.possibleDispatch && !locked.operation.dispatch_possible) throw new ReferenceHoldError("task-dispatch-evidence-missing");
      const attempt = (await client.query("SELECT * FROM reference_task_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [claim.attemptId, claim.operationId])).rows[0];
      if (!attempt) throw new ReferenceHoldError("task-attempt-missing");
      if (facts.provider.kind === "accepted" && (!locked.operation.dispatch_possible || facts.acceptedStatus === undefined && facts.responseAbsenceStatus === undefined && locked.operation.delete_acceptance_status == null && locked.operation.delete_response_absence_status == null)) throw new ReferenceHoldError("task-delete-response-missing");
      const merge = (old: SyncDeliveryReceipt): SyncDeliveryReceipt => {
        // Generic accepted means a successful DELETE response/fulfillment. Only
        // delete_acceptance_status claims actual 2xx; 404/410 is absence-only.
        const incoming = facts.provider.kind === "accepted" ? { kind: "accepted" as const } : facts.provider;
        const provider = old.provider.kind === "accepted" && facts.provider.kind !== "accepted" || old.provider.kind === "uncertain" && facts.provider.kind === "rejected" ? old.provider : incoming;
        const remote = facts.remote.kind === "unobserved" ? old.remote : { kind: facts.remote.kind === "absent" ? "confirmed" : "conflict", observationId: facts.remote.observationId };
        return receipt({ ...old, attemptId: claim.attemptId, provider, remote });
      };
      const accepted = facts.acceptedStatus ?? locked.operation.delete_acceptance_status, absent = facts.responseAbsenceStatus ?? locked.operation.delete_response_absence_status;
      await client.query("UPDATE reference_task_attempts SET receipt=$3,delete_acceptance_status=$4,delete_response_absence_status=$5,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, merge(receipt(attempt.receipt)), accepted, absent]);
      const recorded = await client.query("UPDATE reference_task_operations SET receipt=$3,delete_acceptance_status=$4,delete_response_absence_status=$5 WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp()", [claim.operationId, claim.attemptId, merge(receipt(locked.operation.receipt)), accepted, absent]);
      if (recorded.rowCount !== 1) throw new TaskAckLeaseExpired(); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async completeDelete(supplied: ReferenceTaskDeleteClaim, value: ReferenceTaskDeleteObservation, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(value, ["kind", "source", "read"]), read = taskFields(fields.read, ["kind", "status"]);
    if (fields.kind !== "exact-absence" || !["initial-read", "writer-read", "readback"].includes(fields.source as string) || read.kind !== "absent" || !taskDeleteResponseAbsenceStatus(read.status)) throw new ReferenceHoldError("invalid-task-delete-absence");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim, "delete")) return false;
      deleteBaseline(locked.operation);
      const proof = receipt(locked.operation.receipt);
      if (proof.remote.kind !== "confirmed" || proof.provider.kind === "pending" ||
        proof.provider.kind === "not-dispatched" && locked.operation.dispatch_possible || proof.provider.kind !== "not-dispatched" && !locked.operation.dispatch_possible ||
        proof.provider.kind === "accepted" && locked.operation.delete_acceptance_status == null && locked.operation.delete_response_absence_status == null) throw new ReferenceHoldError("task-delete-confirmation-missing");
      // Keep historical ETag/baseline, active grant and source epoch. Absence is
      // the scoped delivery result, not a source retirement/resurrection flow.
      await client.query("UPDATE reference_task_bindings SET destination_lifecycle='absent' WHERE id=$1", [locked.binding.id]);
      await this.acknowledge(client, locked, claim, { version: 1, kind: "absent", operationId: claim.operationId, attemptId: claim.attemptId,
        observationId: proof.remote.observationId, taskId: locked.operation.resolution_basis?.taskId ?? locked.operation.task_id,
        sourceGeneration: Number(locked.binding.source_generation), status: read.status as 404 | 410 }); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async inspectOperation(operationId: string): Promise<ReferenceTaskOperation> {
    const op = (await this.pool.query(`SELECT o.*,t.content,t.revision,t.canonical_lifecycle,t.lifecycle_generation,b.active,b.source_generation AS binding_generation,b.task_id AS binding_task_id,b.etag,b.baseline,to_jsonb(b)->>'destination_lifecycle' AS destination_lifecycle
      FROM reference_task_operations o JOIN reference_task_objects t ON t.id=o.object_id JOIN reference_task_bindings b ON b.id=o.binding_id WHERE o.id=$1`, [operationId])).rows[0];
    if (!op) throw new ReferenceHoldError("task-operation-missing");
    if (op.action !== "update" || op.endpoint_profile !== REFERENCE_TASK_UPDATE_PROFILE) throw new ReferenceHoldError("task-update-port-required");
    return { operationId: op.id, commandId: op.command_id, bindingId: op.binding_id, objectId: op.object_id, provider: "google", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, action: "update", status: op.status,
      payload: op.payload, capture: capture(op), saved: op.saved_projection, dispatchPossible: op.dispatch_possible, acceptedStatus: op.native_acceptance_status, receipt: receipt(op.receipt), ...(op.predecessor_operation_id ? { predecessorOperationId: op.predecessor_operation_id, resolution: op.resolution_basis } : {}), ...(op.completion_evidence ? { completion: op.completion_evidence } : {}),
      canonical: { content: op.content, lifecycle: op.canonical_lifecycle, revision: Number(op.revision), generation: Number(op.lifecycle_generation) },
      binding: { taskListId: op.task_list_id, taskId: op.binding_task_id, active: op.active, sourceGeneration: Number(op.binding_generation), etag: op.etag, baseline: op.baseline, destinationLifecycle: op.destination_lifecycle ?? "present" },
      leaseAttemptId: op.lease_attempt_id, leaseUntil: op.lease_until?.toISOString() ?? null };
  }
  async inspectCreateOperation(operationId: string): Promise<ReferenceTaskCreateOperation> {
    const op = (await this.pool.query(`SELECT o.*,t.content,t.revision,t.canonical_lifecycle,t.lifecycle_generation,b.active,b.source_generation AS binding_generation,
      b.task_id AS binding_task_id,b.etag,b.baseline,b.destination_lifecycle,b.create_operation_id,b.create_profile
      FROM reference_task_operations o JOIN reference_task_objects t ON t.id=o.object_id JOIN reference_task_bindings b ON b.id=o.binding_id WHERE o.id=$1`, [operationId])).rows[0];
    if (!op) throw new ReferenceHoldError("task-operation-missing");
    if (op.action !== "create" || op.endpoint_profile !== REFERENCE_TASK_CREATE_PROFILE) throw new ReferenceHoldError("task-create-port-required");
    return { operationId: op.id, commandId: op.command_id, bindingId: op.binding_id, objectId: op.object_id, provider: "google", endpointProfile: REFERENCE_TASK_CREATE_PROFILE, action: "create", status: op.status,
      payload: op.payload, capture: capture(op), dispatchPossible: op.dispatch_possible, createResponse: createResponse(op), receipt: receipt(op.receipt), ...(op.predecessor_operation_id ? { predecessorOperationId: op.predecessor_operation_id, resolution: op.resolution_basis } : {}), ...(op.completion_evidence ? { completion: op.completion_evidence } : {}),
      canonical: { content: op.content, lifecycle: op.canonical_lifecycle, revision: Number(op.revision), generation: Number(op.lifecycle_generation) },
      binding: { taskListId: op.task_list_id, taskId: op.binding_task_id, active: op.active, sourceGeneration: Number(op.binding_generation), etag: op.etag, baseline: op.baseline,
        destinationLifecycle: op.destination_lifecycle, createOperationId: op.create_operation_id, createProfile: op.create_profile },
      leaseAttemptId: op.lease_attempt_id, leaseUntil: op.lease_until?.toISOString() ?? null };
  }
  private async claimFor(operationId: string, attemptId: string, action: "create" | "update" | "delete", signal?: AbortSignal) {
    if (![operationId, attemptId].every(taskIdentity)) throw new Error("Invalid reference task attempt identity");
    return this.transaction(async client => {
      if (!await activateTaskIntent(client, operationId, signal)) return null;
      const locked = await this.locked(client, operationId), op = locked.operation;
      if (op.action !== action || op.endpoint_profile !== (action === "create" ? REFERENCE_TASK_CREATE_PROFILE : action === "delete" ? REFERENCE_TASK_DELETE_PROFILE : REFERENCE_TASK_UPDATE_PROFILE)) throw new ReferenceHoldError("task-action-port-required");
      if (["acked", "conflict"].includes(op.status) || op.lease_live || op.not_before && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS delayed", [op.not_before])).rows[0].delayed) return null;
      let saved = receipt(op.receipt);
      if (op.dispatch_possible && ["not-dispatched", "pending"].includes(saved.provider.kind)) saved = receipt({ ...saved, provider: { kind: "uncertain" } });
      saved = receipt({ ...saved, attemptId });
      if (Object.hasOwn(op, "create_acceptance_status")) await client.query("INSERT INTO reference_task_attempts(id,operation_id,receipt,recovery,native_acceptance_status,delete_acceptance_status,delete_response_absence_status,create_acceptance_status,create_candidate_id,create_candidate_validator) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [attemptId, operationId, saved, op.dispatch_possible, op.native_acceptance_status, op.delete_acceptance_status, op.delete_response_absence_status, op.create_acceptance_status, op.create_candidate_id, op.create_candidate_validator]);
      else if (Object.hasOwn(op, "delete_acceptance_status")) await client.query("INSERT INTO reference_task_attempts(id,operation_id,receipt,recovery,native_acceptance_status,delete_acceptance_status,delete_response_absence_status) VALUES($1,$2,$3,$4,$5,$6,$7)", [attemptId, operationId, saved, op.dispatch_possible, op.native_acceptance_status, op.delete_acceptance_status, op.delete_response_absence_status]);
      else await client.query("INSERT INTO reference_task_attempts(id,operation_id,receipt,recovery,native_acceptance_status) VALUES($1,$2,$3,$4,$5)", [attemptId, operationId, saved, op.dispatch_possible, op.native_acceptance_status]);
      await client.query("UPDATE reference_task_operations SET status='running',lease_attempt_id=$2,lease_until=clock_timestamp()+interval '120 seconds',receipt=$3,not_before=NULL WHERE id=$1", [operationId, attemptId, saved]);
      if (op.predecessor_operation_id && !(await client.query("SELECT lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM reference_connections c WHERE c.id=reference_task_operations.connection_id AND c.expires_at>clock_timestamp()) AS valid FROM reference_task_operations WHERE id=$1", [operationId, attemptId])).rows[0].valid)
        throw new ReferenceHoldError("task-intent-claim-authority-changed");
      return { op, saved };
    }, signal);
  }
  async claim(operationId: string, attemptId: string, signal?: AbortSignal): Promise<ReferenceTaskClaim | null> {
    const row = await this.claimFor(operationId, attemptId, "update", signal); if (!row) return null;
    const { op, saved } = row;
    return { operationId, attemptId, endpointProfile: op.endpoint_profile, payload: op.payload, binding: binding(op), capture: capture(op),
      locator: { connectionId: op.connection_id, taskListId: op.task_list_id, taskId: op.task_id }, acceptedEtag: op.accepted_etag,
      saved: op.saved_projection, receipt: saved, recovery: op.dispatch_possible, acceptedStatus: op.native_acceptance_status };
  }
  async claimDelete(operationId: string, attemptId: string, signal?: AbortSignal): Promise<ReferenceTaskDeleteClaim | null> {
    const row = await this.claimFor(operationId, attemptId, "delete", signal); if (!row) return null;
    const { op, saved } = row;
    return { operationId, attemptId, endpointProfile: op.endpoint_profile, payload: op.payload, binding: binding(op), capture: capture(op),
      locator: { connectionId: op.connection_id, taskListId: op.task_list_id, taskId: op.task_id }, acceptedEtag: op.accepted_etag,
      acceptedBaseline: op.delete_accepted_baseline, receipt: saved, recovery: op.dispatch_possible,
      deleteResponse: { acceptedStatus: op.delete_acceptance_status, responseAbsenceStatus: op.delete_response_absence_status } };
  }
  async claimCreate(operationId: string, attemptId: string, signal?: AbortSignal): Promise<ReferenceTaskCreateClaim | null> {
    const row = await this.claimFor(operationId, attemptId, "create", signal); if (!row) return null;
    const { op, saved } = row;
    return { operationId, attemptId, endpointProfile: op.endpoint_profile, payload: op.payload, binding: binding(op), capture: capture(op),
      locator: { connectionId: op.connection_id, taskListId: op.task_list_id, taskId: null }, receipt: saved, recovery: op.dispatch_possible, createResponse: createResponse(op) };
  }
  async prepareCreate(supplied: ClaimIdentity, signal?: AbortSignal) {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.currentCreate(locked)) throw new ReferenceHoldError("task-create-authority-changed");
      createProjection(locked.operation); createResponse(locked.operation);
      return { dispatchAllowed: !locked.operation.dispatch_possible };
    }, signal);
  }
  async getCreateSession(supplied: ReferenceTaskCreateClaim, signal?: AbortSignal): Promise<GoogleTaskAccountSession> {
    const claim = claimIdentity(supplied);
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.currentCreate(locked)) throw new ReferenceHoldError("task-create-authority-changed");
      createProjection(locked.operation);
      return { connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation),
        accessToken: decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext), taskWriteAllowed: true };
    }, signal);
    await this.prepareCreate(claim, signal); return session;
  }
  async markCreateDispatch(supplied: ReferenceTaskCreateClaim, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.currentCreate(locked)) throw new ReferenceHoldError("task-create-authority-changed");
      createProjection(locked.operation);
      if (locked.operation.dispatch_possible) throw new ReferenceHoldError("task-create-observe-only");
      const next = receipt({ ...receipt(locked.operation.receipt), provider: { kind: "pending" } });
      const attempt = await client.query("UPDATE reference_task_attempts SET dispatch_possible=true,receipt=$3,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, next]);
      if (attempt.rowCount !== 1) throw new ReferenceHoldError("task-attempt-missing");
      const marked = await client.query("UPDATE reference_task_operations SET dispatch_possible=true,receipt=$3 WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM reference_connections c WHERE c.id=reference_task_operations.connection_id AND c.expires_at>clock_timestamp())", [claim.operationId, claim.attemptId, next]);
      if (marked.rowCount !== 1) throw new TaskAckLeaseExpired(); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async recordCreateEvidence(supplied: ReferenceTaskCreateClaim, value: RuntimeTaskCreateNativeFacts, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(value, ["provider", "remote", "possibleDispatch"], ["acceptedStatus", "responseAddress", "writerResult"]);
    const parsed = SyncJsonObjectSchema.safeParse(fields); if (!parsed.success) throw new ReferenceHoldError("invalid-task-create-evidence");
    const facts = JSON.parse(JSON.stringify(parsed.data)) as unknown as RuntimeTaskCreateNativeFacts;
    if (typeof facts.possibleDispatch !== "boolean" || !facts.provider || !facts.remote || !["not-dispatched", "accepted", "uncertain", "rejected"].includes(facts.provider.kind) || !["unobserved", "confirmed", "conflict"].includes(facts.remote.kind) ||
      facts.acceptedStatus !== undefined && (!taskCreateAcceptedStatus(facts.acceptedStatus) || facts.provider.kind !== "accepted") ||
      facts.provider.kind === "accepted" && facts.provider.validator !== null && !taskStrongEtag(facts.provider.validator)) throw new ReferenceHoldError("invalid-task-create-evidence");
    if (facts.provider.kind === "rejected") SyncErrorSchema.parse(facts.provider.error);
    if (facts.remote.kind !== "unobserved" && !taskIdentity(facts.remote.observationId)) throw new ReferenceHoldError("invalid-task-create-evidence");
    const address = facts.responseAddress === undefined ? undefined : taskFields(facts.responseAddress, ["taskId", "validator"]);
    if (address && (!taskIdentity(address.taskId) || address.validator !== null && (typeof address.validator !== "string" || address.validator.length > 2_000_000))) throw new ReferenceHoldError("invalid-task-create-address");
    if (address) { try { encodeURIComponent(address.taskId as string); } catch { throw new ReferenceHoldError("invalid-task-create-address"); } }
    if (facts.writerResult !== undefined && (!taskIdentity(facts.writerResult.taskId) || !taskStrongEtag(facts.writerResult.etag) || address && address.taskId !== facts.writerResult.taskId)) throw new ReferenceHoldError("invalid-task-create-writer-result");
    const encodedValidator = address?.validator === null || address === undefined ? null : JSON.stringify(address.validator);
    // A live callback may finish after its DB lease expires while waiting for a
    // lock. Concrete original-response facts remain durable; this exception
    // grants no new dispatch, observation, adoption or ACK authority.
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId), op = locked.operation;
      createProjection(op); createResponse(op);
      const attempt = (await client.query("SELECT * FROM reference_task_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [claim.attemptId, claim.operationId])).rows[0];
      if (!attempt) throw new ReferenceHoldError("task-attempt-missing");
      if ((facts.possibleDispatch || facts.provider.kind !== "not-dispatched" || address) && !op.dispatch_possible) throw new ReferenceHoldError("task-dispatch-evidence-missing");
      if (facts.acceptedStatus !== undefined && (op.create_acceptance_status !== null && op.create_acceptance_status !== facts.acceptedStatus || attempt.create_acceptance_status !== null && attempt.create_acceptance_status !== facts.acceptedStatus)) throw new ReferenceHoldError("task-create-acceptance-conflict");
      if (address && (op.create_candidate_id !== null && (op.create_candidate_id !== address.taskId || op.create_candidate_validator !== encodedValidator) ||
        attempt.create_candidate_id !== null && (attempt.create_candidate_id !== address.taskId || attempt.create_candidate_validator !== encodedValidator))) throw new ReferenceHoldError("task-create-candidate-conflict");
      const status = facts.acceptedStatus ?? op.create_acceptance_status;
      if ((facts.provider.kind === "accepted" || address) && status === null) throw new ReferenceHoldError("task-create-acceptance-missing");
      const newConcreteFact = facts.acceptedStatus !== undefined && op.create_acceptance_status === null || address !== undefined && op.create_candidate_id === null;
      if (newConcreteFact && !attempt.dispatch_possible) throw new ReferenceHoldError("task-create-original-attempt-required");
      const now = (await client.query("SELECT lease_until>clock_timestamp() AS live FROM reference_task_operations WHERE id=$1", [claim.operationId])).rows[0];
      const owned = this.owned(locked, claim) && now.live === true && !signal?.aborted;
      const make = (old: SyncDeliveryReceipt, updateRemote: boolean, currentAttempt: boolean) => {
        const incoming = facts.provider.kind === "accepted" ? { kind: "accepted" as const } : facts.provider;
        const provider = old.provider.kind === "accepted" && facts.provider.kind !== "accepted" || old.provider.kind === "uncertain" && facts.provider.kind === "rejected" ? old.provider : incoming;
        const remote = !updateRemote || facts.remote.kind === "unobserved" ? old.remote : { kind: facts.remote.kind, observationId: facts.remote.observationId };
        return receipt({ ...old, ...(currentAttempt ? { attemptId: claim.attemptId } : {}), provider, remote });
      };
      await client.query(`UPDATE reference_task_attempts SET receipt=$3,create_acceptance_status=COALESCE(create_acceptance_status,$4),
        create_candidate_validator=CASE WHEN create_candidate_id IS NULL AND $5::text IS NOT NULL THEN $6 ELSE create_candidate_validator END,
        create_candidate_id=COALESCE(create_candidate_id,$5),updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2`,
      [claim.attemptId, claim.operationId, make(receipt(attempt.receipt), owned, true), status, address?.taskId ?? null, encodedValidator]);
      const old = receipt(op.receipt);
      const next = owned || facts.acceptedStatus !== undefined ? make(old, owned, owned) : old;
      await client.query(`UPDATE reference_task_operations SET receipt=$2,create_acceptance_status=COALESCE(create_acceptance_status,$3),
        create_candidate_validator=CASE WHEN create_candidate_id IS NULL AND $4::text IS NOT NULL THEN $5 ELSE create_candidate_validator END,
        create_candidate_id=COALESCE(create_candidate_id,$4) WHERE id=$1`, [claim.operationId, next, status, address?.taskId ?? null, encodedValidator]);
      return owned;
    }, signal);
  }
  async completeCreate(supplied: ReferenceTaskCreateClaim, value: ReferenceTaskCreateObservation, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(value, ["kind", "taskId", "validator", "projection", "read"]);
    const parsed = SyncJsonObjectSchema.safeParse(fields);
    if (!parsed.success || fields.kind !== "exact-readback" || !taskIdentity(fields.taskId) || !taskStrongEtag(fields.validator)) throw new ReferenceHoldError("invalid-task-create-observation");
    const observation = JSON.parse(JSON.stringify(parsed.data)) as unknown as ReferenceTaskCreateObservation;
    if (observation.read.kind !== "present" || observation.read.etag !== observation.validator || !isStrictGoogleNativeTask(observation.read.task, observation.taskId, observation.validator) || !parseGoogleTaskProjection(observation.projection)) throw new ReferenceHoldError("invalid-task-create-observation");
    const projected = parseGoogleTaskProjection(googleTaskProjectionFromNative(observation.read.task));
    if (!projected || !jsonEqual(projected, observation.projection)) throw new ReferenceHoldError("invalid-task-create-observation");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.currentCreate(locked)) return false;
      const target = createProjection(locked.operation), response = createResponse(locked.operation), proof = receipt(locked.operation.receipt);
      if (!jsonEqual(target, projected) || response.responseAddress?.taskId !== observation.taskId) throw new ReferenceHoldError("task-create-observation-conflict");
      if (!locked.operation.dispatch_possible || response.acceptedStatus === null || !["accepted", "uncertain"].includes(proof.provider.kind) || proof.remote.kind !== "confirmed") throw new ReferenceHoldError("task-create-confirmation-missing");
      if ((await client.query("SELECT id FROM reference_task_bindings WHERE connection_id=$1 AND task_list_id=$2 AND task_id=$3 AND id<>$4", [locked.operation.connection_id, locked.operation.task_list_id, observation.taskId, locked.binding.id])).rowCount) throw new ReferenceHoldError("task-create-scope-occupied");
      const adopted = (await client.query("UPDATE reference_task_bindings SET task_id=$2,etag=$3,baseline=$4,destination_lifecycle='present' WHERE id=$1 RETURNING source_generation", [locked.binding.id, observation.taskId, observation.validator, projected])).rows[0];
      const from = Number(locked.binding.source_generation), to = Number(adopted.source_generation);
      if (to !== from + 1) throw new ReferenceHoldError("task-create-adoption-epoch-changed");
      await this.acknowledge(client, locked, claim, { version: 1, kind: "present", operationId: claim.operationId, attemptId: claim.attemptId,
        observationId: proof.remote.observationId, taskId: observation.taskId, sourceGeneration: to, validator: observation.validator, projectionBaseline: projected,
        adoption: { operationId: claim.operationId, from, to } }); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async renew(supplied: ClaimIdentity, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      await client.query("SELECT id FROM reference_task_operations WHERE id=$1 FOR UPDATE", [claim.operationId]);
      const result = await client.query("UPDATE reference_task_operations SET lease_until=clock_timestamp()+interval '120 seconds' WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp()", [claim.operationId, claim.attemptId]); return result.rowCount === 1;
    }, signal);
  }
  async prepare(supplied: ClaimIdentity, signal?: AbortSignal) {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim)) throw new ReferenceHoldError("task-authority-changed");
      const saved = savedProjection(locked.operation), predecessorAddress = this.predecessorAddress(locked, claim); return { acceptedEtag: locked.operation.accepted_etag as string, baseline: saved.baseline, saved, ...(predecessorAddress ? { predecessorAddress } : {}) };
    }, signal);
  }
  async getSession(supplied: ReferenceTaskClaim, signal?: AbortSignal): Promise<GoogleTaskAccountSession> {
    const claim = claimIdentity(supplied);
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim)) throw new ReferenceHoldError("task-authority-changed");
      savedProjection(locked.operation);
      return { connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation), scope: locked.connection.scope,
        accessToken: decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext), taskWriteAllowed: true };
    }, signal);
    // A credential materialized during an asynchronous wait is checked again.
    await this.prepare(claim, signal); return session;
  }
  async markDispatch(supplied: ReferenceTaskClaim, signal?: AbortSignal): Promise<boolean> { return this.markFor(supplied, "update", signal); }
  async markDeleteDispatch(supplied: ReferenceTaskDeleteClaim, signal?: AbortSignal): Promise<boolean> { return this.markFor(supplied, "delete", signal); }
  private async markFor(supplied: ClaimIdentity, action: "update" | "delete", signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim, action)) throw new ReferenceHoldError("task-authority-changed");
      if (action === "delete") {
        deleteBaseline(locked.operation);
        if (locked.operation.delete_acceptance_status != null || locked.operation.delete_response_absence_status != null) throw new ReferenceHoldError("task-delete-observe-only");
      } else savedProjection(locked.operation);
      const saved = receipt(locked.operation.receipt), next = receipt({ ...saved, provider: saved.provider.kind === "accepted" || action === "delete" && saved.provider.kind === "uncertain" ? saved.provider : { kind: "pending" } });
      const attempt = await client.query("UPDATE reference_task_attempts SET dispatch_possible=true,receipt=$3,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, next]);
      if (attempt.rowCount !== 1) throw new ReferenceHoldError("task-attempt-missing");
      const marked = await client.query("UPDATE reference_task_operations SET dispatch_possible=true,receipt=$3 WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM reference_connections c WHERE c.id=reference_task_operations.connection_id AND c.expires_at>clock_timestamp())", [claim.operationId, claim.attemptId, next]);
      if (marked.rowCount !== 1) throw new TaskAckLeaseExpired(); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async recordEvidence(supplied: ReferenceTaskClaim, value: RuntimeTaskNativeFacts, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(value, ["provider", "remote", "possibleDispatch"], ["acceptedStatus"]);
    const parsed = SyncJsonObjectSchema.safeParse(fields); if (!parsed.success) throw new ReferenceHoldError("invalid-task-evidence");
    const facts = JSON.parse(JSON.stringify(parsed.data)) as unknown as RuntimeTaskNativeFacts;
    if (typeof facts.possibleDispatch !== "boolean" || !["not-dispatched", "accepted", "uncertain", "rejected"].includes(facts.provider.kind) || !["unobserved", "confirmed", "conflict"].includes(facts.remote.kind) ||
      facts.acceptedStatus !== undefined && (facts.provider.kind !== "accepted" || ![200,201,204].includes(facts.acceptedStatus)) || facts.provider.kind === "accepted" && facts.provider.validator !== null && !taskStrongEtag(facts.provider.validator)) throw new ReferenceHoldError("invalid-task-evidence");
    if (facts.provider.kind === "rejected") SyncErrorSchema.parse(facts.provider.error);
    if (facts.remote.kind !== "unobserved" && !taskIdentity(facts.remote.observationId)) throw new ReferenceHoldError("invalid-task-evidence");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim)) return false;
      if (locked.operation.action !== "update") throw new ReferenceHoldError("task-update-evidence-port-required");
      if (facts.possibleDispatch && !locked.operation.dispatch_possible) throw new ReferenceHoldError("task-dispatch-evidence-missing");
      const attempt = (await client.query("SELECT * FROM reference_task_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [claim.attemptId, claim.operationId])).rows[0];
      if (!attempt) throw new ReferenceHoldError("task-attempt-missing");
      if (facts.provider.kind === "accepted" && (!locked.operation.dispatch_possible || facts.acceptedStatus === undefined && locked.operation.native_acceptance_status == null)) throw new ReferenceHoldError("task-acceptance-status-missing");
      const merge = (old: SyncDeliveryReceipt): SyncDeliveryReceipt => {
        const incoming = facts.provider.kind === "accepted" ? { kind: "accepted", ...(facts.provider.validator ? { validator: { kind: "etag", value: facts.provider.validator } } : {}) } : facts.provider;
        const provider = old.provider.kind === "accepted" && facts.provider.kind !== "accepted" || old.provider.kind === "uncertain" && facts.provider.kind === "rejected" ? old.provider : incoming;
        const remote = facts.remote.kind === "unobserved" ? old.remote : { kind: facts.remote.kind, observationId: facts.remote.observationId };
        return receipt({ ...old, attemptId: claim.attemptId, provider, remote });
      };
      const status = facts.provider.kind === "accepted" ? facts.acceptedStatus ?? locked.operation.native_acceptance_status : locked.operation.native_acceptance_status;
      await client.query("UPDATE reference_task_attempts SET receipt=$3,native_acceptance_status=$4,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, merge(receipt(attempt.receipt)), status]);
      const recorded = await client.query("UPDATE reference_task_operations SET receipt=$3,native_acceptance_status=$4 WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp()", [claim.operationId, claim.attemptId, merge(receipt(locked.operation.receipt)), status]);
      if (recorded.rowCount !== 1) throw new TaskAckLeaseExpired(); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async completeUpdate(supplied: ReferenceTaskClaim, value: Pick<RuntimeTaskCompletionEvidence, "validator" | "projection" | "read" | "saved">, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(value, ["validator", "projection", "read", "saved"]);
    const parsed = SyncJsonObjectSchema.safeParse(fields); if (!parsed.success || !taskStrongEtag(fields.validator)) throw new ReferenceHoldError("invalid-task-observation");
    const observation = JSON.parse(JSON.stringify(parsed.data)) as unknown as typeof value;
    if (observation.read.kind !== "present" || observation.read.etag !== observation.validator ||
      !isStrictGoogleNativeTask(observation.read.task, observation.read.task?.id, observation.validator) || !parseGoogleTaskProjection(observation.projection)) throw new ReferenceHoldError("invalid-task-observation");
    const projected = parseGoogleTaskProjection(googleTaskProjectionFromNative(observation.read.task));
    if (!projected || !jsonEqual(projected, observation.projection)) throw new ReferenceHoldError("invalid-task-observation");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!await this.currentFor(client, locked, claim)) return false;
      const saved = savedProjection(locked.operation);
      if (observation.read.task.id !== (locked.operation.resolution_basis?.taskId ?? locked.operation.task_id) || !jsonEqual(saved, observation.saved) || !jsonEqual(saved.projection, observation.projection)) throw new ReferenceHoldError("task-observation-conflict");
      const proof = receipt(locked.operation.receipt), attempt = (await client.query("SELECT recovery FROM reference_task_attempts WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId])).rows[0];
      const emptyMask = Object.keys(saved.patch).length === 0 && proof.provider.kind === "not-dispatched" && !locked.operation.dispatch_possible;
      const fulfilledAfterRejection = proof.provider.kind === "rejected" && locked.operation.dispatch_possible && attempt?.recovery === true;
      if (proof.remote.kind !== "confirmed" || !emptyMask && !fulfilledAfterRejection && !["accepted", "uncertain"].includes(proof.provider.kind)) throw new ReferenceHoldError("task-confirmation-missing");
      if (!(await client.query("SELECT lease_until>clock_timestamp() AS live FROM reference_task_operations WHERE id=$1", [claim.operationId])).rows[0].live) return false;
      await client.query("UPDATE reference_task_bindings SET etag=$2,baseline=$3 WHERE id=$1", [locked.binding.id, observation.validator, projected]);
      // Last DB-clock lease check after every awaited mapping write. Throwing
      // makes false settlement roll back the provisional mapping too.
      await this.acknowledge(client, locked, claim, { version: 1, kind: "present", operationId: claim.operationId, attemptId: claim.attemptId,
        observationId: proof.remote.observationId, taskId: observation.read.task.id, sourceGeneration: Number(locked.binding.source_generation),
        validator: observation.validator, projectionBaseline: projected }); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async finish(supplied: ClaimIdentity, status: "hold" | "conflict", details: { code?: string; retryAfterMs?: number } = {}): Promise<boolean> {
    const claim = claimIdentity(supplied), fields = taskFields(details, [], ["code", "retryAfterMs"]);
    if (!["hold", "conflict"].includes(status) || fields.code !== undefined && (typeof fields.code !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(fields.code)) ||
      fields.retryAfterMs !== undefined && (typeof fields.retryAfterMs !== "number" || fields.retryAfterMs !== Infinity && (!Number.isSafeInteger(fields.retryAfterMs) || fields.retryAfterMs < 0))) throw new Error("Invalid reference task finish");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); if (!this.owned(locked, claim)) return false;
      const settled = await client.query("UPDATE reference_task_operations SET status=$3,lease_attempt_id=NULL,lease_until=NULL,not_before=CASE WHEN $4::double precision IS NULL THEN NULL WHEN $4::double precision='Infinity'::double precision THEN 'infinity'::timestamptz ELSE clock_timestamp()+$4*interval '1 millisecond' END WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp()", [claim.operationId, claim.attemptId, status, fields.retryAfterMs ?? null]);
      if (settled.rowCount !== 1) throw new TaskAckLeaseExpired();
      if (fields.code) await client.query("UPDATE reference_task_attempts SET code=$2,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$3", [claim.attemptId, fields.code, claim.operationId]);
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS live", [locked.operation.lease_until])).rows[0].live) throw new TaskAckLeaseExpired(); return true;
    }).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
}
class TaskAckLeaseExpired extends Error {}
