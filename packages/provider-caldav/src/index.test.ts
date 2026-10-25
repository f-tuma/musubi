import assert from "node:assert/strict";
import test from "node:test";
import "./create.test";
import { readFile } from "node:fs/promises";
import {
  createCaldavPersonalEventDeleteProvider, CaldavProviderError, strongCaldavEtag, selectCaldavEventMaster,
  type CaldavDeleteProviderPorts, type CaldavPersonalDelete, type CaldavRequestMetric, type CaldavNativeProfile,
} from "./index";
import { createGuardedCaldavFetch, createPinnedCaldavFetch } from "./network";
import { isBlockedAddress } from "./network-origin";
import { DavReadResponseError, davMultistatus } from "./dav-properties";

const target = { connectionId: "physical:account", connectionGeneration: "1760000000000", calendarUrl: "https://dav.example.test/cal/",
  resourceUrl: "https://dav.example.test/cal/event.ics", uid: "native-uid" };
const input: CaldavPersonalDelete = { target, acceptedEtag: '"DAV,opaque\\tag"', operationId: "operation:delete", attemptId: "attempt:delete",
  serializer: { id: "caldav-personal-event", version: 1 } };
const native = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Synthetic fixture//EN", "BEGIN:VEVENT", "UID:native-uid", "DTSTART:20261013T080000Z",
  "DTEND:20261013T090000Z", "SUMMARY;LANGUAGE=en:Native event", "X-UNKNOWN:keep", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT5M", "DESCRIPTION:Keep", "END:VALARM", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const response = (body: string | null = native, status = 200, headers: Record<string, string> = { etag: input.acceptedEtag }) =>
  new Response(status === 204 ? null : body, { status, headers });
const prop = (url: string, value: string) => response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${url}</d:href><d:propstat><d:prop>${value}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, 207, { "content-type": "application/xml" });
const acl = (privileges: string[] = ["unbind"]) => prop(target.calendarUrl, `<d:current-user-privilege-set>${privileges.map(name => `<d:privilege><d:${name}/></d:privilege>`).join("")}</d:current-user-privilege-set>`);
const principal = () => prop(target.calendarUrl, "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>");
const addresses = (address = "owner@example.test") => prop("https://dav.example.test/principal/", `<c:calendar-user-address-set><d:href>mailto:${address}</d:href></c:calendar-user-address-set>`);
function fixture(responses: (Response | Error)[], nativeProfile: CaldavNativeProfile = "existing-caldav") {
  const calls: { url: string; init: RequestInit; address: string }[] = [], metrics: CaldavRequestMetric[] = [], fences: CaldavPersonalDelete[] = [];
  let sessions = 0, now = 0, resolutions = 0;
  const ports: CaldavDeleteProviderPorts = {
    accountSession: { async open(scope) { sessions++; return { ...scope, authorization: "Basic SECRET_LOCAL" }; } },
    network: { allowPrivate: false, async lookupImpl() { resolutions++; return [{ address: "203.0.113.10", family: 4 }]; } },
    http: { async fetchPinned(url, init, address) { calls.push({ url: url.href, init, address: address.address });
      const next = responses.shift(); if (!next) throw new Error("Unexpected native dispatch"); if (next instanceof Error) throw next; return next; } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => now++ }, telemetry: { record(value) { metrics.push(value); } },
    async beforeMutation(request) { fences.push(request); },
  };
  return { provider: createCaldavPersonalEventDeleteProvider(ports, { nativeProfile }), ports, calls, metrics, fences,
    sessions: () => sessions, resolutions: () => resolutions, remaining: () => responses.length };
}
const error = (code: CaldavProviderError["code"], outcome?: CaldavProviderError["outcome"]) =>
  (value: unknown) => value instanceof CaldavProviderError && value.code === code && (!outcome || value.outcome === outcome);

test("DAV strong ETag is opaque native text with no weak-tag repair", () => {
  for (const value of [input.acceptedEtag, '""', '"latinÿ"']) assert.equal(strongCaldavEtag(value), value);
  for (const value of [undefined, null, "", "*", 'W/"weak"', ' "space"', '"bad\nline"', '"emoji😀"']) assert.equal(strongCaldavEtag(value), null);
});

