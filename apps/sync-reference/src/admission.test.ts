import assert from "node:assert/strict";
import test from "node:test";
import { acceptedEnvelope, admissionFingerprint, initialReceipt, projection, validateContent, validatePatch } from "./admission.js";
import { assertCredentialKey, decryptCredential, encryptCredential } from "./crypto.js";
import type { ReferenceContent } from "./model.js";
const key = "ab".repeat(32);
const content: ReferenceContent = { name: "Host A", notes: null, place: "Room", beginsAt: "2026-10-13T08:00:00.000Z", endsAt: "2026-10-13T09:00:00.000Z" };
const input = { bindingId: "opaque:binding", expectedRevision: 1, commandId: "command:a", operationId: "operation:a", patch: { name: "Host B", notes: "Note" } };
const host = { objectId: "own:object", connectionId: "account:not-uuid", calendarId: "a/b@c.test", eventId: "event/?:", capture: { acceptedRevision: 2, sourceGeneration: 4, connectionGeneration: 8, privacyGeneration: 6 } };

test("independent content becomes one pinned projection and sparse native UPDATE", () => {
  const envelope = acceptedEnvelope(input, { ...content, ...input.patch }, host);
  assert.deepEqual(envelope.nativePlan.data, { planKind: "json-body", body: { summary: "Host B", description: "Note" } });
  assert.deepEqual(envelope.admittedProjection.data, projection({ ...content, ...input.patch }));
  assert.equal(envelope.hostObjectId, "own:object"); assert.equal(envelope.locator.connectionId, "account:not-uuid");
  assert.equal(envelope.sourceEpoch.generation, 4); assert.equal(envelope.privacyEpoch, "6");
  assert.equal(initialReceipt(envelope).provider.kind, "not-dispatched");
});
test("stable idempotency fingerprint ignores patch property order, includes revision and native binding", () => {
  assert.equal(admissionFingerprint(input), admissionFingerprint({ ...input, patch: { notes: "Note", name: "Host B" } }));
  assert.notEqual(admissionFingerprint(input), admissionFingerprint({ ...input, expectedRevision: 2 }));
  assert.notEqual(admissionFingerprint(input), admissionFingerprint({ ...input, bindingId: "different" }));
});
test("no timing, recurrence or arbitrary transport properties enter this content patch", () => {
  for (const patch of [{}, { beginsAt: content.beginsAt }, { headers: {} }, { name: undefined }, { notes: 1 }, { name: null }])
    assert.throws(() => validatePatch(patch as never), /Invalid reference content patch/);
  assert.throws(() => validateContent({ ...content, endsAt: "2026-10-13T07:00:00.000Z" }), /Invalid reference content/);
  assert.throws(() => validateContent({ ...content, beginsAt: "2026-10-13T08:00:00Z" }), /Invalid reference content/);
});
test("getters and symbol properties are rejected without evaluating untrusted getters", () => {
  let read = false;
  const patch = Object.defineProperty({}, "name", { enumerable: true, get() { read = true; return "hidden"; } });
  assert.throws(() => validatePatch(patch)); assert.equal(read, false);
  assert.throws(() => validatePatch({ name: "A", [Symbol("hidden")]: "secret" }));
});
test("codec bounds reject oversized admitted content rather than truncate it", () => {
  assert.throws(() => acceptedEnvelope({ ...input, patch: { name: "x".repeat(2_000_000) } }, { ...content, name: "x".repeat(2_000_000) }, host));
});
test("AES-GCM credential envelope is randomized and bound to the opaque connection", () => {
  const first = encryptCredential(key, "connection:a", "secret-access-token");
  const second = encryptCredential(key, "connection:a", "secret-access-token");
  assert.notEqual(first, second); assert(!first.includes("secret-access-token"));
  assert.equal(decryptCredential(key, "connection:a", first), "secret-access-token");
  assert.throws(() => decryptCredential(key, "connection:b", first));
  const parts = first.split("."); parts[1] = Buffer.alloc(16).toString("base64");
  assert.throws(() => decryptCredential(key, "connection:a", parts.join(".")));
});
test("credential key is required and errors do not echo input credentials", () => {
  for (const bad of ["", "short", "gg".repeat(32)]) assert.throws(() => assertCredentialKey(bad), /64 hex digits/);
  assert.throws(() => encryptCredential(key, "id", "secret\r\nheader"), /Invalid reference credential/);
});
