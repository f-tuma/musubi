// iCloud legacy-unknown-time one-off content update: adapter matrix.
// Production caldavAdapter, privilege reader, resource reader, guarded transport
// and pinned leaf run unchanged. Only the existing ports are replaced: DNS
// lookup, globalThis.fetch at the pinned leaf, and the @musubi/db module (five
// read queries; every other export throws). Hosts are synthetic.
import { installHostFixture } from "../behavior/host-fixture-env.mjs";
await installHostFixture();
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { mock } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";

mock.module("rrule", { namedExports: createRequire(import.meta.url)("rrule") });
const lookups = new Set<string>();
(dns as unknown as { lookup: unknown }).lookup = async (hostname: string) => {
  lookups.add(hostname);
  assert.match(hostname, /^(?:caldav\.icloud\.com|p123-caldav\.icloud\.com|dav\.example\.test)$/, "Synthetic hosts only");
  return [{ address: "93.184.216.34", family: 4 }];
};
syncBuiltinESMExports();

type Leaf = { method: string; url: string; reply: (init: RequestInit) => Response | Promise<Response> };
let plan: Leaf[] = [];
const seen: { method: string; url: string; ifMatch: string | null; body?: string }[] = [];
let unplanned: string | undefined;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input), method = init.method ?? "GET";
  seen.push({ method, url, ifMatch: new Headers(init.headers).get("if-match"), ...(typeof init.body === "string" ? { body: init.body } : {}) });
  assert.ok((init as { dispatcher?: unknown }).dispatcher, "Every request uses the production pinned leaf");
  const next = plan.shift();
  if (!next || next.method !== method || next.url !== url) { unplanned ??= `${method} ${url}`; return new Response("unplanned", { status: 599 }); }
  return next.reply(init);
}) as typeof fetch;

const { encryptSecret } = await import("../crypto");
const dbPath = new URL("../../../../../packages/db/src/index.ts", import.meta.url).href;
const realDb = await import(dbPath);
const OWNER = "fixture-owner", ACCOUNT = "fixture-account", CAL = "fixture-calendar", LOCAL = "fixture-local";
const ICLOUD = "https://caldav.icloud.com/", COLLECTION = "https://p123-caldav.icloud.com/123/calendars/home/", RESOURCE = COLLECTION + "fixture.ics";
const GENERIC = "https://dav.example.test/", GENERIC_COLLECTION = "https://dav.example.test/cal/", GENERIC_RESOURCE = GENERIC_COLLECTION + "fixture.ics";
type State = {
  account: { serverUrl: string; username: string; encryptedPassword: string } | null;
  owned: { id: string; serverUrl: string; username: string }[];
  calendars: { calendarID: string; externalCalendarID: string; supportsEvents: boolean }[];
  link: Record<string, unknown> | null;
  role: string | null;
  calls: string[];
};
const encrypted = encryptSecret("fixture");
function initialState(serverUrl = ICLOUD, collection = COLLECTION): State {
  return {
    account: { serverUrl, username: "owner@example.test", encryptedPassword: encrypted },
    owned: [{ id: ACCOUNT, serverUrl, username: "owner@example.test" }],
    calendars: [{ calendarID: CAL, externalCalendarID: collection, supportsEvents: true }],
    link: { id: "fixture-source", disabled: false, provider: "caldav", externalCalendarID: collection, supportsEvents: true, supportsTasks: false, userID: OWNER, accountID: ACCOUNT },
    role: "owner",
    calls: [],
  };
}
let state = initialState();
const dbExports: Record<string, unknown> = {};
for (const [name, value] of Object.entries(realDb)) dbExports[name] = typeof value === "function" ? () => { throw new Error(`Unexpected DB port ${name}`); } : value;
Object.assign(dbExports, {
  async getCaldavAccountById(id: string) { state.calls.push("getCaldavAccountById"); return id === ACCOUNT ? state.account : null; },
  async getCaldavAccountsByUser(userID: string) { state.calls.push("getCaldavAccountsByUser"); return userID === OWNER ? state.owned : []; },
  async getUserExternalCalendars(provider: string, userID: string, accountID: string) { state.calls.push("getUserExternalCalendars"); return provider === "caldav" && userID === OWNER && accountID === ACCOUNT ? state.calendars : []; },
  async getExternalLinkForCalendar(calendarID: string) { state.calls.push("getExternalLinkForCalendar"); return calendarID === CAL ? state.link : null; },
  async getUserRoleForCalendar(userID: string, calendarID: string) { state.calls.push("getUserRoleForCalendar"); return userID === OWNER && calendarID === CAL ? state.role : null; },
});
mock.module(dbPath, { namedExports: dbExports });

