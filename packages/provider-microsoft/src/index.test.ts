import assert from "node:assert/strict";
import test from "node:test";
import "./create.test";
import {
  createMicrosoftPersonalEventDeleteProvider, MicrosoftProviderError, nativeMicrosoftEtag,
  type MicrosoftAccountSession, type MicrosoftDeleteProviderPorts, type MicrosoftPersonalDelete, type MicrosoftRequestMetric,
} from "./index";

const target = { connectionId: "physical:account", connectionGeneration: "4", calendarId: "calendar/id", eventId: "event/a?b#c" };
const input: MicrosoftPersonalDelete = { target, acceptedEtag: 'W/"before"', operationId: "operation:delete", attemptId: "attempt:delete",
  serializer: { id: "microsoft-personal-event", version: 1 } };
const native = { id: target.eventId, "@odata.etag": input.acceptedEtag, subject: "Synthetic event", type: "singleInstance", isCancelled: false,
  isOrganizer: true, isDraft: false, recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null,
  isAllDay: false, start: { dateTime: "2026-10-13T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-13T09:00:00", timeZone: "UTC" },
  body: { contentType: "text", content: "Notes" }, location: { displayName: "Place" }, customProviderValue: { preserved: true } };
const me = { id: "self", mail: "owner@example.test", userPrincipalName: "other@example.test" };
const calendar = { id: target.calendarId, canEdit: true, owner: { address: "OWNER@example.test" } };
const eventURL = "https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events/event%2Fa%3Fb%23c";
const smallPrefer = 'outlook.timezone="UTC", outlook.body-content-type="text"';
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
function fixture(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [], metrics: MicrosoftRequestMetric[] = [], fences: MicrosoftPersonalDelete[] = [];
  let sessions = 0, now = 10;
  const ports: MicrosoftDeleteProviderPorts = {
    accountSession: { async open(scope) { sessions++; return { ...scope, accessToken: "SECRET_LOCAL", eventWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error("Unexpected dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => now++ },
    telemetry: { record(metric) { metrics.push(metric); } }, beforeMutation: async request => { fences.push(request); },
  };
  return { provider: createMicrosoftPersonalEventDeleteProvider(ports), ports, calls, metrics, fences, sessions: () => sessions, remaining: () => responses.length };
}
const error = (code: MicrosoftProviderError["code"], outcome?: MicrosoftProviderError["outcome"]) =>
  (value: unknown) => value instanceof MicrosoftProviderError && value.code === code && (!outcome || value.outcome === outcome);
const preflight = (event: unknown = native, owner: unknown = calendar, self: unknown = me) => [response(self), response(owner), response(event)];

test("native Graph version preserves only its original nonempty weak ETag", () => {
  assert.equal(nativeMicrosoftEtag(input.acceptedEtag), input.acceptedEtag);
  for (const value of [undefined, null, "changeKey", '"strong"', 'W/""', '*', ' W/"before"', 'W/"before" ', 'W/"line\n"', 'W/"emoji😀"', `W/"${"a".repeat(2048)}"`])
    assert.equal(nativeMicrosoftEtag(value), null);
});

test("host dispatch refusal survives Graph read and mutation catches without native evidence", async () => {
  const refusal = new Error("fixture budget refusal"), f = fixture([]);
  f.ports.http.dispatch = async () => { throw refusal; }; f.ports.http.isDispatchDeferred = value => value === refusal;
  await assert.rejects(f.provider.readForDelete(target), value => value === refusal);
  await assert.rejects(f.provider.delete(input), value => value === refusal);
  assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 0);
});

test("delivery and verification exact reads retain native JSON and the distinct legacy Prefer headers", async () => {
  const f = fixture([response(native), response(native)]);
  const observed = await f.provider.readForDelete(target);
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") assert.fail();
  assert.deepEqual(observed.event, native); assert.equal(observed.etag, input.acceptedEtag);
  assert.ok(Object.isFrozen(observed.event)); assert.ok(Object.isFrozen(observed.event.customProviderValue));
  await f.provider.readForDelete(target, undefined, "verification");
  assert.equal(f.sessions(), 2); assert.equal(f.fences.length, 0);
  f.calls.forEach(call => { assert.equal(call.url, eventURL); assert.equal(call.init.method, "GET"); assert.equal(call.init.redirect, "error");
    assert.equal(new Headers(call.init.headers).get("cache-control"), "no-cache"); assert.ok(call.init.signal instanceof AbortSignal); });
  assert.equal(new Headers(f.calls[0]!.init.headers).get("prefer"), `${smallPrefer}, odata.maxpagesize=100`);
  assert.equal(new Headers(f.calls[1]!.init.headers).get("prefer"), smallPrefer);
});

test("observation does not require personal shape, a usable validator or current write grant", async () => {
  for (const etag of [undefined, null, '"strong"', 'W/"changed"']) {
    const f = fixture([response({ ...native, "@odata.etag": etag, isCancelled: true, isOrganizer: false, isAllDay: true,
      type: "occurrence", attendees: [{}], recurrence: {}, seriesMasterId: "parent", isOnlineMeeting: true })]);
    f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "read-only", eventWriteAllowed: false });
    const observed = await f.provider.readForDelete(target);
    assert.equal(observed.kind, "present"); if (observed.kind === "present") assert.equal(observed.etag, etag === 'W/"changed"' ? etag : null);
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
});

test("only exact event 404 supplies absence; 410 and partial/malformed reads are failures", async () => {
  const missing = fixture([response({}, 404)]); assert.deepEqual(await missing.provider.readForDelete(target), { kind: "absent", status: 404 });
  const moved = response({}, 404); Object.defineProperty(moved, "url", { value: "https://other.invalid/moved" });
  const redirected = response({}, 404); Object.defineProperty(redirected, "redirected", { value: true });
  for (const res of [response({}, 410), response(native, 206), response(native, 200, { "content-range": "bytes 0-10/100" }),
    response({ ...native, id: "other" }), response({ ...native, start: { dateTime: "invalid" } }), response({ ...native, end: {} }),
    response({ ...native, start: null }), moved, redirected, new Response("not JSON")]) {
    const f = fixture([res]); await assert.rejects(f.provider.readForDelete(target), value => value instanceof MicrosoftProviderError);
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
});

test("complete preflight proves current identity, owned calendar, exact version and timed personal shape", async () => {
  const f = fixture(preflight());
  const result = await f.provider.preflightDelete(input); assert.equal(result.kind, "allowed");
  assert.deepEqual(f.calls.map(call => call.url), ["https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
    "https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid?$select=id,canEdit,owner", eventURL]);
  f.calls.forEach(call => assert.equal(new Headers(call.init.headers).get("prefer"), smallPrefer));
  assert.equal(f.fences.length, 0);
  const fallback = fixture(preflight(native, calendar, { ...me, mail: null, userPrincipalName: "owner@example.test" }));
  assert.equal((await fallback.provider.preflightDelete(input)).kind, "allowed");
});

test("event 404 is a preflight no-op only after current calendar/owner proof", async () => {
  const f = fixture([response(me), response(calendar), response({}, 404)]);
  assert.deepEqual(await f.provider.preflightDelete(input), { kind: "absent", status: 404 }); assert.equal(f.calls.length, 3);
  for (const owner of [{ ...calendar, owner: { address: "other@example.test" } }, { ...calendar, canEdit: false }, { ...calendar, canEdit: undefined },
    { ...calendar, id: "other" }, { ...calendar, owner: null }]) {
    const denied = fixture([response(me), response(owner), response({}, 404)]);
    await assert.rejects(denied.provider.preflightDelete(input), error("capability-evidence")); assert.equal(denied.calls.length, 2);
  }
  for (const self of [{ id: "", mail: me.mail }, { ...me, mail: "invalid" }, { ...me, mail: "", userPrincipalName: "owner@example.test" }]) {
    const denied = fixture(preflight(native, calendar, self));
    await assert.rejects(denied.provider.preflightDelete(input), error("capability-evidence")); assert.equal(denied.calls.length, 2);
  }
});

test("changed or missing native version and every unsupported personal shape prevent dispatch", async () => {
  for (const etag of [undefined, null, '"strong"', 'W/"changed"']) {
    const f = fixture(preflight({ ...native, "@odata.etag": etag }));
    await assert.rejects(f.provider.preflightDelete(input), error(etag === 'W/"changed"' ? "provider-conflict" : "provider-version-unavailable"));
    assert.equal(f.fences.length, 0);
  }
  for (const change of [{ attendees: [{}] }, { attendees: undefined }, { type: "seriesMaster" }, { type: "occurrence" }, { recurrence: {} },
    { recurrence: undefined }, { seriesMasterId: "master" }, { isCancelled: true }, { isOrganizer: false }, { isDraft: true }, { isDraft: undefined },
    { isOnlineMeeting: true }, { isOnlineMeeting: undefined }, { onlineMeeting: {} }, { onlineMeetingUrl: "https://meeting.invalid" },
    { "@removed": {} }, { "@odata.nextLink": "next" }, { "attendees@odata.nextLink": "next" }, { isAllDay: true }, { isAllDay: undefined },
    { start: { dateTime: "2026-02-30T08:00:00", timeZone: "UTC" } }, { start: { ...native.start, timeZone: "Europe/Prague" } },
    { end: { dateTime: "2026-10-13T07:00:00", timeZone: "UTC" } }]) {
    const f = fixture(preflight({ ...native, ...change }));
    await assert.rejects(f.provider.preflightDelete(input), error("capability-evidence"));
    assert.ok(f.calls.every(call => call.init.method === "GET")); assert.equal(f.fences.length, 0);
  }
});

test("invalid command data and read modes fail before credentials or any other port", async () => {
  let getterCalls = 0;
  const getter = { ...input }; Object.defineProperty(getter, "acceptedEtag", { enumerable: true, get() { getterCalls++; return input.acceptedEtag; } });
  const hidden = { ...input }; Object.defineProperty(hidden, "hidden", { value: true });
  const symbol = { ...input, [Symbol("extra")]: true };
  for (const invalid of [{ ...input, extra: true }, { ...input, acceptedEtag: '"strong"' }, { ...input, acceptedEtag: 'W/""' },
    { ...input, target: { ...target, eventId: ".." } }, { ...input, target: { ...target, calendarId: " " } },
    { ...input, target: { ...target, authorization: "escape" } }, { ...input, operationId: "" },
    { ...input, serializer: { id: "google-personal-event", version: 1 } }, { ...input, serializer: { ...input.serializer, extra: true } }, getter, hidden, symbol]) {
    for (const method of ["delete", "preflightDelete"] as const) {
      const f = fixture([]); await assert.rejects(f.provider[method](invalid as MicrosoftPersonalDelete), value => value instanceof MicrosoftProviderError);
      assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0); assert.equal(f.metrics.length, 0);
    }
  }
  const f = fixture([]); await assert.rejects(f.provider.readForDelete(target, undefined, "unsafe" as "delivery")); assert.equal(f.sessions(), 0);
  assert.equal(getterCalls, 0);
});

test("fresh session incarnation and refreshed OAuth grant fence every mutation", async () => {
  for (const change of [{ connectionGeneration: "5" }, { connectionId: "another" }, { eventWriteAllowed: false }, { eventWriteAllowed: undefined }, { accessToken: "" }]) {
    for (const method of ["delete", "preflightDelete"] as const) {
      const f = fixture([]); f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "token", eventWriteAllowed: true, ...change });
      await assert.rejects(f.provider[method](input), value => value instanceof MicrosoftProviderError);
      assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
    }
  }
  const f = fixture(preflight());
  await f.provider.preflightDelete(input);
  f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "token", eventWriteAllowed: false });
  await assert.rejects(f.provider.delete(input), error("capability-evidence")); assert.equal(f.calls.length, 3); assert.equal(f.fences.length, 0);
});

