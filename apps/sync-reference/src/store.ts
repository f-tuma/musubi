import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { nativeMicrosoftEtag, type MicrosoftNativeEvent } from "@musubi/provider-microsoft";
import { decodeSyncOperationPayload, SyncDeliveryReceiptSchema, SyncOperationEnvelopeSchema, SyncErrorSchema, SyncJsonObjectSchema, type SyncDeliveryReceipt, type SyncOperationRowBinding } from "@musubi/types";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import { supportsMicrosoftPersonalDeleteEnvelope, supportsCaldavPersonalDeleteEnvelope, supportsMicrosoftPersonalCreateEnvelope, projectMicrosoftCreatedEvent } from "@musubi/sync-runtime";
import { acceptedEnvelope, acceptedDeleteEnvelope, acceptedCreateEnvelope, acceptedGraphDeleteEnvelope, admissionFingerprint, deleteAdmissionFingerprint, createAdmissionFingerprint, graphDeleteAdmissionFingerprint, graphDeleteEtag, REFERENCE_GRAPH_DELETE_PROFILE, referenceCreateEventID, referenceCreateOperationID, initialReceipt, jsonEqual, projection, strongEtag, validateContent, validatePatch, acceptedCaldavDeleteEnvelope, caldavDeleteAdmissionFingerprint, caldavDeleteAddress, caldavUid, REFERENCE_CALDAV_DELETE_PROFILE, REFERENCE_GRAPH_CREATE_PROFILE, acceptedGraphCreateEnvelope, graphCreateAdmissionFingerprint } from "./admission.js";
import { assertCredentialKey, decryptCredential, encryptCredential, basicCredential } from "./crypto.js";
import { ReferenceHoldError, type ReferenceAdmission, type ReferenceCapture, type ReferenceClaim, type ReferenceEvidence, type ReferenceOperation, type ReferenceSeed, type ReferenceContentPatch, type ReferenceDeleteAdmission, type ReferenceDeleteObservation, type ReferenceCreateAdmission, type ReferenceCreateSeed, type ReferenceCreateObservation, type ReferenceGraphDeleteSeed, type ReferenceGraphDeleteAdmission, type ReferenceGraphDeleteObservation, type ReferenceCaldavDeleteSeed, type ReferenceCaldavDeleteAdmission, type ReferenceCaldavDeleteObservation, type ReferenceGraphCreateSeed, type ReferenceGraphCreateAdmission, type ReferenceGraphCreateEvidence, type ReferenceGraphCreateObservation, type ReferenceGraphCreateNativeEvidence } from "./model.js";
export { ReferenceHoldError } from "./model.js";
export type { ReferenceClaim as Claim } from "./model.js";

