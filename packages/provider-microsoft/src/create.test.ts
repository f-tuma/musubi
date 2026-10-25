import assert from "node:assert/strict";
import test from "node:test";
import {
  createMicrosoftPersonalEventCreateProvider, MicrosoftProviderError,
  type MicrosoftAccountSession, type MicrosoftCreateNativeProfile, type MicrosoftCreateProviderPorts,
  type MicrosoftPersonalCreate, type MicrosoftRequestMetric,
} from "./index";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef";
const target = { connectionId: "physical:account", connectionGeneration: "4", calendarId: "calendar/id" };
const input: MicrosoftPersonalCreate = { target, body: { subject: "Synthetic event", body: { contentType: "text", content: "Notes" },
  location: { displayName: "Place" }, isAllDay: false, start: { dateTime: "2026-10-13T08:00:00.000Z", timeZone: "UTC" },
  end: { dateTime: "2026-10-13T09:00:00.000Z", timeZone: "UTC" }, transactionId: operationId },
  operationId, attemptId: "attempt:create", serializer: { id: "microsoft-personal-event", version: 1 } };
const base = "https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events";
const list = `${base}?$select=id,transactionId,subject,start,end,isAllDay,isCancelled,body,location,organizer,recurrence,onlineMeeting,onlineMeetingUrl&$top=100`;
const native = { id: "assigned/event", transactionId: operationId, "@odata.etag": 'W/"created"', subject: input.body.subject,
  start: input.body.start, end: input.body.end, body: input.body.body, location: input.body.location, isAllDay: false,
  type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, attendees: [],
  isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null };
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 || status === 205 || status === 304 ? null : JSON.stringify(body), { status, headers });
function fixture(responses: (Response | Error)[], profile: MicrosoftCreateNativeProfile = "existing-microsoft") {
  const calls: { url: string; init: RequestInit }[] = [], metrics: MicrosoftRequestMetric[] = [], fences: MicrosoftPersonalCreate[] = [];
  let sessions = 0, now = 10;
  const ports: MicrosoftCreateProviderPorts = {
    accountSession: { async open(scope) { sessions++; return { ...scope, accessToken: "SECRET_LOCAL", eventWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error("Unexpected dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => now++ }, telemetry: { record(metric) { metrics.push(metric); } },
    beforeMutation: async request => { fences.push(request); },
  };
  return { provider: createMicrosoftPersonalEventCreateProvider(ports, { nativeProfile: profile }), ports, calls, metrics, fences,
    sessions: () => sessions, remaining: () => responses.length };
}
const error = (code: MicrosoftProviderError["code"], outcome?: MicrosoftProviderError["outcome"]) =>
  (value: unknown) => value instanceof MicrosoftProviderError && value.code === code && (!outcome || value.outcome === outcome);

test("CREATE validates exact body, canonical marker and fixed profile before any side effect", async () => {
  let getters = 0;
  const getter = structuredClone(input); Object.defineProperty(getter.body, "subject", { enumerable: true, get() { getters++; return "late"; } });
  const inherited = Object.assign(Object.create({ extra: true }), input);
  const wrongCases = [
    { ...input, operationId: operationId.toUpperCase() }, { ...input, body: { ...input.body, transactionId: "00000000-0000-4000-8000-000000000001" } },
    { ...input, target: { ...target, eventId: "not-admitted" } }, { ...input, target: { ...target, calendarId: "" } },
    { ...input, serializer: { id: "microsoft-personal-event", version: 2 } }, { ...input, extra: true },
    { ...input, body: { ...input.body, recurrence: null } }, { ...input, body: { ...input.body, isAllDay: true } },
    { ...input, body: { ...input.body, body: { contentType: "html", content: "Notes" } } },
    { ...input, body: { ...input.body, start: { dateTime: "2026-02-30T08:00:00Z", timeZone: "UTC" } } },
    { ...input, body: { ...input.body, end: { dateTime: "2026-10-13T07:00:00Z", timeZone: "UTC" } } }, getter, inherited,
  ];
  for (const candidate of wrongCases) for (const method of ["preflightCreate", "create", "readCreated"] as const) {
    const f = fixture([]); await assert.rejects(f.provider[method](candidate as MicrosoftPersonalCreate), value => value instanceof MicrosoftProviderError);
    assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0); assert.equal(f.metrics.length, 0);
  }
  assert.equal(getters, 0);
  const f = fixture([]);
  for (const config of [undefined, {}, { nativeProfile: "other" }, { nativeProfile: "existing-microsoft", extra: true }])
    assert.throws(() => createMicrosoftPersonalEventCreateProvider(f.ports, config as { nativeProfile: MicrosoftCreateNativeProfile }));
});

test("legacy CREATE preflight preserves any successful status, default redirect and original canEdit select", async () => {
  for (const status of [200, 201, 202, 206, 299]) {
    const res = response({ canEdit: true, id: "different", owner: null }, status, { "content-range": "items 0-1/2" });
    Object.defineProperty(res, "redirected", { value: true }); Object.defineProperty(res, "url", { value: "https://other.invalid/followed" });
    const f = fixture([res]); assert.deepEqual(await f.provider.preflightCreate(input), { kind: "allowed" });
    assert.equal(f.calls[0]!.url, `${base.slice(0, -7)}?$select=canEdit`);
    assert.equal(f.calls[0]!.init.redirect, undefined); assert.equal(f.calls[0]!.init.body, undefined);
    assert.deepEqual([...new Headers(f.calls[0]!.init.headers)], [["authorization", "Bearer SECRET_LOCAL"]]);
    assert.equal(f.fences.length, 0);
  }
  for (const [allowed, evidence] of [[false, "denied"], [undefined, "unknown"], [1, "unknown"]])
    await assert.rejects(fixture([response({ canEdit: allowed })]).provider.preflightCreate(input), value =>
      value instanceof MicrosoftProviderError && value.code === "capability-evidence" && value.evidence === evidence);
});

test("legacy GET parser/network and item accessor failures retain raw host error classes", async () => {
  const raw = new TypeError("SYNTHETIC_PRIVATE");
  await assert.rejects(fixture([raw]).provider.preflightCreate(input), value => value === raw);
  await assert.rejects(fixture([new Response("not-json")]).provider.preflightCreate(input), SyntaxError);
  await assert.rejects(fixture([response(null)]).provider.preflightCreate(input), TypeError);
  await assert.rejects(fixture([response({ value: [null] })]).provider.readCreated(input), TypeError);
  await assert.rejects(fixture([response({ value: [], "@odata.nextLink": "/relative" })]).provider.readCreated(input), TypeError);
});

test("fresh sessions and refreshed grant fence preflight and one POST independently", async () => {
  for (const change of [{ connectionGeneration: "5" }, { connectionId: "another" }, { eventWriteAllowed: false }, { eventWriteAllowed: undefined }, { accessToken: "" }])
    for (const method of ["create", "preflightCreate"] as const) {
      const f = fixture([]); f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "token", eventWriteAllowed: true, ...change });
      await assert.rejects(f.provider[method](input)); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
    }
  const f = fixture([response({ canEdit: true })]); await f.provider.preflightCreate(input);
  f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "refreshed", eventWriteAllowed: false });
  await assert.rejects(f.provider.create(input), error("capability-evidence")); assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  const read = fixture([response({ value: [] })]); read.ports.accountSession.open = async scope => ({ ...scope, accessToken: "read-only", eventWriteAllowed: false });
  assert.deepEqual(await read.provider.readCreated(input), { kind: "missing" });
});