test("DELETE snapshots request and session before suspended credentials and host fences", async () => {
  const mutable = { ...input, target: { ...target }, serializer: { ...input.serializer } };
  const f = fixture([response({}, 204)]);
  let current!: MicrosoftAccountSession;
  f.ports.accountSession.open = async scope => {
    mutable.target.eventId = "late"; mutable.acceptedEtag = 'W/"late"'; mutable.operationId = "late";
    current = { ...scope, accessToken: "original-secret", eventWriteAllowed: true }; return current;
  };
  const guarded = createMicrosoftPersonalEventDeleteProvider({ ...f.ports, beforeMutation: async request => {
    assert.deepEqual(request, input); assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.target)); assert.ok(Object.isFrozen(request.serializer));
    (current as { accessToken: string }).accessToken = "mutated-secret";
  } });
  assert.deepEqual(await guarded.delete(mutable), { kind: "deleted", status: 204 });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, eventURL); assert.equal(f.calls[0]!.init.body, undefined);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("if-match"), input.acceptedEtag);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("authorization"), "Bearer original-secret");
  assert.equal(new Headers(f.calls[0]!.init.headers).get("prefer"), null);
});

test("raw DELETE returns only 204/404 acceptance with no hidden GET or retry", async () => {
  for (const status of [204, 404] as const) {
    const f = fixture([response({}, status)]); assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status });
    assert.equal(f.sessions(), 1); assert.equal(f.fences.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.init.method, "DELETE");
  }
  for (const status of [200, 201, 202, 206, 301, 400, 401, 403, 408, 409, 410, 412, 429, 500, 503]) {
    const f = fixture([response({}, status, { "retry-after": "2" })]);
    await assert.rejects(f.provider.delete(input), value => value instanceof MicrosoftProviderError && value.providerStatus === status &&
      value.code === (status === 412 ? "provider-conflict" : "provider-write-failed") &&
      value.outcome === (status === 408 || status >= 500 || status >= 200 && status < 300 ? "unconfirmed" : "not-written") && value.retryAfterMs === 2000);
    assert.equal(f.calls.length, 1);
  }
  const lost = fixture([new Error("lost response SECRET_LOCAL")]); await assert.rejects(lost.provider.delete(input), error("provider-write-failed", "unconfirmed"));
  assert.equal(lost.calls.length, 1);
});

