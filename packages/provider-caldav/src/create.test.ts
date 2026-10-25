import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";
import {
  caldavPersonalCreateIdentityV1, createCaldavPersonalEventCreateProvider, normalizeCaldavCreateProjection, CaldavProviderError,
  type CaldavAccountSession, type CaldavCreateProviderPorts, type CaldavNativeProfile, type CaldavPersonalCreate, type CaldavRequestMetric,
} from "./index";

const operationId = "abcdef01-abcd-4000-8000-abcdefabcdef", calendarUrl = "https://dav.example.test/cal/";
const identity = caldavPersonalCreateIdentityV1(calendarUrl, operationId)!;
const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Synthetic fixture//EN", "BEGIN:VEVENT", `UID:${identity.uid}`,
  "DTSTART:20261013T080000Z", "DTEND:20261013T090000Z", "SUMMARY:Synthetic event", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const input: CaldavPersonalCreate = { target: { connectionId: "physical:account", connectionGeneration: "1760000000000", calendarUrl, ...identity },
  body, operationId, attemptId: "attempt:create", serializer: { id: "caldav-personal-event", version: 1 } };
const response = (data: string | null = body, status = 200, headers?: Record<string, string>) =>
  new Response([204, 205, 304].includes(status) ? null : data, { status, headers });