test("exact native resource observation retains bytes and provider UID with nullable versions", async () => {
  for (const tag of [input.acceptedEtag, 'W/"weak"', null]) {
    const f = fixture([response(native, 200, tag === null ? {} : { etag: tag })]);
    const read = await f.provider.readForDelete(target); assert.equal(read.kind, "present");
    if (read.kind === "present") {
      assert.deepEqual(read.resource, { resourceUrl: target.resourceUrl, uid: target.uid, data: native });
      assert.equal(read.etag, tag === input.acceptedEtag ? tag : null); assert.ok(Object.isFrozen(read.resource));
    }
    assert.equal(f.calls[0]!.url, target.resourceUrl); assert.equal(f.calls[0]!.init.redirect, "manual");
    assert.equal(new Headers(f.calls[0]!.init.headers).get("accept"), "text/calendar");
    assert.equal(new Headers(f.calls[0]!.init.headers).get("cache-control"), "no-cache"); assert.equal(f.fences.length, 0);
  }
});

test("read 404 is absence; 410, cancelled resource and malformed data retain distinct floors", async () => {
  assert.deepEqual(await fixture([response(null, 404)]).provider.readForDelete(target), { kind: "absent", status: 404 });
  await assert.rejects(fixture([response(null, 410)]).provider.readForDelete(target), error("capability-evidence"));
  await assert.rejects(fixture([response(native.replace("SUMMARY;", "STATUS:CANCELLED\r\nSUMMARY;"))]).provider.readForDelete(target), error("provider-conflict"));
  for (const text of [native.replace("UID:native-uid", "UID:wrong"), native.replace("UID:native-uid", "UID:native-uid\r\nUID:native-uid"), native.replace("DTSTART:20261013T080000Z\r\n", "")])
    await assert.rejects(fixture([response(text)]).provider.readForDelete(target), error("provider-write-failed"));
  const badUTF8 = new Response(new Uint8Array([0xc3, 0x28]), { headers: { etag: input.acceptedEtag } });
  await assert.rejects(fixture([badUTF8]).provider.readForDelete(target), value => value instanceof TypeError && !(value instanceof CaldavProviderError));
  await assert.rejects(fixture([response("this is not iCalendar")]).provider.readForDelete(target), value => value instanceof Error && !(value instanceof CaldavProviderError));
  const dated = native.replace("DTEND:", "RDATE:20261014T080000Z\r\nDTEND:");
  await assert.rejects(fixture([response(dated)]).provider.readForDelete(target), value => value instanceof CaldavProviderError && value.capability === "recurrence" && value.evidence === "unsupported");
});

test("generic preflight proves collection unbind and accepted resource version without hidden mutation", async () => {
  for (const grant of [["unbind"], ["write"], ["all"]]) {
    const f = fixture([acl(grant), response()]); const result = await f.provider.preflightDelete(input);
    assert.equal(result.kind, "allowed"); assert.equal(result.etag, input.acceptedEtag); assert.equal(result.resource.data, native);
    assert.deepEqual(f.calls.map(call => [call.url, call.init.method ?? "GET"]), [[target.calendarUrl, "PROPFIND"], [target.resourceUrl, "GET"]]);
    assert.equal(new Headers(f.calls[0]!.init.headers).get("depth"), "0"); assert.equal(f.fences.length, 0);
  }
  for (const grant of [[], ["read"], ["write-content"]]) {
    const f = fixture([acl(grant)]); await assert.rejects(f.provider.preflightDelete(input), value => value instanceof CaldavProviderError && value.evidence === "denied");
    assert.equal(f.calls.length, 1);
  }
});

