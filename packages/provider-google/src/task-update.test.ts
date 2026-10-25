import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleTaskUpdateProvider, GoogleTaskProviderError, parseGoogleTaskProjection, parseGoogleTaskPatch,
  googleTaskProjectionFromNative, diffGoogleTaskProjection, sameGoogleTaskProjection, achievesGoogleTaskPatch,
  isStrictGoogleNativeTask,
  type GoogleTaskProviderPorts, type GoogleTaskRequestMetric, type GoogleTaskUpdate, type GoogleNativeTask } from "./index";

const target = { connectionId: "account/private", connectionGeneration: "12", taskListId: "list/a?b#c", taskId: "task/a?b#c" };
const url = "https://tasks.googleapis.com/tasks/v1/lists/list%2Fa%3Fb%23c/tasks/task%2Fa%3Fb%23c";
const accepted: GoogleTaskUpdate = { target, acceptedEtag: '"accepted"', body: { title: "Admitted", notes: null }, operationId: "operation:one", attemptId: "attempt:two", serializer: { id: "google-task", version: 1 } };
const native = { id: target.taskId, title: "Before", notes: "Notes", status: "needsAction", due: "2026-10-20T00:00:00.000Z", etag: '"accepted"' };
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
function fixture(queue: (Response | Error)[], override: Partial<GoogleTaskProviderPorts> = {}, strict = false) {
  const calls: { url: string; init: RequestInit }[] = [], metrics: GoogleTaskRequestMetric[] = [], acceptedStatuses: number[] = [];
  let sessions = 0, marks = 0, now = 0;
  const ports: GoogleTaskProviderPorts = { accountSession: { async open(connection) { sessions++; return { ...connection, accessToken: "private-token", taskWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = queue.shift(); assert(next, "Unexpected fixture HTTP"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => Date.parse("2026-10-25T12:00:00.000Z"), nowMonotonicMs: () => now += 7 },
    telemetry: { record(metric) { metrics.push(metric); } }, beforeMutation: async () => { marks++; },
    onAcceptedResponse: async receipt => { acceptedStatuses.push(receipt.status); assert.equal(receipt.validator, null); }, ...override };
  return { provider: createGoogleTaskUpdateProvider(ports, { nativeProfile: strict ? "strict-reference" : "existing-google" }), calls, metrics, acceptedStatuses,
    sessions: () => sessions, marks: () => marks, remaining: () => queue.length };
}
const error = (code: string, outcome?: string, status?: number) => (value: unknown) => value instanceof GoogleTaskProviderError && value.code === code &&
  (outcome === undefined || value.outcome === outcome) && (status === undefined || value.providerStatus === status);

test("Google task native update re-reads exact ID and PATCHes only frozen fields with original tag", async () => {
  const f = fixture([response(native), response({ id: "ignored-legacy-return-id", etag: '"written"' }, 201)]);
  assert.deepEqual(await f.provider.update(accepted), { kind: "written", etag: '"written"' });
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "PATCH"]);
  assert(f.calls.every(call => call.url === url)); assert.equal(f.calls[0]!.init.redirect, "error"); assert.equal(f.calls[1]!.init.redirect, undefined);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("Cache-Control"), "no-cache");
  assert.equal(new Headers(f.calls[1]!.init.headers).get("If-Match"), '"accepted"'); assert.equal(f.calls[1]!.init.body, '{"title":"Admitted","notes":null}');
  assert.equal(f.sessions(), 1); assert.equal(f.marks(), 1); assert.deepEqual(f.acceptedStatuses, [201]);
});
test("Google task empty native body preserves its preflight GET but never fences or PATCHes", async () => {
  const f = fixture([response(native)]);
  assert.deepEqual(await f.provider.update({ ...accepted, body: {} }), { kind: "not-written", reason: "empty-body" });
  assert.equal(f.sessions(), 1); assert.deepEqual(f.calls.map(call => call.init.method), ["GET"]); assert.equal(f.marks(), 0); assert.deepEqual(f.acceptedStatuses, []);
});
test("Google task strict own-field snapshots reject getters and unsupported input before sessions", async () => {
  const bad: unknown[] = [{ ...accepted, body: { attendees: [] } }, { ...accepted, body: { title: null } }, { ...accepted, body: { notes: undefined } },
    { ...accepted, body: { due: "2026-02-30T00:00:00.000Z" } }, { ...accepted, serializer: { id: "future", version: 1 } }, { ...accepted, injected: true },
    { ...accepted, target: { ...target, injected: true } }, { ...accepted, target: { ...target, taskId: String.fromCharCode(0xd800) } }];
  let evaluated = false;
  bad.push({ ...accepted, body: Object.defineProperty({}, "title", { enumerable: true, get() { evaluated = true; return "Bad"; } }) });
  for (const input of bad) { const f = fixture([]); await assert.rejects(f.provider.update(input as GoogleTaskUpdate), error("task-projection-unavailable")); assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); }
  assert.equal(evaluated, false);
  for (const etag of [null, "", 'W/"weak"', "unquoted"]) { const f = fixture([]); await assert.rejects(f.provider.update({ ...accepted, acceptedEtag: etag } as GoogleTaskUpdate), error("task-version-unavailable")); assert.equal(f.sessions(), 0); }
});
test("Google task suspended credentials cannot replace captured body, address or serializer", async () => {
  const mutable = { ...accepted, target: { ...target }, body: { title: "Captured" }, serializer: { ...accepted.serializer } };
  const f = fixture([response(native), response({ etag: '"written"' })], { accountSession: { async open(connection) {
    mutable.target.taskId = "other"; mutable.body.title = "Changed"; mutable.serializer.version = 1;
    return { ...connection, accessToken: "token", taskWriteAllowed: true };
  } }, beforeMutation: async request => { assert(Object.isFrozen(request)); assert(Object.isFrozen(request.target)); assert(Object.isFrozen(request.body)); assert(Object.isFrozen(request.serializer)); } });
  await f.provider.update(mutable); assert.equal(f.calls[1]!.url, url); assert.equal(f.calls[1]!.init.body, '{"title":"Captured"}');
});
test("Google task current Tasks grant and captured physical generation are mandatory", async () => {
  for (const change of [{ connectionGeneration: "13" }, { connectionId: "other" }]) {
    const f = fixture([], { accountSession: { async open(connection) { return { ...connection, ...change, accessToken: "token", taskWriteAllowed: true }; } } });
    await assert.rejects(f.provider.readForUpdate(target), error("account-session-changed")); assert.equal(f.calls.length, 0);
  }
  for (const taskWriteAllowed of [false, undefined]) {
    const f = fixture([], { accountSession: { async open(connection) { return { ...connection, accessToken: "token", taskWriteAllowed, eventWriteAllowed: true }; } } });
    await assert.rejects(f.provider.preflightUpdate(accepted), error("task-scope-missing")); assert.equal(f.calls.length, 0);
  }
  const raw = new Error("Host Tasks grant missing");
  const f = fixture([], { accountSession: { async open() { throw raw; } } }); await assert.rejects(f.provider.readForUpdate(target), value => value === raw);
});
test("Google task delivery GET401 retries only its concrete read and preserves refreshed identity/grant", async () => {
  let recovery = 0;
  const f = fixture([response({}, 401), response(native)], { accountSession: { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection, rejected) { recovery++; assert.equal(rejected, "old"); return { ...connection, accessToken: "fresh", taskWriteAllowed: true }; } } });
  assert.equal((await f.provider.readForUpdate(target)).kind, "present"); assert.equal(recovery, 1);
  assert.deepEqual(f.calls.map(call => new Headers(call.init.headers).get("Authorization")), ["Bearer old", "Bearer fresh"]);
  assert.deepEqual(f.metrics.map(metric => metric.status), [401, 200]);
  const changed = fixture([response({}, 401)], { accountSession: { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { return { ...connection, connectionGeneration: "13", accessToken: "fresh", taskWriteAllowed: true }; } } });
  await assert.rejects(changed.provider.readForUpdate(target), error("account-session-changed")); assert.equal(changed.calls.length, 1);
});
test("Google task second delivery401 cancels bodies and preserves raw host auth rejection with no hint", async () => {
  const first = response({}, 401), second = response({}, 401, { "retry-after": "70" }), raw = new Error("Host resource_401"); let rejected = 0;
  const f = fixture([first, second], { accountSession: { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { return { ...connection, accessToken: "fresh", taskWriteAllowed: true }; }, async onReadAuthenticationRejected() { rejected++; throw raw; } } });
  await assert.rejects(f.provider.readForUpdate(target), value => value === raw); assert.equal(rejected, 1); assert.equal(first.bodyUsed, true); assert.equal(second.bodyUsed, true); assert.equal(f.calls.length, 2);
});
test("Google task writer finalGET401 and PATCH401 never trigger authentication replay", async () => {
  for (const queue of [[response({}, 401)], [response(native), response({}, 401)]] ) {
    let recovery = 0;
    const f = fixture(queue, { accountSession: { async open(connection) { return { ...connection, accessToken: "token", taskWriteAllowed: true }; },
      async recoverRejectedRead(connection) { recovery++; return { ...connection, accessToken: "new", taskWriteAllowed: true }; } } });
    await assert.rejects(f.provider.update(accepted), error("task-write-failed", "not-written", 401)); assert.equal(recovery, 0); assert(f.calls.length <= 2); assert.deepEqual(f.acceptedStatuses, []);
  }
});
test("Google task absent, assigned, mismatched or newer native copies cannot authorize PATCH", async () => {
  for (const [reply, code] of [[response(null, 404), "task-provider-conflict"], [response(null, 410), "task-provider-conflict"],
    [response({ ...native, id: "other" }), "task-projection-unavailable"], [response({ ...native, etag: '"newer"' }), "task-provider-conflict"],
    [response({ ...native, assignmentInfo: { surfaceType: "DOCUMENT" } }), "task-source-read-only"], [response({ ...native, etag: 'W/"weak"' }), "task-version-unavailable"]] as const) {
    const f = fixture([reply]); await assert.rejects(f.provider.update(accepted), error(code)); assert.equal(f.calls.length, 1); assert.equal(f.marks(), 0);
  }
  for (const status of [404, 410]) assert.deepEqual(await fixture([response(null, status)]).provider.readForUpdate(target), { kind: "absent", status });
});
test("Google task existing read retains any-ok and permissive notes/due parsing floors", async () => {
  for (const status of [200, 201, 206]) {
    const raw = { ...native, notes: { retained: 42 }, due: 12345, assignmentInfo: false };
    const f = fixture([response(raw, status, { "content-range": "items 0-0/2" })]); const read = await f.provider.readForUpdate(target);
    assert.equal(read.kind, "present"); if (read.kind === "present") assert.deepEqual(googleTaskProjectionFromNative(read.task), { title: "Before", notes: { retained: 42 }, status: "needsAction", due: "12345T00:00:00.000Z" });
  }
  await assert.rejects(fixture([new Response("null")]).provider.readForUpdate(target), TypeError);
  await assert.rejects(fixture([new Response("{")]).provider.readForUpdate(target), SyntaxError);
});
test("Google task strict reference rejects incomplete/redirected/malformed native read evidence", async () => {
  const redirected = response(native); Object.defineProperty(redirected, "redirected", { value: true });
  const wrongUrl = response(native); Object.defineProperty(wrongUrl, "url", { value: "https://example.invalid/other" });
  for (const reply of [response(native, 206), response(native, 200, { "content-range": "items 0-0/2" }), redirected, wrongUrl,
    response({ ...native, notes: 42 }), response({ ...native, due: 12345 }), response({ ...native, due: "2026-02-30T00:00:00.000Z" })]) {
    await assert.rejects(fixture([reply], {}, true).provider.readForUpdate(target), value => value instanceof GoogleTaskProviderError);
  }
});
test("Google task accepted response callback precedes JSON and survives malformed/missing/weak tag", async () => {
  for (const reply of [new Response("{"), response({}), response({ etag: 'W/"weak"' }), response(null, 204)]) {
    const order: string[] = [], original = reply.json.bind(reply); reply.json = async () => { order.push("json"); return original(); };
    const f = fixture([response(native), reply], { onAcceptedResponse: async receipt => { order.push("accepted"); assert([200, 201, 204].includes(receipt.status)); } });
    await assert.rejects(f.provider.update(accepted)); assert.deepEqual(order, ["accepted", "json"]);
  }
  const raw = new Error("Host evidence unavailable"), reply = response({ etag: '"written"' }); let json = 0; reply.json = async () => { json++; return {}; };
  const f = fixture([response(native), reply], { onAcceptedResponse: async () => { throw raw; } });
  await assert.rejects(f.provider.update(accepted), value => value === raw); assert.equal(json, 0);
});
test("Google task known mutation refusals preserve Retry-After and never imply acceptance/retry", async () => {
  for (const [status, code, outcome] of [[412, "task-provider-conflict", "not-written"], [408, "task-write-failed", "not-written"],
    [429, "task-write-failed", "not-written"], [500, "task-write-failed", "unconfirmed"], [206, "task-write-failed", "unconfirmed"]] as const) {
    const f = fixture([response(native), response({}, status, { "retry-after": "17" })]);
    await assert.rejects(f.provider.update(accepted), value => error(code, outcome, status)(value) && (value as GoogleTaskProviderError).retryAfterMs === 17_000);
    assert.equal(f.calls.length, 2); assert.deepEqual(f.acceptedStatuses, []);
  }
});
test("Google task raw HTTP failures and bounded telemetry never leak identities or alter acceptance", async () => {
  const raw = new TypeError("secret transport detail"); const f = fixture([response(native), raw]);
  await assert.rejects(f.provider.update(accepted), value => value === raw); assert.deepEqual(f.metrics.map(metric => metric.status), [200, "network-error"]);
  assert(!JSON.stringify(f.metrics).includes(target.taskListId)); assert(!JSON.stringify(f.metrics).includes("private-token"));
  const diagnostic = fixture([response(native), response({ etag: '"written"' })], { telemetry: { record() { throw new Error("Diagnostic failure"); } } });
  assert.equal((await diagnostic.provider.update(accepted)).kind, "written");
});
test("Google task signal abort before credentials or after fence never dispatches a PATCH", async () => {
  const controller = new AbortController(), reason = new Error("Deadline"); controller.abort(reason); const f = fixture([]);
  await assert.rejects(f.provider.update(accepted, controller.signal), value => value === reason); assert.equal(f.sessions(), 0);
  const after = new AbortController(); const second = fixture([response(native)], { beforeMutation: async () => { after.abort(reason); } });
  await assert.rejects(second.provider.update(accepted, after.signal), value => value === reason); assert.deepEqual(second.calls.map(call => call.init.method), ["GET"]);
});
test("Google task pure helpers retain four-field loss-aware values and refuse executable patches", () => {
  const target = parseGoogleTaskProjection({ title: "Target", notes: null, status: "completed", due: "2024-02-29T00:00:00.000Z" }); assert(target);
  const baseline = { ...target, title: "Before" }; assert.deepEqual(diffGoogleTaskProjection(baseline, target), { title: "Target" });
  assert(achievesGoogleTaskPatch({ ...target, notes: "Untouched concurrent" }, { title: "Target" })); assert(!sameGoogleTaskProjection({ ...target, notes: "Untouched concurrent" }, target));
  assert.equal(parseGoogleTaskProjection({ ...target, due: "2025-02-29T00:00:00.000Z" }), null); assert.equal(parseGoogleTaskPatch({ notes: undefined }), null);
  let evaluated = false; assert.equal(parseGoogleTaskPatch(Object.defineProperty({}, "title", { enumerable: true, get() { evaluated = true; return "Bad"; } })), null); assert.equal(evaluated, false);
  const observed = googleTaskProjectionFromNative({ id: "id", title: "x", status: "needsAction", etag: '"e"', due: "2026-10-20T17:00:00Z" } as GoogleNativeTask); assert.equal(observed.due, "2026-10-20T00:00:00.000Z");
});