test("accepted mutation and verification failure remain separate native facts", async () => {
  for (const verification of [response(native), response({}, 403), response({}, 410), new Response("truncated")]) {
    const f = fixture([response({}, 204), verification]);
    const accepted = await f.provider.delete(input); assert.deepEqual(accepted, { kind: "deleted", status: 204 });
    const observed = await f.provider.readForDelete(target, undefined, "verification").catch(value => value);
    assert.ok(observed instanceof MicrosoftProviderError || observed.kind === "present");
    assert.deepEqual(accepted, { kind: "deleted", status: 204 }); assert.equal(f.calls.filter(call => call.init.method === "DELETE").length, 1);
  }
});

test("Graph accepting an edit in the GET/DELETE gap explicitly demonstrates the lack of CAS", async () => {
  const f = fixture(preflight()); await f.provider.preflightDelete(input);
  let remote = { ...native, "@odata.etag": 'W/"changed-after-preflight"' };
  f.ports.http.fetch = async (url, init) => {
    f.calls.push({ url, init });
    assert.equal(remote["@odata.etag"], 'W/"changed-after-preflight"');
    assert.equal(new Headers(init.headers).get("if-match"), input.acceptedEtag);
    remote = { ...remote, id: "deleted" }; return response({}, 204);
  };
  assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status: 204 }); assert.equal(remote.id, "deleted");
  assert.equal(f.calls.filter(call => call.init.method === "DELETE").length, 1);
});

