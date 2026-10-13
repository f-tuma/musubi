import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createGooglePersonalEventProvider, GoogleProviderError, strongGoogleEtag,
  type GoogleEventTarget, type GooglePersonalUpdate, type GoogleProviderPorts, type GoogleRequestMetric,
} from "./index";

const target: GoogleEventTarget = { connectionId: "opaque:account", connectionGeneration: "23", calendarId: "calendar/a@b.test", eventId: "event/a?b#c" };
const accepted: GooglePersonalUpdate = { target, acceptedEtag: '"accepted"', body: { summary: "Title", description: null, location: "  Room  " }, operationId: "operation:one", attemptId: "attempt:two", serializer: { id: "google-personal-event", version: 1 } };
const event = { id: target.eventId, etag: '"accepted"', status: "confirmed", summary: "Old", start: { dateTime: "2026-10-13T08:00:00.000Z" }, end: { dateTime: "2026-10-13T09:00:00.000Z" }, organizer: { email: "owner@example.test", self: true } };
const eventURL = "https://www.googleapis.com/calendar/v3/calendars/calendar%2Fa%40b.test/events/event%2Fa%3Fb%23c";
const calendarURL = "https://www.googleapis.com/calendar/v3/users/me/calendarList/calendar%2Fa%40b.test";
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers });
function fixture(responses: (Response | Error)[], override: Partial<GoogleProviderPorts> = {}) {
  const calls: { url: string; init: RequestInit }[] = [], metrics: GoogleRequestMetric[] = [], fences: GooglePersonalUpdate[] = [];
  let sessions = 0, time = 0;
  const ports: GoogleProviderPorts = {
    accountSession: { async open(connection) { sessions++; return { ...connection, accessToken: "secret-not-in-metrics", eventWriteAllowed: true }; } },
    http: { async fetch(url, init) { calls.push({ url, init }); const next = responses.shift(); if (!next) throw new Error("Unexpected dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => Date.parse("2026-10-13T00:00:00Z"), nowMonotonicMs: () => time += 7 },
    telemetry: { record(metric) { metrics.push(metric); } },
    beforeMutation: async request => { fences.push(request); },
    ...override,
  };
  return { provider: createGooglePersonalEventProvider(ports), calls, metrics, fences, sessions: () => sessions, ports };
}
function error(code: GoogleProviderError["code"], outcome?: GoogleProviderError["outcome"]) {
  return (value: unknown) => value instanceof GoogleProviderError && value.code === code && (outcome === undefined || value.outcome === outcome);
}

test("preflight fresh ACL, exact native ID/version and personal organizer evidence", async () => {
  const f = fixture([response({ id: target.calendarId, accessRole: "writer" }), response(event)]);
  const result = await f.provider.preflightUpdate(accepted);
  assert.equal(result.kind, "allowed"); assert.equal(result.etag, accepted.acceptedEtag);
  assert.deepEqual(f.calls.map(c => c.url), [calendarURL, eventURL]);
  for (const call of f.calls) {
    assert.equal(call.init.method, "GET"); assert.equal(call.init.redirect, "error");
    assert.equal(new Headers(call.init.headers).get("cache-control"), "no-cache");
  }
  assert.deepEqual(f.metrics.map(m => [m.method, m.status, m.durationMs]), [["GET", 200, 7], ["GET", 200, 7]]);
  assert.equal(f.fences.length, 0);
});

test("calendar preflight refuses wrong or missing native identity", async () => {
  for (const calendar of [{ accessRole: "owner" }, { id: "other", accessRole: "writer" }]) {
    const f = fixture([response(calendar), response(event)]);
    await assert.rejects(f.provider.preflightUpdate(accepted), error("provider-conflict", "not-written"));
    assert.equal(f.calls.length, 1);
  }
});

test("native accepted content and exact strong If-Match reach one PATCH", async () => {
  const signal = new AbortController().signal, f = fixture([response({ etag: '"new"' })]);
  assert.deepEqual(await f.provider.update(accepted, signal), { kind: "written", etag: '"new"' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, eventURL);
  assert.equal(f.calls[0]!.init.method, "PATCH"); assert.equal(f.calls[0]!.init.signal, signal);
  assert.equal(f.calls[0]!.init.redirect, "error"); assert.equal(new Headers(f.calls[0]!.init.headers).get("if-match"), '"accepted"');
  assert.deepEqual(JSON.parse(f.calls[0]!.init.body as string), accepted.body);
  assert.equal(f.fences.length, 1); assert.equal(f.fences[0]!.operationId, accepted.operationId);
});

test("async credential resolution cannot change the captured native input", async () => {
  const mutable = { ...accepted, body: { summary: "Captured" }, target: { ...target } };
  const f = fixture([response({ etag: '\"new\"' })], {
    accountSession: { async open(connection) {
      mutable.body.summary = "Changed while refreshing"; mutable.target.calendarId = "different calendar";
      return { ...connection, accessToken: "token", eventWriteAllowed: true };
    } },
    beforeMutation: async request => {
      assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.target), true);
      assert.equal(Object.isFrozen(request.body), true); assert.equal(Object.isFrozen(request.serializer), true);
    },
  });
  await f.provider.update(mutable);
  assert.equal(f.calls[0]!.url, eventURL);
  assert.deepEqual(JSON.parse(f.calls[0]!.init.body as string), { summary: "Captured" });
});

test("empty admitted body skips credentials, authority fence and native write", async () => {
  const f = fixture([]);
  assert.deepEqual(await f.provider.update({ ...accepted, body: {} }), { kind: "not-written", reason: "empty-body" });
  assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0); assert.equal(f.metrics.length, 0);
});

test("body allowlist rejects unsupported mutation and malformed codec before credentials", async () => {
  for (const body of [{ attendees: [] }, { summary: null }, { description: undefined }, { summary: "x".repeat(2_000_001) }]) {
    const f = fixture([]);
    await assert.rejects(f.provider.update({ ...accepted, body } as unknown as GooglePersonalUpdate), error("event-diff-unavailable"));
    assert.equal(f.sessions(), 0); assert.equal(f.calls.length, 0);
  }
  const f = fixture([]);
  await assert.rejects(f.provider.update({ ...accepted, serializer: { id: "future", version: 2 } } as unknown as GooglePersonalUpdate), error("event-diff-unavailable"));
});

test("preflight cannot infer a grant from missing OAuth or ACL evidence", async () => {
  for (const allowed of [false, undefined]) {
    const f = fixture([], { accountSession: { async open(connection) { return { ...connection, accessToken: "token", eventWriteAllowed: allowed }; } } });
    await assert.rejects(f.provider.preflightUpdate(accepted), (e: unknown) => e instanceof GoogleProviderError && e.capability === "event-write" && e.evidence === (allowed === false ? "denied" : "unknown"));
    assert.equal(f.calls.length, 0);
  }
  for (const calendar of [{ id: target.calendarId }, { id: target.calendarId, accessRole: "reader" }, { id: target.calendarId, accessRole: "writerWithoutPrivateAccess" }]) {
    const f = fixture([response(calendar)]);
    await assert.rejects(f.provider.preflightUpdate(accepted), error("capability-evidence"));
    assert.equal(f.calls.length, 1);
  }
});

test("preflight does not turn an invited, guest-notifying, hidden-attendee or recurring copy into a personal write", async () => {
  for (const changed of [
    { organizer: { email: "another@example.test" } }, { organizer: undefined },
    { attendees: [{ email: "guest@example.test" }] }, { attendeesOmitted: true },
    { recurrence: ["RRULE:FREQ=DAILY"] }, { recurringEventId: "series" },
    { originalStartTime: event.start },
  ]) {
    const f = fixture([response({ id: target.calendarId, accessRole: "owner" }), response({ ...event, ...changed })]);
    await assert.rejects(f.provider.preflightUpdate(accepted), error("capability-evidence"));
    assert.equal(f.calls.length, 2); assert.equal(f.fences.length, 0);
  }
});

test("preflight refuses wrong identity, cancellation, mismatched and missing validator", async () => {
  for (const [changed, code] of [
    [{ id: "other" }, "provider-conflict"], [{ status: "cancelled" }, "provider-conflict"],
    [{ etag: '"changed"' }, "provider-conflict"], [{ etag: undefined }, "provider-version-unavailable"],
  ] as const) {
    const f = fixture([response({ id: target.calendarId, accessRole: "owner" }), response({ ...event, ...changed })]);
    await assert.rejects(f.provider.preflightUpdate(accepted), error(code));
  }
});

test("current account session incarnation and write grant are checked after refresh", async () => {
  for (const changed of [{ connectionGeneration: "24" }, { connectionId: "another" }]) {
    const f = fixture([], { accountSession: { async open(connection) { return { ...connection, ...changed, accessToken: "token", eventWriteAllowed: true }; } } });
    await assert.rejects(f.provider.update(accepted), error("account-session-changed", "not-written"));
    assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
    await assert.rejects(f.provider.readEvent(target), error("account-session-changed"));
  }
  const f = fixture([], { accountSession: { async open(connection) { return { ...connection, accessToken: "narrowed-token", eventWriteAllowed: false }; } } });
  await assert.rejects(f.provider.update(accepted), error("capability-evidence"));
  assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
});

test("host authority fence after asynchronous credentials can reject without dispatch", async () => {
  const order: string[] = [];
  const denied = new Error("Host source/privacy/lease changed");
  const f = fixture([], {
    accountSession: { async open(connection) { await Promise.resolve(); order.push("session"); return { ...connection, accessToken: "token", eventWriteAllowed: true }; } },
    beforeMutation: async request => { order.push("fence"); assert.equal(request.acceptedEtag, accepted.acceptedEtag); throw denied; },
  });
  await assert.rejects(f.provider.update(accepted), value => value === denied);
  assert.deepEqual(order, ["session", "fence"]); assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 0);
});