test("POST owns frozen request and credentials across both suspension points", async () => {
  type Writable<T> = { -readonly [Key in keyof T]: Writable<T[Key]> };
  const mutable = structuredClone(input) as Writable<MicrosoftPersonalCreate>, expectedBody = JSON.stringify(mutable.body), f = fixture([response({ id: "assigned" }, 201)]);
  let current!: MicrosoftAccountSession;
  f.ports.accountSession.open = async scope => {
    mutable.target.calendarId = "late"; mutable.body.subject = "late"; mutable.body.transactionId = "late";
    current = { ...scope, accessToken: "original-secret", eventWriteAllowed: true }; return current;
  };
  const ports: MicrosoftCreateProviderPorts = { ...f.ports, beforeMutation: async request => {
    assert.deepEqual(request, input); assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.body));
    assert.ok(Object.isFrozen(request.body.body)); assert.ok(Object.isFrozen(request.body.start));
    (current as { accessToken: string }).accessToken = "late-secret";
  } };
  await createMicrosoftPersonalEventCreateProvider(ports, { nativeProfile: "existing-microsoft" }).create(mutable);
  assert.equal(f.calls[0]!.url, base); assert.equal(f.calls[0]!.init.body, expectedBody);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("authorization"), "Bearer original-secret");
  assert.equal(new Headers(f.calls[0]!.init.headers).get("if-match"), null); assert.equal(new Headers(f.calls[0]!.init.headers).get("prefer"), null);
  assert.equal(f.calls[0]!.init.redirect, "error");
});

test("POST preserves every native ETag string and only original accepted statuses plus nonempty ID", async () => {
  for (const etag of [undefined, null, "", "arbitrary", '"strong"', 'W/"weak"', " malformed \n"]) {
    const f = fixture([response({ id: "native/id", "@odata.etag": etag }, 201)]);
    assert.deepEqual(await f.provider.create(input), { kind: "created", status: 201, eventId: "native/id", etag: typeof etag === "string" ? etag : null });
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1);
  }
  const accepted204 = response(null, 204); accepted204.json = async () => ({ id: "native/id", "@odata.etag": "" });
  assert.deepEqual(await fixture([accepted204]).provider.create(input), { kind: "created", status: 204, eventId: "native/id", etag: "" });
  for (const res of [response({}, 200), response({ id: "" }, 201), response(null, 204), new Response("broken", { status: 201 })])
    await assert.rejects(fixture([res]).provider.create(input), error("provider-write-failed", "unconfirmed"));
});