const { config } = await import("@musubi/config");
const { EventWriteError } = await import("@musubi/types");
const { encodeEventV1 } = await import("@musubi/sync-codec");
const { caldavAdapter } = await import("./caldav");
const { ProviderEventWriteError } = await import("../event_write");
const { createGuardedCaldavFetch } = await import("@musubi/provider-caldav/network");

const ics = (lines: string[], calendar: string[] = [], extra: string[] = []) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fixture//EN", ...calendar, "BEGIN:VEVENT", "UID:fixture-uid", "DTSTAMP:20261106T224400Z", ...lines, "END:VEVENT", ...extra, "END:VCALENDAR", ""].join("\r\n");
const TIMED = ["DTSTART:20261130T210000Z", "DTEND:20261130T210500Z"];
const BEFORE = ics([...TIMED, "SUMMARY:Before", "X-PRIVATE:keep"]);
const multistatus = (href: string, inner: string, code: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:x="urn:fixture"><d:response><d:href>${new URL(href).pathname}</d:href><d:propstat><d:prop>${inner}</d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat></d:response></d:multistatus>`, { status: 207, headers: { "content-type": "application/xml" } });
const privileges = (...names: string[]) => `<d:current-user-privilege-set>${names.map(name => `<d:privilege><${name.includes(":") ? name : `d:${name}`}/></d:privilege>`).join("")}</d:current-user-privilege-set>`;
const propfind = (url: string, reply: Leaf["reply"]): Leaf => ({ method: "PROPFIND", url, reply });
const missing = (url = RESOURCE) => propfind(url, () => multistatus(url, "<d:current-user-privilege-set/>", "404 Not Found"));
const granted = (url: string, ...names: string[]) => propfind(url, () => multistatus(url, privileges(...names), "200 OK"));
const collectionWritable = () => granted(COLLECTION, "read", "bind", "unbind");
const get = (data = BEFORE, etag: string | null = '"v1"', url = RESOURCE): Leaf => ({ method: "GET", url, reply: () => new Response(data, { status: 200, headers: { "content-type": "text/calendar", ...(etag === null ? {} : { etag }) } }) });
const put = (status: number, etag?: string, url = RESOURCE): Leaf => ({ method: "PUT", url, reply: () => new Response(null, { status, headers: etag ? { etag } : {} }) });
const redirect = (method: string, url: string): Leaf => ({ method, url, reply: () => new Response(null, { status: 301, headers: { location: COLLECTION + "elsewhere.ics" } }) });
const status = (method: string, url: string, code: number, headers: Record<string, string> = {}): Leaf => ({ method, url, reply: () => new Response(code === 207 ? "<not-xml" : null, { status: code, headers }) });

const event = (patch: Record<string, unknown> = {}) => ({ id: "00000000-0000-4000-8000-000000000001", creatorID: OWNER, organizer: OWNER, title: "After", color: "#112233", description: null, location: null,
  start: new Date("2026-11-30T21:00:00Z"), end: new Date("2026-11-30T21:05:00Z"), calendars: [LOCAL, CAL], originCalendarID: LOCAL, isAllDay: false, isCanceled: false, hasAttendees: false, recurrence: null, ...patch });
const ref = (patch: Record<string, unknown> = {}) => ({ externalEventId: RESOURCE, etag: '"v1"', icalUid: "fixture-uid", ...patch });
const operation = (patch: Record<string, unknown> = {}) => ({ action: "update" as const, event: event(), patch: { title: "After" }, external: ref(), ...patch });
const plan1 = (properties = ["summary"]) => ({ ...encodeEventV1("caldav", event() as never, { title: "After" }, { action: "update", operationId: "00000000-0000-4000-8000-000000000002", uid: "fixture-uid", acceptedAt: "2026-11-07T00:00:00.000Z" }).nativePlan.data, properties });

function describe(error: unknown): string {
  if (error instanceof EventWriteError) return `EventWriteError(${error.capability},${error.reason})`;
  if (error instanceof ProviderEventWriteError) return `ProviderEventWriteError(${error.code},${error.outcome}${error.providerStatus === undefined ? "" : `,${error.providerStatus}`})`;
  if (error instanceof Error) return error.constructor === Error ? `Error(${error.message})` : error.name;
  return String(error);
}
let cases = 0;
const flags = (icloud: boolean, time = false) => { config.api.icloudPersonalContentWritesEnabled = icloud; config.api.eventTimeEditsEnabled = time; };
async function check(name: string, setup: { leaves: Leaf[]; state?: State; icloud?: boolean; time?: boolean }, run: () => Promise<unknown>, expected: string | ((result: unknown) => void), expectCalls?: string[]) {
  state = setup.state ?? initialState(); plan = [...setup.leaves]; seen.length = 0; unplanned = undefined; flags(setup.icloud ?? true, setup.time ?? false);
  let actual: string, result: unknown;
  try { result = await run(); actual = "ok"; } catch (error) { actual = describe(error); }
  try {
  assert.equal(unplanned, undefined, `${name}: unplanned provider request`);
  assert.equal(plan.length, 0, `${name}: unconsumed provider fixtures ${plan.map(leaf => `${leaf.method} ${leaf.url}`).join(", ")}`);
  if (typeof expected === "string") assert.equal(actual, expected, name);
  else { assert.equal(actual, "ok", name); expected(result); }
  if (!name.includes("push")) assert.equal(seen.filter(item => item.method === "PUT").length, 0, `${name}: preflight never sends PUT`);
  if (expectCalls) assert.deepEqual(state.calls, expectCalls, `${name}: DB calls`);
  } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)} [actual ${actual}]`); }
  cases++;
}
const failures: string[] = [];
const preflight = (op = operation(), collection = COLLECTION) => () => caldavAdapter.assertEventWrite!(OWNER, ACCOUNT, collection, op as never);
const push = (op = { event: event(), ref: ref(), patch: { title: "After" } as Record<string, unknown>, nativePlan: undefined as unknown }, collection = COLLECTION, resource = RESOURCE, signal?: AbortSignal) =>
  () => caldavAdapter.pushUpdate(OWNER, ACCOUNT, collection, resource, op.event as never, op.ref, op.patch as never, signal, op.nativePlan as never);