test("412 never produces an unconditional PATCH retry", async () => {
  const f = fixture([response({}, 412), response({ etag: '"would-be-retry"' })]);
  await assert.rejects(f.provider.update(accepted), error("provider-conflict", "not-written"));
  assert.equal(f.calls.length, 1); assert.equal(f.metrics.length, 1);
});

test("native mutation outcomes distinguish refusal from uncertain acceptance", async () => {
  for (const status of [400, 401, 403, 408, 429, 500, 503, 202, 206]) {
    const f = fixture([response({}, status, { "retry-after": "12" })]);
    await assert.rejects(f.provider.update(accepted), (value: unknown) => value instanceof GoogleProviderError && value.providerStatus === status && value.outcome === (status >= 500 || status === 202 || status === 206 ? "unconfirmed" : "not-written") && value.retryAfterMs === 12000);
    assert.equal(f.calls.length, 1);
  }
  const lost = fixture([new Error("Lost reply")]);
  await assert.rejects(lost.provider.update(accepted), error("provider-write-failed", "unconfirmed"));
  assert.deepEqual(lost.metrics.map(m => m.status), ["network-error"]);
});

test("Retry-After HTTP date uses injected epoch and diagnostics omit all identities/secrets", async () => {
  const f = fixture([response({}, 503, { "retry-after": "Tue, 13 Oct 2026 00:00:30 GMT" })]);
  await assert.rejects(f.provider.update(accepted), (value: unknown) => value instanceof GoogleProviderError && value.retryAfterMs === 30000);
  assert.deepEqual(f.metrics[0], { provider: "google", family: "event", method: "PATCH", status: 503, durationMs: 7 });
  assert.equal(JSON.stringify(f.metrics).includes("secret"), false); assert.equal(JSON.stringify(f.metrics).includes("calendar/a"), false);
});