test("POST has no automatic GET/retry and distinguishes known rejection from possible acceptance", async () => {
  for (const status of [202, 206, 301, 400, 401, 403, 408, 409, 410, 412, 429, 500, 503]) {
    const f = fixture([response({}, status, { "retry-after": "2" })]);
    await assert.rejects(f.provider.create(input), value => value instanceof MicrosoftProviderError && value.providerStatus === status &&
      value.code === (status === 412 ? "provider-conflict" : "provider-write-failed") &&
      value.outcome === (status >= 500 || status >= 200 && status < 300 ? "unconfirmed" : "not-written") && value.retryAfterMs === 2000);
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1);
  }
  const f = fixture([new Error("lost-reply")]); await assert.rejects(f.provider.create(input), error("provider-write-failed", "unconfirmed"));
  assert.equal(f.calls.length, 1);
});

test("complete scoped pagination preserves old select, UTC Prefer, native content and raw validator", async () => {
  const page2 = `${base}?$skiptoken=owned`;
  const malformed = { ...native, "@odata.etag": "", start: { dateTime: "bad" }, body: { contentType: "text", content: 42 }, extra: { retained: true } };
  const f = fixture([response({ value: [{ id: "unrelated", transactionId: "other", body: 42 }, malformed], "@odata.nextLink": page2 }), response({ value: [] })]);
  const observed = await f.provider.readCreated(input); assert.equal(observed.kind, "present");
  if (observed.kind !== "present") assert.fail();
  assert.deepEqual(observed.event, malformed); assert.equal(observed.etag, ""); assert.ok(Object.isFrozen(observed.event)); assert.ok(Object.isFrozen(observed.event.extra));
  assert.deepEqual(f.calls.map(call => call.url), [list, page2]); assert.equal(f.fences.length, 0);
  for (const call of f.calls) {
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.body, undefined);
    assert.equal(new Headers(call.init.headers).get("prefer"), 'outlook.timezone="UTC"');
    assert.equal(new Headers(call.init.headers).get("cache-control"), "no-cache");
  }
});

test("listing must finish before candidate selection and rejects duplicate/unsafe/incomplete chains", async () => {
  for (const responses of [
    [response({ value: [native, native] })], [response({ value: [{ ...native, id: "" }] })],
    [response({ value: [native], "@odata.nextLink": `${base}?$skip=2` }), response({ value: [native] })],
    [response({ value: [], "@odata.nextLink": list })], [response({ value: [], "@odata.nextLink": "https://evil.invalid/events" })],
    [response({ value: [], "@odata.nextLink": `${base}/different` })], [response({ value: [], "@odata.nextLink": "https://u:p@graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events" })],
    [response({ value: [], "@odata.nextLink": " " })], [response({ value: [] }, 206)], [response({ value: [] }, 200, { "content-range": "items 0-1/2" })],
    [response({ value: [] }, 404)], [response({ value: [] }, 410)], [response({ value: {} })],
    [response({ value: [native], "@odata.nextLink": `${base}?$skip=2` }), response({}, 403)],
  ]) {
    const f = fixture(responses); await assert.rejects(f.provider.readCreated(input)); assert.equal(f.fences.length, 0);
    assert.ok(f.calls.every(call => call.init.method === "GET"));
  }
  const missing = fixture([response({ value: ["nonmatch", 42, { transactionId: "other" }] })]);
  assert.deepEqual(await missing.provider.readCreated(input), { kind: "missing" });
  for (const change of [{ isCancelled: true }, { recurrence: {} }])
    await assert.rejects(fixture([response({ value: [{ ...native, ...change }] })]).provider.readCreated(input), error("provider-conflict"));
});

test("selected native candidate is owned before the next page can suspend", async () => {
  const mutable = structuredClone(native), firstPage = response(null), lastPage = response({ value: [] });
  firstPage.json = async () => ({ value: [mutable], "@odata.nextLink": `${base}?$skiptoken=owned` });
  const f = fixture([]);
  f.ports.http.fetch = async (url, init) => {
    f.calls.push({ url, init });
    if (f.calls.length === 1) return firstPage;
    mutable.transactionId = "late-marker"; mutable.subject = "late-title";
    mutable.body = { contentType: "text", content: "late-content" };
    return lastPage;
  };
  const result = await f.provider.readCreated(input); assert.equal(result.kind, "present");
  if (result.kind !== "present") assert.fail();
  assert.deepEqual(result.event, native); assert.equal(f.calls.length, 2);
});