type Row = Record<string, any>;
interface Locked { operation: Row; connection: Row; object: Row; binding: Row }
const scopeValue = (scope: string) => [...new Set(scope.split(/\s+/).filter(Boolean))].sort().join(" ");
const writeAllowed = (scope: string, provider: "google" | "microsoft" = "google") => provider === "microsoft"
  ? scope.split(/[\s,]+/).includes("Calendars.ReadWrite") : scope.split(/\s+/).some(value => [
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
function copyExactDataFields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const result = copyDataFields(value, required, optional);
  if (Reflect.ownKeys(value as object).some(key => typeof key !== "string" || ![...required, ...optional].includes(key)))
    throw new Error("Invalid reference input");
  return result;
}
/** Only the literal pre-provider schema lacks this column. New rows have
 * NOT NULL metadata; invalid or mismatched explicit values never fall back. */
function providerOf(row: Row): "google" | "microsoft" | "caldav" {
  if (!Object.hasOwn(row, "provider")) return "google";
  if (row.provider === "google" || row.provider === "microsoft" || row.provider === "caldav") return row.provider;
  throw new ReferenceHoldError("provider-profile-unavailable");
}
function profileOf(row: Row): string {
  if (!Object.hasOwn(row, "endpoint_profile") && providerOf(row) === "google") return `google-personal-event-${row.action}-v1`;
  if (typeof row.endpoint_profile === "string") return row.endpoint_profile;
  throw new ReferenceHoldError("provider-profile-unavailable");
}
function profileMatches(row: Row): boolean {
  const provider = providerOf(row), profile = profileOf(row);
  return provider === "google" ? ["create", "update", "delete"].includes(row.action) && profile === `google-personal-event-${row.action}-v1`
    : provider === "microsoft" ? (row.action === "create" && profile === REFERENCE_GRAPH_CREATE_PROFILE || row.action === "delete" && profile === REFERENCE_GRAPH_DELETE_PROFILE)
    : row.action === "delete" && profile === REFERENCE_CALDAV_DELETE_PROFILE;
}
/** Only the durable lease identities are accepted from a caller's claim DTO. */
function claimIdentity(value: ReferenceClaim): ReferenceClaim {
  const fields = copyDataFields(value, ["operationId", "attemptId"]);
  if (![fields.operationId, fields.attemptId].every(item => typeof item === "string" && item.length > 0 && item.length <= 2048))
    throw new Error("Invalid reference claim identity");
  return Object.freeze(fields) as unknown as ReferenceClaim;
}
/** JSON string encoding round-trips even NUL/unpaired UTF-16 without claiming
 * that raw native acceptance metadata is a conditional-write validator. */
const encodeCreateValidator = (value: string | null): string | null => value === null ? null : JSON.stringify(value);
function graphCreateNativeEvidence(row: Row): ReferenceGraphCreateNativeEvidence {
  let validator: unknown = null;
  try { if (row.create_acceptance_validator !== null && row.create_acceptance_validator !== undefined) validator = JSON.parse(row.create_acceptance_validator); }
  catch { throw new ReferenceHoldError("invalid-graph-create-history"); }
  if (validator !== null && typeof validator !== "string") throw new ReferenceHoldError("invalid-graph-create-history");
  return { candidateEventId: row.create_candidate_id ?? null, acceptanceStatus: row.create_acceptance_status ?? null, acceptanceValidator: validator as string | null };
}
const receipt = (value: unknown): SyncDeliveryReceipt => SyncDeliveryReceiptSchema.parse(value);
const rawEnvelope = (payload: unknown) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  ? (payload as Record<string, unknown>).operationEnvelope : undefined;
const capture = (row: Row): ReferenceCapture => ({ connectionGeneration: Number(row.connection_generation), sourceGeneration: Number(row.source_generation),
  privacyGeneration: Number(row.privacy_generation), acceptedRevision: Number(row.accepted_revision), canonicalGeneration: Number(row.canonical_generation) });
const rowBinding = (row: Row): SyncOperationRowBinding => ({ kind: "event", action: row.action, operationId: row.id, commandId: row.command_id,
  hostObjectId: row.object_id, provider: providerOf(row), connectionId: row.connection_id, collectionId: row.calendar_id, resourceId: row.event_id,
  acceptedRevision: Number(row.accepted_revision), sourceEpoch: { sourceId: row.binding_id, generation: Number(row.source_generation) },
  privacyEpoch: String(row.privacy_generation) });

/** Short transactions own all authority/lease checks; no network awaits occur under locks. */
export class ReferenceStore {
  constructor(readonly pool: Pool, private readonly credentialKey: string) { assertCredentialKey(credentialKey); }
  async migrate(): Promise<void> {
    const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    const forward = await readFile(new URL("./schema-delete.sql", import.meta.url), "utf8");
    const create = await readFile(new URL("./schema-create.sql", import.meta.url), "utf8");
    const graph = await readFile(new URL("./schema-graph-delete.sql", import.meta.url), "utf8");
    const caldav = await readFile(new URL("./schema-caldav-delete.sql", import.meta.url), "utf8");
    const graphCreate = await readFile(new URL("./schema-graph-create.sql", import.meta.url), "utf8");
    await this.transaction(async client => { await client.query(sql); await client.query(forward); await client.query(create); await client.query(graph); await client.query(caldav); await client.query(graphCreate); });
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
      providerOf(conn) === providerOf(op) && profileMatches(op) &&
      (providerOf(op) !== "caldav" || conn.scope === "" && caldavUid(op.accepted_uid) && binding.ical_uid === op.accepted_uid && caldavDeleteAddress(op.calendar_id, op.event_id)) &&
      (op.action === "create" ? binding.destination_lifecycle === "reserved" && binding.create_operation_id === op.id &&
        (providerOf(op) === "microsoft" ? binding.create_profile === REFERENCE_GRAPH_CREATE_PROFILE && binding.event_id === null && op.event_id === null
          : !Object.hasOwn(binding, "create_profile") || binding.create_profile === "google-personal-event-create-v1") : binding.destination_lifecycle === "present") &&
      object.canonical_lifecycle === (op.action === "delete" ? "tombstoned" : "active") && Number(object.lifecycle_generation) === Number(op.canonical_generation) &&
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
  async seedCreateBinding(supplied: ReferenceCreateSeed): Promise<void> {
    const fields = copyDataFields(supplied, ["connectionId", "objectId", "bindingId", "calendarId", "operationId", "accessToken", "expiresAt", "scope", "content"], ["privacyLabel"]);
    const input = Object.freeze({ ...fields, content: Object.freeze({ ...validateContent(fields.content as ReferenceCreateSeed["content"]) }) }) as unknown as ReferenceCreateSeed;
    const eventId = referenceCreateEventID(input.operationId);
    if (typeof input.accessToken !== "string" || typeof input.scope !== "string" || typeof input.expiresAt !== "string" ||
      input.privacyLabel !== undefined && typeof input.privacyLabel !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) || input.calendarId === "primary" ||
      ![input.connectionId, input.objectId, input.bindingId, input.calendarId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048))
      throw new Error("Invalid reference CREATE seed");
    const ciphertext = encryptCredential(this.credentialKey, input.connectionId, input.accessToken);
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,scope,credential_ciphertext,expires_at) VALUES($1,$2,$3,$4)",
        [input.connectionId, scopeValue(input.scope), ciphertext, input.expiresAt]);
      await client.query("INSERT INTO reference_objects(id,privacy_label,content) VALUES($1,$2,$3)", [input.objectId, input.privacyLabel ?? "private", input.content]);
      await client.query(`INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline,destination_lifecycle,create_operation_id)
        VALUES($1,$2,$3,$4,$5,NULL,NULL,'reserved',$6)`, [input.bindingId, input.connectionId, input.objectId, input.calendarId, eventId, input.operationId]);
    });
  }
  async seedGraphDeleteBinding(supplied: ReferenceGraphDeleteSeed): Promise<void> {
    const fields = copyExactDataFields(supplied, ["provider", "endpointProfile", "connectionId", "objectId", "bindingId", "calendarId", "eventId", "accessToken", "expiresAt", "scope", "content", "etag"], ["privacyLabel"]);
    const input = Object.freeze({ ...fields, content: Object.freeze({ ...validateContent(fields.content as ReferenceGraphDeleteSeed["content"]) }) }) as unknown as ReferenceGraphDeleteSeed;
    if (input.provider !== "microsoft" || input.endpointProfile !== REFERENCE_GRAPH_DELETE_PROFILE || !graphDeleteEtag(input.etag) ||
      typeof input.accessToken !== "string" || typeof input.scope !== "string" || typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) ||
      input.privacyLabel !== undefined && typeof input.privacyLabel !== "string" ||
      ![input.connectionId, input.objectId, input.bindingId, input.calendarId, input.eventId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048 && value.trim() === value && ![".", ".."].includes(value)))
      throw new Error("Invalid reference Graph DELETE seed");
    const ciphertext = encryptCredential(this.credentialKey, input.connectionId, input.accessToken);
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,provider,scope,credential_ciphertext,expires_at) VALUES($1,'microsoft',$2,$3,$4)",
        [input.connectionId, scopeValue(input.scope), ciphertext, input.expiresAt]);
      await client.query("INSERT INTO reference_objects(id,privacy_label,content) VALUES($1,$2,$3)", [input.objectId, input.privacyLabel ?? "private", input.content]);
      await client.query("INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [input.bindingId, input.connectionId, input.objectId, input.calendarId, input.eventId, input.etag, projection(input.content)]);
    });
  }
  async admitGraphDelete(supplied: ReferenceGraphDeleteAdmission): Promise<ReferenceOperation> {
    const input = Object.freeze(copyExactDataFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceGraphDeleteAdmission;
    const fingerprint = graphDeleteAdmissionFingerprint(input);
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
      const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [binding.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("command-reused"); return; }
      if (providerOf(conn) !== "microsoft" || conn.status !== "active" || conn.credential_ciphertext == null || !writeAllowed(conn.scope, "microsoft") || !binding.active)
        throw new ReferenceHoldError("source-unavailable");
      if (object.canonical_lifecycle !== "active" || binding.destination_lifecycle !== "present") throw new ReferenceHoldError("lifecycle-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount)
        throw new ReferenceHoldError("causal-barrier");
      if (!graphDeleteEtag(binding.etag)) throw new ReferenceHoldError("validator-unavailable");
      const content = validateContent(object.content);
      const tombstone = (await client.query("UPDATE reference_objects SET revision=$2,canonical_lifecycle='tombstoned' WHERE id=$1 RETURNING revision,lifecycle_generation", [object.id, input.expectedRevision + 1])).rows[0];
      const epochs: ReferenceCapture = { acceptedRevision: Number(tombstone.revision), canonicalGeneration: Number(tombstone.lifecycle_generation),
        connectionGeneration: Number(conn.generation), sourceGeneration: Number(binding.source_generation), privacyGeneration: Number(object.privacy_generation) };
      const envelope = acceptedGraphDeleteEnvelope(input, content, { objectId: object.id, connectionId: conn.id, calendarId: binding.calendar_id, eventId: binding.event_id, capture: epochs });
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action,provider,endpoint_profile)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'delete','microsoft',$17)`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, binding.event_id, epochs.acceptedRevision,
          epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, binding.etag, fingerprint, { operationEnvelope: envelope }, initialReceipt(envelope), epochs.canonicalGeneration, REFERENCE_GRAPH_DELETE_PROFILE]);
    });
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
  }
  async seedGraphCreateBinding(supplied: ReferenceGraphCreateSeed): Promise<void> {
    const fields = copyExactDataFields(supplied, ["provider", "endpointProfile", "connectionId", "objectId", "bindingId", "calendarId", "operationId", "accessToken", "expiresAt", "scope", "content"], ["privacyLabel"]);
    const input = Object.freeze({ ...fields, content: Object.freeze({ ...validateContent(fields.content as ReferenceGraphCreateSeed["content"]) }) }) as unknown as ReferenceGraphCreateSeed;
    if (input.provider !== "microsoft" || input.endpointProfile !== REFERENCE_GRAPH_CREATE_PROFILE ||
      typeof input.accessToken !== "string" || typeof input.scope !== "string" || typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) ||
      input.privacyLabel !== undefined && typeof input.privacyLabel !== "string" ||
      ![input.connectionId, input.objectId, input.bindingId, input.calendarId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048 && value.trim() === value && ![".", ".."].includes(value)))
      throw new Error("Invalid reference Graph CREATE seed");
    referenceCreateOperationID(input.operationId);
    const ciphertext = encryptCredential(this.credentialKey, input.connectionId, input.accessToken);
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,provider,scope,credential_ciphertext,expires_at) VALUES($1,'microsoft',$2,$3,$4)", [input.connectionId, scopeValue(input.scope), ciphertext, input.expiresAt]);
      await client.query("INSERT INTO reference_objects(id,privacy_label,content) VALUES($1,$2,$3)", [input.objectId, input.privacyLabel ?? "private", input.content]);
      await client.query(`INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline,destination_lifecycle,create_operation_id,create_profile)
        VALUES($1,$2,$3,$4,NULL,NULL,NULL,'reserved',$5,$6)`, [input.bindingId, input.connectionId, input.objectId, input.calendarId, input.operationId, REFERENCE_GRAPH_CREATE_PROFILE]);
    });
  }
  async admitGraphCreate(supplied: ReferenceGraphCreateAdmission): Promise<ReferenceOperation> {
    const input = Object.freeze(copyExactDataFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceGraphCreateAdmission;
    const fingerprint = graphCreateAdmissionFingerprint(input);
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
      const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [binding.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("command-reused"); return; }
      if (providerOf(conn) !== "microsoft" || conn.status !== "active" || conn.credential_ciphertext == null || !writeAllowed(conn.scope, "microsoft") || !binding.active)
        throw new ReferenceHoldError("source-unavailable");
      if (object.canonical_lifecycle !== "active" || binding.destination_lifecycle !== "reserved" || binding.create_profile !== REFERENCE_GRAPH_CREATE_PROFILE || binding.create_operation_id !== input.operationId ||
        binding.event_id !== null || binding.etag !== null || binding.baseline !== null) throw new ReferenceHoldError("lifecycle-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount) throw new ReferenceHoldError("causal-barrier");
      const epochs: ReferenceCapture = { acceptedRevision: input.expectedRevision + 1, connectionGeneration: Number(conn.generation), sourceGeneration: Number(binding.source_generation),
        privacyGeneration: Number(object.privacy_generation), canonicalGeneration: Number(object.lifecycle_generation) };
      const envelope = acceptedGraphCreateEnvelope(input, validateContent(object.content), { objectId: object.id, connectionId: conn.id, calendarId: binding.calendar_id, capture: epochs });
      await client.query("UPDATE reference_objects SET revision=$2 WHERE id=$1", [object.id, epochs.acceptedRevision]);
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action,provider,endpoint_profile)
        VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,NULL,$11,$12,$13,$14,'create','microsoft',$15)`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, epochs.acceptedRevision, epochs.connectionGeneration, epochs.sourceGeneration,
          epochs.privacyGeneration, fingerprint, { operationEnvelope: envelope }, initialReceipt(envelope), epochs.canonicalGeneration, REFERENCE_GRAPH_CREATE_PROFILE]);
    });
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
  }
  async seedCaldavDeleteBinding(supplied: ReferenceCaldavDeleteSeed): Promise<void> {
    const fields = copyExactDataFields(supplied, ["provider", "endpointProfile", "connectionId", "objectId", "bindingId", "calendarUrl", "resourceUrl", "uid", "username", "password", "expiresAt", "content", "etag"], ["privacyLabel"]);
    const input = Object.freeze({ ...fields, content: Object.freeze({ ...validateContent(fields.content as ReferenceCaldavDeleteSeed["content"]) }) }) as unknown as ReferenceCaldavDeleteSeed;
    if (input.provider !== "caldav" || input.endpointProfile !== REFERENCE_CALDAV_DELETE_PROFILE || !strongEtag(input.etag) || !caldavUid(input.uid) ||
      !caldavDeleteAddress(input.calendarUrl, input.resourceUrl) || typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt)) ||
      input.privacyLabel !== undefined && typeof input.privacyLabel !== "string" ||
      ![input.connectionId, input.objectId, input.bindingId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048) ||
      ![input.content.beginsAt, input.content.endsAt].every(value => value.endsWith(".000Z")) || input.content.notes === "" || input.content.place === "")
      throw new Error("Invalid reference CalDAV DELETE seed");
    const credential = basicCredential({ kind: "basic", username: input.username, password: input.password });
    const ciphertext = encryptCredential(this.credentialKey, input.connectionId, JSON.stringify(credential));
    await this.transaction(async client => {
      await client.query("INSERT INTO reference_connections(id,provider,scope,credential_ciphertext,expires_at) VALUES($1,'caldav','',$2,$3)", [input.connectionId, ciphertext, input.expiresAt]);
      await client.query("INSERT INTO reference_objects(id,privacy_label,content) VALUES($1,$2,$3)", [input.objectId, input.privacyLabel ?? "private", input.content]);
      await client.query("INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline,ical_uid) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [input.bindingId, input.connectionId, input.objectId, input.calendarUrl, input.resourceUrl, input.etag, projection(input.content), input.uid]);
    });
  }
  async admitCaldavDelete(supplied: ReferenceCaldavDeleteAdmission): Promise<ReferenceOperation> {
    const input = Object.freeze(copyExactDataFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceCaldavDeleteAdmission;
    const fingerprint = caldavDeleteAdmissionFingerprint(input);
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
      const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [binding.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("command-reused"); return; }
      if (providerOf(conn) !== "caldav" || conn.status !== "active" || conn.credential_ciphertext == null || conn.scope !== "" || !binding.active)
        throw new ReferenceHoldError("source-unavailable");
      if (object.canonical_lifecycle !== "active" || binding.destination_lifecycle !== "present") throw new ReferenceHoldError("lifecycle-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount) throw new ReferenceHoldError("causal-barrier");
      if (!strongEtag(binding.etag) || !caldavUid(binding.ical_uid) || !caldavDeleteAddress(binding.calendar_id, binding.event_id)) throw new ReferenceHoldError("native-identity-unavailable");
      const content = validateContent(object.content);
      const tombstone = (await client.query("UPDATE reference_objects SET revision=$2,canonical_lifecycle='tombstoned' WHERE id=$1 RETURNING revision,lifecycle_generation", [object.id, input.expectedRevision + 1])).rows[0];
      const epochs: ReferenceCapture = { acceptedRevision: Number(tombstone.revision), canonicalGeneration: Number(tombstone.lifecycle_generation),
        connectionGeneration: Number(conn.generation), sourceGeneration: Number(binding.source_generation), privacyGeneration: Number(object.privacy_generation) };
      const envelope = acceptedCaldavDeleteEnvelope(input, content, { objectId: object.id, connectionId: conn.id, calendarUrl: binding.calendar_id, resourceUrl: binding.event_id, uid: binding.ical_uid, capture: epochs });
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action,provider,endpoint_profile,accepted_uid)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'delete','caldav',$17,$18)`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, binding.event_id, epochs.acceptedRevision,
          epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, binding.etag, fingerprint, { operationEnvelope: envelope }, initialReceipt(envelope), epochs.canonicalGeneration, REFERENCE_CALDAV_DELETE_PROFILE, binding.ical_uid]);
    });
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
  }
  async admitCreate(supplied: ReferenceCreateAdmission): Promise<ReferenceOperation> {
    const input = Object.freeze(copyDataFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceCreateAdmission;
    const fingerprint = createAdmissionFingerprint(input);
    const eventId = referenceCreateEventID(input.operationId);
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
      const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [binding.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("command-reused"); return; }
      if (providerOf(conn) !== "google" || conn.status !== "active" || conn.credential_ciphertext == null || !writeAllowed(conn.scope) || !binding.active) throw new ReferenceHoldError("source-unavailable");
      if (object.canonical_lifecycle !== "active" || binding.destination_lifecycle !== "reserved" || binding.create_operation_id !== input.operationId ||
          binding.event_id !== eventId || binding.etag !== null || binding.baseline !== null) throw new ReferenceHoldError("lifecycle-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount)
        throw new ReferenceHoldError("causal-barrier");
      const epochs: ReferenceCapture = { acceptedRevision: input.expectedRevision + 1, connectionGeneration: Number(conn.generation),
        sourceGeneration: Number(binding.source_generation), privacyGeneration: Number(object.privacy_generation), canonicalGeneration: Number(object.lifecycle_generation) };
      const envelope = acceptedCreateEnvelope(input, validateContent(object.content), { objectId: object.id, connectionId: conn.id, calendarId: binding.calendar_id, eventId, capture: epochs });
      await client.query("UPDATE reference_objects SET revision=$2 WHERE id=$1", [object.id, epochs.acceptedRevision]);
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,$14,$15,'create')`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, eventId, epochs.acceptedRevision,
          epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, fingerprint, { operationEnvelope: envelope }, initialReceipt(envelope), epochs.canonicalGeneration]);
    });
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
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
      if (providerOf(conn) !== "google" || conn.status !== "active" || conn.credential_ciphertext == null || !writeAllowed(conn.scope) || !binding.active) throw new ReferenceHoldError("source-unavailable");
      if (object.canonical_lifecycle !== "active" || binding.destination_lifecycle !== "present") throw new ReferenceHoldError("lifecycle-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount)
        throw new ReferenceHoldError("causal-barrier");
      if (!strongEtag(binding.etag)) throw new ReferenceHoldError("validator-unavailable");
      const content = validateContent({ ...object.content, ...input.patch });
      const acceptedRevision = input.expectedRevision + 1;
      const epochs: ReferenceCapture = { acceptedRevision, connectionGeneration: Number(conn.generation), sourceGeneration: Number(binding.source_generation), privacyGeneration: Number(object.privacy_generation), canonicalGeneration: Number(object.lifecycle_generation) };
      const envelope = acceptedEnvelope(input, content, { objectId: object.id, connectionId: conn.id, calendarId: binding.calendar_id, eventId: binding.event_id, capture: epochs });
      await client.query("UPDATE reference_objects SET revision=$2,content=$3 WHERE id=$1", [object.id, acceptedRevision, content]);
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, binding.event_id, acceptedRevision,
          epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, binding.etag, fingerprint,
          { operationEnvelope: envelope }, initialReceipt(envelope), epochs.canonicalGeneration]);
    });
    // Idempotent command retry returns the original operation, including after ACK.
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
  }
  async admitDelete(supplied: ReferenceDeleteAdmission): Promise<ReferenceOperation> {
    const input = Object.freeze(copyDataFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId"])) as unknown as ReferenceDeleteAdmission;
    const fingerprint = deleteAdmissionFingerprint(input);
    await this.transaction(async client => {
      const initial = (await client.query("SELECT * FROM reference_bindings WHERE id=$1", [input.bindingId])).rows[0];
      if (!initial) throw new ReferenceHoldError("binding-missing");
      const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [initial.connection_id])).rows[0];
      const object = (await client.query("SELECT * FROM reference_objects WHERE id=$1 FOR UPDATE", [initial.object_id])).rows[0];
      const binding = (await client.query("SELECT * FROM reference_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
      const existing = (await client.query("SELECT * FROM reference_operations WHERE connection_id=$1 AND command_id=$2 FOR UPDATE", [binding.connection_id, input.commandId])).rows[0];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new ReferenceHoldError("command-reused"); return; }
      if (providerOf(conn) !== "google" || conn.status !== "active" || conn.credential_ciphertext == null || !writeAllowed(conn.scope) || !binding.active) throw new ReferenceHoldError("source-unavailable");
      if (object.canonical_lifecycle !== "active" || binding.destination_lifecycle !== "present") throw new ReferenceHoldError("lifecycle-unavailable");
      if (Number(object.revision) !== input.expectedRevision) throw new ReferenceHoldError("revision-conflict");
      if ((await client.query("SELECT 1 FROM reference_operations WHERE binding_id=$1 AND status<>'acked'", [input.bindingId])).rowCount)
        throw new ReferenceHoldError("causal-barrier");
      if (!strongEtag(binding.etag)) throw new ReferenceHoldError("validator-unavailable");
      const content = validateContent(object.content);
      // Capture the trigger's post-CAS tombstoned incarnation, never the prior active one.
      const tombstone = (await client.query("UPDATE reference_objects SET revision=$2,canonical_lifecycle='tombstoned' WHERE id=$1 RETURNING revision,lifecycle_generation", [object.id, input.expectedRevision + 1])).rows[0];
      const epochs: ReferenceCapture = { acceptedRevision: Number(tombstone.revision), canonicalGeneration: Number(tombstone.lifecycle_generation),
        connectionGeneration: Number(conn.generation), sourceGeneration: Number(binding.source_generation), privacyGeneration: Number(object.privacy_generation) };
      const envelope = acceptedDeleteEnvelope(input, content, { objectId: object.id, connectionId: conn.id, calendarId: binding.calendar_id, eventId: binding.event_id, capture: epochs });
      await client.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,
        connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,canonical_generation,action)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'delete')`,
        [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.calendar_id, binding.event_id, epochs.acceptedRevision,
          epochs.connectionGeneration, epochs.sourceGeneration, epochs.privacyGeneration, binding.etag, fingerprint,
          { operationEnvelope: envelope }, initialReceipt(envelope), epochs.canonicalGeneration]);
    });
    const result = await this.pool.query("SELECT id FROM reference_operations WHERE command_id=$1 AND binding_id=$2", [input.commandId, input.bindingId]);
    return this.inspectOperation(result.rows[0].id);
  }
  async inspectOperation(operationId: string): Promise<ReferenceOperation> {
    const row = (await this.pool.query(`SELECT o.*,b.etag AS binding_etag,b.baseline,b.active,b.source_generation AS binding_generation,b.destination_lifecycle,
      b.event_id AS binding_event_id,c.canonical_lifecycle,c.lifecycle_generation,c.revision AS canonical_revision
      FROM reference_operations o JOIN reference_bindings b ON b.id=o.binding_id JOIN reference_objects c ON c.id=o.object_id WHERE o.id=$1`, [operationId])).rows[0];
    if (!row) throw new ReferenceHoldError("operation-missing");
    return { operationId: row.id, commandId: row.command_id, bindingId: row.binding_id, objectId: row.object_id, provider: providerOf(row), endpointProfile: profileOf(row), action: row.action, payload: row.payload,
      canonical: { lifecycle: row.canonical_lifecycle, generation: Number(row.lifecycle_generation), revision: Number(row.canonical_revision) },
      deleteAcceptanceStatus: row.delete_acceptance_status,
      capture: capture(row), status: row.status, dispatchPossible: row.dispatch_possible, receipt: receipt(row.receipt),
      ...(providerOf(row) === "caldav" ? { acceptedUid: row.accepted_uid } : {}),
      ...(providerOf(row) === "microsoft" && row.action === "create" ? { graphCreate: { ...graphCreateNativeEvidence(row), bindingEventId: row.binding_event_id } } : {}),
      leaseAttemptId: row.lease_attempt_id, leaseUntil: row.lease_until?.toISOString() ?? null,
      binding: { etag: row.binding_etag, baseline: row.baseline, active: row.active, sourceGeneration: Number(row.binding_generation), destinationLifecycle: row.destination_lifecycle } };
  }
  async claim(operationId: string, attemptId: string): Promise<ReferenceClaim | null> {
    if (!attemptId || attemptId.length > 2048) throw new Error("Invalid reference attempt identity");
    return this.transaction(async client => {
      const locked = await this.locked(client, operationId); const op = locked.operation;
      if (op.status === "acked" || op.status === "conflict" || op.lease_live ||
        (op.not_before && (await client.query("SELECT $1::timestamptz>clock_timestamp() AS delayed", [op.not_before])).rows[0].delayed)) return null;
      let saved = receipt(op.receipt);
      const attemptNumber = Number((await client.query("SELECT count(*) FROM reference_attempts WHERE operation_id=$1", [operationId])).rows[0].count) + 1;
      if (!Number.isSafeInteger(attemptNumber)) throw new ReferenceHoldError("attempt-number-unavailable");
      if (op.dispatch_possible && ["pending", "not-dispatched"].includes(saved.provider.kind)) saved = receipt({ ...saved, provider: { kind: "uncertain" } });
      saved = receipt({ ...saved, attemptId });
      await client.query("INSERT INTO reference_attempts(id,operation_id,receipt,recovery,delete_acceptance_status) VALUES($1,$2,$3,$4,$5)", [attemptId, operationId, saved, op.dispatch_possible, op.delete_acceptance_status]);
      await client.query("UPDATE reference_operations SET status='running',lease_attempt_id=$2,lease_until=clock_timestamp()+interval '120 seconds',receipt=$3,not_before=NULL WHERE id=$1", [operationId, attemptId, saved]);
      const parsed = SyncOperationEnvelopeSchema.safeParse(rawEnvelope(op.payload));
      return { operationId, attemptId, payload: op.payload, envelope: parsed.success ? parsed.data : undefined,
        binding: rowBinding(op), capture: capture(op), locator: { connectionId: op.connection_id, calendarId: op.calendar_id, eventId: op.event_id },
        etag: op.accepted_etag, receipt: saved, recovery: op.dispatch_possible, deleteAcceptanceStatus: op.delete_acceptance_status,
        endpointProfile: profileOf(op), attemptNumber, ...(providerOf(op) === "caldav" ? { acceptedUid: op.accepted_uid } : {}),
        ...(providerOf(op) === "microsoft" && op.action === "create" ? { graphCreate: graphCreateNativeEvidence(op) } : {}) };
    });
  }
  async renew(claim: ReferenceClaim): Promise<boolean> {
    claim = claimIdentity(claim);
    const result = await this.pool.query(`UPDATE reference_operations SET lease_until=clock_timestamp()+interval '120 seconds'
      WHERE id=$1 AND lease_attempt_id=$2 AND status='running' AND lease_until>clock_timestamp()`, [claim.operationId, claim.attemptId]);
    return result.rowCount === 1;
  }
  async getSession(claim: ReferenceClaim, _clockEpochMs: number, signal?: AbortSignal): Promise<{
    accessToken: string; connectionId: string; connectionGeneration: string; scope: string; eventWriteAllowed: boolean;
  }> {
    claim = claimIdentity(claim);
    if (signal?.aborted) throw new ReferenceHoldError("cancelled");
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [locked.connection.expires_at])).rows[0].valid)
        throw new ReferenceHoldError("credentials-expired");
      const provider = providerOf(locked.connection);
      if (provider === "caldav") throw new ReferenceHoldError("credential-kind-unavailable");
      return { accessToken: decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext),
        connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation), scope: locked.connection.scope,
        eventWriteAllowed: writeAllowed(locked.connection.scope, provider) };
    });
    if (signal?.aborted) throw new ReferenceHoldError("cancelled");
    // Recheck after asynchronous materialization; final mutation has another fence.
    await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
    });
    return session;
  }
  async getCaldavSession(claim: ReferenceClaim, _clockEpochMs: number, signal?: AbortSignal): Promise<{
    authorization: string; connectionId: string; connectionGeneration: string;
  }> {
    claim = claimIdentity(claim);
    const session = await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(locked.connection) !== "caldav" || locked.connection.scope !== "")
        throw new ReferenceHoldError("authority-changed");
      // This is this independent host's local credential-valid-until policy.
      // Basic credentials have no OAuth provider expiry or OAuth write scope.
      if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [locked.connection.expires_at])).rows[0].valid)
        throw new ReferenceHoldError("credentials-expired");
      let credential;
      try { credential = basicCredential(JSON.parse(decryptCredential(this.credentialKey, locked.connection.id, locked.connection.credential_ciphertext))); }
      catch { throw new ReferenceHoldError("credential-kind-unavailable"); }
      return { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
        connectionId: locked.connection.id, connectionGeneration: String(locked.connection.generation) };
    }, signal);
    await this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
    }, signal);
    return session;
  }
  async markDispatch(claim: ReferenceClaim, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked)) throw new ReferenceHoldError("authority-changed");
      if (providerOf(locked.operation) === "microsoft" && locked.operation.dispatch_possible)
        throw new ReferenceHoldError(locked.operation.action === "create" ? "create-observe-only" : "guarded-delete-observe-only");
      const saved = receipt(locked.operation.receipt);
      const next = receipt({ ...saved, provider: saved.provider.kind === "accepted" ? saved.provider : { kind: "pending" } });
      await client.query("UPDATE reference_operations SET dispatch_possible=true,receipt=$3 WHERE id=$1 AND lease_attempt_id=$2", [claim.operationId, claim.attemptId, next]);
      await client.query("UPDATE reference_attempts SET dispatch_possible=true,receipt=$3,updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, next]);
      return true;
    }, signal);
  }
  async recordEvidence(claim: ReferenceClaim, supplied: ReferenceEvidence, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyDataFields(supplied, ["provider", "remote"], ["validator", "observationId", "code", "error", "acceptanceStatus"]);
    if (!["accepted", "uncertain", "rejected", "not-dispatched"].includes(fields.provider as string) ||
      !["confirmed", "conflict", "unobserved"].includes(fields.remote as string) ||
      ["validator", "observationId", "code"].some(field => fields[field] !== undefined && typeof fields[field] !== "string"))
      throw new ReferenceHoldError("invalid-protocol-evidence");
    if (fields.acceptanceStatus !== undefined && (fields.provider !== "accepted" || ![200,201,204,404,410].includes(fields.acceptanceStatus as number))) throw new ReferenceHoldError("invalid-protocol-evidence");
    const parsedError = fields.error === undefined ? undefined : SyncErrorSchema.safeParse(fields.error);
    if (parsedError && !parsedError.success) throw new ReferenceHoldError("invalid-protocol-error");
    const protocolError = parsedError?.success ? Object.freeze(parsedError.data) : undefined;
    const evidence = Object.freeze({ ...fields, ...(protocolError ? { error: protocolError } : {}) }) as unknown as ReferenceEvidence;
    if (evidence.validator !== undefined && !strongEtag(evidence.validator)) throw new ReferenceHoldError("validator-unavailable");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (providerOf(locked.operation) === "microsoft" && locked.operation.action === "create") throw new ReferenceHoldError("graph-create-evidence-port-required");
      if (locked.operation.action === "delete" && (evidence.validator !== undefined || evidence.provider === "accepted" && evidence.acceptanceStatus === undefined) ||
        locked.operation.action !== "delete" && evidence.acceptanceStatus !== undefined) throw new ReferenceHoldError("invalid-protocol-evidence");
      if ((providerOf(locked.operation) === "microsoft" && evidence.acceptanceStatus !== undefined && ![204, 404].includes(evidence.acceptanceStatus)) ||
        (providerOf(locked.operation) === "caldav" && evidence.acceptanceStatus !== undefined && ![200, 201, 204, 404].includes(evidence.acceptanceStatus)))
        throw new ReferenceHoldError("invalid-protocol-evidence");
      const attempt = (await client.query("SELECT receipt,delete_acceptance_status FROM reference_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [claim.attemptId, claim.operationId])).rows[0];
      if (!attempt) throw new ReferenceHoldError("attempt-missing");
      const make = (saved: SyncDeliveryReceipt) => {
        const provider = evidence.provider === "accepted" ? { kind: "accepted", ...(evidence.validator ? { validator: { kind: "etag", value: evidence.validator } } : {}) } :
          evidence.provider === "rejected" ? { kind: "rejected", error: protocolError ?? { code: ["conflict", "provider-conflict"].includes(evidence.code ?? "") ? "conflict" : "transport-failed", retry: "never" } } : { kind: evidence.provider };
        // Never erase a known native acceptance when observation subsequently fails.
        const effectiveProvider = (saved.provider.kind === "accepted" && evidence.provider !== "accepted" || saved.provider.kind === "rejected" && ["uncertain", "not-dispatched"].includes(evidence.provider)) ? saved.provider : provider;
        const remote = evidence.remote === "unobserved" ? saved.remote : { kind: evidence.remote, observationId: evidence.observationId ?? claim.attemptId };
        return receipt({ ...saved, attemptId: claim.attemptId, provider: effectiveProvider, remote });
      };
      const nextAttempt = make(receipt(attempt.receipt));
      const safeCode = evidence.code && /^[a-z][a-z0-9-]{0,63}$/.test(evidence.code) ? evidence.code : null;
      await client.query("UPDATE reference_attempts SET receipt=$3,code=$4,delete_acceptance_status=COALESCE($5,delete_acceptance_status),updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2", [claim.attemptId, claim.operationId, nextAttempt, safeCode, evidence.acceptanceStatus ?? null]);
      if (!this.owned(locked, claim)) return false;
      await client.query("UPDATE reference_operations SET receipt=$2,delete_acceptance_status=COALESCE($3,delete_acceptance_status) WHERE id=$1", [claim.operationId, make(receipt(locked.operation.receipt)), evidence.acceptanceStatus ?? null]);
      return true;
    }, signal);
  }
  async recordGraphCreateEvidence(claim: ReferenceClaim, supplied: ReferenceGraphCreateEvidence, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyExactDataFields(supplied, ["provider", "remote"], ["observationId", "code", "error", "candidateEventId", "createAcceptance"]);
    if (!["accepted", "uncertain", "rejected", "not-dispatched"].includes(fields.provider as string) || !["confirmed", "conflict", "unobserved"].includes(fields.remote as string) ||
      ["observationId", "code"].some(key => fields[key] !== undefined && typeof fields[key] !== "string") || fields.candidateEventId !== undefined && (typeof fields.candidateEventId !== "string" || !fields.candidateEventId || fields.candidateEventId.length > 2048))
      throw new ReferenceHoldError("invalid-graph-create-evidence");
    const acceptance = fields.createAcceptance === undefined ? undefined : copyExactDataFields(fields.createAcceptance, ["status", "validator"]);
    if (acceptance && (![200, 201, 204].includes(acceptance.status as number) || acceptance.validator !== null && typeof acceptance.validator !== "string") ||
      fields.provider === "accepted" && (!acceptance || fields.candidateEventId === undefined) || fields.provider !== "accepted" && acceptance ||
      fields.candidateEventId !== undefined && fields.provider !== "accepted" && !(fields.provider === "uncertain" && fields.remote === "confirmed"))
      throw new ReferenceHoldError("invalid-graph-create-evidence");
    const parsedError = fields.error === undefined ? undefined : SyncErrorSchema.safeParse(fields.error);
    if (parsedError && !parsedError.success) throw new ReferenceHoldError("invalid-protocol-error");
    const protocolError = parsedError?.success ? parsedError.data : undefined;
    const evidence = Object.freeze({ ...fields, ...(acceptance ? { createAcceptance: Object.freeze({ ...acceptance }) } : {}) }) as unknown as Readonly<ReferenceGraphCreateEvidence>;
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId), op = locked.operation;
      signal?.throwIfAborted();
      if (providerOf(op) !== "microsoft" || op.action !== "create" || profileOf(op) !== REFERENCE_GRAPH_CREATE_PROFILE || op.event_id !== null)
        throw new ReferenceHoldError("graph-create-profile-unavailable");
      if ((evidence.provider !== "not-dispatched" || evidence.candidateEventId !== undefined) && !op.dispatch_possible) throw new ReferenceHoldError("confirmation-missing");
      const attempt = (await client.query("SELECT * FROM reference_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [claim.attemptId, claim.operationId])).rows[0];
      if (!attempt) throw new ReferenceHoldError("attempt-missing");
      const owned = this.owned(locked, claim), candidate = evidence.candidateEventId;
      if (owned && candidate !== undefined && op.create_candidate_id !== null && op.create_candidate_id !== candidate)
        throw new ReferenceHoldError("create-candidate-conflict");
      const encodedValidator = acceptance ? encodeCreateValidator(acceptance.validator as string | null) : null;
      if (acceptance && (attempt.create_acceptance_status !== null && (attempt.create_acceptance_status !== acceptance.status || attempt.create_acceptance_validator !== encodedValidator) ||
        owned && op.create_acceptance_status !== null && (op.create_acceptance_status !== acceptance.status || op.create_acceptance_validator !== encodedValidator)))
        throw new ReferenceHoldError("create-acceptance-conflict");
      if (candidate !== undefined && attempt.create_candidate_id !== null && attempt.create_candidate_id !== candidate) throw new ReferenceHoldError("create-candidate-conflict");
      const make = (saved: SyncDeliveryReceipt) => {
        // Raw native acceptance versions belong only in the encoded sidecar;
        // no conditional-write validator is manufactured in the shared receipt.
        const provider = evidence.provider === "accepted" ? { kind: "accepted" as const } : evidence.provider === "rejected"
          ? { kind: "rejected" as const, error: protocolError ?? { code: "transport-failed", retry: "never" as const } } : { kind: evidence.provider };
        const effective = saved.provider.kind === "accepted" && evidence.provider !== "accepted" || saved.provider.kind === "rejected" && ["uncertain", "not-dispatched"].includes(evidence.provider as string) ? saved.provider : provider;
        const remote = evidence.remote === "unobserved" ? saved.remote : { kind: evidence.remote, observationId: evidence.observationId ?? claim.attemptId };
        return receipt({ ...saved, attemptId: claim.attemptId, provider: effective, remote });
      };
      const safeCode = typeof evidence.code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(evidence.code) ? evidence.code : null;
      await client.query(`UPDATE reference_attempts SET receipt=$3,code=$4,create_candidate_id=COALESCE(create_candidate_id,$5),
        create_acceptance_validator=CASE WHEN create_acceptance_status IS NULL AND $6::smallint IS NOT NULL THEN $7 ELSE create_acceptance_validator END,
        create_acceptance_status=COALESCE(create_acceptance_status,$6),updated_at=clock_timestamp() WHERE id=$1 AND operation_id=$2`,
        [claim.attemptId, claim.operationId, make(receipt(attempt.receipt)), safeCode, candidate ?? null, acceptance?.status ?? null, encodedValidator]);
      if (!owned) return false;
      await client.query(`UPDATE reference_operations SET receipt=$2,create_candidate_id=COALESCE(create_candidate_id,$3),
        create_acceptance_validator=CASE WHEN create_acceptance_status IS NULL AND $4::smallint IS NOT NULL THEN $5 ELSE create_acceptance_validator END,
        create_acceptance_status=COALESCE(create_acceptance_status,$4) WHERE id=$1`,
        [claim.operationId, make(receipt(op.receipt)), candidate ?? null, acceptance?.status ?? null, encodedValidator]);
      return true;
    }, signal);
  }
  async completeGraphCreate(claim: ReferenceClaim, supplied: ReferenceGraphCreateObservation, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyExactDataFields(supplied, ["kind", "eventId", "etag", "projection", "read", "correlation"]);
    const read = copyExactDataFields(fields.read, ["kind", "event", "etag"]), correlation = copyExactDataFields(fields.correlation, ["kind", "operationId", "calendarId", "matches"]);
    const parsedProjection = SyncJsonObjectSchema.safeParse(fields.projection), parsedEvent = SyncJsonObjectSchema.safeParse(read.event);
    if (fields.kind !== "correlated-readback" || typeof fields.eventId !== "string" || !fields.eventId || fields.eventId.length > 2048 ||
      fields.etag !== null && nativeMicrosoftEtag(fields.etag) !== fields.etag || read.kind !== "present" || read.etag !== fields.etag || !parsedProjection.success || !parsedEvent.success ||
      correlation.kind !== "complete-scoped-listing" || correlation.matches !== 1 || typeof correlation.operationId !== "string" || typeof correlation.calendarId !== "string")
      throw new ReferenceHoldError("invalid-graph-create-observation");
    const observation = Object.freeze({ eventId: fields.eventId, etag: fields.etag as string | null,
      projection: Object.freeze(JSON.parse(JSON.stringify(parsedProjection.data)) as Record<string, unknown>),
      event: Object.freeze(JSON.parse(JSON.stringify(parsedEvent.data)) as Record<string, unknown>), correlation: Object.freeze({ ...correlation }) });
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId), op = locked.operation;
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(op) !== "microsoft" || op.action !== "create" || profileOf(op) !== REFERENCE_GRAPH_CREATE_PROFILE) return false;
      const decoded = decodeSyncOperationPayload(op.payload, rowBinding(op), { supports: supportsMicrosoftPersonalCreateEnvelope });
      if (decoded.kind !== "pinned-v1" || op.event_id !== null || decoded.envelope.locator.resourceId !== null) throw new ReferenceHoldError("invalid-graph-create-operation");
      const plan = parseNativeWritePlanV1(decoded.envelope.serializer, "create", "event", decoded.envelope.nativePlan.data);
      if (!plan || plan.planKind !== "json-body" || !plan.body || plan.body.transactionId !== op.id || Object.hasOwn(plan.body, "id") ||
        observation.correlation.operationId !== op.id || observation.correlation.calendarId !== op.calendar_id || observation.event.id !== observation.eventId || observation.event.transactionId !== op.id ||
        !jsonEqual(observation.projection, decoded.envelope.admittedProjection.data) || !jsonEqual(projectMicrosoftCreatedEvent(observation.event as unknown as MicrosoftNativeEvent), observation.projection))
        throw new ReferenceHoldError("observation-conflict");
      const saved = receipt(op.receipt);
      if (!op.dispatch_possible || !["accepted", "uncertain"].includes(saved.provider.kind) || saved.remote.kind !== "confirmed" || op.create_candidate_id !== observation.eventId)
        throw new ReferenceHoldError("confirmation-missing");
      if ((await client.query("SELECT id FROM reference_bindings WHERE connection_id=$1 AND calendar_id=$2 AND event_id=$3 AND id<>$4", [op.connection_id, op.calendar_id, observation.eventId, locked.binding.id])).rowCount)
        throw new ReferenceHoldError("create-scope-occupied");
      await client.query("UPDATE reference_bindings SET event_id=$2,destination_lifecycle='present',etag=$3,baseline=$4 WHERE id=$1", [locked.binding.id, observation.eventId, observation.etag, observation.projection]);
      await client.query("UPDATE reference_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1", [claim.operationId]);
      return true;
    }, signal);
  }
  async complete(claim: ReferenceClaim, supplied: { etag: string; projection: Record<string, unknown> }, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
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
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(locked.operation) !== "google" || locked.operation.action !== "update") return false;
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
  async completeDelete(claim: ReferenceClaim, supplied: ReferenceDeleteObservation, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyDataFields(supplied, ["kind", "read"]);
    const read = copyDataFields(fields.read, ["kind"], ["status"]);
    if (fields.kind !== "exact-absence" || !(read.kind === "cancelled" && read.status === undefined || read.kind === "absent" && [404, 410].includes(read.status as number)))
      throw new ReferenceHoldError("invalid-protocol-absence");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(locked.operation) !== "google" || locked.operation.action !== "delete") return false;
      const parsed = SyncOperationEnvelopeSchema.safeParse(rawEnvelope(locked.operation.payload));
      if (!parsed.success || parsed.data.operation.action !== "delete") throw new ReferenceHoldError("invalid-delete-operation");
      const saved = receipt(locked.operation.receipt);
      // GET-only scoped absence confirms the destination. It never invents native acceptance.
      if (saved.remote.kind !== "confirmed" || saved.provider.kind === "pending") throw new ReferenceHoldError("confirmation-missing");
      await client.query("UPDATE reference_bindings SET destination_lifecycle='absent' WHERE id=$1", [locked.binding.id]);
      await client.query("UPDATE reference_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1", [claim.operationId]);
      return true;
    }, signal);
  }
  async completeCreate(claim: ReferenceClaim, supplied: ReferenceCreateObservation, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyDataFields(supplied, ["eventId", "etag", "projection"]);
    const parsedProjection = SyncJsonObjectSchema.safeParse(fields.projection);
    if (typeof fields.eventId !== "string" || !strongEtag(fields.etag) || !parsedProjection.success)
      throw new ReferenceHoldError("invalid-create-observation");
    const observation = Object.freeze({ eventId: fields.eventId, etag: fields.etag,
      projection: Object.freeze(JSON.parse(JSON.stringify(parsedProjection.data)) as Record<string, unknown>) });
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(locked.operation) !== "google" || locked.operation.action !== "create") return false;
      const parsed = SyncOperationEnvelopeSchema.safeParse(rawEnvelope(locked.operation.payload));
      if (!parsed.success || parsed.data.operation.action !== "create" || parsed.data.operationId !== locked.operation.id ||
        parsed.data.locator.resourceId !== locked.operation.event_id || referenceCreateEventID(locked.operation.id) !== observation.eventId ||
        observation.eventId !== locked.operation.event_id || !jsonEqual(observation.projection, parsed.data.admittedProjection.data))
        throw new ReferenceHoldError("observation-conflict");
      const plan = parseNativeWritePlanV1(parsed.data.serializer, "create", "event", parsed.data.nativePlan.data);
      if (!plan || plan.planKind !== "json-body" || plan.body?.id !== observation.eventId ||
        (plan.body.extendedProperties as { private?: { musubiOperationID?: unknown } })?.private?.musubiOperationID !== locked.operation.id ||
        !matchesPinnedProjectionV1(parsed.data.serializer, "create", observation.projection, parsed.data.nativePlan.data))
        throw new ReferenceHoldError("invalid-create-operation");
      const saved = receipt(locked.operation.receipt);
      // Remote confirmation does not manufacture a provider response; accepted
      // or uncertain dispatch must have been durably recorded before adoption.
      if (!locked.operation.dispatch_possible || saved.remote.kind !== "confirmed" || !["accepted", "uncertain"].includes(saved.provider.kind))
        throw new ReferenceHoldError("confirmation-missing");
      await client.query("UPDATE reference_bindings SET destination_lifecycle='present',etag=$2,baseline=$3 WHERE id=$1", [locked.binding.id, observation.etag, parsed.data.admittedProjection.data]);
      await client.query("UPDATE reference_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1", [claim.operationId]);
      return true;
    }, signal);
  }
  async completeGraphDelete(claim: ReferenceClaim, supplied: ReferenceGraphDeleteObservation, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyExactDataFields(supplied, ["kind", "read"]);
    const read = copyExactDataFields(fields.read, ["kind", "status"]);
    if (fields.kind !== "exact-absence" || read.kind !== "absent" || read.status !== 404) throw new ReferenceHoldError("invalid-graph-absence");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(locked.operation) !== "microsoft" || locked.operation.action !== "delete" ||
        profileOf(locked.operation) !== REFERENCE_GRAPH_DELETE_PROFILE) return false;
      const decoded = decodeSyncOperationPayload(locked.operation.payload, rowBinding(locked.operation), { supports: supportsMicrosoftPersonalDeleteEnvelope });
      if (decoded.kind !== "pinned-v1" || !graphDeleteEtag(locked.operation.accepted_etag))
        throw new ReferenceHoldError("invalid-graph-delete-operation");
      const saved = receipt(locked.operation.receipt);
      if (saved.remote.kind !== "confirmed" || saved.provider.kind === "pending") throw new ReferenceHoldError("confirmation-missing");
      await client.query("UPDATE reference_bindings SET destination_lifecycle='absent' WHERE id=$1", [locked.binding.id]);
      await client.query("UPDATE reference_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1", [claim.operationId]);
      return true;
    }, signal);
  }
  async completeCaldavDelete(claim: ReferenceClaim, supplied: ReferenceCaldavDeleteObservation, signal?: AbortSignal): Promise<boolean> {
    claim = claimIdentity(claim);
    const fields = copyExactDataFields(supplied, ["kind", "read"]), read = copyExactDataFields(fields.read, ["kind", "status"]);
    if (fields.kind !== "exact-absence" || read.kind !== "absent" || read.status !== 404) throw new ReferenceHoldError("invalid-caldav-absence");
    return this.transaction(async client => {
      const locked = await this.locked(client, claim.operationId);
      signal?.throwIfAborted();
      if (!this.owned(locked, claim) || !this.current(locked) || providerOf(locked.operation) !== "caldav" || locked.operation.action !== "delete" ||
        profileOf(locked.operation) !== REFERENCE_CALDAV_DELETE_PROFILE) return false;
      const decoded = decodeSyncOperationPayload(locked.operation.payload, rowBinding(locked.operation), { supports: supportsCaldavPersonalDeleteEnvelope });
      const plan = decoded.kind === "pinned-v1" ? parseNativeWritePlanV1(decoded.envelope.serializer, "delete", "event", decoded.envelope.nativePlan.data) : undefined;
      if (!plan || plan.planKind !== "caldav-properties" || plan.uid !== locked.operation.accepted_uid || !strongEtag(locked.operation.accepted_etag))
        throw new ReferenceHoldError("invalid-caldav-delete-operation");
      const saved = receipt(locked.operation.receipt);
      if (saved.remote.kind !== "confirmed" || saved.provider.kind === "pending") throw new ReferenceHoldError("confirmation-missing");
      await client.query("UPDATE reference_bindings SET destination_lifecycle='absent' WHERE id=$1", [locked.binding.id]);
      await client.query("UPDATE reference_operations SET status='acked',lease_attempt_id=NULL,lease_until=NULL WHERE id=$1", [claim.operationId]);
      return true;
    }, signal);
  }
  async finish(claim: ReferenceClaim, status: "hold" | "conflict" = "hold", supplied?: { retryAfterMs?: number; code?: string }): Promise<boolean> {
    claim = claimIdentity(claim);
    if (!["hold", "conflict"].includes(status)) throw new Error("Invalid reference finish status");
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
    patch = Object.freeze(copyDataFields(patch, [], ["status", "scope", "accessToken", "expiresAt"])) as typeof patch;
    if (patch.status !== undefined && !["active", "retired"].includes(patch.status) || patch.scope !== undefined && typeof patch.scope !== "string" ||
      patch.accessToken !== undefined && patch.accessToken !== null && typeof patch.accessToken !== "string" ||
      patch.expiresAt !== undefined && (typeof patch.expiresAt !== "string" || !Number.isFinite(Date.parse(patch.expiresAt)))) throw new Error("Invalid reference connection patch");
    await this.transaction(async client => {
      const row = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [connectionId])).rows[0];
      if (!row) throw new ReferenceHoldError("connection-missing");
      const ciphertext = patch.accessToken === undefined ? row.credential_ciphertext : patch.accessToken === null ? null : encryptCredential(this.credentialKey, connectionId, patch.accessToken);
      await client.query("UPDATE reference_connections SET status=$2,scope=$3,credential_ciphertext=$4,expires_at=$5 WHERE id=$1", [connectionId,
        patch.status ?? row.status, patch.scope === undefined ? row.scope : scopeValue(patch.scope), ciphertext, patch.expiresAt ?? row.expires_at]);
    });
  }
  async changeBinding(bindingId: string, patch: { active?: boolean; calendarId?: string; eventId?: string }): Promise<void> {
    patch = Object.freeze(copyDataFields(patch, [], ["active", "calendarId", "eventId"])) as typeof patch;
    if (patch.active !== undefined && typeof patch.active !== "boolean" || [patch.calendarId, patch.eventId].some(value => value !== undefined && (typeof value !== "string" || !value || value.length > 2048))) throw new Error("Invalid reference binding patch");
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
    if (typeof objectId !== "string" || typeof privacyLabel !== "string") throw new Error("Invalid reference privacy input");
    // This locks only the object, never subsequently a connection, so it cannot invert the host lock order.
    await this.pool.query("UPDATE reference_objects SET privacy_label=$2 WHERE id=$1", [objectId, privacyLabel]);
  }
}
