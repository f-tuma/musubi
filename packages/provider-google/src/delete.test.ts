import assert from "node:assert/strict";
import test from "node:test";
import {
  createGooglePersonalEventDeleteProvider, GoogleProviderError,
  type GoogleDeleteProviderPorts, type GooglePersonalDelete, type GoogleRequestMetric,
} from "./index";
const target = { connectionId: "physical:account", connectionGeneration: "4", calendarId: "a/b@c.test", eventId: "event/a?b#c" };
const input: GooglePersonalDelete = { target, acceptedEtag: '"before"', operationId: "operation:delete", attemptId: "attempt:delete", serializer: { id: "google-personal-event", version: 1 } };
const native = { id: target.eventId, etag: '"before"', status: "confirmed", start: { dateTime: "2026-10-13T08:00:00Z" }, end: { dateTime: "2026-10-13T09:00:00Z" }, organizer: { self: true, email: "owner@test.example" } };
const eventURL = "https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40c.test/events/event%2Fa%3Fb%23c";
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
function fixture(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [], metrics: GoogleRequestMetric[] = [], fences: GooglePersonalDelete[] = [];
  let sessions = 0;
  const ports: GoogleDeleteProviderPorts = {
    accountSession: { async open(scope) { sessions++; return { ...scope, accessToken: "SECRET_LOCAL", eventWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error("Unexpected dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record(metric) { metrics.push(metric); } },
    beforeMutation: async request => { fences.push(request); },
  };
  return { provider: createGooglePersonalEventDeleteProvider(ports), ports, calls, metrics, fences, sessions: () => sessions };
}
const error = (code: GoogleProviderError["code"], outcome?: GoogleProviderError["outcome"]) =>
  (value: unknown) => value instanceof GoogleProviderError && value.code === code && (!outcome || value.outcome === outcome);

test("DELETE exact read treats missing/weak version as present evidence, retaining UPDATE's strong contract", async () => {
  for (const etag of [undefined, null, 'W/"weak"', '"before"']) {
    const f = fixture([response({ ...native, etag })]); const observed = await f.provider.readForDelete(target);
    assert.equal(observed.kind, "present"); if (observed.kind === "present") assert.equal(observed.etag, etag === '"before"' ? etag : null);
    assert.equal(f.calls[0]!.url, eventURL); assert.equal(f.calls[0]!.init.redirect, "error");
    assert.equal(new Headers(f.calls[0]!.init.headers).get("cache-control"), "no-cache"); assert.equal(f.fences.length, 0);
  }
});

test("DELETE absence and cancellation do not invent ETag or mutation acceptance", async () => {
  for (const status of [404, 410] as const) {
    const f = fixture([response({}, status)]); assert.deepEqual(await f.provider.readForDelete(target), { kind: "absent", status });
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
  const f = fixture([response({ id: target.eventId, status: "cancelled" })]);
  assert.deepEqual(await f.provider.readForDelete(target), { kind: "cancelled" });
});

test("DELETE exact read rejects partial, wrong identity, malformed endpoints and redirected scope", async () => {
  const moved = response({}, 404); Object.defineProperty(moved, "url", { value: "https://other.test/moved" });
  const redirected = response({}, 404); Object.defineProperty(redirected, "redirected", { value: true });
  for (const res of [response(native, 206), response(native, 200, { "content-range": "bytes 0-10/100" }),
    response({ ...native, id: "other" }), response({ ...native, start: { dateTime: "2026-02-30T08:00:00Z" } }),
    response({ ...native, start: { dateTime: "2026-10-13T24:00:00Z" } }), response({ ...native, end: { date: "2026-10-14" } }),
    response({ id: "other", status: "cancelled" }), moved, redirected, new Response("not JSON")]) {
    const f = fixture([res]); await assert.rejects(f.provider.readForDelete(target), value => value instanceof GoogleProviderError);
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
  const date = fixture([response({ ...native, start: { date: "2028-02-29" }, end: { date: "2028-03-01" } })]);
  assert.equal((await date.provider.readForDelete(target)).kind, "present");
});

test("DELETE preflight preserves attendee copy and organizer guest rules without UPDATE's self-only guard", async () => {
  for (const organizer of [{ self: false, email: "owner@test.example" }, { self: false }, { email: "owner@test.example" }, { self: true, email: "owner@test.example" }]) {
    const f = fixture([response({ id: target.calendarId, accessRole: "writer" }), response({ ...native, organizer, attendeesOmitted: true,
      attendees: organizer.self === true ? [{ self: true }, { organizer: true }] : [{ email: "other-guest@test.example" }] })]);
    assert.equal((await f.provider.preflightDelete(input)).kind, "allowed"); assert.equal(f.fences.length, 0);
  }
  for (const changed of [{ organizer: undefined }, { organizer: {} }, { attendees: [{ email: "guest@test.example" }] }]) {
    const f = fixture([response({ id: target.calendarId, accessRole: "owner" }), response({ ...native, ...changed })]);
    await assert.rejects(f.provider.preflightDelete(input), error("capability-evidence")); assert.equal(f.fences.length, 0);
  }
});

test("DELETE preflight weak/missing/changed versions conflict and late absence skips DELETE", async () => {
  for (const etag of [undefined, null, 'W/"weak"', '"changed"']) {
    const f = fixture([response({ id: target.calendarId, accessRole: "writer" }), response({ ...native, etag })]);
    await assert.rejects(f.provider.preflightDelete(input), error("provider-conflict", "not-written"));
  }
  const f = fixture([response({ id: target.calendarId, accessRole: "owner" }), response({}, 410)]);
  assert.deepEqual(await f.provider.preflightDelete(input), { kind: "absent", status: 410 }); assert.equal(f.fences.length, 0);
});

test("DELETE snapshots address and exact strong guard before credentials and emits no body", async () => {
  const mutable = { ...input, target: { ...target } }; const f = fixture([response({}, 204)]);
  f.ports.accountSession.open = async scope => { mutable.target.eventId = "late"; mutable.acceptedEtag = '"late"'; return { ...scope, accessToken: "token", eventWriteAllowed: true }; };
  assert.deepEqual(await f.provider.delete(mutable), { kind: "deleted", status: 204 });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, eventURL); assert.equal(f.calls[0]!.init.method, "DELETE");
  assert.equal(new Headers(f.calls[0]!.init.headers).get("if-match"), '"before"'); assert.equal(f.calls[0]!.init.body, undefined);
  assert.equal(f.calls[0]!.init.redirect, "error"); assert.equal(f.fences.length, 1); assert.equal(Object.isFrozen(f.fences[0]!.target), true);
  assert.ok(!JSON.stringify(f.metrics).includes("SECRET_LOCAL"));
});

test("DELETE native outcomes preserve old success statuses, explicit rejection and unconfirmed transport", async () => {
  for (const status of [200, 201, 204, 404, 410] as const) {
    const f = fixture([response({}, status)]); assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status }); assert.equal(f.calls.length, 1);
  }
  for (const status of [412, 401, 403, 429, 500, 302, 400]) {
    const f = fixture([response({}, status, { "retry-after": "2" })]);
    await assert.rejects(f.provider.delete(input), value => value instanceof GoogleProviderError && value.providerStatus === status &&
      value.outcome === ([412, 401, 403, 429].includes(status) ? "not-written" : "unconfirmed")); assert.equal(f.calls.length, 1);
  }
  const lost = fixture([new Error("lost body SECRET_LOCAL")]); await assert.rejects(lost.provider.delete(input), error("provider-write-failed", "unconfirmed"));
  assert.equal(lost.calls.length, 1); assert.equal(lost.metrics[0]!.status, "network-error");
});

test("DELETE fresh incarnation, OAuth grant and cancellation fence prevent native dispatch", async () => {
  for (const change of [{ connectionGeneration: "5" }, { eventWriteAllowed: false }, { eventWriteAllowed: undefined }]) {
    const f = fixture([]); f.ports.accountSession.open = async scope => ({ ...scope, accessToken: "token", eventWriteAllowed: true, ...change });
    await assert.rejects(f.provider.delete(input), value => value instanceof GoogleProviderError); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
  }
  const f = fixture([]), controller = new AbortController();
  const guarded = createGooglePersonalEventDeleteProvider({ ...f.ports, beforeMutation: async () => { controller.abort(); } });
  await assert.rejects(guarded.delete(input, controller.signal)); assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 0);
});
