import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleTaskDeleteProvider, GoogleTaskProviderError, isGoogleTaskDeleteAcceptedStatus,
  type GoogleTaskDelete, type GoogleTaskDeleteProviderPorts, type GoogleTaskDeleteRequestMetric, type GoogleNativeTaskDeleteResponse } from "./index";

const target = { connectionId: "private-account", connectionGeneration: "7", taskListId: "list/a?b#c", taskId: "task/a?b#c" };
const input: GoogleTaskDelete = { target, acceptedEtag: '"accepted"', operationId: "operation:one", attemptId: "attempt:two", serializer: { id: "google-task", version: 1 } };
const native = { id: target.taskId, title: "Task", notes: null, status: "needsAction", due: null, etag: '"accepted"' };
const url = "https://tasks.googleapis.com/tasks/v1/lists/list%2Fa%3Fb%23c/tasks/task%2Fa%3Fb%23c";
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(body === null && [204, 205, 304].includes(status) ? null : JSON.stringify(body), { status, headers });
function fixture(queue: (Response | Error)[], override: Partial<GoogleTaskDeleteProviderPorts> = {}, strict = false) {
  const calls: { url: string; init: RequestInit }[] = [], metrics: GoogleTaskDeleteRequestMetric[] = [], receipts: GoogleNativeTaskDeleteResponse[] = [], fences: GoogleTaskDelete[] = [];
  let sessions = 0, tick = 0;
  const ports: GoogleTaskDeleteProviderPorts = { accountSession: { async open(connection) { sessions++; return { ...connection, accessToken: "private-token", taskWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = queue.shift(); assert(next, "Unexpected native fixture call"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => Date.parse("2026-10-26T00:00:00Z"), nowMonotonicMs: () => tick += 7 },
    telemetry: { record(metric) { metrics.push(metric); } }, beforeMutation: async request => { fences.push(request); }, onDeleteResponse: async receipt => { receipts.push(receipt); }, ...override };
  return { ports, provider: createGoogleTaskDeleteProvider(ports, { nativeProfile: strict ? "strict-reference" : "existing-google" }), calls, metrics, receipts, fences, sessions: () => sessions };
}
const error = (code: string, outcome?: string, status?: number) => (value: unknown) => value instanceof GoogleTaskProviderError && value.code === code && (outcome === undefined || value.outcome === outcome) && (status === undefined || value.providerStatus === status);

test("Task DELETE reuses the writer session, exact fresh GET and original conditional no-body request", async () => {
  const f = fixture([response(native), response(null, 204)]);
  assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status: 204 });
  assert.equal(f.sessions(), 1); assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "DELETE"]); assert(f.calls.every(call => call.url === url));
  assert.equal(f.calls[0]!.init.redirect, "error"); assert.equal(f.calls[1]!.init.redirect, undefined); assert.equal(f.calls[1]!.init.body, undefined);
  assert.equal(new Headers(f.calls[1]!.init.headers).get("Content-Type"), null); assert.equal(new Headers(f.calls[1]!.init.headers).get("If-Match"), '"accepted"');
  assert.deepEqual(f.receipts, [{ kind: "accepted", status: 204, validator: null }]); assert.equal(f.fences.length, 1);
});
test("Task DELETE preserves all native 2xx statuses without parsing body or widening UPDATE", async () => {
  for (let status = 200; status <= 299; status++) {
    assert(isGoogleTaskDeleteAcceptedStatus(status)); const reply = new Response(null, { status }); let parsed = false;
    reply.json = async () => { parsed = true; throw new Error("DELETE body must not be parsed"); };
    const f = fixture([response(native), reply]); assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status });
    assert.deepEqual(f.receipts, [{ kind: "accepted", status, validator: null }]); assert.equal(parsed, false); assert.equal(f.calls.length, 2);
  }
  for (const status of [199, 300, 404, 410, 200.5, Infinity, NaN, "204"]) assert.equal(isGoogleTaskDeleteAcceptedStatus(status), false);
});
test("Task DELETE404/410 response fulfillment is distinct from accepted HTTP and pre-dispatch GET absence", async () => {
  for (const status of [404, 410] as const) {
    const f = fixture([response(native), new Response("not JSON", { status })]);
    assert.deepEqual(await f.provider.delete(input), { kind: "absent", status, source: "delete-response" });
    assert.deepEqual(f.receipts, [{ kind: "absent", status }]); assert.equal(f.fences.length, 1);
    const absent = fixture([new Response("not JSON", { status })]);
    assert.deepEqual(await absent.provider.delete(input), { kind: "absent", status, source: "writer-read" });
    assert.equal(absent.calls.length, 1); assert.equal(absent.fences.length, 0); assert.deepEqual(absent.receipts, []);
  }
});
test("Task DELETE permission-read absence does not hide the writer's fresh read/reappearance", async () => {
  const f = fixture([response(null, 404), response(native), response(null, 204)]);
  assert.deepEqual(await f.provider.preflightDelete(input), { kind: "absent", status: 404 });
  assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status: 204 });
  assert.deepEqual(f.calls.map(call => call.init.method), ["GET", "GET", "DELETE"]); assert.equal(f.sessions(), 2); assert.equal(f.receipts.length, 1);
});
test("Task DELETE initial absence needs only scoped address and no accepted tag or parsed body", async () => {
  for (const status of [404, 410] as const) assert.deepEqual(await fixture([new Response("{", { status })]).provider.readForDelete(target), { kind: "absent", status });
});
test("Task DELETE strict absence validates URL, redirect and partial metadata before404/410", async () => {
  for (const status of [404, 410]) for (const change of ["url", "redirect", "partial"]) {
    const reply = response(null, status, change === "partial" ? { "content-range": "bytes 0-1/2" } : undefined);
    if (change === "url") Object.defineProperty(reply, "url", { value: "https://example.invalid/other" });
    if (change === "redirect") Object.defineProperty(reply, "redirected", { value: true });
    const strict = fixture([reply], {}, true); await assert.rejects(strict.provider.readForDelete(target), error("task-write-failed", "not-written", status)); assert.equal(strict.fences.length, 0);
    const legacyReply = response(null, status, change === "partial" ? { "content-range": "bytes 0-1/2" } : undefined);
    if (change === "url") Object.defineProperty(legacyReply, "url", { value: "https://example.invalid/other" });
    if (change === "redirect") Object.defineProperty(legacyReply, "redirected", { value: true });
    assert.deepEqual(await fixture([legacyReply]).provider.readForDelete(target), { kind: "absent", status });
  }
});
test("Task DELETE snapshot rejects getters, body escapes, bad IDs and unsupported tags before credentials", async () => {
  const bad: unknown[] = [{ ...input, body: null }, { ...input, serializer: { id: "future", version: 1 } }, { ...input, target: { ...target, taskId: String.fromCharCode(0xd800) } }];
  let evaluated = false; bad.push(Object.defineProperty({ ...input }, "acceptedEtag", { enumerable: true, get() { evaluated = true; return '"bad"'; } }));
  for (const value of bad) { const f = fixture([]); await assert.rejects(f.provider.delete(value as GoogleTaskDelete), error("task-projection-unavailable")); assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); }
  assert.equal(evaluated, false);
  for (const acceptedEtag of [null, "", 'W/"weak"', "unquoted"]) { const f = fixture([]); await assert.rejects(f.provider.delete({ ...input, acceptedEtag } as GoogleTaskDelete), error("task-version-unavailable")); assert.equal(f.sessions(), 0); }
});
test("Task DELETE captures all mutation values before suspended credentials", async () => {
  const mutable = { ...input, target: { ...target } };
  const f = fixture([response(native), response(null, 204)], { accountSession: { async open(connection) { mutable.target.taskId = "changed"; mutable.acceptedEtag = '"changed"'; return { ...connection, accessToken: "token", taskWriteAllowed: true }; } } });
  await f.provider.delete(mutable); assert.equal(f.calls[1]!.url, url); assert.equal(new Headers(f.calls[1]!.init.headers).get("If-Match"), '"accepted"');
  assert(Object.isFrozen(f.fences[0])); assert(Object.isFrozen(f.fences[0]!.target)); assert(Object.isFrozen(f.fences[0]!.serializer));
});
test("Task DELETE enforces current Tasks grant and physical generation before any HTTP", async () => {
  for (const changed of [{ taskWriteAllowed: false }, { taskWriteAllowed: undefined }, { connectionGeneration: "8" }, { connectionId: "other" }]) {
    const f = fixture([], { accountSession: { async open(connection) { return { ...connection, accessToken: "token", taskWriteAllowed: true, eventWriteAllowed: true, ...changed }; } } });
    await assert.rejects(f.provider.delete(input), value => value instanceof GoogleTaskProviderError); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
  }
  const raw = new Error("Host scope failure"); await assert.rejects(fixture([], { accountSession: { async open() { throw raw; } } }).provider.readForDelete(target), value => value === raw);
});
test("Task DELETE refuses assigned Docs/Chat and missing, weak, changed current versions", async () => {
  for (const [changed, code] of [[{ assignmentInfo: { surfaceType: "DOCUMENT" } }, "task-source-read-only"], [{ assignmentInfo: { surfaceType: "SPACE" } }, "task-source-read-only"],
    [{ etag: null }, "task-version-unavailable"], [{ etag: 'W/"weak"' }, "task-version-unavailable"], [{ etag: '"newer"' }, "task-provider-conflict"]] as const) {
    const f = fixture([response({ ...native, ...changed })]); await assert.rejects(f.provider.delete(input), error(code)); assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
  const strict = fixture([response({ ...native, deleted: true })], {}, true); await assert.rejects(strict.provider.delete(input), error("task-provider-conflict"));
});
test("Task DELETE delivery reads recover401 once while final writer GET and DELETE never replay", async () => {
  let recovered = 0;
  const accountSession: GoogleTaskDeleteProviderPorts["accountSession"] = { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { recovered++; return { ...connection, accessToken: "new", taskWriteAllowed: true }; } };
  const read = fixture([response({}, 401), response(native)], { accountSession }); assert.equal((await read.provider.readForDelete(target)).kind, "present"); assert.equal(recovered, 1);
  for (const queue of [[response({}, 401)], [response(native), response({}, 401)]]) {
    recovered = 0; const f = fixture(queue, { accountSession }); await assert.rejects(f.provider.delete(input), error("task-write-failed", "not-written", 401)); assert.equal(recovered, 0); assert(f.calls.length <= 2); assert.deepEqual(f.receipts, []);
  }
});
test("Task DELETE second delivery401 retains raw host auth error without an invented hint", async () => {
  const raw = new Error("Host resource_401"), first = response({}, 401), second = response({}, 401, { "retry-after": "99" });
  const f = fixture([first, second], { accountSession: { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { return { ...connection, accessToken: "new", taskWriteAllowed: true }; }, async onReadAuthenticationRejected() { throw raw; } } });
  await assert.rejects(f.provider.preflightDelete(input), value => value === raw); assert(first.bodyUsed && second.bodyUsed); assert.equal(f.calls.length, 2);
});
test("Task DELETE preserves known refusals and throttle hints separately from any prior response", async () => {
  for (const status of [302, 308, 400, 401, 403, 408, 412, 429, 500]) {
    const f = fixture([response(native), response({}, status, { "retry-after": "17" })]);
    await assert.rejects(f.provider.delete(input), value => value instanceof GoogleTaskProviderError && value.providerStatus === status && value.retryAfterMs === 17_000 && value.outcome === (status >= 500 ? "unconfirmed" : "not-written"));
    assert.deepEqual(f.receipts, []); assert.equal(f.calls.length, 2);
  }
});
test("Task DELETE raw transport failures, callbacks and diagnostics cannot cause hidden observation/retry", async () => {
  const raw = new TypeError("Private transport detail"), f = fixture([response(native), raw]); await assert.rejects(f.provider.delete(input), value => value === raw);
  assert.deepEqual(f.metrics.map(metric => metric.status), [200, "network-error"]); assert(!JSON.stringify(f.metrics).includes("private-token")); assert(!JSON.stringify(f.metrics).includes(target.taskId));
  const accepted: GoogleNativeTaskDeleteResponse[] = [], failure = new Error("Evidence persistence failed");
  const interrupted = fixture([response(native), response(null, 204)], { onDeleteResponse: async receipt => { accepted.push(receipt); throw failure; } });
  await assert.rejects(interrupted.provider.delete(input), value => value === failure); assert.deepEqual(accepted, [{ kind: "accepted", status: 204, validator: null }]); assert.equal(interrupted.calls.length, 2);
  const diagnostic = fixture([response(native), response(null, 204)], { telemetry: { record() { throw new Error("Diagnostics"); } } }); assert.equal((await diagnostic.provider.delete(input)).kind, "deleted");
});
test("Task DELETE strict reference keeps any2xx receipt but refuses changed response scope", async () => {
  const accepted = fixture([response(native), response(null, 202)], {}, true); assert.deepEqual(await accepted.provider.delete(input), { kind: "deleted", status: 202 }); assert.equal(accepted.calls[1]!.init.redirect, "error");
  const reply = response(null, 206); Object.defineProperty(reply, "url", { value: "https://example.invalid/other" });
  const f = fixture([response(native), reply], {}, true); await assert.rejects(f.provider.delete(input), error("task-write-failed", "unconfirmed", 206)); assert.deepEqual(f.receipts, [{ kind: "accepted", status: 206, validator: null }]);
});
test("Task DELETE cancellation before credentials or after final GET prevents mutation", async () => {
  const controller = new AbortController(), reason = new Error("Deadline"); controller.abort(reason); const f = fixture([]);
  await assert.rejects(f.provider.delete(input, controller.signal), value => value === reason); assert.equal(f.sessions(), 0);
  const after = new AbortController(), late = fixture([response(native)], { beforeMutation: async () => { after.abort(reason); } });
  await assert.rejects(late.provider.delete(input, after.signal), value => value === reason); assert.deepEqual(late.calls.map(call => call.init.method), ["GET"]); assert.deepEqual(late.receipts, []);
});