const acl = (grants = ["bind"], href = calendarUrl) => response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop><d:current-user-privilege-set>${grants.map(name => `<d:privilege><d:${name}/></d:privilege>`).join("")}</d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 207);
function fixture(responses: (Response | Error)[], nativeProfile: CaldavNativeProfile = "existing-caldav") {
  const calls: { url: string; init: RequestInit; address: string }[] = [], metrics: CaldavRequestMetric[] = [], fences: CaldavPersonalCreate[] = [];
  let sessions = 0, now = 0, dns = 0;
  const ports: CaldavCreateProviderPorts = {
    accountSession: { async open(scope) { sessions++; return { ...scope, authorization: "Basic SECRET_LOCAL" }; } },
    network: { allowPrivate: false, async lookupImpl() { dns++; return [{ address: "203.0.113.10", family: 4 }]; } },
    http: { async fetchPinned(url, init, address) { calls.push({ url: url.href, init, address: address.address });
      const next = responses.shift(); if (!next) throw new Error("Unexpected native dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => now++ }, telemetry: { record(value) { metrics.push(value); } },
    async beforeMutation(request) { fences.push(request); },
  };
  return { provider: createCaldavPersonalEventCreateProvider(ports, { nativeProfile }), ports, calls, metrics, fences,
    sessions: () => sessions, dns: () => dns, remaining: () => responses.length };
}
const error = (code: CaldavProviderError["code"], outcome?: CaldavProviderError["outcome"]) =>
  (value: unknown) => value instanceof CaldavProviderError && value.code === code && (!outcome || value.outcome === outcome);

test("CREATE raw URL/UID identity preserves optional slash and long derived resource addresses", async () => {
  assert.equal(caldavPersonalCreateIdentityV1(calendarUrl.slice(0, -1), operationId)?.resourceUrl, identity.resourceUrl);
  for (const id of [operationId.toUpperCase(), "not-uuid", null]) assert.equal(caldavPersonalCreateIdentityV1(calendarUrl, id), null);
  for (const collection of [calendarUrl.slice(0, -1), `${calendarUrl}?opaque=1`, `${calendarUrl}#opaque`, `https://dav.example.test/${"a".repeat(2023)}`]) {
    assert.ok(collection.length <= 2048);
    const derived = caldavPersonalCreateIdentityV1(collection, operationId)!, request = { ...input, target: { ...input.target, calendarUrl: collection, ...derived } };
    const f = fixture([response(null, 201)]); const created = await f.provider.create(request);
    assert.equal(created.resourceUrl, derived.resourceUrl); assert.equal(f.calls[0]!.url, new URL(derived.resourceUrl).href);
  }
});

test("frozen CREATE identity/body coherence fails before credentials, DNS, telemetry or HTTP", async () => {
  let getters = 0;
  const accessor = { ...input }; Object.defineProperty(accessor, "body", { enumerable: true, get() { getters++; return body; } });
  const candidates = [accessor, { ...input, operationId: operationId.toUpperCase() }, { ...input, extra: true },
    { ...input, target: { ...input.target, uid: "different" } }, { ...input, target: { ...input.target, resourceUrl: `${calendarUrl}wrong.ics` } },
    { ...input, body: body.replace(identity.uid, "different") }, { ...input, serializer: { id: "caldav-personal-event", version: 2 } },
    { ...input, body: body.replace("DTSTART:20261013T080000Z", "DTSTART;VALUE=DATE:20261013") },
    { ...input, body: body.replace("SUMMARY:", "RRULE:FREQ=DAILY\r\nSUMMARY:") },
    { ...input, body: body.replace("SUMMARY:", "ATTENDEE:mailto:nobody@example.invalid\r\nSUMMARY:") }];
  for (const candidate of candidates) for (const method of ["preflightCreate", "create", "readCreated"] as const) {
    const f = fixture([]); await assert.rejects(f.provider[method](candidate as CaldavPersonalCreate));
    assert.equal(f.sessions(), 0); assert.equal(f.dns(), 0); assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 0); assert.equal(f.fences.length, 0);
  }
  assert.equal(getters, 0);
});

test("CREATE preflight reads only current collection bind/all/write privileges", async () => {
  for (const grant of [["bind"], ["write"], ["all"]]) {
    const f = fixture([acl(grant)]); assert.deepEqual(await f.provider.preflightCreate(input), { kind: "allowed" });
    assert.deepEqual(f.calls.map(call => [call.url, call.init.method]), [[calendarUrl, "PROPFIND"]]);
    assert.equal(new Headers(f.calls[0]!.init.headers).get("depth"), "0"); assert.equal(f.fences.length, 0);
  }
  for (const grant of [[], ["unbind"], ["read"], ["write-content"]]) await assert.rejects(fixture([acl(grant)]).provider.preflightCreate(input),
    value => value instanceof CaldavProviderError && value.evidence === "denied");
  for (const res of [response("malformed", 207), response(null, 403), acl(["bind"], "https://dav.example.test/other/")])
    await assert.rejects(fixture([res]).provider.preflightCreate(input), value => value instanceof CaldavProviderError && value.evidence === "unknown");
  for (const status of [408, 429, 503]) await assert.rejects(fixture([response(null, status, { "retry-after": "2" })]).provider.preflightCreate(input),
    value => value instanceof CaldavProviderError && value.providerStatus === status && value.retryAfterMs === 2000 && value.outcome === "not-written");
});

test("fresh session revision and final host authority fence every CREATE", async () => {
  for (const change of [{ connectionId: "other" }, { connectionGeneration: "later" }, { authorization: "" }]) {
    const f = fixture([]); f.ports.accountSession.open = async scope => ({ ...scope, authorization: "Basic LOCAL", ...change });
    await assert.rejects(f.provider.create(input)); assert.equal(f.calls.length, 0); assert.equal(f.fences.length, 0);
  }
  const f = fixture([acl()]); await f.provider.preflightCreate(input);
  f.ports.accountSession.open = async scope => ({ ...scope, connectionGeneration: "later", authorization: "Basic LOCAL" });
  await assert.rejects(f.provider.create(input), error("account-session-changed")); assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
});

test("conditional PUT owns frozen saved bytes and credentials across both suspension points", async () => {
  type Writable<T> = { -readonly [Key in keyof T]: Writable<T[Key]> };
  const mutable = structuredClone(input) as Writable<CaldavPersonalCreate>, f = fixture([response(null, 201)]);
  let current!: CaldavAccountSession;
  f.ports.accountSession.open = async scope => { mutable.body = "late"; mutable.target.resourceUrl = "https://other.invalid/late";
    current = { ...scope, authorization: "Basic ORIGINAL" }; return current; };
  const guarded = createCaldavPersonalEventCreateProvider({ ...f.ports, async beforeMutation(request) {
    assert.deepEqual(request, input); assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.target));
    (current as { authorization: string }).authorization = "Basic LATE";
  } }, { nativeProfile: "existing-caldav" });
  await guarded.create(mutable);
  assert.equal(f.calls[0]!.url, identity.resourceUrl); assert.equal(f.calls[0]!.init.body, body);
  const headers = new Headers(f.calls[0]!.init.headers); assert.equal(headers.get("if-none-match"), "*"); assert.equal(headers.get("if-match"), null);
  assert.equal(headers.get("authorization"), "Basic ORIGINAL"); assert.equal(headers.get("content-type"), "text/calendar; charset=utf-8");
});

