import assert from "node:assert/strict";
import {
  SYNC_OPERATION_SERIALIZER_FORMATS, SyncJsonValueSchema, SyncOperationEnvelopeSchema,
  decodeSyncOperationPayload, isSyncOperationBlockCode, type SyncOperationRowBinding,
} from "./sync_operation";
import { SYNC_PROFILE_V1 } from "./sync_protocol";

const binding: SyncOperationRowBinding = {
  kind: "event", action: "update", operationId: "operation-1", commandId: "human-edit-1",
  hostObjectId: "host-event-1", provider: "google", connectionId: "grant-1",
  collectionId: "calendar-1", resourceId: "native-event-1", acceptedRevision: 3,
  sourceEpoch: { sourceId: "source-link-1", generation: 4 }, privacyEpoch: "privacy-2",
};
const envelope = {
  schemaVersion: 1, profileVersion: SYNC_PROFILE_V1,
  operation: { kind: "event", action: "update", version: 1 },
  serializer: { id: "google-personal-event", version: 1 },
  commandId: binding.commandId, operationId: binding.operationId, hostObjectId: binding.hostObjectId,
  locator: { provider: binding.provider, connectionId: binding.connectionId, collectionId: binding.collectionId, resourceId: binding.resourceId },
  sourceEpoch: binding.sourceEpoch, acceptedRevision: binding.acceptedRevision, privacyEpoch: binding.privacyEpoch,
  allowedSideEffects: ["provider-content-write"],
  admittedProjection: { data: { title: "Accepted title", reminders: [{ minutes: 15 }], description: null } },
  nativePlan: { kind: "codec-data", data: { summary: "Accepted title" } },
};
function decode(value: unknown, row = binding) { return decodeSyncOperationPayload(value, row); }
function blocked(value: unknown, code: string, row = binding) {
  assert.deepEqual(decode(value, row), { kind: "blocked", code });
  assert.equal(isSyncOperationBlockCode(code), true);
}
function payload(value: unknown) { return { event: { title: "Newer host title must not replace admission" }, operationEnvelope: value }; }

const legacyEvent = {
  event: { id: "host-event-1", title: "Legacy event", start: "2026-10-12T08:00:00.000Z" },
  providerProjection: { title: "Legacy provider title", nativeUnknown: "preserve" },
  patch: { location: null }, createIdentityVersion: 1,
};
const oldEventBytes = JSON.stringify(legacyEvent);
const oldEventResult = decode(legacyEvent);
assert.equal(oldEventResult.kind, "legacy-v0");
if (oldEventResult.kind !== "legacy-v0") throw new Error("Legacy regression");
assert.equal(oldEventResult.payload, legacyEvent);
assert.equal(JSON.stringify(oldEventResult.payload), oldEventBytes);
assert.equal("operationEnvelope" in legacyEvent, false);

for (const value of [undefined, null, false, [], {}, "not-an-envelope"]) blocked(payload(value), "operation-envelope-malformed");
blocked(payload({ ...envelope, schemaVersion: 2 }), "operation-envelope-schema-unsupported");
blocked(payload({ ...envelope, profileVersion: "sync-profile-v0" }), "operation-envelope-profile-unsupported");
blocked(payload({ ...envelope, profileVersion: "sync-profile-v2" }), "operation-envelope-profile-unsupported");
blocked(payload({ ...envelope, serializer: { id: "unknown-codec", version: 1 } }), "delivery-serializer-unavailable");
blocked(payload({ ...envelope, serializer: { id: "google-personal-event", version: 2 } }), "delivery-serializer-unavailable");
blocked(payload({ ...envelope, serializer: { id: "google-personal-event", version: 0 } }), "operation-envelope-malformed");
blocked(payload({ ...envelope, attemptId: "retry-lease-2" }), "operation-envelope-malformed");
blocked(payload({ ...envelope, version: 1 }), "operation-envelope-malformed");
blocked(payload({ ...envelope, nativePlan: { ...envelope.nativePlan, headers: {} } }), "operation-envelope-malformed");
blocked(payload({ ...envelope, operation: { ...envelope.operation, extra: true } }), "operation-envelope-malformed");
blocked(payload(envelope), "operation-envelope-codec-unavailable");
const originalEnvelopeBytes = JSON.stringify(envelope);
decode(payload(envelope));
assert.equal(JSON.stringify(envelope), originalEnvelopeBytes, "decode must not mutate or reproject the accepted plan");