test("late preflight 404 is unknown, never completion; missing ACL is not DELETE permission", async () => {
  const missing = fixture([acl(), response(null, 404)]);
  await assert.rejects(missing.provider.preflightDelete(input), value => value instanceof CaldavProviderError && value.code === "capability-evidence" && value.evidence === "unknown");
  assert.equal(missing.calls.length, 2);
  const omitted = response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${target.calendarUrl}</d:href><d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`, 207);
  for (const res of [omitted, response(null, 401), response("broken XML", 207), prop(target.resourceUrl, "<d:current-user-privilege-set/>")]) {
    const f = fixture([res]); await assert.rejects(f.provider.preflightDelete(input), value => value instanceof CaldavProviderError && value.evidence === "unknown");
    assert.equal(f.calls.length, 1);
  }
});

test("preflight never adopts a changed or unavailable strong version and rejects incomplete GET", async () => {
  for (const tag of [null, 'W/"weak"', '"changed"']) {
    const f = fixture([acl(), response(native, 200, tag === null ? {} : { etag: tag })]);
    await assert.rejects(f.provider.preflightDelete(input), error(tag === '"changed"' ? "provider-conflict" : "provider-version-unavailable"));
  }
  for (const res of [response(native, 206), response(native, 200, { etag: input.acceptedEtag, "content-range": "bytes 0-9/100" })])
    await assert.rejects(fixture([acl(), res]).provider.preflightDelete(input), error("provider-write-failed"));
});

test("generic organizer guards distinguish own meeting, unproven principal and appointment", async () => {
  const owned = native.replace("UID:native-uid", "UID:native-uid\r\nORGANIZER:mailto:OWNER@example.test");
  assert.equal((await fixture([acl(), response(owned), principal(), addresses()]).provider.preflightDelete(input)).kind, "allowed");
  const meeting = owned.replace("UID:native-uid", "UID:native-uid\r\nATTENDEE:mailto:guest@example.test");
  await assert.rejects(fixture([acl(), response(meeting), principal(), addresses()]).provider.preflightDelete(input),
    value => value instanceof CaldavProviderError && value.capability === "organizer" && value.evidence === "unsupported");
  for (const result of [addresses("other@example.test"), response(null, 403)])
    await assert.rejects(fixture([acl(), response(owned), principal(), result]).provider.preflightDelete(input),
      value => value instanceof CaldavProviderError && value.capability === "organizer" && value.evidence === "unknown");
  const foreignPrincipal = prop(target.calendarUrl, "<d:current-user-principal><d:href>https://other.example.test/principal/</d:href></d:current-user-principal>");
  const f = fixture([acl(), response(owned), foreignPrincipal]);
  await assert.rejects(f.provider.preflightDelete(input), error("capability-evidence")); assert.equal(f.calls.length, 3);
});

test("existing profile retains extra masters, overrides and orphan attendees while reference refuses them", async () => {
  const extra = "BEGIN:VEVENT\r\nUID:other-uid\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nEND:VEVENT\r\n";
  const detached = "BEGIN:VEVENT\r\nUID:native-uid\r\nRECURRENCE-ID:20261014T080000Z\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nEND:VEVENT\r\n";
  for (const data of [native.replace("END:VCALENDAR", extra + "END:VCALENDAR"), native.replace("END:VCALENDAR", detached + "END:VCALENDAR"),
    native.replace("UID:native-uid", "UID:native-uid\r\nATTENDEE:mailto:orphan@example.test"), native.replace("UID:native-uid", "UID:native-uid\r\nRRULE:FREQ=DAILY;COUNT=2")]) {
    assert.equal((await fixture([acl(), response(data)]).provider.preflightDelete(input)).kind, "allowed");
    await assert.rejects(fixture([acl(), response(data)], "strict-reference").provider.preflightDelete(input), error("capability-evidence"));
  }
  assert.equal((await fixture([acl(), response(native)], "strict-reference").provider.preflightDelete(input)).kind, "allowed", "VALARM and unknown properties are retained");
  const allDay = native.replace("DTSTART:20261013T080000Z", "DTSTART;VALUE=DATE:20261013").replace("DTEND:20261013T090000Z", "DTEND;VALUE=DATE:20261014");
  await assert.rejects(fixture([acl(), response(allDay)], "strict-reference").provider.preflightDelete(input), error("capability-evidence"));
});

test("strict-reference direct-child rules do not silently narrow generic saved URLs", async () => {
  for (const resourceUrl of ["https://dav.example.test/other/event.ics", "https://other.example.test/event.ics", "https://dav.example.test/cal/nested/event.ics",
    "https://dav.example.test/cal/event.ics?query=1", "https://dav.example.test/cal/event%252Fother.ics", "https://dav.example.test/cal/event%2Fother.ics"]) {
    const scope = { ...target, resourceUrl }, strict = fixture([], "strict-reference");
    await assert.rejects(strict.provider.readForDelete(scope), error("provider-conflict")); assert.equal(strict.sessions(), 0);
    const generic = fixture([response()]); assert.equal((await generic.provider.readForDelete(scope)).kind, "present"); assert.equal(generic.calls[0]!.url, resourceUrl);
  }
});

test("strict-reference validates every component-tree branch before allowing whole-resource DELETE", async () => {
  const event = "BEGIN:VEVENT\r\nUID:nested-uid\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nEND:VEVENT\r\n";
  const todo = "BEGIN:VTODO\r\nUID:nested-todo\r\nEND:VTODO\r\n";
  const unknown = "BEGIN:X-NATIVE-COMPONENT\r\nX-PRIVATE:keep\r\nEND:X-NATIVE-COMPONENT\r\n";
  const observance = "BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nX-PRIVATE:keep\r\nEND:STANDARD\r\n";
  const timezone = `BEGIN:VTIMEZONE\r\nTZID:Owned/Unmodified\r\nX-PRIVATE:keep\r\n${observance}END:VTIMEZONE\r\n`;
  const atRoot = (child: string) => native.replace("BEGIN:VEVENT\r\n", child + "BEGIN:VEVENT\r\n");
  const inEvent = (child: string) => native.replace("END:VEVENT\r\nEND:VCALENDAR", child + "END:VEVENT\r\nEND:VCALENDAR");
  const bad = [inEvent(event), inEvent(todo), inEvent(unknown), inEvent(timezone), inEvent(observance),
    native.replace("END:VALARM", event + "END:VALARM"), native.replace("END:VALARM", todo + "END:VALARM"),
    native.replace("END:VALARM", unknown + "END:VALARM"), atRoot("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM\r\n"),
    atRoot(timezone.replace("END:VTIMEZONE", event + "END:VTIMEZONE")),
    atRoot(timezone.replace("END:STANDARD", "BEGIN:DAYLIGHT\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nEND:DAYLIGHT\r\nEND:STANDARD")),
    atRoot(timezone.replace("END:STANDARD", unknown + "END:STANDARD")),
    atRoot("BEGIN:VTIMEZONE\r\nTZID:Empty/Zone\r\nEND:VTIMEZONE\r\n"),
    native.replace("ACTION:DISPLAY\r\n", "")];
  for (const data of bad) {
    const strict = fixture([acl(), response(data)], "strict-reference");
    await assert.rejects(strict.provider.preflightDelete(input), value => value instanceof CaldavProviderError && value.evidence === "unsupported");
    assert.equal(strict.fences.length, 0); assert.ok(strict.calls.every(call => call.init.method !== "DELETE"));
  }
  // These are existing native extras, not a new generic Musubi guard.
  assert.equal((await fixture([acl(), response(inEvent(event))]).provider.preflightDelete(input)).kind, "allowed");
  const daylight = observance.replaceAll("STANDARD", "DAYLIGHT").replace("DTSTART:19700101T000000", "DTSTART:19700329T020000").replace("TZOFFSETTO:+0000", "TZOFFSETTO:+0100");
  const positive = atRoot(timezone.replace("END:VTIMEZONE", daylight + "END:VTIMEZONE"));
  const accepted = await fixture([acl(), response(positive)], "strict-reference").provider.preflightDelete(input);
  assert.equal(accepted.kind, "allowed"); assert.equal(accepted.resource.data, positive, "valid timezone/alarm and all unknown properties remain byte-identical");
});

test("strict-reference refuses scheduling METHOD without adding a generic API guard", async () => {
  const scheduling = native.replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:PUBLISH");
  await assert.rejects(fixture([acl(), response(scheduling)], "strict-reference").provider.preflightDelete(input),
    value => value instanceof CaldavProviderError && value.evidence === "unsupported");
  assert.equal((await fixture([acl(), response(scheduling)]).provider.preflightDelete(input)).kind, "allowed");
});

test("guarded redirects preserve generic aliases and per-hop metrics; reference refuses every redirect", async () => {
  const moved = () => response(null, 307, { location: "/alias/event.ics" });
  const final = response(); Object.defineProperty(final, "url", { value: "https://dav.example.test/alias/event.ics" });
  const f = fixture([moved(), final]); const read = await f.provider.readForDelete(target);
  assert.equal(read.kind, "present"); if (read.kind === "present") assert.equal(read.resource.resourceUrl, target.resourceUrl);
  assert.deepEqual(f.calls.map(call => call.url), [target.resourceUrl, "https://dav.example.test/alias/event.ics"]);
  assert.equal(f.resolutions(), 2); assert.equal(f.metrics.length, 2); assert.deepEqual(f.metrics.map(metric => metric.status), [307, 200]);
  const strict = fixture([moved()], "strict-reference"); await assert.rejects(strict.provider.readForDelete(target), error("provider-write-failed")); assert.equal(strict.calls.length, 1);
  const wrongURL = response(null, 404); Object.defineProperty(wrongURL, "url", { value: "https://dav.example.test/other.ics" });
  await assert.rejects(fixture([wrongURL], "strict-reference").provider.readForDelete(target), error("provider-write-failed"));
});

test("DELETE 301/302/307/308 remain conditional DELETE; 303 can never become a successful GET", async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = fixture([response(null, status, { location: "/alias/event.ics" }), response(null, 204)]);
    assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status: 204 });
    assert.equal(f.calls.length, 2); f.calls.forEach(call => { assert.equal(call.init.method, "DELETE"); assert.equal(new Headers(call.init.headers).get("if-match"), input.acceptedEtag); });
  }
  const f = fixture([response(null, 303, { location: "/success" })]);
  await assert.rejects(f.provider.delete(input), value => value instanceof Error && !(value instanceof CaldavProviderError)); assert.equal(f.calls.length, 1);
});

test("cross-origin credentials are stripped and public/private DNS policy applies before each leaf", async () => {
  const f = fixture([response(null, 302, { location: "https://other.example.test/event.ics" }), response()]);
  await f.provider.readForDelete(target);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("authorization"), "Basic SECRET_LOCAL");
  assert.equal(new Headers(f.calls[1]!.init.headers).get("authorization"), null);
  const blocked = fixture([]);
  const guarded = createCaldavPersonalEventDeleteProvider({ ...blocked.ports, network: { allowPrivate: false,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 }] } }, { nativeProfile: "existing-caldav" });
  await assert.rejects(guarded.readForDelete(target), /internal address/); assert.equal(blocked.calls.length, 0); assert.equal(blocked.metrics.length, 0);
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true); assert.equal(isBlockedAddress("fe80.example.test"), false);
});

test("raw mutation statuses preserve generic DAV outcome floor including HTTP 408", async () => {
  for (const status of [200, 201, 204, 404] as const) {
    const f = fixture([response(null, status)]); assert.deepEqual(await f.provider.delete(input), { kind: "deleted", status });
    assert.equal(f.calls.length, 1); assert.equal(f.fences.length, 1); assert.equal(f.calls[0]!.init.body, undefined);
  }
  for (const status of [202, 400, 401, 403, 408, 410, 412, 429, 500]) {
    const f = fixture([response(null, status, { "retry-after": "2" })]);
    await assert.rejects(f.provider.delete(input), value => value instanceof CaldavProviderError && value.providerStatus === status && value.retryAfterMs === 2000 &&
      value.code === (status === 412 ? "provider-conflict" : "provider-write-failed") && value.outcome === (status === 202 || status >= 500 ? "unconfirmed" : "not-written"));
    assert.equal(f.calls.length, 1);
  }
  const raw = new TypeError("Synthetic lost reply SECRET_LOCAL"), f = fixture([raw]);
  await assert.rejects(f.provider.delete(input), value => value === raw); assert.equal(f.calls.length, 1);
});

test("bad inputs fail before credentials/DNS/metrics and never invoke getters", async () => {
  let getters = 0; const accessor = { ...input }; Object.defineProperty(accessor, "acceptedEtag", { enumerable: true, get() { getters++; return input.acceptedEtag; } });
  const hidden = { ...input }; Object.defineProperty(hidden, "hidden", { value: true });
  for (const invalid of [{ ...input, extra: true }, { ...input, acceptedEtag: 'W/"weak"' }, { ...input, serializer: { ...input.serializer, version: 2 } },
    { ...input, target: { ...target, uid: "" } }, { ...input, target: { ...target, uid: "line\n" } }, { ...input, target: { ...target, headers: {} } },
    { ...input, target: { ...target, resourceUrl: "ftp://example.test/file" } }, accessor, hidden]) {
    for (const method of ["preflightDelete", "delete"] as const) {
      const f = fixture([]); await assert.rejects(f.provider[method](invalid as CaldavPersonalDelete));
      assert.equal(f.sessions(), 0); assert.equal(f.resolutions(), 0); assert.equal(f.calls.length, 0); assert.equal(f.metrics.length, 0);
    }
  }
  assert.equal(getters, 0);
});

test("native target/request and authorization are frozen before suspended credentials and host fence", async () => {
  const mutable = { ...input, target: { ...target } }, f = fixture([response(null, 204)]);
  let current!: { connectionId: string; connectionGeneration: string; authorization: string };
  f.ports.accountSession.open = async scope => { mutable.target.resourceUrl = "https://other.example.test/late"; mutable.target.uid = "late"; mutable.acceptedEtag = '"late"';
    current = { ...scope, authorization: "Basic ORIGINAL" }; return current; };
  const guarded = createCaldavPersonalEventDeleteProvider({ ...f.ports, beforeMutation: async accepted => {
    assert.deepEqual(accepted, input); assert.ok(Object.isFrozen(accepted)); assert.ok(Object.isFrozen(accepted.target)); current.authorization = "Basic LATE";
  } }, { nativeProfile: "existing-caldav" });
  await guarded.delete(mutable); assert.equal(f.calls[0]!.url, target.resourceUrl);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("if-match"), input.acceptedEtag);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("authorization"), "Basic ORIGINAL");
});

test("changed incarnation, cancelled work and failed host fence cannot dispatch", async () => {
  const changed = fixture([]); changed.ports.accountSession.open = async scope => ({ ...scope, connectionGeneration: "later", authorization: "Basic fixture" });
  await assert.rejects(changed.provider.delete(input), error("account-session-changed")); assert.equal(changed.calls.length, 0);
  const f = fixture([]), controller = new AbortController(); controller.abort();
  await assert.rejects(f.provider.delete(input, controller.signal)); assert.equal(f.sessions(), 0);
  const stopped = fixture([]), later = new AbortController();
  const guarded = createCaldavPersonalEventDeleteProvider({ ...stopped.ports, beforeMutation: async () => { later.abort(); } }, { nativeProfile: "existing-caldav" });
  await assert.rejects(guarded.delete(input, later.signal)); assert.equal(stopped.calls.length, 0); assert.equal(stopped.resolutions(), 0);
});

test("telemetry is bounded, per actual hop, redacted and nonauthoritative", async () => {
  const f = fixture([response(null, 307, { location: "/alias/event.ics" }), response(null, 204)]);
  await f.provider.delete(input);
  assert.deepEqual(f.metrics, [{ provider: "caldav", family: "event", method: "DELETE", status: 307, durationMs: 1 },
    { provider: "caldav", family: "event", method: "DELETE", status: 204, durationMs: 1 }]);
  const serialized = JSON.stringify(f.metrics); for (const value of ["SECRET_LOCAL", target.uid, target.resourceUrl, input.operationId]) assert.ok(!serialized.includes(value));
  const noisy = fixture([response(null, 204)]); noisy.ports.telemetry.record = () => { throw new Error("diagnostic failed"); };
  assert.equal((await noisy.provider.delete(input)).kind, "deleted");
});

test("shared namespace parser retains exact href/error class and rejects XML entity tricks", () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${target.calendarUrl}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`;
  assert.equal(davMultistatus(xml, target.calendarUrl)[0]!.href, target.calendarUrl);
  assert.throws(() => davMultistatus('<!DOCTYPE d [<!ENTITY x "secret">]>' + xml, target.calendarUrl), value => value instanceof DavReadResponseError);
  assert.throws(() => selectCaldavEventMaster(native, "wrong"), error("provider-write-failed"));
});

test("shared pinned helper requires explicit leaf fetch and guard bounds redirect loops", async () => {
  let leaf = 0;
  const pinned = createPinnedCaldavFetch(async (_url, init) => { leaf++; assert.ok(init && "dispatcher" in init); return response(null, 204); });
  await pinned(new URL(target.resourceUrl), { method: "DELETE" }, { address: "203.0.113.10", family: 4 }); assert.equal(leaf, 1);
  let redirects = 0;
  const guard = createGuardedCaldavFetch({ allowPrivate: false, lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchPinnedImpl: async () => { redirects++; return response(null, 307, { location: "/loop" }); } });
  await assert.rejects(guard(target.resourceUrl), /Too many CalDAV redirects/); assert.equal(redirects, 6);
});

test("provider production sources have no app storage/auth/config or ambient fetch/DNS implementation", async () => {
  for (const file of ["index.ts", "types.ts", "native-event.ts", "network.ts", "network-origin.ts", "dav-properties.ts", "dav-privileges.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from|import\()\s*["'](?:@musubi\/(?:db|auth|config)|.*apps\/api)/);
    assert.doesNotMatch(source, /globalThis\.fetch\s*\(|from\s*["']node:dns\/promises["']/);
  }
});
