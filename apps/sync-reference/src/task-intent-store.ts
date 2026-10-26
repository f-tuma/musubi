import type { PoolClient } from "pg";
import { decodeSyncOperationPayload, SyncDeliveryReceiptSchema, type SyncOperationRowBinding } from "@musubi/types";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import { initialReceipt, jsonEqual } from "./admission.js";
import { ReferenceHoldError } from "./model.js";
import { taskFields, taskSavedProjection, taskWriteAllowed, validateTaskContent, validateTaskPatch, validateTaskBaseline } from "./task-admission.js";
import { acceptedQueuedTaskEnvelope, queuedTaskFingerprint, taskCompletion, taskSemanticDigest } from "./task-intent-admission.js";
import type { ReferenceTaskIntent, ReferenceTaskQueuedDelete, ReferenceTaskQueuedUpdate, ReferenceTaskResolutionBasis } from "./task-intent-model.js";

type Row = Record<string, any>;
const fail: (code: string) => never = code => { throw new ReferenceHoldError(code); };
export function taskOperationBinding(op: Row): SyncOperationRowBinding {
  return { kind: "task", action: op.action, operationId: op.id, commandId: op.command_id, hostObjectId: op.object_id, provider: "google",
    connectionId: op.connection_id, collectionId: op.task_list_id, resourceId: op.task_id, acceptedRevision: Number(op.accepted_revision),
    ...(op.predecessor_operation_id ? { predecessorOperationId: op.predecessor_operation_id } : {}),
    sourceEpoch: { sourceId: op.binding_id, generation: Number(op.source_generation) }, privacyEpoch: String(op.privacy_generation) };
}
export async function taskIntentsInstalled(client: PoolClient): Promise<boolean> {
  return (await client.query("SELECT to_regclass('reference_task_intents') IS NOT NULL AS ready")).rows[0].ready;
}
/** Cross-table IDs and commands share the original task namespace. The one-ID
 * advisory lock closes collisions between different connection transactions. */