test("listing page cap fails closed at 1000 requests without a POST", async () => {
  const f = fixture(Array.from({ length: 1000 }, (_, index) => response({ value: [], "@odata.nextLink": `${base}?$skip=${index + 1}` })));
  await assert.rejects(f.provider.readCreated(input), error("provider-write-failed"));
  assert.equal(f.calls.length, 1000); assert.equal(f.remaining(), 0); assert.equal(f.fences.length, 0);
});

test("strict reference explicitly requires owned calendar and complete personal correlated event", async () => {
  const me = { id: "self", mail: "owner@example.invalid" }, calendar = { id: target.calendarId, canEdit: true, owner: { address: "OWNER@example.invalid" } };
  const f = fixture([response(me), response(calendar), response({ value: [native] })], "strict-reference");
  assert.deepEqual(await f.provider.preflightCreate(input), { kind: "allowed" });
  assert.equal((await f.provider.readCreated(input)).kind, "present");
  assert.equal(f.calls[0]!.url, "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName");
  assert.equal(f.calls[1]!.url, `${base.slice(0, -7)}?$select=id,canEdit,owner`);
  assert.ok(f.calls[2]!.url.includes(",type,isOrganizer,isDraft,seriesMasterId,attendees,isOnlineMeeting&$top=100"));
  for (const change of [{ attendees: [{}] }, { type: "occurrence" }, { isOrganizer: false }, { isAllDay: true }, { isDraft: true }, { isOnlineMeeting: true }, { isDraft: undefined }])
    await assert.rejects(fixture([response({ value: [{ ...native, ...change }] })], "strict-reference").provider.readCreated(input));
  const moved = response({ value: [native] }); Object.defineProperty(moved, "url", { value: "https://other.invalid/moved" });
  await assert.rejects(fixture([moved], "strict-reference").provider.readCreated(input));
  const legacyMoved = response({ value: [native] }); Object.defineProperty(legacyMoved, "redirected", { value: true });
  assert.equal((await fixture([legacyMoved]).provider.readCreated(input)).kind, "present");
});

test("strict reference requests text explicitly instead of relying on the Graph default HTML body", async () => {
  for (const profile of ["existing-microsoft", "strict-reference"] as const) {
    const f = fixture([], profile);
    f.ports.http.fetch = async (url, init) => {
      f.calls.push({ url, init });
      const wantsText = new Headers(init.headers).get("prefer")?.includes('outlook.body-content-type="text"');
      return response({ value: [{ ...native, body: wantsText ? native.body : { contentType: "html", content: "<html><body>Notes</body></html>" } }] });
    };
    const observed = await f.provider.readCreated(input); assert.equal(observed.kind, "present");
    if (observed.kind !== "present") assert.fail();
    assert.equal((observed.event.body as { contentType: string }).contentType, profile === "strict-reference" ? "text" : "html");
    assert.equal(new Headers(f.calls[0]!.init.headers).get("prefer"), profile === "strict-reference"
      ? 'outlook.timezone="UTC", outlook.body-content-type="text"' : 'outlook.timezone="UTC"');
    assert.equal(new URL(f.calls[0]!.url).searchParams.get("$select")?.includes("@odata.etag"), false);
  }
});

test("strict POST retains raw acceptance before later verification, without claiming exact response URL", async () => {
  const res = response({ id: "native", "@odata.etag": "arbitrary" }, 201);
  Object.defineProperty(res, "url", { value: "https://other.invalid/fixture" });
  assert.deepEqual(await fixture([res], "strict-reference").provider.create(input), { kind: "created", status: 201, eventId: "native", etag: "arbitrary" });
});

test("CREATE metrics are bounded once per request and diagnostic failure never changes evidence", async () => {
  const f = fixture([response({ canEdit: true }), response({ id: "native" }, 201), new Error("SECRET_ERROR")]);
  await f.provider.preflightCreate(input); await f.provider.create(input); await assert.rejects(f.provider.readCreated(input));
  assert.deepEqual(f.metrics, [
    { provider: "microsoft", family: "event", method: "GET", status: 200, durationMs: 1 },
    { provider: "microsoft", family: "event", method: "POST", status: 201, durationMs: 1 },
    { provider: "microsoft", family: "event", method: "GET", status: "network-error", durationMs: 1 },
  ]);
  const text = JSON.stringify(f.metrics); for (const value of ["SECRET_LOCAL", "SECRET_ERROR", target.calendarId, operationId, input.body.subject]) assert.equal(text.includes(value), false);
  const silent = fixture([response({ id: "native" }, 201)]); silent.ports.telemetry.record = () => { throw new Error("ignored"); };
  assert.equal((await silent.provider.create(input)).kind, "created");
});
