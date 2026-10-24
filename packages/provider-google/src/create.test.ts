import assert from "node:assert/strict";
import test from "node:test";
import {
  createGooglePersonalEventCreateProvider, GoogleProviderError,
  type GoogleCreateProviderPorts, type GooglePersonalCreate, type GoogleRequestMetric,
} from "./index";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const target = { connectionId: "physical:account", connectionGeneration: "4", calendarId: "a/b@c.test", eventId: `musubi${operationId.replace(/-/g, "")}` };
const input: GooglePersonalCreate = { target, operationId, attemptId: "attempt:create",
  serializer: { id: "google-personal-event", version: 1 }, body: {
    summary: "Saved title", description: "  Exact notes  ", location: null,
    start: { dateTime: "2026-10-13T08:00:00.123Z" }, end: { dateTime: "2026-10-13T09:00:00.456Z" }, recurrence: null,
    id: target.eventId, extendedProperties: { private: { musubiOperationID: operationId } },
  } };
const native = { ...input.body, etag: '"created"', status: "confirmed", organizer: { self: true, email: "owner@example.test" } };
const collectionURL = "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40c.test/events";
const calendarURL = "https://www.googleapis.com/calendar/v3/users/me/calendarList/a%2Fb%40c.test";
const eventURL = `${collectionURL}/${target.eventId}`;
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
const error = (code: GoogleProviderError["code"], outcome?: GoogleProviderError["outcome"]) =>
  (value: unknown) => value instanceof GoogleProviderError && value.code === code && (!outcome || value.outcome === outcome);
function fixture(responses: (Response | Error)[] = []) {
  const calls: { url: string; init: RequestInit }[] = [], fences: GooglePersonalCreate[] = [], metrics: GoogleRequestMetric[] = [];
  let sessions = 0, clock = 0;
  const ports: { -readonly [K in keyof GoogleCreateProviderPorts]: GoogleCreateProviderPorts[K] } = {
    accountSession: { async open(scope) { sessions++; return { ...scope, accessToken: "PRIVATE_TOKEN", eventWriteAllowed: true }; } },
    http: { async fetch(url, init) {
      calls.push({ url, init }); const next = responses.shift();
      if (!next) throw new Error("Unexpected HTTP dispatch");
      if (next instanceof Error) throw next;
      return next;
    } },
    clock: { nowEpochMs: () => Date.parse("2026-10-13T00:00:00Z"), nowMonotonicMs: () => clock += 5 },
    telemetry: { record(metric) { metrics.push(metric); } }, beforeMutation: async request => { fences.push(request); },
  };
  return { provider: createGooglePersonalEventCreateProvider(ports), ports, calls, fences, metrics, sessions: () => sessions };
}

