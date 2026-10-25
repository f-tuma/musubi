import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeWritePlanV1, matchesPinnedProjectionV1 } from "@musubi/sync-codec";
import { acceptedCaldavDeleteEnvelope, caldavDeleteAdmissionFingerprint, caldavDeleteAddress, graphDeleteAdmissionFingerprint, caldavUid, initialReceipt, REFERENCE_CALDAV_DELETE_PROFILE } from "./admission.js";
import { basicCredential, encryptCredential, decryptCredential } from "./crypto.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceClaim, ReferenceEvidence } from "./model.js";

const input = { bindingId: "dav:binding", expectedRevision: 1, commandId: "dav:command", operationId: "ea2b9dba-8e96-42ee-95b6-06c8a9760a8e" };
const content = { name: "Exact personal DELETE", notes: null, place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" };
const host = { objectId: "dav:object", connectionId: "dav:connection", calendarUrl: "https://dav.example.test/calendars/own/", resourceUrl: "https://dav.example.test/calendars/own/native.ics", uid: "native-uid@example.test",
  capture: { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 2 } };
test("CalDAV admission uses the actual pinned codec and original resource UID, not a derived filename UID", () => {
  const envelope = acceptedCaldavDeleteEnvelope(input, content, host);
  assert.equal(envelope.serializer.id, "caldav-personal-event"); assert.equal(envelope.locator.provider, "caldav");
  assert.equal(envelope.locator.collectionId, host.calendarUrl); assert.equal(envelope.locator.resourceId, host.resourceUrl);
  const plan = parseNativeWritePlanV1(envelope.serializer, "delete", "event", envelope.nativePlan.data);
  assert.equal(plan?.planKind, "caldav-properties"); if (plan?.planKind !== "caldav-properties") assert.fail("DAV codec plan missing");
  assert.equal(plan.uid, host.uid); assert.deepEqual(plan.properties, []); assert.equal(matchesPinnedProjectionV1(envelope.serializer, "delete", envelope.admittedProjection.data, plan), true);
  assert.notEqual(caldavDeleteAdmissionFingerprint(input), graphDeleteAdmissionFingerprint(input));
});
test("strict reference addresses reject collection escapes, aliases, redirects and encoded path separators", () => {
  assert.equal(caldavDeleteAddress(host.calendarUrl, host.resourceUrl), true);
  for (const resourceUrl of ["https://other.example.test/calendars/own/native.ics", host.calendarUrl, host.calendarUrl + "nested/native.ics", host.calendarUrl + "a%2Fb.ics", host.calendarUrl + "a%5Cb.ics", host.resourceUrl + "?read=1", host.resourceUrl + "#fragment", "https://user:secret@dav.example.test/calendars/own/native.ics", "http://dav.example.test/calendars/own/native.ics", "https://dav.example.test/calendars/own/../native.ics"])
    assert.equal(caldavDeleteAddress(host.calendarUrl, resourceUrl), false, resourceUrl);
  assert.equal(caldavDeleteAddress("https://dav.example.test/calendars/own", host.resourceUrl), false);
});
test("missing or newline UID is refused, and serializer escapes exact accepted text", () => {
  for (const uid of ["", "x\ny", "x\ry", null]) { assert.equal(caldavUid(uid), false); assert.throws(() => acceptedCaldavDeleteEnvelope(input, content, { ...host, uid: uid as string })); }
  const envelope = acceptedCaldavDeleteEnvelope(input, { ...content, name: "Comma, semicolon; slash\\ and\nnewline", notes: "Exact čárka" }, { ...host, uid: "original,semi;back\\slash" });
  assert.equal(matchesPinnedProjectionV1(envelope.serializer, "delete", envelope.admittedProjection.data, envelope.nativePlan.data), true);
});
test("the independent DAV codec rejects lost timestamp or nullable-text precision", () => {
  for (const patch of [{ beginsAt: "2026-10-25T08:00:00.123Z" }, { notes: "" }, { place: "" }])
    assert.throws(() => acceptedCaldavDeleteEnvelope(input, { ...content, ...patch }, host), /wire precision/);
});
test("new reference DAV CLI identity is canonical UUID without tightening existing Graph IDs", () => {
  for (const operationId of ["opaque-existing-id", input.operationId.toUpperCase()]) assert.throws(() => caldavDeleteAdmissionFingerprint({ ...input, operationId }), /identity/);
  assert.doesNotThrow(() => graphDeleteAdmissionFingerprint({ ...input, operationId: "opaque-existing-id" }));
});
test("Basic credentials stay in an authenticated encrypted envelope and require their exact own shape", () => {
  const credential = basicCredential({ kind: "basic", username: "owner@example.test", password: "synthetic-password:with-colon" });
  const key = "ab".repeat(32), encrypted = encryptCredential(key, host.connectionId, JSON.stringify(credential));
  assert.equal(encrypted.includes(credential.password), false); assert.deepEqual(basicCredential(JSON.parse(decryptCredential(key, host.connectionId, encrypted))), credential);
  assert.throws(() => decryptCredential(key, "other-connection", encrypted));
  for (const invalid of [{ ...credential, scope: "Calendars.ReadWrite" }, { ...credential, kind: "bearer" }, { ...credential, username: "user:other" }, { ...credential, password: "secret\r\nheader" }]) assert.throws(() => basicCredential(invalid), /Invalid reference Basic credential/);
  let reads = 0; const accessor = { kind: "basic", username: credential.username, get password() { reads++; return credential.password; } };
  assert.throws(() => basicCredential(accessor)); assert.equal(reads, 0);
});

const native = () => {
  const plan = acceptedCaldavDeleteEnvelope(input, content, host).nativePlan.data as { createResource: string };
  return plan.createResource.replace("END:VEVENT", "X-PRIVATE:synthetic-only\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:synthetic-only\r\nEND:VALARM\r\nEND:VEVENT");
};
const response = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : body, { status, headers });
const present = () => response(native(), 200, { etag: '"original-native"' });
const privilege = () => response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${host.calendarUrl}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:unbind/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 207);
function fixture(replies: (Response | Error)[], recovery = false) {
  const envelope = acceptedCaldavDeleteEnvelope(input, content, host);
  const claim: ReferenceClaim = { operationId: input.operationId, attemptId: "dav:attempt", payload: { operationEnvelope: envelope }, envelope,
    binding: { kind: "event", action: "delete", operationId: input.operationId, commandId: input.commandId, hostObjectId: host.objectId, provider: "caldav", connectionId: host.connectionId,
      collectionId: host.calendarUrl, resourceId: host.resourceUrl, acceptedRevision: 2, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    capture: host.capture, locator: { connectionId: host.connectionId, calendarId: host.calendarUrl, eventId: host.resourceUrl }, etag: '"original-native"', acceptedUid: host.uid,
    receipt: initialReceipt(envelope), recovery, endpointProfile: REFERENCE_CALDAV_DELETE_PROFILE };
  if (recovery) claim.receipt.provider = { kind: "uncertain" };
  const calls: { url: string; init: RequestInit }[] = [], evidence: ReferenceEvidence[] = [], completions: unknown[] = [], finishes: unknown[] = [];
  let sessions = 0, marks = 0, mismatch = false;
  const store: ReferenceRunnerStore = { async claim() { return claim; }, async renew() { return true; }, async markDispatch() { marks++; return true; },
    async getSession() { assert.fail("DAV cannot use OAuth credentials"); }, async getCaldavSession() { sessions++; return { connectionId: host.connectionId, connectionGeneration: "1", authorization: "Basic c3ludGhldGljOnBhc3N3b3Jk" }; },
    async recordEvidence(_claim, facts) { evidence.push(facts); return true; }, async finish(_claim, status, outcome) { finishes.push({ status, ...outcome }); return true; },
    async complete() { assert.fail("DAV cannot use Google UPDATE completion"); }, async completeDelete() { assert.fail("DAV cannot use Google absence completion"); },
    async completeGraphDelete() { assert.fail("DAV cannot use Graph absence completion"); }, async completeCaldavDelete(_claim, observation) { completions.push(observation); return true; } };
  const ports: ReferenceRunnerPorts = { http: { async fetch() { assert.fail("DAV cannot use generic unguarded fetch"); } },
    caldav: { network: { allowPrivate: false, lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }] }, http: { async fetchPinned(url, init, address) {
      assert.equal(address.address, "93.184.216.34"); calls.push({ url: url.href, init }); const next = replies.shift(); if (!next) { mismatch = true; throw new Error("Unexpected fixture HTTP"); } if (next instanceof Error) throw next; return next;
    } } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  const run = async () => { const result = await deliverReferenceOperation(store, input.operationId, ports); assert.equal(mismatch, false); assert.equal(replies.length, 0); return result; };
  return { claim, store, ports, calls, evidence, completions, finishes, run, counts: () => ({ sessions, marks }) };
}
test("reference DAV runtime uses guarded ports, original If-Match and exact404 completion", async () => {
  const f = fixture([present(), privilege(), present(), response("", 204), response("", 404)]); assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(c => c.init.method ?? "GET"), ["GET", "PROPFIND", "GET", "DELETE", "GET"]);
  assert.equal(new Headers(f.calls[3]!.init.headers).get("if-match"), '"original-native"'); assert.equal(f.calls[3]!.init.body, undefined); assert.equal(f.counts().marks, 1);
  assert.deepEqual(f.completions, [{ kind: "exact-absence", read: { kind: "absent", status: 404 } }]); assert.equal(f.evidence.at(-1)!.provider, "accepted"); assert.equal(f.evidence.at(-1)!.acceptanceStatus, 204);
});
test("actual reference runner refuses a second VEVENT nested inside the selected resource before any DELETE", async () => {
  const nested = native().replace("END:VEVENT", "BEGIN:VEVENT\r\nUID:nested-unrelated-uid\r\nDTSTART:20261025T100000Z\r\nDTEND:20261025T110000Z\r\nEND:VEVENT\r\nEND:VEVENT");
  const read = () => response(nested, 200, { etag: '"original-native"' });
  const f = fixture([read(), privilege(), read()]); assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().marks, 0); assert.equal(f.completions.length, 0);
  assert.deepEqual(f.calls.map(call => call.init.method ?? "GET"), ["GET", "PROPFIND", "GET"]);
});
test("scoped initial404 and lost-reply404 keep their actual provider facts", async () => {
  const early = fixture([response("", 404)]); assert.equal((await early.run()).status, "acked"); assert.equal(early.evidence.at(-1)!.provider, "not-dispatched"); assert.equal(early.counts().marks, 0);
  const lost = fixture([present(), privilege(), present(), new Error("Owned lost reply"), response("", 404)]); assert.equal((await lost.run()).status, "acked"); assert.equal(lost.evidence.at(-1)!.provider, "uncertain"); assert.equal(lost.counts().marks, 1);
});
test("DAV recovery may conditionally retry the same retained version without importing Graph observe-only semantics", async () => {
  const f = fixture([present(), privilege(), present(), response("", 204), response("", 404)], true); assert.equal((await f.run()).status, "acked"); assert.equal(f.counts().marks, 1); assert.equal(f.evidence.at(-1)!.provider, "accepted");
  const changed = fixture([response(native(), 200, { etag: '"new-version"' })], true); assert.equal((await changed.run()).status, "conflict"); assert.equal(changed.counts().marks, 0);
});
test("missing dedicated transport or completion capability holds before credentials and HTTP", async () => {
  for (const missing of ["transport", "session", "completion"]) {
    const f = fixture([]); if (missing === "transport") delete f.ports.caldav; else if (missing === "session") delete f.store.getCaldavSession; else delete f.store.completeCaldavDelete;
    assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0); assert.equal(f.calls.length, 0);
  }
});
test("wrong profile or accepted UID cannot acquire OAuth credentials or adopt a newly observed resource", async () => {
  const profile = fixture([]); (profile.claim as { endpointProfile: string }).endpointProfile = "google-personal-event-delete-v1"; assert.equal((await profile.run()).status, "hold"); assert.equal(profile.counts().sessions, 0);
  const uid = fixture([]); (uid.claim as { acceptedUid: string }).acceptedUid = "newly-guessed-uid"; assert.equal((await uid.run()).status, "hold"); assert.equal(uid.counts().sessions, 0);
});
test("410 cannot satisfy DAV absence and rejected429 keeps its bounded retry delay", async () => {
  const gone = fixture([response("", 410)], true); assert.notEqual((await gone.run()).status, "acked"); assert.equal(gone.completions.length, 0);
  const limited = fixture([present(), privilege(), present(), response("", 429, { "retry-after": "9" })]); assert.equal((await limited.run()).status, "hold"); assert.equal(limited.evidence.at(-1)!.provider, "rejected"); assert.equal((limited.finishes.at(-1) as { retryAfterMs: number }).retryAfterMs, 9000);
});
test("earlier uncertain DAV DELETE remains uncertain after a known rejection of its later conditional retry", async () => {
  const f = fixture([present(), privilege(), present(), response("", 429, { "retry-after": "9" })], true);
  assert.equal((await f.run()).status, "hold"); assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.counts().marks, 1); assert.equal(f.completions.length, 0);
});
test("earlier accepted DAV DELETE keeps its actual status when a later conditional retry loses its reply", async () => {
  const f = fixture([present(), privilege(), present(), new Error("Owned retry lost reply"), response("", 404)], true);
  f.claim.receipt.provider = { kind: "accepted" }; (f.claim as { deleteAcceptanceStatus: number }).deleteAcceptanceStatus = 204;
  assert.equal((await f.run()).status, "acked"); assert.equal(f.evidence.at(-1)!.provider, "accepted"); assert.equal(f.evidence.at(-1)!.acceptanceStatus, 204); assert.equal(f.counts().marks, 1);
});
