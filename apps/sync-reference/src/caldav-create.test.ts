import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { matchesPinnedProjectionV1, parseNativeWritePlanV1 } from "@musubi/sync-codec";
import { acceptedCaldavCreateEnvelope, caldavCreateAdmissionFingerprint, caldavDeleteAdmissionFingerprint, referenceCaldavCreateIdentity, initialReceipt, REFERENCE_CALDAV_CREATE_PROFILE } from "./admission.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts, type ReferenceRunnerStore } from "./runner.js";
import type { ReferenceClaim, ReferenceCaldavCreateEvidence } from "./model.js";

const input = { bindingId: "dav-create:binding", expectedRevision: 1, commandId: "dav-create:command", operationId: "ea2b9dba-8e96-42ee-95b6-06c8a9760a8e" };
const content = { name: "Exact CREATE, with; escaped\\text", notes: "Exact note\nčárka", place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" };
const calendarUrl = "https://dav.example.test/calendars/own/", identity = referenceCaldavCreateIdentity(calendarUrl, input.operationId);
const host = { objectId: "dav-create:object", connectionId: "dav-create:connection", calendarUrl, ...identity,
  capture: { acceptedRevision: 2, connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, canonicalGeneration: 1 } };
const envelope = () => acceptedCaldavCreateEnvelope(input, content, host);
const body = () => (envelope().nativePlan.data as { createResource: string }).createResource;
const response = (data: string, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 ? null : data, { status, headers });
const present = (data = body(), etag = '"readback"') => response(data, 200, { etag, "content-type": "text/calendar" });
const privilege = (name = "bind") => response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${calendarUrl}</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:${name}/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 207);
function fixture(replies: (Response | Error)[], recovery = false, prior: "uncertain" | "accepted" | "rejected" = "uncertain") {
  const accepted = envelope();
  const claim: ReferenceClaim = { operationId: input.operationId, attemptId: "dav-create:attempt", payload: { operationEnvelope: accepted }, envelope: accepted,
    binding: { kind: "event", action: "create", operationId: input.operationId, commandId: input.commandId, hostObjectId: host.objectId, provider: "caldav", connectionId: host.connectionId,
      collectionId: calendarUrl, resourceId: identity.resourceUrl, acceptedRevision: 2, sourceEpoch: accepted.sourceEpoch, privacyEpoch: accepted.privacyEpoch },
    capture: host.capture, locator: { connectionId: host.connectionId, calendarId: calendarUrl, eventId: identity.resourceUrl }, etag: null, acceptedUid: identity.uid,
    receipt: initialReceipt(accepted), recovery, endpointProfile: REFERENCE_CALDAV_CREATE_PROFILE, caldavCreateAcceptanceStatus: prior === "accepted" ? 201 : null };
  if (recovery) claim.receipt.provider = prior === "accepted" ? { kind: "accepted", validator: { kind: "etag", value: '"response"' } } : prior === "rejected" ? { kind: "rejected", error: { code: "rate-limited", retry: "after-delay", retryAfterMs: 9000 } } : { kind: "uncertain" };
  const calls: { url: string; init: RequestInit }[] = [], evidence: ReferenceCaldavCreateEvidence[] = [], completions: unknown[] = [], finishes: unknown[] = [];
  let sessions = 0, marks = 0, mismatch = false;
  const store: ReferenceRunnerStore = { async claim() { return claim; }, async renew() { return true; }, async markDispatch() { marks++; return true; },
    async getSession() { assert.fail("DAV cannot use OAuth"); }, async getCaldavSession() { sessions++; return { connectionId: host.connectionId, connectionGeneration: "1", authorization: "Basic c3ludGhldGljOnBhc3N3b3Jk" }; },
    async recordEvidence() { assert.fail("CREATE requires its own evidence port"); }, async recordCaldavCreateEvidence(_claim, facts) { evidence.push(facts); return true; },
    async finish(_claim, status, outcome) { finishes.push({ status, ...outcome }); return true; }, async complete() { assert.fail("Wrong completion"); }, async completeDelete() { assert.fail("Wrong completion"); },
    async completeCaldavCreate(_claim, observation) { completions.push(observation); return true; } };
  const ports: ReferenceRunnerPorts = { http: { async fetch() { assert.fail("DAV cannot use unguarded fetch"); } }, caldav: {
    network: { allowPrivate: false, lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }] }, http: { async fetchPinned(url, init, address) {
      assert.equal(address.address, "93.184.216.34"); calls.push({ url: url.href, init }); const next = replies.shift(); if (!next) { mismatch = true; throw new Error("Unexpected fixture HTTP"); } if (next instanceof Error) throw next; return next;
    } } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} } };
  const run = async () => { const result = await deliverReferenceOperation(store, input.operationId, ports); assert.equal(mismatch, false); assert.equal(replies.length, 0); return result; };
  return { claim, store, ports, calls, evidence, completions, finishes, run, counts: () => ({ sessions, marks }) };
}
test("DAV CREATE pins the real full codec resource, stable URL/UID and distinct action fingerprint", () => {
  const accepted = envelope(), plan = parseNativeWritePlanV1(accepted.serializer, "create", "event", accepted.nativePlan.data);
  assert.equal(plan?.planKind, "caldav-properties"); if (plan?.planKind !== "caldav-properties") assert.fail("Missing plan");
  assert.equal(plan.uid, identity.uid); assert.equal(accepted.locator.resourceId, identity.resourceUrl); assert.match(plan.createResource, /^BEGIN:VCALENDAR\r\n/); assert.match(plan.replacementComponent, /^BEGIN:VEVENT\r\n/);
  assert.equal(matchesPinnedProjectionV1(accepted.serializer, "create", accepted.admittedProjection.data, plan), true); assert.deepEqual(plan.properties, []);
  assert.notEqual(caldavCreateAdmissionFingerprint(input), caldavDeleteAdmissionFingerprint(input));
  assert.deepEqual(referenceCaldavCreateIdentity(calendarUrl, input.operationId), identity);
});
test("reference identity and original projection cannot silently change or lose codec precision", () => {
  for (const operationId of ["opaque", input.operationId.toUpperCase()]) assert.throws(() => referenceCaldavCreateIdentity(calendarUrl, operationId));
  for (const patch of [{ beginsAt: "2026-10-25T08:00:00.001Z" }, { notes: "" }, { place: "" }]) assert.throws(() => acceptedCaldavCreateEnvelope(input, { ...content, ...patch }, host), /wire precision/);
  for (const patch of [{ uid: "other" }, { resourceUrl: calendarUrl + "other.ics" }]) assert.throws(() => acceptedCaldavCreateEnvelope(input, content, { ...host, ...patch }), /identity/);
  for (const target of ["http://dav.example.test/own/", "https://user:secret@dav.example.test/own/", "https://dav.example.test/own/?q=1", "https://dav.example.test/own/../alias/"]) assert.throws(() => referenceCaldavCreateIdentity(target, input.operationId));
});
test("fresh reference CREATE uses bind ACL, exact full ICS conditional PUT and strong readback", async () => {
  const f = fixture([privilege(), response("", 201, { etag: '"accepted"' }), present()]); assert.equal((await f.run()).status, "acked");
  assert.deepEqual(f.calls.map(c => c.init.method ?? "GET"), ["PROPFIND", "PUT", "GET"]); const put = f.calls[1]!;
  assert.equal(put.url, identity.resourceUrl); assert.equal(put.init.body, body()); assert.equal(new Headers(put.init.headers).get("if-none-match"), "*"); assert.equal(new Headers(put.init.headers).get("if-match"), null);
  assert.equal(f.counts().marks, 1); assert.equal(f.completions.length, 1); assert.equal(f.evidence.at(-1)!.createAcceptanceStatus, 201);
});
test("accepted missing response ETag can complete only through strong actual GET readback", async () => {
  const f = fixture([privilege(), response("", 204), present()]); assert.equal((await f.run()).status, "acked"); assert.equal(f.evidence.find(e => e.provider === "accepted")!.validator, undefined); assert.equal(f.evidence.at(-1)!.createAcceptanceStatus, 204);
});
test("restart matching readback preserves uncertain or accepted native evidence with no second PUT", async () => {
  for (const prior of ["uncertain", "accepted"] as const) { const f = fixture([present()], true, prior); assert.equal((await f.run()).status, "acked"); assert.equal(f.counts().marks, 0); assert.equal(f.evidence.at(-1)!.provider, prior); }
});
test("restart exact404 can retry same URL/UID/body, including previous native acceptance", async () => {
  for (const prior of ["uncertain", "accepted", "rejected"] as const) { const f = fixture([response("", 404), privilege(), response("", 200), present()], true, prior); assert.equal((await f.run()).status, "acked"); assert.equal(f.counts().marks, 1); assert.equal(f.calls[2]!.init.body, body()); }
});
test("prior rejected matching resource stays held without adoption or invented acceptance", async () => {
  const f = fixture([present()], true, "rejected"); assert.equal((await f.run()).status, "hold"); assert.equal(f.completions.length, 0); assert.equal(f.counts().marks, 0); assert.equal(f.evidence.at(-1)!.provider, "rejected");
});
test("lost PUT reply can readback exact owned resource without duplicate mutation", async () => {
  const f = fixture([privilege(), new Error("Owned lost reply"), present()]); assert.equal((await f.run()).status, "acked"); assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.counts().marks, 1);
});
test("known412 is terminal conflict without same-attempt readback/adoption", async () => {
  const f = fixture([privilege(), response("", 412)]); assert.equal((await f.run()).status, "conflict"); assert.equal(f.completions.length, 0); assert.deepEqual(f.calls.map(c => c.init.method ?? "GET"), ["PROPFIND", "PUT"]);
});
test("readback404 does not perform a second PUT in one bounded attempt", async () => {
  const f = fixture([privilege(), response("", 201), response("", 404)]); assert.equal((await f.run()).status, "conflict"); assert.equal(f.counts().marks, 1); assert.equal(f.completions.length, 0);
});
test("wrong UID/content, nested event, organizer, cancelled and weak readback never ACK", async () => {
  const variants = [body().replace(identity.uid, "other-uid"), body().replace("SUMMARY:", "SUMMARY:Foreign "), body().replace("END:VEVENT", "BEGIN:VEVENT\r\nUID:nested\r\nDTSTART:20261025T080000Z\r\nDTEND:20261025T090000Z\r\nEND:VEVENT\r\nEND:VEVENT"), body().replace("END:VEVENT", "ORGANIZER:mailto:unknown@example.test\r\nEND:VEVENT"), body().replace("END:VEVENT", "STATUS:CANCELLED\r\nEND:VEVENT")];
  for (const data of variants) { const f = fixture([present(data)], true); assert.notEqual((await f.run()).status, "acked"); assert.equal(f.completions.length, 0); assert.equal(f.counts().marks, 0); }
  const weak = fixture([present(body(), 'W/"weak"')], true); assert.notEqual((await weak.run()).status, "acked"); assert.equal(weak.completions.length, 0);
});
test("missing transport/session/evidence/completion capabilities hold before Basic or HTTP", async () => {
  for (const missing of ["transport", "session", "evidence", "completion"]) { const f = fixture([]); if (missing === "transport") delete f.ports.caldav; else if (missing === "session") delete f.store.getCaldavSession; else if (missing === "evidence") delete f.store.recordCaldavCreateEvidence; else delete f.store.completeCaldavCreate; assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0); }
});
test("wrong explicit profile/UID and lost acceptance metadata cannot open credentials", async () => {
  for (const kind of ["profile", "uid", "history"]) { const f = fixture([], kind === "history", "accepted"); if (kind === "profile") (f.claim as { endpointProfile: string }).endpointProfile = "caldav-personal-event-delete-v1"; else if (kind === "uid") (f.claim as { acceptedUid: string }).acceptedUid = "other-uid"; else (f.claim as { caldavCreateAcceptanceStatus: null }).caldavCreateAcceptanceStatus = null; assert.equal((await f.run()).status, "hold"); assert.equal(f.counts().sessions, 0); }
});