test("wrong native identity in a PATCH success is uncertain and cannot adopt its validator", async () => {
  const f = fixture([response({ id: "wrong-object", etag: '\"different\"' })]);
  await assert.rejects(f.provider.update(accepted), error("provider-write-failed", "unconfirmed"));
  assert.equal(f.calls.length, 1);
});

test("malformed success body remains native acceptance with no adopted validator", async () => {
  for (const res of [new Response("broken-json", { status: 200 }), new Response(null, { status: 204 }), response({ etag: 'W/"weak"' })]) {
    const f = fixture([res]);
    assert.deepEqual(await f.provider.update(accepted), { kind: "written", etag: null });
    assert.equal(f.calls.length, 1);
  }
});

test("scope-bound exact read accepts read-only credentials and retains selected native state", async () => {
  const native = { ...event, summary: undefined, description: null, location: undefined,
    iCalUID: "native@example.test", htmlLink: "https://example.test/event", eventType: "default", recurringEventId: "series",
    originalStartTime: event.start, recurrence: ["RRULE:FREQ=DAILY"],
    attendees: [{ self: true, responseStatus: "accepted", displayName: "Owner" }],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    conferenceData: { entryPoints: [{ uri: "https://example.test/meeting" }] },
    extendedProperties: { private: { musubiOperationID: "op" } }, unknownLargeProviderField: { discarded: true } };
  const f = fixture([response(native)], { accountSession: { async open(connection) { return { ...connection, accessToken: "read-only", eventWriteAllowed: false }; } } });
  const observed = await f.provider.readEvent(target);
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") throw new Error("Missing read");
  assert.equal(observed.event.summary, undefined); assert.equal(observed.event.description, null);
  assert.equal(observed.event.iCalUID, native.iCalUID); assert.deepEqual(observed.event.reminders, native.reminders);
  assert.deepEqual(observed.event.conferenceData, native.conferenceData); assert.equal("unknownLargeProviderField" in observed.event, false);
  assert.equal(observed.etag, '"accepted"'); assert.equal(f.fences.length, 0);
});

test("exact native absence and cancellation never become present content evidence", async () => {
  for (const status of [404, 410] as const) {
    const f = fixture([response({}, status)]);
    assert.deepEqual(await f.provider.readEvent(target), { kind: "absent", status });
  }
  const cancelled = fixture([response({ id: target.eventId, status: "cancelled" })]);
  assert.deepEqual(await cancelled.provider.readEvent(target), { kind: "cancelled" });
});