test("PUT native acceptance normalizes strong or null ETags and never reads automatically", async () => {
  for (const status of [200, 201, 204] as const) for (const etag of [undefined, "", 'W/"weak"', '""', '"DAV,opaque\\tag"', "malformed"]) {
    const f = fixture([response(null, status, etag === undefined ? {} : { etag })]);
    assert.deepEqual(await f.provider.create(input), { kind: "created", status, ...identity, etag: etag?.startsWith('"') ? etag : null });
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1); assert.equal(f.sessions(), 1);
  }
  for (const status of [202, 206, 400, 401, 403, 408, 409, 410, 412, 429, 500, 503]) {
    const f = fixture([response(null, status, { "retry-after": "2" })]);
    await assert.rejects(f.provider.create(input), value => value instanceof CaldavProviderError && value.providerStatus === status && value.retryAfterMs === 2000 &&
      value.code === (status === 412 ? "provider-conflict" : "provider-write-failed") && value.outcome === (status < 300 || status >= 500 ? "unconfirmed" : "not-written"));
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1);
  }
});

test("CREATE recovery retains bytes for host normalization before cancellation/date refusals", async () => {
  const malformedCancelled = body.replace("DTSTART:20261013T080000Z\r\n", "").replace("SUMMARY:", "STATUS:CANCELLED\r\nSUMMARY:");
  const extra = body.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:unrelated\r\nDTSTART:20261013T100000Z\r\nDTEND:20261013T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR");
  for (const native of [body, malformedCancelled, extra, body.replace("SUMMARY:", "ATTENDEE:mailto:nobody@example.invalid\r\nSUMMARY:")]) {
    const f = fixture([response(native, 200, { etag: 'W/"weak"' })]); const read = await f.provider.readCreated(input);
    assert.equal(read.kind, "present"); if (read.kind !== "present") assert.fail();
    assert.deepEqual(read.resource, { ...identity, data: native }); assert.equal(read.etag, null); assert.ok(Object.isFrozen(read.resource));
    const headers = new Headers(f.calls[0]!.init.headers); assert.equal(headers.get("accept"), "text/calendar"); assert.equal(headers.get("cache-control"), "no-cache");
    assert.equal(f.fences.length, 0);
  }
});

test("only planned resource 404 is retry evidence; 410 and incomplete/invalid reads never supply absence", async () => {
  assert.deepEqual(await fixture([response(null, 404)]).provider.readCreated(input), { kind: "absent", status: 404 });
  for (const res of [response(null, 410), response(body, 206), response(body, 200, { "content-range": "bytes 0-1/2" }), response(body.replace(identity.uid, "wrong"))])
    await assert.rejects(fixture([res]).provider.readCreated(input));
  const invalidUTF8 = new Response(new Uint8Array([0xc3, 0x28]));
  await assert.rejects(fixture([invalidUTF8]).provider.readCreated(input), value => value instanceof TypeError && !(value instanceof CaldavProviderError));
  await assert.rejects(fixture([response("not iCalendar")]).provider.readCreated(input), value => value instanceof Error && !(value instanceof CaldavProviderError));
  const raw = new TypeError("SYNTHETIC_PRIVATE"); await assert.rejects(fixture([raw]).provider.create(input), value => value === raw);
});

test("existing conditional PUT redirects preserve body and condition, re-pin DNS and strip cross-origin authorization", async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = fixture([response(null, status, { location: "/alias/event.ics" }), response(null, 201, { etag: '"created"' })]);
    const result = await f.provider.create(input); assert.equal(result.resourceUrl, identity.resourceUrl);
    assert.equal(f.calls.length, 2); assert.equal(f.dns(), 2); assert.equal(f.metrics.length, 2); assert.equal(f.fences.length, 1);
    for (const call of f.calls) { assert.equal(call.init.method, "PUT"); assert.equal(call.init.body, body); assert.equal(new Headers(call.init.headers).get("if-none-match"), "*"); }
  }
  const cross = fixture([response(null, 307, { location: "https://other.example.test/alias.ics" }), response(null, 204)]); await cross.provider.create(input);
  assert.equal(new Headers(cross.calls[1]!.init.headers).get("authorization"), null);
  const refused = fixture([response(null, 303, { location: "/alias/event.ics" })]); await assert.rejects(refused.provider.create(input)); assert.equal(refused.calls.length, 1);
  const denied = fixture([]);
  const deniedProvider = createCaldavPersonalEventCreateProvider({ ...denied.ports, network: { ...denied.ports.network,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 }] } }, { nativeProfile: "existing-caldav" });
  await assert.rejects(deniedProvider.create(input)); assert.equal(denied.calls.length, 0);
});

