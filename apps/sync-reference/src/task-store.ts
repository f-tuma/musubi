import type { Pool, PoolClient } from "pg";
import { googleTaskProjectionFromNative, parseGoogleTaskProjection, isStrictGoogleNativeTask, type GoogleTaskAccountSession } from "@musubi/provider-google";
import { supportsGoogleTaskUpdateEnvelope, type RuntimeTaskNativeFacts, type RuntimeTaskCompletionEvidence, type GoogleTaskSavedProjection } from "@musubi/sync-runtime";
import { decodeSyncOperationPayload, SyncDeliveryReceiptSchema, SyncErrorSchema, SyncJsonObjectSchema, type SyncDeliveryReceipt, type SyncOperationRowBinding } from "@musubi/types";
import { assertCredentialKey, decryptCredential, encryptCredential } from "./crypto.js";
import { initialReceipt, jsonEqual } from "./admission.js";
import { ReferenceHoldError } from "./model.js";
import { acceptedTaskEnvelope, REFERENCE_TASK_UPDATE_PROFILE, taskAdmissionFingerprint, taskFields, taskIdentity, taskInstant, taskSavedProjection, taskStrongEtag, taskWriteAllowed, validateTaskBaseline, validateTaskContent, validateTaskPatch } from "./task-admission.js";
import type { ReferenceTaskAdmission, ReferenceTaskClaim, ReferenceTaskOperation, ReferenceTaskSeed } from "./task-model.js";

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
function binding(op: Row): SyncOperationRowBinding {
  return { kind: "task", action: "update", operationId: op.id, commandId: op.command_id, hostObjectId: op.object_id, provider: op.provider,
    connectionId: op.connection_id, collectionId: op.task_list_id, resourceId: op.task_id, acceptedRevision: Number(op.accepted_revision),
    sourceEpoch: { sourceId: op.binding_id, generation: Number(op.source_generation) }, privacyEpoch: String(op.privacy_generation) };
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
  private current(rows: Locked): boolean {
    const { connection: conn, object, binding: target, operation: op } = rows;
    return !!conn && !!object && !!target && conn.provider === "google" && conn.status === "active" && conn.credential_ciphertext != null && conn.credential_live === true && taskWriteAllowed(conn.scope) &&
      op.provider === "google" && op.action === "update" && op.endpoint_profile === REFERENCE_TASK_UPDATE_PROFILE && target.active && object.canonical_lifecycle === "active" &&
      Number(conn.generation) === Number(op.connection_generation) && Number(object.revision) === Number(op.accepted_revision) &&
      Number(object.privacy_generation) === Number(op.privacy_generation) && Number(object.lifecycle_generation) === Number(op.canonical_generation) && Number(target.source_generation) === Number(op.source_generation) &&
      target.connection_id === op.connection_id && target.object_id === op.object_id && target.task_list_id === op.task_list_id && target.task_id === op.task_id &&
      target.etag === op.accepted_etag && jsonEqual(target.baseline, op.saved_projection?.baseline);
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
      if (conn) conn.credential_live = (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid;
      if (!conn || conn.provider !== "google" || conn.status !== "active" || !conn.credential_ciphertext || !conn.credential_live || !taskWriteAllowed(conn.scope) || !target.active || object.canonical_lifecycle !== "active") throw new ReferenceHoldError("task-source-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("task-revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_task_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount) throw new ReferenceHoldError("task-causal-barrier");
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
  async inspectOperation(operationId: string): Promise<ReferenceTaskOperation> {
    const op = (await this.pool.query(`SELECT o.*,t.content,t.revision,t.canonical_lifecycle,t.lifecycle_generation,b.active,b.source_generation AS binding_generation,b.etag,b.baseline
      FROM reference_task_operations o JOIN reference_task_objects t ON t.id=o.object_id JOIN reference_task_bindings b ON b.id=o.binding_id WHERE o.id=$1`, [operationId])).rows[0];
    if (!op) throw new ReferenceHoldError("task-operation-missing");
    return { operationId: op.id, commandId: op.command_id, bindingId: op.binding_id, objectId: op.object_id, provider: "google", endpointProfile: REFERENCE_TASK_UPDATE_PROFILE, action: "update", status: op.status,
      payload: op.payload, capture: capture(op), saved: op.saved_projection, dispatchPossible: op.dispatch_possible, acceptedStatus: op.native_acceptance_status, receipt: receipt(op.receipt),
      canonical: { content: op.content, lifecycle: op.canonical_lifecycle, revision: Number(op.revision), generation: Number(op.lifecycle_generation) },
      binding: { taskListId: op.task_list_id, taskId: op.task_id, active: op.active, sourceGeneration: Number(op.binding_generation), etag: op.etag, baseline: op.baseline },
      leaseAttemptId: op.lease_attempt_id, leaseUntil: op.lease_until?.toISOString() ?? null };
  }
  async claim(operationId: string, attemptId: string): Promise<ReferenceTaskClaim | null> {
    if (![operationId, attemptId].every(taskIdentity)) throw new Error("Invalid reference task attempt identity");
    return this.transaction(async client => {
      const locked = await this.locked(client, operationId), op = locked.operation;
      if (["acked", "conflict"].includes(op.status) || op.lease_live || op.not_before && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS delayed", [op.not_before])).rows[0].delayed) return null;
      let saved = receipt(op.receipt);
      if (op.dispatch_possible && ["not-dispatched", "pending"].includes(saved.provider.kind)) saved = receipt({ ...saved, provider: { kind: "uncertain" } });
      saved = receipt({ ...saved, attemptId });
      await client.query("INSERT INTO reference_task_attempts(id,operation_id,receipt,recovery,native_acceptance_status) VALUES($1,$2,$3,$4,$5)", [attemptId, operationId, saved, op.dispatch_possible, op.native_acceptance_status]);
      await client.query("UPDATE reference_task_operations SET status='running',lease_attempt_id=$2,lease_until=clock_timestamp()+interval '120 seconds',receipt=$3,not_before=NULL WHERE id=$1", [operationId, attemptId, saved]);
      return { operationId, attemptId, endpointProfile: op.endpoint_profile, payload: op.payload, binding: binding(op), capture: capture(op),
        locator: { connectionId: op.connection_id, taskListId: op.task_list_id, taskId: op.task_id }, acceptedEtag: op.accepted_etag,
        saved: op.saved_projection, receipt: saved, recovery: op.dispatch_possible, acceptedStatus: op.native_acceptance_status };
    });
  }
  async renew(supplied: ReferenceTaskClaim, signal?: AbortSignal): Promise<boolean> {
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
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("task-authority-changed");
      const saved = savedProjection(locked.operation); return { acceptedEtag: locked.operation.accepted_etag as string, baseline: saved.baseline, saved };
    }, signal);
  }
  async getSession(supplied: ReferenceTaskClaim, signal?: AbortSignal): Promise<GoogleTaskAccountSession> {
    const claim = claimIdentity(supplied);
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("task-authority-changed");
      savedProjection(locked.operation);
      return { connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation), scope: locked.connection.scope,
        accessToken: decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext), taskWriteAllowed: true };
    }, signal);
    // A credential materialized during an asynchronous wait is checked again.
    await this.prepare(claim, signal); return session;
  }
  async markDispatch(supplied: ReferenceTaskClaim, signal?: AbortSignal): Promise<boolean> {
    const claim = claimIdentity(supplied);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId); signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("task-authority-changed");
      savedProjection(locked.operation);
      const saved = receipt(locked.operation.receipt), next = receipt({ ...saved, provider: saved.provider.kind === "accepted" ? saved.provider : { kind: "pending" } });
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
      if (!this.owned(locked, claim) || !this.current(locked)) return false;
      const saved = savedProjection(locked.operation);
      if (observation.read.task.id !== locked.operation.task_id || !jsonEqual(saved, observation.saved) || !jsonEqual(saved.projection, observation.projection)) throw new ReferenceHoldError("task-observation-conflict");
      const proof = receipt(locked.operation.receipt), attempt = (await client.query("SELECT recovery FROM reference_task_attempts WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId])).rows[0];
      const emptyMask = Object.keys(saved.patch).length === 0 && proof.provider.kind === "not-dispatched" && !locked.operation.dispatch_possible;
      const fulfilledAfterRejection = proof.provider.kind === "rejected" && locked.operation.dispatch_possible && attempt?.recovery === true;
      if (proof.remote.kind !== "confirmed" || !emptyMask && !fulfilledAfterRejection && !["accepted", "uncertain"].includes(proof.provider.kind)) throw new ReferenceHoldError("task-confirmation-missing");
      if (!(await client.query("SELECT lease_until>clock_timestamp() AS live FROM reference_task_operations WHERE id=$1", [claim.operationId])).rows[0].live) return false;
      await client.query("UPDATE reference_task_bindings SET etag=$2,baseline=$3 WHERE id=$1", [locked.binding.id, observation.validator, projected]);
      // Last DB-clock lease check after every awaited mapping write. Throwing
      // makes false settlement roll back the provisional mapping too.
      const completed = await client.query("UPDATE reference_task_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp() AND EXISTS(SELECT 1 FROM reference_connections c WHERE c.id=reference_task_operations.connection_id AND c.expires_at>clock_timestamp())", [claim.operationId, claim.attemptId]);
      if (completed.rowCount !== 1) throw new TaskAckLeaseExpired(); return true;
    }, signal).catch(error => { if (error instanceof TaskAckLeaseExpired) return false; throw error; });
  }
  async finish(supplied: ReferenceTaskClaim, status: "hold" | "conflict", details: { code?: string; retryAfterMs?: number } = {}): Promise<boolean> {
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