test("partial, malformed, misidentified or validatorless reads cannot authorize recovery ACK", async () => {
  const responses = [
    response(event, 206), response(event, 200, { "content-range": "bytes 0-10/20" }),
    response({ ...event, id: "other" }), response({ ...event, summary: 7 }),
    response({ ...event, start: { dateTime: "2026-02-30T08:00:00Z" } }),
    response({ ...event, start: { dateTime: "2026-10-13T24:00:00Z" } }),
    response({ ...event, start: { dateTime: "2026-10-13T08:00:00+01:60" } }),
    response({ ...event, end: { date: "2026-10-14" } }), response({ ...event, attendees: {} }),
    response({ ...event, start: undefined }), response({ ...event, etag: undefined }), response({ ...event, etag: 'W/"weak"' }),
    new Response("not json", { status: 200 }),
  ];
  for (const res of responses) {
    const f = fixture([res]);
    await assert.rejects(f.provider.readEvent(target), value => value instanceof GoogleProviderError);
    assert.equal(f.calls.length, 1);
  }
});

test("valid leap-day offset and DATE exclusive end remain native rather than product-normalized", async () => {
  for (const times of [
    { start: { dateTime: "2028-02-29T08:00:00.456+01:00" }, end: { dateTime: "2028-02-29T09:00:00.789+01:00" } },
    { start: { date: "2028-02-29" }, end: { date: "2028-03-01" } },
  ]) {
    const f = fixture([response({ ...event, ...times })]);
    const observed = await f.provider.readEvent(target);
    assert.equal(observed.kind, "present");
    if (observed.kind === "present") { assert.deepEqual(observed.event.start, times.start); assert.deepEqual(observed.event.end, times.end); }
  }
});

test("event GET has no hidden OAuth retry and rate-limited read retains Retry-After", async () => {
  const denied = fixture([response({}, 401), response(event)]);
  await assert.rejects(denied.provider.readEvent(target), error("capability-evidence"));
  assert.equal(denied.calls.length, 1); assert.equal(denied.sessions(), 1);
  const limited = fixture([response({}, 429, { "retry-after": "9" })]);
  await assert.rejects(limited.provider.readEvent(target), value => value instanceof GoogleProviderError && value.retryAfterMs === 9000 && value.outcome === "not-written");
});

test("pre-aborted and late credential/fence cancellation dispatch nothing and count no HTTP", async () => {
  const controller = new AbortController(); controller.abort();
  const early = fixture([]);
  await assert.rejects(early.provider.update(accepted, controller.signal));
  assert.equal(early.sessions(), 0); assert.equal(early.metrics.length, 0);
  const lateController = new AbortController(), late = fixture([], { beforeMutation: async () => { lateController.abort(); } });
  await assert.rejects(late.provider.update(accepted, lateController.signal));
  assert.equal(late.calls.length, 0); assert.equal(late.metrics.length, 0);
});

test("actual aborted HTTP is counted once; telemetry failure does not replace native acceptance", async () => {
  const controller = new AbortController();
  const f = fixture([], { http: { async fetch() { controller.abort(); throw new DOMException("Cancelled", "AbortError"); } } });
  await assert.rejects(f.provider.update(accepted, controller.signal), error("provider-write-failed", "unconfirmed"));
  assert.deepEqual(f.metrics.map(m => m.status), ["aborted"]);
  const diagnostics = fixture([response({ etag: '"new"' })], { telemetry: { record() { throw new Error("Metrics unavailable"); } } });
  assert.deepEqual(await diagnostics.provider.update(accepted), { kind: "written", etag: '"new"' });
});

test("provider runtime imports no product/storage/auth/config package or ambient HTTP/clock", () => {
  const sourceDir = fileURLToPath(new URL(".", import.meta.url));
  const files = readdirSync(sourceDir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.deepEqual(files.sort(), ["index.ts", "types.ts"]);
  for (const file of files) {
    const code = readFileSync(`${sourceDir}/${file}`, "utf8");
    const imports = [...code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map(match => match[1]);
    assert.ok(imports.every(path => path?.startsWith("./")), `${file}: only package-local imports`);
    assert.equal(/(?:globalThis\s*\.|\bDate\s*\.\s*now\s*\(|\bperformance\s*\.\s*now\s*\(|\bprocess\s*\.)/.test(code), false, `${file}: no ambient runtime services`);
    const runtimeCode = code.replace("fetch(url: string, init: RequestInit): Promise<Response>", "explicitHttpPortSignature");
    assert.equal(/(?:^|[^.\w])fetch\s*\(/m.test(runtimeCode), false, `${file}: no global fetch`);
  }
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.equal(strongGoogleEtag('"exact"'), '"exact"'); assert.equal(strongGoogleEtag('W/"exact"'), null);
});
