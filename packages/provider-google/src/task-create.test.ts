import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleTaskCreateProvider, GoogleTaskProviderError, googleTaskProjectionFromNative,
  type GoogleTaskCreate, type GoogleTaskCreateProviderPorts, type GoogleTaskCreateRequestMetric,
  type GoogleNativeTaskAcceptedResponse, type GoogleNativeTaskResponseAddress } from "./index";

const target = { connectionId: "physical-account", connectionGeneration: "7", taskListId: "list/a?b#c" };
const taskId = "task/a?b#c", body = { due: "2026-10-26T00:00:00.000Z", notes: null, status: "needsAction" as const, title: "Task" };
const input: GoogleTaskCreate = { target, body, operationId: "operation:one", attemptId: "attempt:two", serializer: { id: "google-task", version: 1 } };
const native = { ...body, id: taskId, etag: '"created"' }, readTarget = { ...target, taskId };
const collectionURL = "https://tasks.googleapis.com/tasks/v1/lists/list%2Fa%3Fb%23c/tasks";
const taskURL = `${collectionURL}/task%2Fa%3Fb%23c`, listURL = "https://tasks.googleapis.com/tasks/v1/users/@me/lists/list%2Fa%3Fb%23c";
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(value === null && [204, 205, 304].includes(status) ? null : JSON.stringify(value), { status, headers });
function fixture(queue: (Response | Error)[], override: Partial<GoogleTaskCreateProviderPorts> = {}, strict = false) {
  const calls: { url: string; init: RequestInit }[] = [], metrics: GoogleTaskCreateRequestMetric[] = [], fences: GoogleTaskCreate[] = [];
  const receipts: GoogleNativeTaskAcceptedResponse[] = [], addresses: GoogleNativeTaskResponseAddress[] = [];
  let sessions = 0, tick = 0;
  const ports: GoogleTaskCreateProviderPorts = {
    accountSession: { async open(connection) { sessions++; return { ...connection, accessToken: "private-token", taskWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = queue.shift(); assert(next, "Unexpected native fixture call"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => Date.parse("2026-10-26T00:00:00.000Z"), nowMonotonicMs: () => tick += 7 },
    telemetry: { record(metric) { metrics.push(metric); } }, beforeMutation: async request => { fences.push(request); },
    onAcceptedResponse: async receipt => { receipts.push(receipt); }, onResponseAddress: async address => { addresses.push(address); }, ...override,
  };
  return { provider: createGoogleTaskCreateProvider(ports, { nativeProfile: strict ? "strict-reference" : "existing-google" }), ports, calls, metrics, fences, receipts, addresses, sessions: () => sessions };
}
const error = (code: string, outcome?: string, status?: number) => (value: unknown) => value instanceof GoogleTaskProviderError && value.code === code &&
  (outcome === undefined || value.outcome === outcome) && (status === undefined || value.providerStatus === status);

test("Task CREATE preserves list GET, exact admitted POST, generated-address GET and three sessions", async () => {
  const signal = new AbortController().signal, f = fixture([response({ id: target.taskListId }), response(native, 201), response(native)]);
  assert.deepEqual(await f.provider.preflightCreate(input, signal), { kind: "allowed" });
  const created = await f.provider.create(input, signal); assert.deepEqual(created, { kind: "created", taskId, etag: '"created"' });
  const read = await f.provider.readForCreate({ ...target, taskId: created.taskId }, signal); assert.equal(read.kind, "present");
  assert.equal(f.sessions(), 3); assert.deepEqual(f.calls.map(call => [call.url, call.init.method]), [[listURL, "GET"], [collectionURL, "POST"], [taskURL, "GET"]]);
  assert.deepEqual(f.calls.map(call => call.init.redirect), ["error", undefined, "error"]); assert(f.calls.every(call => call.init.signal === signal));
  assert.equal(new Headers(f.calls[0]!.init.headers).get("Cache-Control"), null); assert.equal(new Headers(f.calls[2]!.init.headers).get("Cache-Control"), "no-cache");
  const headers = new Headers(f.calls[1]!.init.headers); assert.equal(headers.get("Content-Type"), "application/json"); assert.equal(headers.get("If-Match"), null);
  assert.equal(f.calls[1]!.init.body, JSON.stringify(body)); assert.equal(f.fences.length, 1);
  assert.deepEqual(f.receipts, [{ status: 201, validator: null }]); assert.deepEqual(f.addresses, [{ taskId, validator: '"created"' }]);
  assert.deepEqual(f.metrics.map(metric => [metric.method, metric.status, metric.durationMs]), [["GET", 200, 7], ["POST", 201, 7], ["GET", 200, 7]]);
});

test("Task CREATE owns body, collection and serializer before suspended credentials", async () => {
  const mutable = { ...input, target: { ...target }, body: { ...body }, serializer: { ...input.serializer } };
  const f = fixture([response(native)], { accountSession: { async open(connection) {
    mutable.target.taskListId = "different-list"; mutable.body.title = "Changed"; mutable.serializer.version = 99 as 1;
    return { ...connection, accessToken: "token", taskWriteAllowed: true };
  } }, beforeMutation: async request => {
    assert(Object.isFrozen(request)); assert(Object.isFrozen(request.target)); assert(Object.isFrozen(request.body)); assert(Object.isFrozen(request.serializer));
    assert.equal(request.body.title, "Task");
  } });
  await f.provider.create(mutable); assert.equal(f.calls[0]!.url, collectionURL); assert.equal(f.calls[0]!.init.body, JSON.stringify(body));
});

test("Task CREATE refuses executable, incomplete and unsupported admitted inputs before sessions", async () => {
  let evaluated = false;
  const getterBody = Object.defineProperty({ ...body }, "title", { enumerable: true, get() { evaluated = true; return "Unsafe"; } });
  const bad: unknown[] = [{ ...input, target: { ...target, taskId } }, { ...input, body: { title: "Only one field" } },
    { ...input, body: { ...body, due: "2025-02-29T00:00:00.000Z" } }, { ...input, body: { ...body, id: "client-id" } },
    { ...input, body: getterBody }, { ...input, serializer: { id: "future", version: 1 } }, { ...input, target: { ...target, taskListId: String.fromCharCode(0xd800) } },
    Object.defineProperty({ ...input }, "operationId", { enumerable: true, get() { evaluated = true; return "Unsafe"; } })];
  for (const value of bad) { const f = fixture([]); await assert.rejects(f.provider.create(value as GoogleTaskCreate), error("task-projection-unavailable")); assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); }
  assert.equal(evaluated, false);
});

test("Task CREATE checks Tasks scope and captured physical session on every materialization", async () => {
  for (const changed of [{ taskWriteAllowed: false }, { taskWriteAllowed: undefined }, { connectionGeneration: "8" }, { connectionId: "different" }, { accessToken: "" }]) {
    const f = fixture([], { accountSession: { async open(connection) { return { ...connection, accessToken: "token", taskWriteAllowed: true, eventWriteAllowed: true, ...changed }; } } });
    await assert.rejects(f.provider.create(input), value => value instanceof GoogleTaskProviderError); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
  }
  const raw = new Error("Host grant rejected"); const f = fixture([], { accountSession: { async open() { throw raw; } } });
  await assert.rejects(f.provider.preflightCreate(input), value => value === raw); assert.equal(f.calls.length, 0);
});

test("Task CREATE list preflight requires exact ID and keeps existing any-ok floor", async () => {
  for (const value of [{ id: "different" }, { title: "Missing ID" }]) {
    const f = fixture([response(value)]); await assert.rejects(f.provider.preflightCreate(input), error("task-projection-unavailable")); assert.equal(f.fences.length, 0);
  }
  const partial = fixture([response({ id: target.taskListId }, 206, { "content-range": "bytes 0-10/20" })]); assert.deepEqual(await partial.provider.preflightCreate(input), { kind: "allowed" });
  for (const change of ["status", "partial", "url", "redirect"]) {
    const reply = response({ id: target.taskListId }, change === "status" ? 201 : 200, change === "partial" ? { "content-range": "bytes 0-10/20" } : undefined);
    if (change === "url") Object.defineProperty(reply, "url", { value: "https://example.invalid/other" });
    if (change === "redirect") Object.defineProperty(reply, "redirected", { value: true });
    await assert.rejects(fixture([reply], {}, true).provider.preflightCreate(input), error("task-write-failed", "not-written"));
  }
});

test("Task CREATE list and delivery reads recover one concrete GET401 and recheck refreshed grant", async () => {
  for (const list of [true, false]) {
    let recovered = 0; const rejected = response({}, 401);
    const f = fixture([rejected, response(list ? { id: target.taskListId } : native)], { accountSession: {
      async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
      async recoverRejectedRead(connection, token) { recovered++; assert.equal(token, "old"); return { ...connection, accessToken: "new", taskWriteAllowed: true }; },
    } });
    if (list) await f.provider.preflightCreate(input); else await f.provider.readForCreate(readTarget);
    assert.equal(recovered, 1); assert(rejected.bodyUsed); assert.deepEqual(f.calls.map(call => new Headers(call.init.headers).get("Authorization")), ["Bearer old", "Bearer new"]);
    assert(f.calls.every(call => call.init.method === "GET" && call.url === (list ? listURL : taskURL)));
  }
  const narrowed = fixture([response({}, 401)], { accountSession: { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { return { ...connection, accessToken: "new", taskWriteAllowed: false }; } } });
  await assert.rejects(narrowed.provider.preflightCreate(input), error("task-scope-missing")); assert.equal(narrowed.calls.length, 1);
});

test("Task CREATE second GET401 retains raw host rejection without invented Retry-After", async () => {
  const raw = new Error("Host resource_401"), first = response({}, 401), second = response({}, 401, { "retry-after": "99" });
  const f = fixture([first, second], { accountSession: { async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { return { ...connection, accessToken: "new", taskWriteAllowed: true }; }, async onReadAuthenticationRejected() { throw raw; } } });
  await assert.rejects(f.provider.preflightCreate(input), value => value === raw); assert(first.bodyUsed && second.bodyUsed); assert.equal(f.calls.length, 2);
});

test("Task CREATE POST401 and explicit mutation-preflight GET never replay authentication", async () => {
  let recovered = 0; const accountSession: GoogleTaskCreateProviderPorts["accountSession"] = {
    async open(connection) { return { ...connection, accessToken: "old", taskWriteAllowed: true }; },
    async recoverRejectedRead(connection) { recovered++; return { ...connection, accessToken: "new", taskWriteAllowed: true }; },
  };
  const post = fixture([response({}, 401)], { accountSession }); await assert.rejects(post.provider.create(input), error("task-write-failed", "not-written", 401));
  const read = fixture([response({}, 401)], { accountSession }); await assert.rejects(read.provider.readForCreate(readTarget, undefined, "mutation-preflight"), error("task-write-failed", "not-written", 401));
  assert.equal(recovered, 0); assert.equal(post.calls.length, 1); assert.equal(read.calls.length, 1); assert.deepEqual(post.receipts, []);
});

test("Task CREATE separates accepted HTTP and response address before requiring a strong tag", async () => {
  for (const etag of [undefined, null, "unquoted", 'W/"weak"']) {
    const order: string[] = [], f = fixture([response({ id: taskId, etag })], {
      onAcceptedResponse: async receipt => { order.push("accepted"); assert.deepEqual(receipt, { status: 200, validator: null }); assert(Object.isFrozen(receipt)); },
      onResponseAddress: async address => { order.push("address"); assert.deepEqual(address, { taskId, validator: null }); assert(Object.isFrozen(address)); },
    });
    await assert.rejects(f.provider.create(input), error("task-version-unavailable")); assert.deepEqual(order, ["accepted", "address"]); assert.equal(f.calls.length, 1);
  }
  for (const value of [{}, { id: "" }, { id: 42 }]) {
    const f = fixture([response(value)]); await assert.rejects(f.provider.create(input), error("task-write-failed", "unconfirmed"));
    assert.deepEqual(f.receipts, [{ status: 200, validator: null }]); assert.deepEqual(f.addresses, []);
  }
});

test("Task CREATE raw acceptance survives malformed JSON and accepted204 without a body", async () => {
  for (const reply of [new Response("{", { status: 201 }), new Response(null, { status: 204 })]) {
    const f = fixture([reply]); await assert.rejects(f.provider.create(input), SyntaxError);
    assert.deepEqual(f.receipts, [{ status: reply.status, validator: null }]); assert.deepEqual(f.addresses, []); assert.equal(f.calls.length, 1);
  }
  const ok = fixture([response({ id: taskId, etag: '"tag"' }, 200)]); assert.equal((await ok.provider.create(input)).kind, "created");
});

test("Task CREATE existing generated IDs retain nonempty-only floor across the subsequent read", async () => {
  const long = "native-" + "x".repeat(3000), f = fixture([response({ id: long, etag: '"created"' }), response({ ...native, id: long })]);
  const result = await f.provider.create(input); assert.equal(result.taskId, long); assert.equal((await f.provider.readForCreate({ ...target, taskId: long })).kind, "present");
  assert.equal(f.calls[1]!.url, `${collectionURL}/${long}`);
  const strict = fixture([response({ id: long, etag: '"created"' })], {}, true); await assert.rejects(strict.provider.create(input), error("task-write-failed", "unconfirmed")); assert.equal(strict.addresses.length, 0);
  const malformed = String.fromCharCode(0xd800), legacy = fixture([response({ id: malformed, etag: '"created"' })]);
  assert.equal((await legacy.provider.create(input)).taskId, malformed); await assert.rejects(legacy.provider.readForCreate({ ...target, taskId: malformed }), URIError); assert.equal(legacy.calls.length, 1);
});

test("Task CREATE reads preserve existing any-ok notes, due and deleted-flag floors", async () => {
  const value = { ...native, notes: 42, due: 123, deleted: true }, f = fixture([response(value, 206, { "content-range": "bytes 0-1/2" })]);
  const result = await f.provider.readForCreate(readTarget); assert.equal(result.kind, "present");
  if (result.kind === "present") assert.deepEqual(googleTaskProjectionFromNative(result.task), { ...body, notes: 42, due: "123T00:00:00.000Z" });
  for (const [change, code] of [[{ id: "different" }, "task-projection-unavailable"], [{ title: null }, "task-projection-unavailable"],
    [{ status: "in-process" }, "task-projection-unavailable"], [{ assignmentInfo: { surfaceType: "SPACE" } }, "task-source-read-only"], [{ etag: null }, "task-version-unavailable"]] as const)
    await assert.rejects(fixture([response({ ...native, ...change })]).provider.readForCreate(readTarget), error(code));
});

test("Task CREATE strict reads require exact scope, complete200 and strict native body proof", async () => {
  for (const change of ["status", "partial", "url", "redirect"]) {
    const reply = response(native, change === "status" ? 201 : 200, change === "partial" ? { "content-range": "bytes 0-1/2" } : undefined);
    if (change === "url") Object.defineProperty(reply, "url", { value: "https://example.invalid/other" });
    if (change === "redirect") Object.defineProperty(reply, "redirected", { value: true });
    await assert.rejects(fixture([reply], {}, true).provider.readForCreate(readTarget), error("task-write-failed", "not-written"));
  }
  for (const [change, code] of [[{ notes: 42 }, "task-projection-unavailable"], [{ due: "2026-10-26garbage" }, "task-projection-unavailable"],
    [{ deleted: true }, "task-provider-conflict"], [{ assignmentInfo: { surfaceType: "DOCUMENT" } }, "task-source-read-only"]] as const)
    await assert.rejects(fixture([response({ ...native, ...change })], {}, true).provider.readForCreate(readTarget), error(code));
  let evaluated = false; const executable = { ...native, links: [Object.defineProperty({}, "link", { enumerable: true, get() { evaluated = true; return "Unsafe"; } })] };
  const reply = response({}); reply.json = async () => executable; await assert.rejects(fixture([reply], {}, true).provider.readForCreate(readTarget), error("task-projection-unavailable")); assert.equal(evaluated, false);
});

test("Task CREATE read404/410 are scoped absence without parsing body or replaying POST", async () => {
  for (const status of [404, 410] as const) {
    const f = fixture([new Response("{", { status })]); assert.deepEqual(await f.provider.readForCreate(readTarget), { kind: "absent", status }); assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
    for (const change of ["partial", "url", "redirect"]) {
      const reply = new Response("{", { status, headers: change === "partial" ? { "content-range": "bytes 0-1/2" } : undefined });
      if (change === "url") Object.defineProperty(reply, "url", { value: "https://example.invalid/other" });
      if (change === "redirect") Object.defineProperty(reply, "redirected", { value: true });
      await assert.rejects(fixture([reply], {}, true).provider.readForCreate(readTarget), error("task-write-failed", "not-written", status));
    }
  }
});

test("Task CREATE preserves default POST redirects while strict reference refuses scope and partial responses", async () => {
  for (const change of ["partial", "url", "redirect"]) {
    const make = () => {
      const reply = response(native, 201, change === "partial" ? { "content-range": "bytes 0-1/2" } : undefined);
      if (change === "url") Object.defineProperty(reply, "url", { value: "https://example.invalid/other" });
      if (change === "redirect") Object.defineProperty(reply, "redirected", { value: true }); return reply;
    };
    const existing = fixture([make()]); assert.equal((await existing.provider.create(input)).kind, "created"); assert.equal(existing.calls[0]!.init.redirect, undefined);
    const strict = fixture([make()], {}, true); await assert.rejects(strict.provider.create(input), error("task-write-failed", "unconfirmed", 201));
    assert.equal(strict.calls[0]!.init.redirect, "error"); assert.deepEqual(strict.receipts, [{ status: 201, validator: null }]); assert.deepEqual(strict.addresses, []);
  }
});

test("Task CREATE known refusals keep raw status and Retry-After separate from acceptance", async () => {
  for (const status of [202, 206, 302, 400, 401, 403, 408, 412, 429, 500]) {
    const f = fixture([response({}, status, { "retry-after": "17" })]);
    await assert.rejects(f.provider.create(input), value => value instanceof GoogleTaskProviderError && value.code === (status === 412 ? "task-provider-conflict" : "task-write-failed") &&
      value.providerStatus === status && value.retryAfterMs === 17_000 && value.outcome === (status >= 500 || status < 300 ? "unconfirmed" : "not-written"));
    assert.deepEqual(f.receipts, []); assert.deepEqual(f.addresses, []); assert.equal(f.calls.length, 1);
  }
  const read = fixture([response({}, 429, { "retry-after": "Mon, 26 Oct 2026 00:00:09 GMT" })]);
  await assert.rejects(read.provider.preflightCreate(input), value => value instanceof GoogleTaskProviderError && value.retryAfterMs === 9000 && value.outcome === "not-written");
});

test("Task CREATE callbacks and transport failures cannot cause hidden reads or retries", async () => {
  const raw = new TypeError("Private transport failure"), f = fixture([raw]); await assert.rejects(f.provider.create(input), value => value === raw);
  assert.deepEqual(f.metrics.map(metric => metric.status), ["network-error"]); assert.deepEqual(f.receipts, []); assert.deepEqual(f.addresses, []);
  for (const at of ["accepted", "address"] as const) {
    const failure = new Error("Evidence persistence failed"), captured: string[] = [];
    const interrupted = fixture([response(native)], { onAcceptedResponse: async () => { captured.push("accepted"); if (at === "accepted") throw failure; },
      onResponseAddress: async () => { captured.push("address"); throw failure; } });
    await assert.rejects(interrupted.provider.create(input), value => value === failure); assert.deepEqual(captured, at === "accepted" ? ["accepted"] : ["accepted", "address"]); assert.equal(interrupted.calls.length, 1);
  }
  const diagnostic = fixture([response(native)], { telemetry: { record() { throw new Error("Diagnostics"); } } }); assert.equal((await diagnostic.provider.create(input)).kind, "created");
  assert(!JSON.stringify(f.metrics).includes("private-token")); assert(!JSON.stringify(f.metrics).includes(target.taskListId));
});

test("Task CREATE cancellation before credentials or after mutation fence prevents POST", async () => {
  const reason = new Error("Deadline"), controller = new AbortController(); controller.abort(reason); const early = fixture([]);
  await assert.rejects(early.provider.create(input, controller.signal), value => value === reason); assert.equal(early.sessions(), 0);
  const after = new AbortController(), f = fixture([], { beforeMutation: async () => { after.abort(reason); } });
  await assert.rejects(f.provider.create(input, after.signal), value => value === reason); assert.equal(f.calls.length, 0); assert.deepEqual(f.receipts, []);
  const aborted = new AbortController(), late = fixture([], { http: { async fetch() { aborted.abort(reason); throw new DOMException("Cancelled", "AbortError"); } } });
  await assert.rejects(late.provider.create(input, aborted.signal), DOMException); assert.deepEqual(late.metrics.map(metric => metric.status), ["aborted"]);
});
