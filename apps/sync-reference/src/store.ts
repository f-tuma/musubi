import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { SyncDeliveryReceiptSchema, SyncOperationEnvelopeSchema, SyncErrorSchema, SyncJsonObjectSchema, type SyncDeliveryReceipt, type SyncOperationRowBinding } from "@musubi/types";
import { acceptedEnvelope, admissionFingerprint, initialReceipt, jsonEqual, projection, strongEtag, validateContent, validatePatch } from "./admission.js";
import { assertCredentialKey, decryptCredential, encryptCredential } from "./crypto.js";
import { ReferenceHoldError, type ReferenceAdmission, type ReferenceCapture, type ReferenceClaim, type ReferenceEvidence, type ReferenceOperation, type ReferenceSeed, type ReferenceContentPatch } from "./model.js";
export { ReferenceHoldError } from "./model.js";
export type { ReferenceClaim as Claim } from "./model.js";

type Row = Record<string, any>;
interface Locked { operation: Row; connection: Row; object: Row; binding: Row }
const scopeValue = (scope: string) => [...new Set(scope.split(/\s+/).filter(Boolean))].sort().join(" ");
const writeAllowed = (scope: string) => scope.split(/\s+/).some(value => [
  "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.owned",
].includes(value));
/** Read sanctioned own data fields once, without evaluating accessors. The
 * caller retains its objects; asynchronous persistence uses only our copy. */
function copyDataFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Invalid reference input");
  const copy: Record<string, unknown> = {};
  for (const field of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor && optional.includes(field)) continue;
    if (!descriptor || !("value" in descriptor)) throw new Error("Invalid reference input");
    copy[field] = descriptor.value;
  }
  return copy;
}
const receipt = (value: unknown): SyncDeliveryReceipt => SyncDeliveryReceiptSchema.parse(value);
const rawEnvelope = (payload: unknown) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  ? (payload as Record<string, unknown>).operationEnvelope : undefined;
const capture = (row: Row): ReferenceCapture => ({ connectionGeneration: Number(row.connection_generation), sourceGeneration: Number(row.source_generation),
  privacyGeneration: Number(row.privacy_generation), acceptedRevision: Number(row.accepted_revision) });
const rowBinding = (row: Row): SyncOperationRowBinding => ({ kind: "event", action: "update", operationId: row.id, commandId: row.command_id,
  hostObjectId: row.object_id, provider: "google", connectionId: row.connection_id, collectionId: row.calendar_id, resourceId: row.event_id,
  acceptedRevision: Number(row.accepted_revision), sourceEpoch: { sourceId: row.binding_id, generation: Number(row.source_generation) },
  privacyEpoch: String(row.privacy_generation) });