test("redirected scope is never evidence even for 404, and mutation redirection remains unconfirmed", async () => {
  for (const change of [{ key: "url", value: "https://graph.microsoft.com/v1.0/me/events/different" }, { key: "redirected", value: true }]) {
    const res = response({}, 404); Object.defineProperty(res, change.key, { value: change.value });
    const f = fixture([res]); await assert.rejects(f.provider.delete(input), error("provider-write-failed", "unconfirmed")); assert.equal(f.calls.length, 1);
  }
});

test("aborted credentials, authority fences and in-flight requests cannot dispatch again", async () => {
  const before = fixture([]), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(before.provider.delete(input, cancelled.signal)); assert.equal(before.sessions(), 0);
  const fence = fixture([]), controller = new AbortController();
  const guarded = createMicrosoftPersonalEventDeleteProvider({ ...fence.ports, beforeMutation: async () => { controller.abort(); } });
  await assert.rejects(guarded.delete(input, controller.signal)); assert.equal(fence.calls.length, 0); assert.equal(fence.metrics.length, 0);
  const inflight = fixture([]), during = new AbortController();
  inflight.ports.http.fetch = async (_url, init) => { assert.notEqual(init.signal, during.signal); during.abort(); return response({}, 204); };
  await assert.rejects(inflight.provider.delete(input, during.signal), error("provider-write-failed", "unconfirmed"));
  // The raw HTTP span observed 204. The later operation guard still rejects
  // cancellation; host work after headers cannot rewrite that HTTP receipt.
  assert.equal(inflight.metrics[0]!.status, 204);
});