test("strict reference rejects aliases, unsupported resource trees and unproven organizers without principal discovery", async () => {
  const redirect = fixture([response(null, 307, { location: "/alias/event.ics" })], "strict-reference");
  await assert.rejects(redirect.provider.readCreated(input)); assert.equal(redirect.calls.length, 1);
  for (const native of [body.replace("SUMMARY:", "ORGANIZER:mailto:owner@example.invalid\r\nSUMMARY:"),
    body.replace("END:VEVENT", "BEGIN:VEVENT\r\nUID:hidden\r\nEND:VEVENT\r\nEND:VEVENT"),
    body.replace("SUMMARY:", "ATTENDEE:mailto:nobody@example.invalid\r\nSUMMARY:")]) {
    const f = fixture([response(native)], "strict-reference"); await assert.rejects(f.provider.readCreated(input)); assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 0);
  }
});

test("portable CREATE projection handles UTC and owned embedded zones, preserving native text", () => {
  const resource = { ...identity, data: body };
  const expected = { title: "Synthetic event", description: null, location: null, start: "2026-10-13T08:00:00.000Z", end: "2026-10-13T09:00:00.000Z", isAllDay: false, recurrence: null };
  assert.deepEqual(normalizeCaldavCreateProjection(resource), expected);
  assert.deepEqual(normalizeCaldavCreateProjection({ ...resource, data: body.replace("SUMMARY:Synthetic event", "SUMMARY:") }), { ...expected, title: "" });
  const zone = ["BEGIN:VTIMEZONE", "TZID:Fixture/Fixed", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
  const zoned = body.replace("BEGIN:VEVENT", `${zone}\r\nBEGIN:VEVENT`).replace("DTSTART:20261013T080000Z", "DTSTART;TZID=Fixture/Fixed:20261013T090000").replace("DTEND:20261013T090000Z", "DTEND;TZID=Fixture/Fixed:20261013T100000");
  assert.deepEqual(normalizeCaldavCreateProjection({ ...resource, data: zoned }), expected);
  for (const data of [body.replace(/0000Z/g, "0000"), body.replace("SUMMARY:", "STATUS:CANCELLED\r\nSUMMARY:"),
    body.replace("SUMMARY:", "ORGANIZER:mailto:owner@example.invalid\r\nSUMMARY:"), body.replace(identity.uid, "wrong")])
    assert.equal(normalizeCaldavCreateProjection({ ...resource, data }), null);
});

test("portable CREATE projection refuses an ambient alias to UTC without a resource-owned definition", () => {
  const alias = "Ambient/UTC", previous = ICAL.TimezoneService.get(alias);
  const data = body.replace("DTSTART:20261013T080000Z", `DTSTART;TZID=${alias}:20261013T080000`)
    .replace("DTEND:20261013T090000Z", `DTEND;TZID=${alias}:20261013T090000`);
  try {
    ICAL.TimezoneService.remove(alias);
    assert.equal(normalizeCaldavCreateProjection({ ...identity, data }), null);
    ICAL.TimezoneService.register(ICAL.Timezone.utcTimezone, alias);
    assert.equal(normalizeCaldavCreateProjection({ ...identity, data }), null);
    // A resource definition remains authoritative even when an ambient alias
    // with the same TZID points at UTC instead of the resource's actual offset.
    const zone = ["BEGIN:VTIMEZONE", `TZID:${alias}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
    const owned = data.replace("BEGIN:VEVENT", `${zone}\r\nBEGIN:VEVENT`);
    const projected = normalizeCaldavCreateProjection({ ...identity, data: owned });
    assert.equal(projected?.start, "2026-10-13T07:00:00.000Z"); assert.equal(projected?.end, "2026-10-13T08:00:00.000Z");
  } finally {
    if (previous) ICAL.TimezoneService.register(previous, alias); else ICAL.TimezoneService.remove(alias);
  }
});

test("CREATE metrics count each actual leaf once with bounded secret-free labels", async () => {
  const f = fixture([acl(), response(null, 201), new Error("PRIVATE_FAILURE")]);
  await f.provider.preflightCreate(input); await f.provider.create(input); await assert.rejects(f.provider.readCreated(input));
  assert.deepEqual(f.metrics, [
    { provider: "caldav", family: "event", method: "PROPFIND", status: 207, durationMs: 1 },
    { provider: "caldav", family: "event", method: "PUT", status: 201, durationMs: 1 },
    { provider: "caldav", family: "event", method: "GET", status: "network-error", durationMs: 1 },
  ]);
  const data = JSON.stringify(f.metrics); for (const value of ["SECRET_LOCAL", "PRIVATE_FAILURE", input.target.resourceUrl, input.target.uid, operationId]) assert.equal(data.includes(value), false);
  const silent = fixture([response(null, 204)]); silent.ports.telemetry.record = () => { throw new Error("ignored"); };
  assert.equal((await silent.provider.create(input)).kind, "created");
});