/** Short transactions own all authority/lease checks; no network awaits occur under locks. */
export class ReferenceStore {
  constructor(readonly pool: Pool, private readonly credentialKey: string) { assertCredentialKey(credentialKey); }
  async migrate(): Promise<void> {
    const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await this.transaction(async client => { await client.query(sql); });
  }
  private async transaction<T>(body: (client: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    try {
      signal?.throwIfAborted();
      await client.query("BEGIN");
      const result = await body(client);
      // Cancellation during an awaited pool/lock/query rolls back provisional
      // writes. Cancellation after COMMIT is sent cannot undo a host ACK.
      signal?.throwIfAborted();
      await client.query("COMMIT");
      return result;
    }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async locked(client: PoolClient, operationId: string): Promise<Locked> {
    const initial = (await client.query("SELECT * FROM reference_operations WHERE id=$1", [operationId])).rows[0];
    if (!initial) throw new ReferenceHoldError("operation-missing");
    // Every host operation uses connection -> object -> binding -> operation.
    const connection = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
    const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
    const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [initial.binding_id])).rows[0];
    const operation = (await client.query("SELECT *,lease_until>clock_timestamp() AS lease_live FROM reference_operations WHERE id=$1 FOR UPDATE", [operationId])).rows[0];
    return { operation, connection, object, binding };
  }
  private current(locked: Locked): boolean {
    const { operation: op, connection: conn, object, binding } = locked;
    return !!conn && !!object && !!binding && conn.status === "active" && conn.credential_ciphertext != null && binding.active &&
      Number(conn.generation) === Number(op.connection_generation) && Number(object.revision) === Number(op.accepted_revision) &&
      Number(object.privacy_generation) === Number(op.privacy_generation) && Number(binding.source_generation) === Number(op.source_generation) &&
      binding.connection_id === op.connection_id && binding.object_id === op.object_id && binding.calendar_id === op.calendar_id && binding.event_id === op.event_id;
  }
  private owned(locked: Locked, claim: ReferenceClaim): boolean {
    return locked.operation.lease_live === true && locked.operation.lease_attempt_id === claim.attemptId && locked.operation.status === "running";
  }
  async seedBinding(supplied: ReferenceSeed): Promise<void> {
    const fields = copyDataFields(supplied, ["connectionId", "objectId", "bindingId", "calendarId", "eventId", "accessToken", "expiresAt", "scope", "content", "etag"], ["privacyLabel"]);
    const input = Object.freeze({ ...fields, content: Object.freeze({ ...validateContent(fields.content as ReferenceSeed["content"]) }) }) as unknown as ReferenceSeed;
    if (typeof input.accessToken !== "string" || typeof input.scope !== "string" || typeof input.expiresAt !== "string" ||
      input.privacyLabel !== undefined && typeof input.privacyLabel !== "string" ||
      !strongEtag(input.etag) || !Number.isFinite(Date.parse(input.expiresAt)) ||
      ![input.connectionId, input.objectId, input.bindingId, input.calendarId, input.eventId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048))
      throw new Error("Invalid reference binding seed");
    const ciphertext = encryptCredential(this.credentialKey, input.connectionId, input.accessToken);
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,scope,credential_ciphertext,expires_at) VALUES($1,$2,$3,$4)",
        [input.connectionId, scopeValue(input.scope), ciphertext, input.expiresAt]);
      await client.query("INSERT INTO reference_objects(id,privacy_label,content) VALUES($1,$2,$3)", [input.objectId, input.privacyLabel ?? "private", input.content]);
      await client.query("INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [input.bindingId, input.connectionId, input.objectId, input.calendarId, input.eventId, input.etag, projection(input.content)]);
    });
  }
  async admitUpdate(supplied: ReferenceAdmission): Promise<ReferenceOperation> {
    const fields = copyDataFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId", "patch"]);
    const input = Object.freeze({ ...fields, patch: Object.freeze({ ...validatePatch(fields.patch as ReferenceContentPatch) }) }) as unknown as ReferenceAdmission;
    const fingerprint = admissionFingerprint(input);
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
      const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [binding.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("command-reused"); return; }
      if (conn.status !== "active" || conn.credential_ciphertext == null || !writeAllowed(conn.scope) || !binding.active) throw new ReferenceHoldError("source-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount)
        throw new ReferenceHoldError("causal-barrier");
      if (!strongEtag(binding.etag)) throw new ReferenceHoldError("validator-unavailable");
      const content = validateContent({ ...object.content, ...input.patch });
      const acceptedRevision = input.expectedRevision + 1;
      const epochs: ReferenceCapture = { acceptedRevision, connectionGeneration: Number(conn.generation), sourceGeneration: Number(binding.source_generation), privacyGeneration: Number(object.privacy_generation) };
      const envelope = acceptedEnvelope(input, content, { objectId: object.id, connectionId: conn.id, calendarId: binding.calendar_id, eventId: binding.event_id, capture: epochs });
      await client.query("UPDATE reference_objects SET revision=$2,content=$3 WHERE id=$1", [object.id, acceptedRevision, content]);
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, binding.event_id, acceptedRevision,
          epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, binding.etag, fingerprint,
          { operationEnvelope: envelope }, initialReceipt(envelope)]);
    });
    // Idempotent command retry returns the original operation, including after ACK.
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
  }
  async inspectOperation(operationId: string): Promise<ReferenceOperation> {
    const row = (await this.pool.query(`SELECT o.*,b.etag AS binding_etag,b.baseline,b.active,b.source_generation AS binding_generation
      FROM reference_operations o JOIN reference_bindings b ON b.id=o.binding_id WHERE o.id=$1`, [operationId])).rows[0];
    if (!row) throw new ReferenceHoldError("operation-missing");
    return { operationId: row.id, commandId: row.command_id, bindingId: row.binding_id, objectId: row.object_id, payload: row.payload,
      capture: capture(row), status: row.status, dispatchPossible: row.dispatch_possible, receipt: receipt(row.receipt),
      leaseAttemptId: row.lease_attempt_id, leaseUntil: row.lease_until?.toISOString() ?? null,
      binding: { etag: row.binding_etag, baseline: row.baseline, active: row.active, sourceGeneration: Number(row.binding_generation) } };
  }
  async claim(operationId: string, attemptId: string): Promise<ReferenceClaim | null> {
    if (!attemptId || attemptId.length > 2048) throw new Error("Invalid reference attempt identity");
    return this.transaction(async client => {
      const locked = await this.locked(client, operationId); const op = locked.operation;
      if (op.status === "acked" || op.status === "conflict" || op.lease_live ||
        (op.not_before && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS delayed", [op.not_before])).rows[0].delayed)) return null;
      let saved = receipt(op.receipt);
      if (op.dispatch_possible && ["pending", "not-dispatched"].includes(saved.provider.kind)) saved = receipt({ ...saved, provider: { kind: "uncertain" } });
      saved = receipt({ ...saved, attemptId });
      await client.query("INSERT INTO reference_attempts(id,operation_id,receipt,recovery) VALUES($1,$2,$3,$4)", [attemptId, operationId, saved, op.dispatch_possible]);
      await client.query("UPDATE reference_operations SET status='running',lease_attempt_id=$2,lease_until=clock_timestamp()+interval '120 seconds',receipt=$3,not_before=NULL WHERE id=$1", [operationId, attemptId, saved]);
      const parsed = SyncOperationEnvelopeSchema.safeParse(rawEnvelope(op.payload));
      return { operationId, attemptId, payload: op.payload, envelope: parsed.success ? parsed.data : undefined,
        binding: rowBinding(op), capture: capture(op), locator: { connectionId: op.connection_id, calendarId: op.calendar_id, eventId: op.event_id },
        etag: op.accepted_etag, receipt: saved, recovery: op.dispatch_possible };
    });
  }
  async renew(claim: ReferenceClaim): Promise<boolean> {
    const result = await this.pool.query(`UPDATE reference_operations SET lease_until=clock_timestamp()+interval '120 seconds'
      WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp()`, [claim.operationId, claim.attemptId]);
    return result.rowCount === 1;
  }
  async getSession(claim: ReferenceClaim, _clockEpochMs: number, signal?: AbortSignal): Promise<{
    accessToken: string; connectionId: string; connectionGeneration: string; scope: string; eventWriteAllowed: boolean;
  }> {
    if (signal?.aborted) throw new ReferenceHoldError("cancelled");
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [locked.connection.expires_at])).rows[0].valid)
        throw new ReferenceHoldError("credentials-expired");
      return { accessToken: decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext),
        connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation), scope: locked.connection.scope,
        eventWriteAllowed: writeAllowed(locked.connection.scope) };
    });
    if (signal?.aborted) throw new ReferenceHoldError("cancelled");
    // Recheck after asynchronous materialization; final mutation has another fence.
    await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
    });
    return session;
  }
  async markDispatch(claim: ReferenceClaim, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
      const saved = receipt(locked.operation.receipt);
      const next = receipt({ ...saved, provider: saved.provider.kind === "accepted" ? saved.provider : { kind: "pending" } });
      await client.query("UPDATE reference_operations SET dispatch_possible=true,receipt=$3 WHERE id=$1 AND lease_attempt_id=$2", [claim.operationId, claim.attemptId, next]);
      await client.query("UPDATE reference_attempts SET dispatch_possible=true,receipt=$3,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, next]);
      return true;
    }, signal);
  }
  async recordEvidence(claim: ReferenceClaim, supplied: ReferenceEvidence, signal?: AbortSignal): Promise<boolean> {
    const fields = copyDataFields(supplied, ["provider", "remote"], ["validator", "observationId", "code", "error"]);
    if (!["accepted", "uncertain", "rejected", "not-dispatched"].includes(fields.provider as string) ||
      !["confirmed", "conflict", "unobserved"].includes(fields.remote as string) ||
      ["validator", "observationId", "code"].some(field => fields[field] !== undefined && typeof fields[field] !== "string"))
      throw new ReferenceHoldError("invalid-protocol-evidence");
    const parsedError = fields.error === undefined ? undefined : SyncErrorSchema.safeParse(fields.error);
    if (parsedError && !parsedError.success) throw new ReferenceHoldError("invalid-protocol-error");
    const protocolError = parsedError?.success ? Object.freeze(parsedError.data) : undefined;
    const evidence = Object.freeze({ ...fields, ...(protocolError ? { error: protocolError } : {}) }) as unknown as ReferenceEvidence;
    if (evidence.validator !== undefined && !strongEtag(evidence.validator)) throw new ReferenceHoldError("validator-unavailable");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      const attempt = (await client.query("SELECT receipt FROM reference_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [claim.attemptId, claim.operationId])).rows[0];
      if (!attempt) throw new ReferenceHoldError("attempt-missing");
      const make = (saved: SyncDeliveryReceipt) => {
        const provider = evidence.provider === "accepted" ? { kind: "accepted", ...(evidence.validator ? { validator: { kind: "etag", value: evidence.validator } } : {}) } :
          evidence.provider === "rejected" ? { kind: "rejected", error: protocolError ?? { code: ["conflict", "provider-conflict"].includes(evidence.code ?? "") ? "conflict" : "transport-failed", retry: "never" } } : { kind: evidence.provider };
        // Never erase a known native acceptance when observation subsequently fails.
        const effectiveProvider = saved.provider.kind === "accepted" && evidence.provider !== "accepted" ? saved.provider : provider;
        const remote = evidence.remote === "unobserved" ? saved.remote : { kind: evidence.remote, observationId: evidence.observationId ?? claim.attemptId };
        return receipt({ ...saved, attemptId: claim.attemptId, provider: effectiveProvider, remote });
      };
      const nextAttempt = make(receipt(attempt.receipt));
      const safeCode = evidence.code && /^[a-z][a-z0-9-]{0,63}$/.test(evidence.code) ? evidence.code : null;
      await client.query("UPDATE reference_attempts SET receipt=$3,code=$4,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, nextAttempt, safeCode]);
      if (!this.owned(locked, claim)) return false;
      await client.query("UPDATE reference_operations SET receipt=$2 WHERE id=$1", [claim.operationId, make(receipt(locked.operation.receipt))]);
      return true;
    }, signal);
  }
  async complete(claim: ReferenceClaim, supplied: { etag: string; projection: Record<string, unknown> }, signal?: AbortSignal): Promise<boolean> {
    const fields = copyDataFields(supplied, ["etag", "projection"]);
    if (!strongEtag(fields.etag)) throw new ReferenceHoldError("validator-unavailable");
    const parsedProjection = SyncJsonObjectSchema.safeParse(fields.projection);
    if (!parsedProjection.success) throw new ReferenceHoldError("invalid-protocol-observation");
    // The custom schema validates lossless plain JSON; clone it while synchronous
    // so caller-owned nested values cannot change after the validator check.
    const observation = Object.freeze({ etag: fields.etag, projection: Object.freeze(JSON.parse(JSON.stringify(parsedProjection.data)) as Record<string, unknown>) });
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked)) return false;
      const parsed = SyncOperationEnvelopeSchema.safeParse(rawEnvelope(locked.operation.payload));
      if (!parsed.success || !jsonEqual(observation.projection, parsed.data.admittedProjection.data)) throw new ReferenceHoldError("observation-conflict");
      const saved = receipt(locked.operation.receipt);
      const attempt = (await client.query("SELECT recovery FROM reference_attempts WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId])).rows[0];
      // ACK binds the verified desired content. A recorded rejection remains a
      // rejection even when another actor later fulfils that target.
      const fulfilledAfterRejection = saved.provider.kind === "rejected" && locked.operation.dispatch_possible && attempt?.recovery === true;
      if (saved.remote.kind !== "confirmed" || (!fulfilledAfterRejection && !["accepted", "uncertain"].includes(saved.provider.kind)))
        throw new ReferenceHoldError("confirmation-missing");
      await client.query("UPDATE reference_bindings SET etag=$2,baseline=$3 WHERE id=$1", [locked.binding.id, observation.etag, parsed.data.admittedProjection.data]);
      await client.query("UPDATE reference_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1", [claim.operationId]);
      return true;
    }, signal);
  }
  async finish(claim: ReferenceClaim, status: "hold" | "conflict" = "hold", supplied?: { retryAfterMs?: number; code?: string }): Promise<boolean> {
    const fields = supplied === undefined ? {} : copyDataFields(supplied, [], ["retryAfterMs", "code"]);
    const retryAfterMs = fields.retryAfterMs;
    const code = fields.code;
    if (retryAfterMs !== undefined && (typeof retryAfterMs !== "number" ||
      retryAfterMs !== Infinity && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0))) throw new Error("Invalid reference retry delay");
    if (code !== undefined && typeof code !== "string") throw new Error("Invalid reference finish code");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim)) return false;
      await client.query("UPDATE reference_operations SET status=$3,lease_attempt_id=NULL,lease_until=NULL,not_before=CASE WHEN $4::double precision IS NULL THEN NULL WHEN $4::double precision='Infinity'::double precision THEN 'infinity'::timestamptz ELSE clock_timestamp()+$4*interval '1 millisecond' END WHERE id=$1 AND lease_attempt_id=$2",
        [claim.operationId, claim.attemptId, status, retryAfterMs ?? null]);
      if (code && /^[a-z][a-z0-9-]{0,63}$/.test(code)) await client.query("UPDATE reference_attempts SET code=$2,updated_at=clock_timestamp() WHERE id=$1", [claim.attemptId, code]);
      return true;
    });
  }
  async changeConnection(connectionId: string, patch: { status?: "active" | "retired"; scope?: string; accessToken?: string | null; expiresAt?: string }): Promise<void> {
    await this.transaction(async client => {
      const row = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [connectionId])).rows[0];
      if (!row) throw new ReferenceHoldError("connection-missing");
      const ciphertext = patch.accessToken === undefined ? row.credential_ciphertext : patch.accessToken === null ? null : encryptCredential(this.credentialKey, connectionId, patch.accessToken);
      await client.query("UPDATE reference_connections SET status=$2,scope=$3,credential_ciphertext=$4,expires_at=$5 WHERE id=$1", [connectionId,
        patch.status ?? row.status, patch.scope === undefined ? row.scope : scopeValue(patch.scope), ciphertext, patch.expiresAt ?? row.expires_at]);
    });
  }
  async changeBinding(bindingId: string, patch: { active?: boolean; calendarId?: string; eventId?: string }): Promise<void> {
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      await client.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id]);
      await client.query("SELECT id FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id]);
      const row = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [bindingId])).rows[0];
      await client.query("UPDATE reference_bindings SET active=$2,calendar_id=$3,event_id=$4 WHERE id=$1", [bindingId, patch.active ?? row.active, patch.calendarId ?? row.calendar_id, patch.eventId ?? row.event_id]);
    });
  }
  async changePrivacy(objectId: string, privacyLabel: string): Promise<void> {
    // This locks only the object, never subsequently a connection, so it cannot invert the host lock order.
    await this.pool.query("UPDATE reference_objects SET privacy_label=$2 WHERE id=$1", [objectId, privacyLabel]);
  }
}