test("CREATE preflight reads only the exact ACL; a fresh POST sends the saved JSON without an implicit GET", async () => {
  const f = fixture([response({ id: target.calendarId, accessRole: "writer" }), response(native, 201)]);
  assert.deepEqual(await f.provider.preflightCreate(input), { kind: "allowed" });
  assert.equal(f.sessions(), 1); assert.equal(f.fences.length, 0);
  assert.deepEqual(await f.provider.create(input), { kind: "created", eventId: target.eventId, etag: '"created"' });
  assert.equal(f.sessions(), 2); assert.equal(f.fences.length, 1);
  assert.deepEqual(f.calls.map(call => [call.url, call.init.method]), [[calendarURL, "GET"], [collectionURL, "POST"]]);
  const post = f.calls[1]!;
  assert.equal(post.init.body, JSON.stringify(input.body), "property order and values stay pinned");
  assert.equal(post.init.redirect, "error");
  const headers = new Headers(post.init.headers);
  assert.equal(headers.get("if-match"), null); assert.equal(headers.get("if-none-match"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(new Headers(f.calls[0]!.init.headers).get("cache-control"), "no-cache");
  assert.deepEqual(f.metrics, [
    { provider: "google", family: "event", method: "GET", status: 200, durationMs: 5 },
    { provider: "google", family: "event", method: "POST", status: 201, durationMs: 5 },
  ]);
  assert.ok(!JSON.stringify(f.metrics).includes("PRIVATE_TOKEN"));
  assert.ok(!JSON.stringify(f.metrics).includes(target.calendarId));
});

test("CREATE snapshots every nested body container before waiting for credentials and the mutation fence", async () => {
  const mutable = { ...input, target: { ...input.target }, body: { ...input.body, start: { ...input.body.start },
    end: { ...input.body.end }, extendedProperties: { private: { ...input.body.extendedProperties.private } } } };
  const saved = JSON.stringify(mutable.body);
  const f = fixture([response(native, 201)]);
  f.ports.accountSession.open = async scope => {
    mutable.body.summary = "Newer current title";
    mutable.body.start.dateTime = "2026-11-01T00:00:00Z";
    mutable.body.extendedProperties.private.musubiOperationID = "changed";
    mutable.target.calendarId = "changed";
    return { ...scope, accessToken: "token", eventWriteAllowed: true };
  };
  f.ports.beforeMutation = async accepted => {
    for (const part of [accepted, accepted.target, accepted.serializer, accepted.body, accepted.body.start,
      accepted.body.end, accepted.body.extendedProperties, accepted.body.extendedProperties.private]) assert.ok(Object.isFrozen(part));
    assert.equal(accepted.body.summary, "Saved title");
    mutable.body.description = "Changed during fence";
  };
  await f.provider.create(mutable);
  assert.equal(f.calls[0]!.url, collectionURL); assert.equal(f.calls[0]!.init.body, saved);
});

test("CREATE rejects unsupported or mismatching IDs and native body shapes before any effects", async () => {
  const variants: unknown[] = [
    { ...input, operationId: "opaque-operation" }, { ...input, operationId: operationId.toUpperCase() },
    { ...input, target: { ...target, eventId: "other" } },
    { ...input, body: { ...input.body, id: "other" } },
    { ...input, body: { ...input.body, extendedProperties: { private: { musubiOperationID: "other" } } } },
    { ...input, body: { ...input.body, extendedProperties: { private: { musubiOperationID: operationId, foreign: "extra" } } } },
    { ...input, body: { ...input.body, attendees: [] } }, { ...input, body: { ...input.body, summary: null } },
    { ...input, body: { ...input.body, description: undefined } }, { ...input, body: { ...input.body, recurrence: [] } },
    { ...input, body: { ...input.body, summary: "x".repeat(1_100_000), description: "x".repeat(1_100_000) } },
    { ...input, body: { ...input.body, start: { dateTime: input.body.start.dateTime, timeZone: "UTC" } } },
    { ...input, body: { ...input.body, start: { date: "2026-10-13" } } },
    { ...input, body: { ...input.body, start: { dateTime: "2026-02-30T08:00:00Z" } } },
    { ...input, body: { ...input.body, end: { dateTime: "2026-10-12T08:00:00Z" } } },
    { ...input, serializer: { id: "google-personal-event", version: 2 } },
    { ...input, target: { ...target, extra: true } }, { ...input, untrusted: true },
  ];
  let getters = 0;
  const getterBody = { ...input.body }; Object.defineProperty(getterBody, "summary", { enumerable: true, get() { getters++; return "secret"; } });
  variants.push({ ...input, body: getterBody });
  const hidden = { ...input.body }; Object.defineProperty(hidden, "summary", { value: "hidden", enumerable: false });
  variants.push({ ...input, body: hidden }, { ...input, body: { ...input.body, [Symbol("hidden")]: "secret" } });
  for (const value of variants) {
    const f = fixture();
    for (const method of ["preflightCreate", "create", "readCreated"] as const)
      await assert.rejects(f.provider[method](value as GooglePersonalCreate), value => value instanceof GoogleProviderError);
    assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0); assert.equal(f.metrics.length, 0);
  }
  assert.equal(getters, 0);
});

test("CREATE requires the same credential incarnation and a current write grant for preflight and POST", async () => {
  for (const method of ["preflightCreate", "create", "readCreated"] as const) {
    for (const change of [{ connectionId: "other" }, { connectionGeneration: "5" }]) {
      const f = fixture();
      f.ports.accountSession.open = async scope => ({ ...scope, ...change, accessToken: "token", eventWriteAllowed: true });
      await assert.rejects(f.provider[method](input), error("account-session-changed", "not-written"));
      assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
    }
  }
  for (const method of ["preflightCreate", "create"] as const) for (const allowed of [false, undefined]) {
    const f = fixture();
    f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "token", eventWriteAllowed: allowed });
    await assert.rejects(f.provider[method](input), value => value instanceof GoogleProviderError && value.code === "capability-evidence" && value.evidence === (allowed === false ? "denied" : "unknown"));
    assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
  }
});