test("Google task strict reference refuses deleted native tasks while existing host flag floors remain unchanged", async () => {
  for (const deleted of [true, "malformed", null]) {
    const f = fixture([response({ ...native, deleted })], {}, true);
    await assert.rejects(f.provider.preflightUpdate(accepted), error(deleted === true ? "task-provider-conflict" : "task-projection-unavailable"));
    assert.equal(f.calls.length, 1); assert.equal(f.marks(), 0);
  }
  assert.equal((await fixture([response({ ...native, deleted: true, hidden: true })]).provider.readForUpdate(target)).kind, "present");
  assert.equal((await fixture([response({ ...native, deleted: false, hidden: true })], {}, true).provider.readForUpdate(target)).kind, "present");
});

test("Google task strict native-body proof is shared, descriptor-safe and binds raw identity/version", async () => {
  assert(isStrictGoogleNativeTask({ ...native, hidden: true, deleted: false }, target.taskId, native.etag));
  const invalid = [{ ...native, id: "other" }, { ...native, etag: '"other"' }, { ...native, assignmentInfo: { surfaceType: "SPACE" } },
    { ...native, deleted: true }, { ...native, notes: 42 }, { ...native, due: "2026-10-20garbage" }, { ...native, due: "2026-10-20T24:00:00Z" }];
  for (const task of invalid) assert.equal(isStrictGoogleNativeTask(task, target.taskId, native.etag), false);
  let evaluated = false;
  const deep = { ...native, links: [Object.defineProperty({}, "link", { enumerable: true, get() { evaluated = true; return "unsafe"; } })] };
  assert.equal(isStrictGoogleNativeTask(deep, target.taskId, native.etag), false); assert.equal(evaluated, false);
  const reply = response({}); reply.json = async () => deep;
  await assert.rejects(fixture([reply], {}, true).provider.readForUpdate(target), error("task-projection-unavailable")); assert.equal(evaluated, false);
});