for (const format of SYNC_OPERATION_SERIALIZER_FORMATS) {
  const row = { ...binding, kind: format.kind, provider: format.provider };
  const value = { ...envelope, operation: { ...envelope.operation, kind: format.kind },
    serializer: { id: format.id, version: format.version }, locator: { ...envelope.locator, provider: format.provider } };
  blocked(payload(value), "operation-envelope-codec-unavailable", row);
}
blocked(payload({ ...envelope, serializer: { id: "microsoft-personal-event", version: 1 } }), "operation-envelope-binding-mismatch");
blocked(payload({ ...envelope, serializer: { id: "google-task", version: 1 } }), "operation-envelope-binding-mismatch");

for (const row of [
  { ...binding, operationId: "operation-2" }, { ...binding, commandId: "human-edit-2" },
  { ...binding, hostObjectId: "other-event" }, { ...binding, kind: "task" as const },
  { ...binding, action: "delete" as const }, { ...binding, provider: "microsoft" },
  { ...binding, connectionId: "other-grant" }, { ...binding, collectionId: "other-calendar" },
  { ...binding, resourceId: "other-native-event" }, { ...binding, acceptedRevision: 4 },
  { ...binding, sourceEpoch: { sourceId: "source-link-2", generation: 4 } },
  { ...binding, sourceEpoch: { sourceId: "source-link-1", generation: 5 } },
  { ...binding, privacyEpoch: "privacy-3" },
]) blocked(payload(envelope), "operation-envelope-binding-mismatch", row);
blocked(payload(envelope), "operation-envelope-binding-mismatch", { ...binding, resourceId: null });
const createEnvelope = { ...envelope, operation: { ...envelope.operation, action: "create" } };
blocked(payload(createEnvelope), "operation-envelope-codec-unavailable", { ...binding, action: "create", resourceId: null });

const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
for (const value of [undefined, () => "side-effect", Infinity, NaN, 1n, new Date(), cyclic, { key: undefined }, [, 1]]) {
  assert.equal(SyncJsonValueSchema.safeParse(value).success, false);
  blocked(payload({ ...envelope, nativePlan: { kind: "codec-data", data: { value } } }), "operation-envelope-malformed");
}
let getterRan = false;
const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { getterRan = true; return "secret"; } });
assert.equal(SyncJsonValueSchema.safeParse(getter).success, false);
assert.equal(getterRan, false, "JSON validation must not invoke accessors");
for (const key of ["access_token", "refreshToken", "client-secret", "credentials", "authorization", "headers", "password"]) {
  blocked(payload({ ...envelope, nativePlan: { kind: "codec-data", data: { nested: { [key]: "synthetic-secret" } } } }), "operation-envelope-malformed");
}
const shared = { nested: true };
assert.equal(SyncJsonValueSchema.safeParse([shared, shared]).success, true, "shared references without cycles are JSON serializable");
assert.equal(SyncJsonValueSchema.safeParse({ strings: ["text", ""], scalars: [null, 0, false] }).success, true);
assert.equal(SyncOperationEnvelopeSchema.safeParse({ ...envelope, allowedSideEffects: ["provider-content-write", "provider-content-write"] }).success, false);

const taskBinding: SyncOperationRowBinding = { ...binding, kind: "task", hostObjectId: "task-1", resourceId: "native-task-1" };
const dispatch = { version: 1, projection: { title: "Exact admitted task", unknownNative: [null, 1] },
  patch: { title: "Exact admitted task" }, baseline: { title: "Old title" }, errorCode: "task-write-failed" };
const taskPayload = { task: { id: "task-1", title: "Newer title" }, dispatchProjection: dispatch,
  providerProjection: { version: 999, diagnosticOnly: true } };
const taskBytes = JSON.stringify(taskPayload);
const taskResult = decode(taskPayload, taskBinding);
assert.equal(taskResult.kind, "legacy-v0");
if (taskResult.kind !== "legacy-v0") throw new Error("Legacy task regression");
assert.equal(taskResult.payload, taskPayload);
assert.equal(JSON.stringify(taskResult.payload), taskBytes);
assert.equal(decode({ task: taskPayload.task, providerProjection: taskPayload.providerProjection }, taskBinding).kind, "legacy-v0");
for (const value of [undefined, null, [], {}, { version: 1 }, { ...dispatch, baseline: undefined }, { ...dispatch, extra: true }]) {
  blocked({ task: taskPayload.task, dispatchProjection: value }, "task-dispatch-projection-malformed", taskBinding);
}
for (const version of [0, 2, "1", null, undefined]) {
  blocked({ task: taskPayload.task, dispatchProjection: { ...dispatch, version } }, "task-dispatch-projection-version-unsupported", taskBinding);
}
blocked(null, "operation-payload-malformed");
blocked([], "operation-payload-malformed");
assert.equal(isSyncOperationBlockCode("not-a-public-block-code"), false);
assert.equal(isSyncOperationBlockCode(null), false);

console.log("Decoder-first operation envelope HOLD contract: OK");