test("older uncertain PUT remains uncertain after a later conditional retry receives known429", async () => {
  const f = fixture([response("", 404), privilege(), response("", 429, { "retry-after": "9" })], true); assert.equal((await f.run()).status, "hold"); assert.equal(f.evidence.at(-1)!.provider, "uncertain"); assert.equal(f.completions.length, 0); assert.equal(f.counts().marks, 1); assert.equal((f.finishes.at(-1) as { retryAfterMs: number }).retryAfterMs, 9000);
});

test("ambient alias to the global UTC singleton cannot substitute for a resource-owned VTIMEZONE", async () => {
  const providerRequire = createRequire(createRequire(import.meta.url).resolve("@musubi/provider-caldav"));
  // The require branch has a separate timezone registry. Load the exact ESM
    // export used by the provider, rather than polluting an unrelated instance.
    const manifestURL = new URL("../package.json", pathToFileURL(providerRequire.resolve("ical.js")));
    const manifest = JSON.parse(await readFile(manifestURL, "utf8"));
    const ical = (await import(new URL(manifest.exports.import, manifestURL).href)).default;
  ical.TimezoneService.register("Ambient/UTC", ical.Timezone.utcTimezone);
  try {
    const data = body().replace("DTSTART:20261025T080000Z", "DTSTART;TZID=Ambient/UTC:20261025T080000").replace("DTEND:20261025T090000Z", "DTEND;TZID=Ambient/UTC:20261025T090000");
    const f = fixture([present(data)], true); assert.notEqual((await f.run()).status, "acked"); assert.equal(f.completions.length, 0); assert.equal(f.counts().marks, 0);
  } finally { ical.TimezoneService.remove("Ambient/UTC"); }
});