test("CREATE ACL preflight rejects missing/mismatching calendar identities and insufficient access", async () => {
  for (const body of [{ accessRole: "owner" }, { id: "other", accessRole: "owner" },
    { id: target.calendarId }, { id: target.calendarId, accessRole: "reader" }]) {
    const f = fixture([response(body)]);
    await assert.rejects(f.provider.preflightCreate(input), value => value instanceof GoogleProviderError);
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
});

test("CREATE recovery reads the exact owned ID without a mutation and preserves nullable validators", async () => {
  for (const etag of [undefined, null, 'W/"weak"', '"created"']) {
    const f = fixture([response({ ...native, etag })]);
    const observed = await f.provider.readCreated(input);
    assert.equal(observed.kind, "present");
    if (observed.kind === "present") { assert.equal(observed.event.id, target.eventId); assert.equal(observed.etag, etag === '"created"' ? etag : null); }
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, eventURL);
    assert.equal(f.calls[0]!.init.method, "GET"); assert.equal(f.calls[0]!.init.redirect, "error");
    assert.equal(new Headers(f.calls[0]!.init.headers).get("cache-control"), "no-cache");
    assert.equal(f.fences.length, 0);
  }
  const absent = fixture([response({}, 404)]);
  assert.deepEqual(await absent.provider.readCreated(input), { kind: "absent", status: 404 });
});

test("CREATE recovery treats 410, cancellation and ID/marker collisions as conflicts", async () => {
  for (const reply of [response({}, 410), response({ ...native, status: "cancelled" }), response({ ...native, id: "other" }),
    response({ ...native, extendedProperties: undefined }), response({ ...native, extendedProperties: { private: {} } }),
    response({ ...native, extendedProperties: { private: { musubiOperationID: operationId.toUpperCase() } } })]) {
    const f = fixture([reply]);
    await assert.rejects(f.provider.readCreated(input), error("provider-conflict", "not-written"));
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
});

test("CREATE recovery and ACL preflight refuse partial, redirected and malformed native responses", async () => {
  for (const method of ["preflightCreate", "readCreated"] as const) {
    const moved = response(native); Object.defineProperty(moved, "url", { value: "https://other.example/wrong" });
    const redirected = response(native); Object.defineProperty(redirected, "redirected", { value: true });
    for (const reply of [response(native, 206), response(native, 200, { "content-range": "bytes 0-10/100" }),
      moved, redirected, new Response("truncated{"), response(null), response([])]) {
      const f = fixture([reply]);
      await assert.rejects(f.provider[method](input), value => value instanceof GoogleProviderError);
      assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
    }
  }
  for (const changed of [{ start: { dateTime: "2026-02-30T08:00:00Z" } }, { end: undefined }]) {
    const f = fixture([response({ ...native, ...changed })]);
    await assert.rejects(f.provider.readCreated(input), error("provider-write-failed", "not-written"));
  }
  const exact = response(native); Object.defineProperty(exact, "url", { value: eventURL });
  assert.equal((await fixture([exact]).provider.readCreated(input)).kind, "present");
});

test("CREATE success with missing/weak ETag remains accepted with a nullable validator", async () => {
  for (const etag of [undefined, null, 'W/"weak"']) {
    const f = fixture([response({ id: target.eventId, etag }, 201)]);
    assert.deepEqual(await f.provider.create(input), { kind: "created", eventId: target.eventId, etag: null });
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1);
  }
});