test("native observation snapshots do not retain mutable HTTP objects or invoke accessors", async () => {
  const mutable = structuredClone(native), res = response({});
  res.json = async () => mutable;
  const f = fixture([res]); const observed = await f.provider.readForDelete(target);
  mutable.start.dateTime = "changed"; mutable.customProviderValue.preserved = false;
  assert.equal(observed.kind, "present"); if (observed.kind === "present") assert.deepEqual(observed.event, native);
  let getters = 0; const bad = { ...native }; Object.defineProperty(bad, "unknown", { enumerable: true, get() { getters++; return "unsafe"; } });
  const hostile = response({}); hostile.json = async () => bad;
  await assert.rejects(fixture([hostile]).provider.readForDelete(target), error("provider-write-failed")); assert.equal(getters, 0);
});

test("preflight retains the identity read before the next suspended HTTP call", async () => {
  const mutable = { ...me }, identityResponse = response({}); identityResponse.json = async () => mutable;
  const f = fixture([identityResponse, response(calendar), response(native)]), fetch = f.ports.http.fetch;
  f.ports.http.fetch = async (url, init) => {
    if (url.includes("/me/calendars/")) mutable.mail = "other@example.test";
    return fetch(url, init);
  };
  assert.equal((await f.provider.preflightDelete(input)).kind, "allowed"); assert.equal(f.calls.length, 3);
});

test("retained native JSON is bounded and rejects cycles, hidden fields and rich objects", async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const hidden = { ...native }; Object.defineProperty(hidden, "hidden", { value: true });
  for (const value of [{ ...native, extra: cycle }, { ...native, extra: new Date() }, { ...native, extra: Infinity },
    { ...native, extra: "x".repeat(2_000_001) }, { ...native, extra: Array.from({ length: 10_001 }, () => null) }, hidden,
    { ...native, start: { ...native.start, timeZone: 1 } }]) {
    const res = response({}); res.json = async () => value;
    const f = fixture([res]); await assert.rejects(f.provider.readForDelete(target), error("provider-write-failed")); assert.equal(f.calls.length, 1);
  }
});

test("metrics are scoped, bounded, secret-free and have no authority over results", async () => {
  const f = fixture([response(native), new Error("SECRET_LOCAL native private failure"), response({}, 204)]);
  await f.provider.readForDelete(target);
  const caught = await f.provider.delete(input).catch(value => value);
  assert.ok(caught instanceof MicrosoftProviderError); assert.ok(!String(caught).includes("SECRET_LOCAL"));
  assert.deepEqual(f.metrics, [
    { provider: "microsoft", family: "event", method: "GET", status: 200, durationMs: 1 },
    { provider: "microsoft", family: "event", method: "DELETE", status: "network-error", durationMs: 1 },
  ]);
  const serialized = JSON.stringify(f.metrics); for (const privateValue of ["SECRET_LOCAL", target.eventId, target.calendarId, input.operationId]) assert.ok(!serialized.includes(privateValue));
  f.ports.telemetry.record = () => { throw new Error("diagnostic failed"); };
  assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status: 204 });
});

test("read transient failures carry Retry-After while current denial stays capability evidence", async () => {
  for (const status of [408, 429, 503]) {
    const f = fixture([response({}, status, { "retry-after": "Thu, 01 Jan 1970 00:00:03 GMT" })]);
    await assert.rejects(f.provider.readForDelete(target), value => value instanceof MicrosoftProviderError && value.outcome === "not-written" && value.retryAfterMs === 3000);
  }
  for (const status of [401, 403]) await assert.rejects(fixture([response({}, status)]).provider.readForDelete(target),
    value => value instanceof MicrosoftProviderError && value.code === "capability-evidence" && value.evidence === "denied");
});