const UNKNOWN = "EventWriteError(event-write,unknown)", DENIED = "EventWriteError(event-write,denied)", UNSUPPORTED = "EventWriteError(event-write,unsupported)";
const ELIGIBLE_LEAVES = () => [missing(), collectionWritable(), get()];

try {
  // R1: pin the exact production transport refusal the predicate depends on.
  const guarded = createGuardedCaldavFetch({ allowPrivate: false, lookupImpl: (async () => [{ address: "93.184.216.34", family: 4 }]) as never, fetchPinnedImpl: async () => new Response(null, { status: 301, headers: { location: "/x" } }) });
  await assert.rejects(guarded(RESOURCE, { method: "PROPFIND", redirect: "error" }), (error: unknown) => error instanceof Error && error.constructor === Error && error.name === "Error" && error.message === "CalDAV scoped resource request cannot redirect.");

  // Phase A ineligible: the existing legacy gate runs unchanged (one resource
  // PROPFIND following redirects, missing ACL -> unknown) and no new DB read.
  const ineligible: [string, () => Promise<unknown>, State?][] = [
    ["non-content patch color", preflight(operation({ patch: { color: "red" } }))],
    ["non-content patch start", preflight(operation({ patch: { start: new Date("2026-11-30T22:00:00Z") } }))],
    ["content plus recurrence key", preflight(operation({ patch: { title: "After", recurrence: null } }))],
    ["empty patch", preflight(operation({ patch: {} }))],
    ["scope edit validated", preflight(operation({ scopeEditValidated: true }))],
    ["wide native plan", preflight(operation({ nativePlan: plan1(["summary", "dtstart"]) }))],
    ["canonical recurrence", preflight(operation({ event: event({ recurrence: "FREQ=DAILY" }) }))],
    ["canonical series member", preflight(operation({ event: event({ seriesID: "00000000-0000-4000-8000-000000000009" }) }))],
    ["canonical original start", preflight(operation({ event: event({ originalStart: { kind: "utc", value: "2026-11-30T21:00:00.000Z" } }) }))],
    ["canonical attendees", preflight(operation({ event: event({ hasAttendees: true }) }))],
    ["canonical meeting", preflight(operation({ event: event({ isMeeting: true }) }))],
    ["canonical cancelled", preflight(operation({ event: event({ isCanceled: true }) }))],
    ["canonical known time", preflight(operation({ event: event({ timeModel: { kind: "floating", start: "2026-11-30T21:00:00", end: "2026-11-30T21:05:00" } }) }))],
    ["weak mapping etag", preflight(operation({ external: ref({ etag: 'W/"v1"' }) }))],
    ["null mapping etag", preflight(operation({ external: ref({ etag: null }) }))],
    ["null icalUid", preflight(operation({ external: ref({ icalUid: null }) }))],
    ["look-alike account host", preflight(), initialState("https://caldav.icloud.com.evil.test/")],
    ["http account", preflight(), initialState("http://caldav.icloud.com/")],
    ["credentials account", preflight(), initialState("https://user:pass@caldav.icloud.com/")],
    ["port account", preflight(), initialState("https://caldav.icloud.com:8443/")],
    ["fragment resource", preflight(operation({ external: ref({ externalEventId: RESOURCE + "#x" }) }))],
  ];
  for (const [name, run, initial] of ineligible) {
    const resource = name === "fragment resource" ? RESOURCE + "#x" : RESOURCE;
    await check(`ineligible ${name}`, { leaves: [missing(resource)], state: initial }, run, UNKNOWN, ["getCaldavAccountById"]);
  }
  await check("ineligible flag off", { leaves: [missing()], icloud: false, time: true }, preflight(), UNKNOWN, ["getCaldavAccountById"]);
  await check("ineligible non-iCloud destination", { leaves: [missing(GENERIC_RESOURCE)], state: initialState(GENERIC, GENERIC_COLLECTION) }, preflight(operation({ external: ref({ externalEventId: GENERIC_RESOURCE }) }), GENERIC_COLLECTION), UNKNOWN, ["getCaldavAccountById"]);

  // Positive: verified iCloud personal one-off, missing resource ACL, writable collection.
  const allOwnership = ["getCaldavAccountById", "getCaldavAccountsByUser", "getUserExternalCalendars", "getExternalLinkForCalendar", "getUserRoleForCalendar"];
  await check("eligible handler shape is allowed", { leaves: ELIGIBLE_LEAVES() }, preflight(), "ok", allOwnership);
  if (JSON.stringify(seen.map(item => `${item.method} ${item.url}`)) !== JSON.stringify([`PROPFIND ${RESOURCE}`, `PROPFIND ${COLLECTION}`, `GET ${RESOURCE}`])) failures.push("eligible handler shape: exact resource ACL, collection ACL, GET order");
  await check("eligible with TIME on as well", { leaves: ELIGIBLE_LEAVES(), time: true }, preflight(), "ok");
  await check("eligible worker shape with pinned plan", { leaves: ELIGIBLE_LEAVES() }, preflight(operation({ nativePlan: plan1() })), "ok");
  await check("eligible description and location clear", { leaves: ELIGIBLE_LEAVES() }, preflight(operation({ patch: { description: null, location: "Room" } })), "ok");
  await check("eligible origin iCloud one-off", { leaves: ELIGIBLE_LEAVES() }, preflight(operation({ event: event({ calendars: [CAL], originCalendarID: CAL }) })), "ok");
  await check("eligible collection all privilege", { leaves: [missing(), granted(COLLECTION, "all"), get()] }, preflight(), "ok");

  // Phase B 1-3: ownership, role, strict URL. No provider request.
  const without = (patch: Partial<State>) => ({ ...initialState(), ...patch });
  for (const [name, initial] of [
    ["account not owned", without({ owned: [] })],
    ["zero links", without({ calendars: [] })],
    ["multiple links", without({ calendars: [{ calendarID: CAL, externalCalendarID: COLLECTION, supportsEvents: true }, { calendarID: "other", externalCalendarID: COLLECTION, supportsEvents: true }] })],
    ["link without events", without({ calendars: [{ calendarID: CAL, externalCalendarID: COLLECTION, supportsEvents: false }] })],
    ["link row missing", without({ link: null })],
    ["link disabled", without({ link: { ...initialState().link, disabled: true } })],
    ["link other account", without({ link: { ...initialState().link, accountID: "other" } })],
    ["link other user", without({ link: { ...initialState().link, userID: "other" } })],
    ["link other collection", without({ link: { ...initialState().link, externalCalendarID: COLLECTION + "x/" } })],
    ["link other provider", without({ link: { ...initialState().link, provider: "google" } })],
  ] as const) await check(`ownership ${name}`, { leaves: [], state: initial }, preflight(), UNKNOWN);
  await check("ownership calendar not in event", { leaves: [] }, preflight(operation({ event: event({ calendars: [LOCAL] }) })), UNKNOWN);
  await check("role viewer", { leaves: [], state: without({ role: "viewer" }) }, preflight(), DENIED);
  await check("role absent", { leaves: [], state: without({ role: null }) }, preflight(), DENIED);
  for (const [name, resource] of [["outside collection", "https://p123-caldav.icloud.com/123/calendars/other/fixture.ics"], ["encoded separator", COLLECTION + "a%2Fb.ics"],
    ["nested path", COLLECTION + "sub/fixture.ics"], ["query", RESOURCE + "?x=1"], ["encoded dot segment", COLLECTION + "%2e%2e%2fother.ics"]] as const)
    await check(`strict URL ${name}`, { leaves: [] }, preflight(operation({ external: ref({ externalEventId: resource }) })), UNKNOWN);

  // Phase B 4: resource ACL classification.
  await check("resource read-only set", { leaves: [granted(RESOURCE, "read")] }, preflight(), DENIED);
  await check("resource empty set", { leaves: [propfind(RESOURCE, () => multistatus(RESOURCE, "<d:current-user-privilege-set/>", "200 OK"))] }, preflight(), DENIED);
  for (const [name, leaf] of [
    ["403 propstat", propfind(RESOURCE, () => multistatus(RESOURCE, "<d:current-user-privilege-set/>", "403 Forbidden"))],
    ["HTTP 401", status("PROPFIND", RESOURCE, 401)], ["HTTP 403", status("PROPFIND", RESOURCE, 403)], ["HTTP 404", status("PROPFIND", RESOURCE, 404)],
    ["200 not 207", status("PROPFIND", RESOURCE, 200)], ["malformed XML", status("PROPFIND", RESOURCE, 207, { "content-type": "application/xml" })],
    ["wrong href", propfind(RESOURCE, () => multistatus(COLLECTION + "other.ics", "<d:current-user-privilege-set/>", "404 Not Found"))],
    ["duplicate rows", propfind(RESOURCE, () => new Response(`<d:multistatus xmlns:d="DAV:">${[1, 2].map(() => `<d:response><d:href>${new URL(RESOURCE).pathname}</d:href><d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`, { status: 207 }))],
    ["unknown namespace", granted(RESOURCE, "read", "x:write-content")],
  ] as const) await check(`resource ACL ${name}`, { leaves: [leaf] }, preflight(), UNKNOWN);
  for (const code of [408, 429, 503]) await check(`resource ACL transient ${code}`, { leaves: [status("PROPFIND", RESOURCE, code, { "retry-after": "7" })] }, preflight(), `ProviderEventWriteError(provider-write-failed,not-written,${code})`);
  await check("resource ACL granted takes the existing path", { leaves: [granted(RESOURCE, "read", "write-content"), get()] }, preflight(), "ok");

  // Phase B 5: mandatory collection prerequisite (necessary, never sufficient).
  await check("collection read-only", { leaves: [missing(), granted(COLLECTION, "read")] }, preflight(), DENIED);
  await check("collection empty set", { leaves: [missing(), propfind(COLLECTION, () => multistatus(COLLECTION, "<d:current-user-privilege-set/>", "200 OK"))] }, preflight(), DENIED);
  await check("collection missing", { leaves: [missing(), missing(COLLECTION)] }, preflight(), UNKNOWN);
  await check("collection malformed", { leaves: [missing(), status("PROPFIND", COLLECTION, 207, { "content-type": "application/xml" })] }, preflight(), UNKNOWN);
  await check("collection HTTP 403", { leaves: [missing(), status("PROPFIND", COLLECTION, 403)] }, preflight(), UNKNOWN);
  await check("collection 503", { leaves: [missing(), status("PROPFIND", COLLECTION, 503)] }, preflight(), "ProviderEventWriteError(provider-write-failed,not-written,503)");

  // R1 redirect refusal: exact predicate in steps 4-6; abort, timeout and other
  // untyped errors keep their existing handling.
  await check("redirect on resource PROPFIND", { leaves: [redirect("PROPFIND", RESOURCE)] }, preflight(), UNKNOWN);
  await check("redirect on collection PROPFIND", { leaves: [missing(), redirect("PROPFIND", COLLECTION)] }, preflight(), UNKNOWN);
  await check("redirect on resource GET", { leaves: [missing(), collectionWritable(), redirect("GET", RESOURCE)] }, preflight(), UNKNOWN);
  const throwing = (method: string, url: string, error: () => unknown): Leaf => ({ method, url, reply: () => { throw error(); } });
  for (const [label, leaves] of [
    ["resource PROPFIND", (error: () => unknown) => [throwing("PROPFIND", RESOURCE, error)]],
    ["collection PROPFIND", (error: () => unknown) => [missing(), throwing("PROPFIND", COLLECTION, error)]],
    ["resource GET", (error: () => unknown) => [missing(), collectionWritable(), throwing("GET", RESOURCE, error)]],
  ] as const) {
    await check(`timeout on ${label} is not mapped`, { leaves: leaves(() => new DOMException("deadline", "TimeoutError")) }, preflight(), "TimeoutError");
    await check(`other untyped error on ${label} is not mapped`, { leaves: leaves(() => new Error("socket hang up")) }, preflight(), "Error(socket hang up)");
    const controller = new AbortController();
    await check(`abort on ${label} is not mapped`, { leaves: leaves(() => { controller.abort(); return new DOMException("aborted", "AbortError"); }) }, preflight(operation({ signal: controller.signal })), "AbortError");
  }
  const aborting = new AbortController();
  await check("redirect after caller abort is not mapped", { leaves: [{ method: "PROPFIND", url: RESOURCE, reply: () => { aborting.abort(); return new Response(null, { status: 301, headers: { location: "/x" } }); } }] },
    preflight(operation({ signal: aborting.signal })), "Error(CalDAV scoped resource request cannot redirect.)");

  // Phase B 6: resource evidence and strict personal shape.
  for (const [name, data] of [
    ["organizer self", ics([...TIMED, "SUMMARY:Before", "ORGANIZER:mailto:owner@example.test"])],
    ["organizer other", ics([...TIMED, "SUMMARY:Before", "ORGANIZER:mailto:other@example.test"])],
    ["method", ics([...TIMED, "SUMMARY:Before"], ["METHOD:REQUEST"])],
    ["attendee", ics([...TIMED, "SUMMARY:Before", "ATTENDEE:mailto:guest@example.test"])],
    ["rrule", ics([...TIMED, "SUMMARY:Before", "RRULE:FREQ=DAILY;COUNT=2"])],
    ["rdate", ics([...TIMED, "SUMMARY:Before", "RDATE:20261201T210000Z"])],
    ["exdate", ics([...TIMED, "SUMMARY:Before", "EXDATE:20261201T210000Z"])],
    ["second VEVENT", ics([...TIMED, "SUMMARY:Before"], [], ["BEGIN:VEVENT", "UID:other-uid", "DTSTAMP:20261106T224400Z", ...TIMED, "END:VEVENT"])],
    ["hidden nested VEVENT", ics([...TIMED, "SUMMARY:Before", "BEGIN:VEVENT", "UID:hidden", "END:VEVENT"])],
    ["extra VTODO", ics([...TIMED, "SUMMARY:Before"], [], ["BEGIN:VTODO", "UID:todo", "DTSTAMP:20261106T224400Z", "END:VTODO"])],
    ["malformed VALARM", ics([...TIMED, "SUMMARY:Before", "BEGIN:VALARM", "ACTION:DISPLAY", "END:VALARM"])],
    ["malformed VTIMEZONE", ics([...TIMED, "SUMMARY:Before"], ["BEGIN:VTIMEZONE", "TZID:Fixture", "END:VTIMEZONE"])],
    ["all-day DATE", ics(["DTSTART;VALUE=DATE:20261130", "DTEND;VALUE=DATE:20261201", "SUMMARY:Before"])],
  ] as const) await check(`resource ${name}`, { leaves: [missing(), collectionWritable(), get(data)] }, preflight(), UNSUPPORTED);
  await check("resource UID mismatch", { leaves: [missing(), collectionWritable(), get(BEFORE.replace("UID:fixture-uid", "UID:other-uid"))] }, preflight(), "ProviderEventWriteError(provider-write-failed,not-written)");
  await check("resource ETag mismatch", { leaves: [missing(), collectionWritable(), get(BEFORE, '"v2"')] }, preflight(), "ProviderEventWriteError(provider-conflict,not-written)");
  await check("resource weak ETag", { leaves: [missing(), collectionWritable(), get(BEFORE, 'W/"v1"')] }, preflight(), "ProviderEventWriteError(provider-version-unavailable,not-written)");
  await check("resource GET 404", { leaves: [missing(), collectionWritable(), status("GET", RESOURCE, 404)] }, preflight(), UNKNOWN);

  // pushUpdate: every iCloud-class legacy update uses strict URL, redirect
  // refusal, If-Match and complete readback that adopts only its strong ETag.
  const PUT_TEXT = (body?: string) => assert.ok(body?.includes("SUMMARY:After") && body.includes("X-PRIVATE:keep"), "Exact preserving transformation");
  for (const icloud of [true, false]) await check(`push PUT 204 without ETag then strong equal readback (flag ${icloud})`, { leaves: [get(), put(204), { method: "GET", url: RESOURCE, reply: () => new Response(seen.find(item => item.method === "PUT")!.body!, { status: 200, headers: { etag: '"v2"' } }) }], icloud }, push(),
    result => { assert.deepEqual(result, { etag: '"v2"', icalUid: "fixture-uid" }); const sent = seen.find(item => item.method === "PUT")!; assert.equal(sent.ifMatch, '"v1"'); PUT_TEXT(sent.body); });
  await check("push never adopts the PUT ETag", { leaves: [get(), put(201, '"put-etag"'), { method: "GET", url: RESOURCE, reply: () => new Response(seen.find(item => item.method === "PUT")!.body!, { status: 200, headers: { etag: '"v3"' } }) }] }, push(),
    result => assert.deepEqual(result, { etag: '"v3"', icalUid: "fixture-uid" }));
  await check("push pinned plan", { leaves: [get(), put(204), { method: "GET", url: RESOURCE, reply: () => new Response(seen.find(item => item.method === "PUT")!.body!, { status: 200, headers: { etag: '"v2"' } }) }] },
    push({ event: event(), ref: ref(), patch: { title: "After" }, nativePlan: plan1() }), result => assert.deepEqual(result, { etag: '"v2"', icalUid: "fixture-uid" }));
  const UNCONFIRMED = "ProviderEventWriteError(provider-write-failed,unconfirmed)";
  await check("push readback mismatch", { leaves: [get(), put(204), get(BEFORE.replace("Before", "Concurrent"), '"v2"')] }, push(), UNCONFIRMED);
  await check("push readback weak ETag", { leaves: [get(), put(204), { method: "GET", url: RESOURCE, reply: () => new Response(seen.find(item => item.method === "PUT")!.body!, { status: 200, headers: { etag: 'W/"v2"' } }) }] }, push(), UNCONFIRMED);
  await check("push readback without ETag", { leaves: [get(), put(204), { method: "GET", url: RESOURCE, reply: () => new Response(seen.find(item => item.method === "PUT")!.body!, { status: 200 }) }] }, push(), UNCONFIRMED);
  await check("push readback 503", { leaves: [get(), put(204), status("GET", RESOURCE, 503)] }, push(), "ProviderEventWriteError(provider-write-failed,unconfirmed,503)");
  await check("push readback redirect", { leaves: [get(), put(204), redirect("GET", RESOURCE)] }, push(), UNCONFIRMED);
  await check("push readback network error", { leaves: [get(), put(204), { method: "GET", url: RESOURCE, reply: () => { throw new TypeError("fetch failed"); } }] }, push(), UNCONFIRMED);
  await check("push PUT 403", { leaves: [get(), put(403)] }, push(), "ProviderEventWriteError(provider-write-failed,not-written,403)");
  await check("push PUT 412", { leaves: [get(), put(412)] }, push(), "ProviderEventWriteError(provider-conflict,not-written,412)");
  await check("push PUT 503", { leaves: [get(), put(503)] }, push(), "ProviderEventWriteError(provider-write-failed,unconfirmed,503)");
  await check("push PUT odd 2xx", { leaves: [get(), put(202)] }, push(), "ProviderEventWriteError(provider-write-failed,unconfirmed,202)");
  await check("push PUT network error", { leaves: [get(), { method: "PUT", url: RESOURCE, reply: () => { throw new TypeError("fetch failed"); } }] }, push(), UNCONFIRMED);
  await check("push PUT redirect", { leaves: [get(), redirect("PUT", RESOURCE)] }, push(), UNCONFIRMED);
  await check("push pre-PUT GET redirect", { leaves: [redirect("GET", RESOURCE)] }, push(), "ProviderEventWriteError(provider-conflict,not-written)");
  await check("push pre-PUT GET 503", { leaves: [status("GET", RESOURCE, 503)] }, push(), "ProviderEventWriteError(provider-write-failed,not-written,503)");
  await check("push pre-PUT GET ETag changed", { leaves: [get(BEFORE, '"v9"')] }, push(), "ProviderEventWriteError(provider-conflict,not-written)");
  await check("push strict URL refusal sends nothing", { leaves: [] }, push(undefined, COLLECTION, "https://p123-caldav.icloud.com/123/calendars/other/fixture.ics"), "ProviderEventWriteError(provider-conflict,not-written)");
  await check("push known no-op", { leaves: [get(ics([...TIMED, "SUMMARY:After", "X-PRIVATE:keep"]))] }, push(), result => assert.equal(result, undefined));
  const pushAbort = new AbortController();
  await check("push pre-PUT abort is not mapped", { leaves: [{ method: "GET", url: RESOURCE, reply: () => { pushAbort.abort(); throw new DOMException("aborted", "AbortError"); } }] }, push(undefined, COLLECTION, RESOURCE, pushAbort.signal), "AbortError");

  // Non-iCloud pushUpdate keeps today's requests and results (no readback,
  // PUT ETag strong-or-null).
  const genericState = () => initialState(GENERIC, GENERIC_COLLECTION);
  const genericPush = () => push({ event: event(), ref: ref({ externalEventId: GENERIC_RESOURCE }), patch: { title: "After" }, nativePlan: undefined }, GENERIC_COLLECTION, GENERIC_RESOURCE);
  await check("generic push PUT ETag", { leaves: [get(BEFORE, '"v1"', GENERIC_RESOURCE), put(204, '"v2"', GENERIC_RESOURCE)], state: genericState() }, genericPush(), result => assert.deepEqual(result, { etag: '"v2"', icalUid: "fixture-uid" }));
  await check("generic push PUT without ETag", { leaves: [get(BEFORE, '"v1"', GENERIC_RESOURCE), put(204, undefined, GENERIC_RESOURCE)], state: genericState() }, genericPush(), result => assert.deepEqual(result, { etag: null, icalUid: "fixture-uid" }));
  await check("generic push PUT 403", { leaves: [get(BEFORE, '"v1"', GENERIC_RESOURCE), put(403, undefined, GENERIC_RESOURCE)], state: genericState() }, genericPush(), "ProviderEventWriteError(provider-write-failed,not-written,403)");

  assert.deepEqual([...lookups].sort(), ["dav.example.test", "p123-caldav.icloud.com"], "Only synthetic hosts were resolved");
  if (failures.length) throw new Error(`${failures.length}/${cases} adapter matrix cases failed:\n${failures.join("\n")}`);
  console.log(`iCloud legacy one-off adapter matrix: ${cases} cases OK`);
} finally {
  config.api.icloudPersonalContentWritesEnabled = false; config.api.eventTimeEditsEnabled = false;
}