test("CREATE POST rejection preserves bounded status/Retry-After and never triggers recovery or retry", async () => {
  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    const f = fixture([response({}, status, { "retry-after": "12" })]);
    await assert.rejects(f.provider.create(input), value => value instanceof GoogleProviderError && value.code === "provider-write-failed" &&
      value.outcome === (status >= 500 ? "unconfirmed" : "not-written") && value.providerStatus === status && value.retryAfterMs === 12_000);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.method, "POST"); assert.equal(f.fences.length, 1);
  }
  const dated = fixture([response({}, 429, { "retry-after": "Tue, 13 Oct 2026 00:00:09 GMT" })]);
  await assert.rejects(dated.provider.create(input), value => value instanceof GoogleProviderError && value.retryAfterMs === 9000);
});

test("CREATE possible POST dispatch with unusable success or transport failure remains uncertain", async () => {
  const moved = response({ id: target.eventId }, 201); Object.defineProperty(moved, "url", { value: "https://other.example/created" });
  const redirected = response({ id: target.eventId }, 201); Object.defineProperty(redirected, "redirected", { value: true });
  for (const reply of [new Error("PRIVATE_NETWORK_DETAIL"), new Response("truncated{", { status: 201 }), response({}, 201),
    response({ id: "other" }, 201), response(null, 201), response([], 201), response({}, 204), response({ id: target.eventId }, 202),
    response({ id: target.eventId }, 201, { "content-range": "bytes 0-10/100" }), moved, redirected]) {
    const f = fixture([reply]);
    await assert.rejects(f.provider.create(input), value => error("provider-write-failed", "unconfirmed")(value) && !String(value).includes("PRIVATE"));
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1);
  }
});

test("CREATE cancellation before dispatch has zero HTTP effects; in-flight cancellation stays uncertain", async () => {
  const early = new AbortController(); early.abort();
  const f = fixture(); await assert.rejects(f.provider.create(input, early.signal));
  assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 0);
  for (const phase of ["credentials", "fence"] as const) {
    const controller = new AbortController(), late = fixture();
    if (phase === "credentials") late.ports.accountSession.open = async scope => {
      controller.abort(); return { ...scope, accessToken: "token", eventWriteAllowed: true };
    };
    else late.ports.beforeMutation = async () => { controller.abort(); };
    await assert.rejects(late.provider.create(input, controller.signal));
    assert.equal(late.calls.length, 0); assert.equal(late.metrics.length, 0);
  }
  const controller = new AbortController(), active = fixture();
  active.ports.http.fetch = async () => { controller.abort(); throw new DOMException("Canceled", "AbortError"); };
  await assert.rejects(active.provider.create(input, controller.signal), error("provider-write-failed", "unconfirmed"));
  assert.deepEqual(active.metrics.map(metric => metric.status), ["aborted"]);
});

test("CREATE diagnostics cannot replace acceptance and a rejected authority fence dispatches nothing", async () => {
  const diagnostics = fixture([response({ id: target.eventId }, 201)]);
  diagnostics.ports.telemetry.record = () => { throw new Error("Metrics unavailable"); };
  assert.equal((await diagnostics.provider.create(input)).kind, "created");
  const denied = fixture(); denied.ports.beforeMutation = async () => { throw new Error("Host authority retired"); };
  await assert.rejects(denied.provider.create(input));
  assert.equal(denied.calls.length, 0); assert.equal(denied.metrics.length, 0);
});