export async function reserveTaskOperationIdentity(client: PoolClient, input: { operationId: string; commandId: string; connectionId: string }): Promise<void> {
  if (!await taskIntentsInstalled(client)) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["reference-task-operation:" + input.operationId]);
  const queued = (await client.query("SELECT id FROM reference_task_intents WHERE id=$1 OR connection_id=$2 AND command_id=$3", [input.operationId, input.connectionId, input.commandId])).rows[0];
  if (queued) fail("task-command-or-operation-reused");
  if ((await client.query("SELECT id FROM reference_task_operations WHERE id=$1", [input.operationId])).rowCount) fail("task-operation-reused");
}
export async function hasWaitingTaskIntent(client: PoolClient, bindingId: string): Promise<boolean> {
  if (!await taskIntentsInstalled(client)) return false;
  return !!(await client.query("SELECT 1 FROM reference_task_intents i LEFT JOIN reference_task_operations o ON o.id=i.id WHERE i.binding_id=$1 AND (o.id IS NULL OR o.status<>'acked') LIMIT 1", [bindingId])).rowCount;
}
function admitted(op: Row) {
  const decoded = decodeSyncOperationPayload(op.payload, taskOperationBinding(op), { supports: envelope => envelope.operation.kind === "task" && envelope.locator.provider === "google" && envelope.serializer.id === "google-task" && envelope.serializer.version === 1 });
  if (decoded.kind !== "pinned-v1") return fail("task-causal-envelope-unavailable");
  const e = decoded.envelope, plan = parseNativeWritePlanV1(e.serializer, e.operation.action, "task", e.nativePlan.data);
  if (!plan || plan.planKind !== "json-body" || !matchesPinnedProjectionV1(e.serializer, e.operation.action, e.admittedProjection.data, plan) ||
    !jsonEqual(plan.body, e.operation.action === "delete" ? null : e.admittedProjection.data)) return fail("task-causal-plan-unavailable");
  return { envelope: e, projection: validateTaskBaseline(e.admittedProjection.data) };
}
function intentRowBinding(intent: Row) {
  return { ...intent, provider: "google", task_id: null, predecessor_operation_id: intent.predecessor_operation_id };
}
function checkedIntent(intent: Row) {
  const result = admitted(intentRowBinding(intent));
  if (!["update", "delete"].includes(intent.action) || result.envelope.locator.resourceId !== null || result.envelope.predecessorOperationId !== intent.predecessor_operation_id ||
    Number(intent.accepted_revision) !== Number(intent.expected_revision) + 1) fail("task-intent-unavailable");
  validateTaskContent(intent.content); return result;
}
export async function enqueueTaskIntent(client: PoolClient, action: "update" | "delete", supplied: ReferenceTaskQueuedUpdate | ReferenceTaskQueuedDelete): Promise<void> {
  const input = Object.freeze(taskFields(supplied, ["bindingId", "expectedRevision", "commandId", "operationId", "predecessorOperationId", ...(action === "update" ? ["patch"] : [])])) as unknown as ReferenceTaskQueuedUpdate;
  const patch = action === "update" ? Object.freeze(validateTaskPatch(input.patch)) : null, fingerprint = queuedTaskFingerprint(action, { ...input, ...(patch ? { patch } : {}) });
  const first = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1", [input.bindingId])).rows[0]; if (!first) fail("task-binding-missing");
  const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [first.connection_id])).rows[0];
  const object = (await client.query("SELECT * FROM reference_task_objects WHERE id=$1 FOR UPDATE", [first.object_id])).rows[0];
  const binding = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [input.bindingId])).rows[0];
  const existing = (await client.query("SELECT * FROM reference_task_intents WHERE connection_id=$1 AND command_id=$2", [conn.id, input.commandId])).rows[0];
  if (existing) { if (existing.fingerprint !== fingerprint) fail("task-command-reused"); return; }
  if ((await client.query("SELECT 1 FROM reference_task_operations WHERE connection_id=$1 AND command_id=$2", [conn.id, input.commandId])).rowCount) fail("task-command-reused");
  await reserveTaskOperationIdentity(client, { ...input, connectionId: conn.id });
  const root = (await client.query("SELECT * FROM reference_task_operations WHERE id=$1 AND connection_id=$2 AND binding_id=$3 AND object_id=$4 AND task_list_id=$5 FOR UPDATE", [binding.create_operation_id, conn.id, binding.id, object.id, binding.task_list_id])).rows[0];
  const live = (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid;
  if (!root || conn.provider !== "google" || conn.status !== "active" || !conn.credential_ciphertext || !live || !taskWriteAllowed(conn.scope) || !binding.active || binding.destination_lifecycle !== "reserved" || binding.create_profile !== "google-task-create-v1" ||
    root.action !== "create" || root.endpoint_profile !== "google-task-create-v1" || root.status === "acked" || binding.task_id !== null || binding.etag !== null || binding.baseline !== null || object.canonical_lifecycle !== "active") fail("task-intent-reservation-unavailable");
  admitted(root);
  if (root.connection_id !== conn.id || root.binding_id !== binding.id || root.object_id !== object.id || root.task_list_id !== binding.task_list_id ||
    Number(root.connection_generation) !== Number(conn.generation) || Number(root.source_generation) !== Number(binding.source_generation) || Number(root.privacy_generation) !== Number(object.privacy_generation) ||
    Number(root.accepted_revision) !== Number(object.revision) || Number(root.canonical_generation) !== Number(object.lifecycle_generation)) fail("task-intent-authority-changed");
  const tail = (await client.query("SELECT * FROM reference_task_intents WHERE binding_id=$1 ORDER BY accepted_revision DESC LIMIT 1", [binding.id])).rows[0];
  if (tail) checkedIntent(tail);
  const expected = tail ? Number(tail.accepted_revision) : Number(object.revision);
  if (input.expectedRevision !== expected || input.predecessorOperationId !== (tail?.id ?? root.id)) fail("task-intent-revision-or-predecessor-conflict");
  if (tail?.action === "delete") fail("task-intent-terminal-delete");
  const content = validateTaskContent({ ...validateTaskContent(tail?.content ?? object.content), ...(patch ?? {}) });
  const capture = { acceptedRevision: expected + 1, connectionGeneration: Number(root.connection_generation), sourceGeneration: Number(root.source_generation), privacyGeneration: Number(root.privacy_generation),
    canonicalGeneration: Number(root.canonical_generation) + (action === "delete" ? 1 : 0) };
  const envelope = acceptedQueuedTaskEnvelope(action, input, content, { objectId: object.id, connectionId: conn.id, taskListId: binding.task_list_id, capture });
  await client.query(`INSERT INTO reference_task_intents(id,command_id,binding_id,object_id,connection_id,task_list_id,action,root_create_operation_id,predecessor_intent_id,predecessor_operation_id,
    expected_revision,accepted_revision,captured_object_revision,connection_generation,source_generation,privacy_generation,reservation_canonical_generation,canonical_generation,canonical_lifecycle,content,payload,fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
  [input.operationId, input.commandId, binding.id, object.id, conn.id, binding.task_list_id, action, root.id, tail?.id ?? null, input.predecessorOperationId, expected, capture.acceptedRevision,
    Number(object.revision), capture.connectionGeneration, capture.sourceGeneration, capture.privacyGeneration, Number(root.canonical_generation), capture.canonicalGeneration,
    action === "delete" ? "tombstoned" : "active", content, { operationEnvelope: envelope }, fingerprint]);
  if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid) fail("task-intent-authority-changed");
}
function scope(row: Row) {
  return [row.binding_id, row.object_id, row.connection_id, row.task_list_id, Number(row.connection_generation), Number(row.source_generation), Number(row.privacy_generation)];
}
function semantic(row: Row) {
  return { binding: taskOperationBinding(row), connectionGeneration: Number(row.connection_generation), canonicalGeneration: Number(row.canonical_generation), acceptedEtag: row.accepted_etag,
    payload: row.payload, saved: row.saved_projection, deleteBaseline: row.delete_accepted_baseline, resolution: row.resolution_basis ?? null, completion: row.completion_evidence, receipt: row.receipt };
}
/** Called only behind current connection/canonical/binding locks. Original
 * captures remain unchanged; one owned root adoption authorizes the new epoch. */
export async function taskPredecessorBasis(client: PoolClient, op: Row, binding: Row, signal?: AbortSignal): Promise<ReferenceTaskResolutionBasis> {
  const intent = (await client.query("SELECT * FROM reference_task_intents WHERE id=$1", [op.queued_intent_id])).rows[0];
  if (!intent || intent.id !== op.id || !jsonEqual(scope(intent), scope(op)) || intent.predecessor_operation_id !== op.predecessor_operation_id || !jsonEqual(intent.payload, op.payload) ||
    Number(intent.accepted_revision) !== Number(op.accepted_revision) || Number(intent.canonical_generation) !== Number(op.canonical_generation)) return fail("task-predecessor-intent-changed");
  checkedIntent(intent);
  const chain: Row[] = [], visited = new Set<string>([op.id]); let id = op.predecessor_operation_id, expectedRevision = Number(op.accepted_revision) - 1;
  while (id) {
    signal?.throwIfAborted(); if (visited.has(id)) fail("task-predecessor-cycle"); visited.add(id);
    const row = (await client.query("SELECT * FROM reference_task_operations WHERE id=$1 AND connection_id=$2 AND binding_id=$3 AND object_id=$4 AND task_list_id=$5 FOR UPDATE", [id, op.connection_id, op.binding_id, op.object_id, op.task_list_id])).rows[0];
    if (!row || row.status !== "acked" || row.provider !== "google" || row.endpoint_profile !== "google-task-" + row.action + "-v1" || !jsonEqual(scope(row), scope(op)) || !["create", "update"].includes(row.action) || Number(row.accepted_revision) !== expectedRevision--) return fail("task-predecessor-incomplete-or-foreign");
    const complete = taskCompletion(row.completion_evidence), parsed = admitted(row), receipt = SyncDeliveryReceiptSchema.parse(row.receipt);
    const attempt = (await client.query("SELECT receipt,recovery FROM reference_task_attempts WHERE id=$1 AND operation_id=$2 FOR UPDATE", [complete.attemptId, row.id])).rows[0];
    // Completion belongs to one actual owned attempt. Preserve its provider fact:
    // rejected GET-recovery and empty-mask UPDATE are both truthful predecessors.
    const providerAllowed = receipt.provider.kind === "accepted" || receipt.provider.kind === "uncertain" || row.action === "update" && (
      receipt.provider.kind === "rejected" && row.dispatch_possible && attempt?.recovery === true ||
      receipt.provider.kind === "not-dispatched" && !row.dispatch_possible && Object.keys(row.saved_projection?.patch ?? {}).length === 0);
    if (complete.kind !== "present" || complete.operationId !== row.id || !attempt || !jsonEqual(attempt.receipt, receipt) ||
      receipt.operationId !== row.id || receipt.attemptId !== complete.attemptId || receipt.local.kind !== "committed" || receipt.local.hostObjectId !== row.object_id || receipt.local.revision !== String(row.accepted_revision) ||
      !providerAllowed || receipt.notification.kind !== "not-requested" || receipt.remote.kind !== "confirmed" || receipt.remote.observationId !== complete.observationId ||
      !jsonEqual(complete.projectionBaseline, parsed.projection) || row.action === "update" && complete.adoption !== undefined) return fail("task-predecessor-completion-unavailable");
    chain.push(row);
    if (row.id === intent.root_create_operation_id) { if (row.action !== "create" || row.predecessor_operation_id) fail("task-predecessor-root-unavailable"); break; }
    if (row.action !== "update" || row.queued_intent_id !== row.id || !row.predecessor_operation_id || !row.resolution_basis) fail("task-predecessor-lineage-unavailable");
    id = row.predecessor_operation_id;
  }
  const root = chain.at(-1); if (!root || root.id !== intent.root_create_operation_id) return fail("task-predecessor-root-unavailable");
  const rootCompletion = taskCompletion(root.completion_evidence), pair = taskCompletion(chain[0].completion_evidence), original = Number(root.source_generation), effective = original + 1;
  if (rootCompletion.kind !== "present" || pair.kind !== "present" || rootCompletion.adoption?.operationId !== root.id || rootCompletion.adoption?.from !== original || rootCompletion.adoption?.to !== effective ||
    !root.dispatch_possible || root.create_acceptance_status === null || root.create_candidate_id !== rootCompletion.taskId || binding.create_operation_id !== root.id || binding.create_profile !== "google-task-create-v1" ||
    binding.id !== op.binding_id || binding.connection_id !== op.connection_id || binding.object_id !== op.object_id || binding.task_list_id !== op.task_list_id ||
    !binding.active || binding.destination_lifecycle !== "present" || Number(binding.source_generation) !== effective || binding.task_id !== pair.taskId || binding.etag !== pair.validator || !jsonEqual(binding.baseline, pair.projectionBaseline)) return fail("task-predecessor-adoption-or-pair-changed");
  for (const row of chain) {
    const complete = taskCompletion(row.completion_evidence);
    if (complete.sourceGeneration !== effective || complete.taskId !== rootCompletion.taskId) fail("task-predecessor-pair-changed");
  }
  if (op.task_id !== null || op.accepted_etag !== pair.validator || !jsonEqual(op.action === "delete" ? op.delete_accepted_baseline : op.saved_projection?.baseline, pair.projectionBaseline)) fail("task-predecessor-prepared-pair-changed");
  const lineage = [...chain].reverse().map(row => ({ operationId: row.id, digest: taskSemanticDigest(semantic(row)) }));
  const value = { version: 1 as const, rootCreateOperationId: root.id as string, predecessorOperationId: op.predecessor_operation_id as string, evidenceOperationId: chain[0].id as string,
    originalSourceGeneration: original, effectiveSourceGeneration: effective, taskId: pair.taskId, validator: pair.validator, projectionBaseline: pair.projectionBaseline,
    lineage, intentDigest: taskSemanticDigest({ intent, operation: { ...semantic(op), resolution: null, completion: null, receipt: null } }) };
  return { ...value, witness: taskSemanticDigest(value) };
}
/** One execution row exists per binding. A waiting intent acquires no attempt
 * and cannot materialize canonical truth until its exact predecessor ACKs. */
export async function activateTaskIntent(client: PoolClient, operationId: string, signal?: AbortSignal): Promise<boolean> {
  if (!await taskIntentsInstalled(client)) return true;
  if ((await client.query("SELECT 1 FROM reference_task_operations WHERE id=$1", [operationId])).rowCount) return true;
  const intent = (await client.query("SELECT * FROM reference_task_intents WHERE id=$1", [operationId])).rows[0]; if (!intent) return true;
  const conn = (await client.query("SELECT * FROM reference_connections WHERE id=$1 FOR UPDATE", [intent.connection_id])).rows[0];
  const object = (await client.query("SELECT * FROM reference_task_objects WHERE id=$1 FOR UPDATE", [intent.object_id])).rows[0];
  const binding = (await client.query("SELECT * FROM reference_task_bindings WHERE id=$1 FOR UPDATE", [intent.binding_id])).rows[0];
  if ((await client.query("SELECT 1 FROM reference_task_operations WHERE id=$1", [operationId])).rowCount) return true;
  const predecessor = (await client.query("SELECT * FROM reference_task_operations WHERE id=$1 AND connection_id=$2 AND binding_id=$3 AND object_id=$4 AND task_list_id=$5 FOR UPDATE", [intent.predecessor_operation_id, intent.connection_id, intent.binding_id, intent.object_id, intent.task_list_id])).rows[0]; if (!predecessor || predecessor.status !== "acked") return false;
  signal?.throwIfAborted();
  const live = (await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid;
  if (conn.provider !== "google" || conn.status !== "active" || !conn.credential_ciphertext || !live || !taskWriteAllowed(conn.scope) || Number(conn.generation) !== Number(intent.connection_generation) ||
    Number(object.privacy_generation) !== Number(intent.privacy_generation) || Number(object.revision) !== Number(intent.expected_revision) || object.canonical_lifecycle !== "active" || Number(object.lifecycle_generation) !== Number(intent.reservation_canonical_generation)) fail("task-intent-activation-authority-changed");
  if ((await client.query("SELECT 1 FROM reference_task_operations WHERE binding_id=$1 AND status<>'acked'", [intent.binding_id])).rowCount) return false;
  const parsed = checkedIntent(intent), complete = taskCompletion(predecessor.completion_evidence); if (complete.kind !== "present") fail("task-predecessor-completion-unavailable");
  const saved = intent.action === "update" ? taskSavedProjection(parsed.projection, complete.projectionBaseline) : null;
  const op = { ...intent, provider: "google", task_id: null, endpoint_profile: "google-task-" + intent.action + "-v1", accepted_etag: complete.validator,
    queued_intent_id: intent.id, saved_projection: saved, delete_accepted_baseline: intent.action === "delete" ? complete.projectionBaseline : null, completion_evidence: null };
  const basis = await taskPredecessorBasis(client, op, binding, signal);
  await client.query("UPDATE reference_task_objects SET content=$2,canonical_lifecycle=$3,revision=$4 WHERE id=$1", [intent.object_id, intent.content, intent.canonical_lifecycle, Number(intent.accepted_revision)]);
  await client.query(`INSERT INTO reference_task_operations(id,command_id,binding_id,object_id,connection_id,provider,endpoint_profile,action,task_list_id,task_id,accepted_revision,
    connection_generation,source_generation,privacy_generation,canonical_generation,accepted_etag,fingerprint,payload,saved_projection,field_mask,delete_accepted_baseline,receipt,predecessor_operation_id,queued_intent_id,resolution_basis)
    VALUES($1,$2,$3,$4,$5,'google',$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$1,$22)`,
  [intent.id, intent.command_id, intent.binding_id, intent.object_id, intent.connection_id, op.endpoint_profile, intent.action, intent.task_list_id, Number(intent.accepted_revision), Number(intent.connection_generation),
    Number(intent.source_generation), Number(intent.privacy_generation), Number(intent.canonical_generation), complete.validator, intent.fingerprint, intent.payload, saved, saved ? Object.keys(saved.patch).sort() : null,
    op.delete_accepted_baseline, initialReceipt(parsed.envelope), intent.predecessor_operation_id, basis]);
  if (!(await client.query("SELECT $1::timestamptz>clock_timestamp() AS valid", [conn.expires_at])).rows[0].valid) fail("task-intent-activation-authority-changed"); return true;
}
export async function inspectTaskIntent(client: Pick<PoolClient, "query">, operationId: string): Promise<ReferenceTaskIntent> {
  const row = (await client.query(`SELECT i.*,o.status,t.content AS materialized_content,t.revision AS materialized_revision,t.canonical_lifecycle AS materialized_lifecycle,t.lifecycle_generation AS materialized_generation
    FROM reference_task_intents i JOIN reference_task_objects t ON t.id=i.object_id LEFT JOIN reference_task_operations o ON o.id=i.id WHERE i.id=$1`, [operationId])).rows[0];
  if (!row) return fail("task-intent-missing");
  return { operationId: row.id, commandId: row.command_id, bindingId: row.binding_id, objectId: row.object_id, action: row.action, predecessorOperationId: row.predecessor_operation_id, rootCreateOperationId: row.root_create_operation_id,
    expectedRevision: Number(row.expected_revision), acceptedRevision: Number(row.accepted_revision), capturedObjectRevision: Number(row.captured_object_revision), content: row.content, lifecycle: row.canonical_lifecycle, canonicalGeneration: Number(row.canonical_generation),
    reservationCapture: { acceptedRevision: Number(row.captured_object_revision), connectionGeneration: Number(row.connection_generation), sourceGeneration: Number(row.source_generation), privacyGeneration: Number(row.privacy_generation), canonicalGeneration: Number(row.reservation_canonical_generation) },
    payload: row.payload, status: row.status ?? "waiting", materialized: { content: row.materialized_content, revision: Number(row.materialized_revision), lifecycle: row.materialized_lifecycle, generation: Number(row.materialized_generation) } };
}
