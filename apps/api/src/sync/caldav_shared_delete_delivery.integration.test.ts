import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import {
  caldavAccounts, claimEventOutbox, createCalendar, createEvent, db, decodeEventOutboxOperation, eventOutbox, events, externalCalendars,
  externalEvents, externalEventTombstones, getOwnedCaldavAccountById, patchEventAndCalendarLinks, saveCaldavAccount,
  user, type EventOutboxIntent,
} from "@musubi/db";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { caldavAdapter } from "./adapters/caldav";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverSharedCaldavDelete } from "./caldav_shared_delete_delivery";
import { encryptSecret } from "./crypto";
import { providerHttpMetricsRegistry } from "./provider_http_metrics";
import { retainPendingEventPull } from "../../../../packages/db/src/queries/event-outbox-pull";

const nativeUID = "personal-delete@example.test", acceptedEtag = '"accepted"';
const authorization = `Basic ${Buffer.from("fixture:fixture-password").toString("base64")}`;
type Wire = { method: string; path: string; host: "primary" | "secondary"; body: string; authorization?: string;
  ifMatch?: string; accept?: string; depth?: string; contentType?: string; cacheControl?: string };
const calendarData = (extra = "", additional = "") => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Musubi QA//EN", "BEGIN:VEVENT",
  `UID:${nativeUID}`, "DTSTART:20261025T090000Z", "DTEND:20261025T100000Z", "SUMMARY:Personal DELETE A",
  "DESCRIPTION:Before notes", "LOCATION:Before place", ...extra.split("\r\n").filter(Boolean), "END:VEVENT",
  ...additional.split("\r\n").filter(Boolean), "END:VCALENDAR", ""].join("\r\n");

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.equal(config.security.federationAllowPrivateHosts, true, "Owned loopback fixture needs the explicit private-host QA policy");
  const originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let mode = "success", data = calendarData(), etag: string | null = acceptedEtag, absent = false, reads = 0;
  let requests: Wire[] = [], failures: unknown[] = [], factoryCalls = 0, sessions = 0, legacyCalls = 0;
  let onPreflight: (() => Promise<void>) | undefined, afterDelete: (() => Promise<void>) | undefined;
  let origin = "", secondaryOrigin = "";
  const collection = () => origin + "/dav/calendar/", resource = () => collection() + "event+id.ics";
  const xml = (href: string, property: string, status = 200) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${property}</d:prop><d:status>HTTP/1.1 ${status} Status</d:status></d:propstat></d:response></d:multistatus>`;
  const handler = (host: Wire["host"]) => async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const url = new URL(req.url!, host === "primary" ? origin : secondaryOrigin), method = req.method!;
      const header = (name: string) => typeof req.headers[name] === "string" ? req.headers[name] as string : undefined;
      requests.push({ method, path: url.pathname + url.search, host, body, authorization: header("authorization"), ifMatch: header("if-match"),
        accept: header("accept"), depth: header("depth"), contentType: header("content-type"), cacheControl: header("cache-control") });
      assert.equal(header("authorization"), host === "secondary" ? undefined : authorization);
      const respond = (status: number, text = "", headers: Record<string, string> = {}) => { res.writeHead(status, headers); res.end(text); };
      if (method === "PROPFIND") {
        assert.equal(header("depth"), "0");
        if (body.includes("current-user-privilege-set")) {
          if (mode === "acl-drop") return res.destroy();
          if (mode.startsWith("acl-")) {
            const status = Number(mode.slice(4));
            if (status) return respond(status, "", status === 429 ? { "retry-after": "1" } : {});
          }
          if (mode === "acl-redirect" && url.pathname === "/dav/calendar/") return respond(307, "", { location: "/dav/acl-alias/" });
          if (mode === "acl-malformed") return respond(207, "<broken", { "content-type": "application/xml" });
          const property = mode === "acl-missing" ? "<d:displayname>Calendar</d:displayname>" :
            `<d:current-user-privilege-set>${mode === "acl-denied" ? "" : "<d:privilege><d:unbind/></d:privilege>"}</d:current-user-privilege-set>`;
          return respond(207, xml(collection(), property), { "content-type": "application/xml" });
        }
        if (body.includes("current-user-principal")) {
          const href = mode === "principal-other-origin" ? secondaryOrigin + "/dav/principal/" : "/dav/principal/";
          return respond(207, xml(collection(), `<d:current-user-principal><d:href>${href}</d:href></d:current-user-principal>`), { "content-type": "application/xml" });
        }
        assert(body.includes("calendar-user-address-set"));
        const address = mode === "organizer-other" ? "other@example.test" : "owner@example.test";
        return respond(207, xml(origin + "/dav/principal/", `<c:calendar-user-address-set><d:href>mailto:${address}</d:href></c:calendar-user-address-set>`), { "content-type": "application/xml" });
      }
      assert(["/dav/calendar/event+id.ics", "/dav/calendar/alias.ics"].includes(url.pathname));
      if (method === "GET") {
        reads++; if (reads === 2) await onPreflight?.();
        if (mode === "read-drop") return res.destroy();
        if (mode.startsWith("read-")) {
          const status = Number(mode.slice(5));
          if (status) return respond(status, "", status === 429 ? { "retry-after": "1" } : {});
        }
        if (mode === "get-redirect" && url.pathname.endsWith("event+id.ics")) return respond(302, "", { location: "/dav/calendar/alias.ics" });
        if (mode === "preflight-404" && reads === 2) return respond(404);
        if (absent) return respond(404);
        const headers: Record<string, string> = { "content-type": "text/calendar; charset=utf-8", ...(etag === null ? {} : { etag }) };
        if (mode === "range") headers["content-range"] = "items 0-0/2";
        if (mode === "invalid-utf8") { res.writeHead(200, headers); return res.end(Buffer.from([0xc3, 0x28])); }
        return respond(200, data, headers);
      }
      assert.equal(method, "DELETE"); assert.equal(body, ""); assert.equal(header("if-match"), acceptedEtag);
      if (url.pathname.endsWith("event+id.ics")) {
        if (mode === "delete-redirect303") return respond(303, "", { location: "/dav/calendar/alias.ics" });
        if (mode === "delete-redirect307") return respond(307, "", { location: "/dav/calendar/alias.ics" });
        if (mode === "delete-cross-origin307") return respond(307, "", { location: secondaryOrigin + "/dav/calendar/alias.ics" });
      }
      if (["400", "401", "403", "410", "412", "429", "408", "500", "202"].includes(mode))
        return respond(Number(mode), "", mode === "429" ? { "retry-after": "1" } : {});
      if (mode !== "lost-retained") absent = true;
      await afterDelete?.();
      if (mode === "lost" || mode === "lost-retained") return res.destroy();
      return respond(mode === "delete-200" ? 200 : mode === "delete-201" ? 201 : mode === "delete-404" ? 404 : 204);
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned DAV fixture assertion failed"); }
  };
  const server = createServer(handler("primary")), secondary = createServer(handler("secondary"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => secondary.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  secondaryOrigin = `http://127.0.0.1:${(secondary.address() as { port: number }).port}`;
  const oldAdapter: CalendarAdapter = { ...caldavAdapter, caldavPersonalDeleteV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...caldavAdapter,
    caldavPersonalDeleteV1(userID, accountID, capture) {
      factoryCalls++; const bridge = caldavAdapter.caldavPersonalDeleteV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.equal(target.connectionId, accountID);
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return caldavAdapter.assertEventWrite!(...args); },
    async pushDelete(...args) { legacyCalls++; return caldavAdapter.pushDelete(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function seed() {
    const owner = `dav-delete-${randomUUID()}`;
    await db.insert(user).values({ id: owner, name: "DAV DELETE fixture", email: `${owner}@example.test` });
    const account = await saveCaldavAccount(owner, origin + "/", "fixture", encryptSecret("fixture-password"));
    const calendar = await createCalendar({ creatorID: owner, name: "DAV DELETE fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "caldav", userID: owner,
      accountID: account.id, externalCalendarID: collection(), providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: "Personal DELETE A", description: "Before notes", location: "Before place", color: "#112233",
      start: "2026-10-25T09:00:00.000Z", end: "2026-10-25T10:00:00.000Z", isAllDay: false, isCanceled: false });
    await createEvent(event, event.calendars);
    const [mapping] = await db.insert(externalEvents).values({ provider: "caldav", eventID: event.id, calendarID: calendar.id,
      externalCalendarID: collection(), externalEventID: resource(), etag: acceptedEtag, icalUid: nativeUID }).returning();
    const operationID = randomUUID();
    const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0, eventID: event.id, calendarID: calendar.id,
      externalCalendarLinkID: source!.id, provider: "caldav", userID: owner, accountID: account.id, externalCalendarID: collection(),
      externalEventID: resource(), expectedEtag: acceptedEtag, icalUid: nativeUID, action: "delete", payload: { event } };
    assert.equal((await patchEventAndCalendarLinks(event.id, 1, { calendars: [] }, true, [intent])).status, "saved");
    await db.insert(externalEvents).values(mapping!);
    const row = async (id: string = operationID) => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.id, mapping!.id)))[0];
    return { owner, accountID: account.id, calendar, source: source!, event, operationID, row, mapped, mapping: mapping! };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const metrics = async () => (await providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!.get()).values
    .filter(value => value.labels.provider === "caldav" && value.labels.family === "event").reduce((sum, value) => sum + value.value, 0);
  async function fixture(label: string, body: (f: Fixture) => Promise<void>, verifyMetrics = true, hostname = false) {
    const savedOrigin = origin;
    if (hostname) origin = origin.replace("127.0.0.1", "localhost");
    mode = "success"; data = calendarData(); etag = acceptedEtag; absent = false; reads = 0; requests = []; failures = [];
    factoryCalls = sessions = legacyCalls = 0; onPreflight = afterDelete = undefined;
    const f = await seed(), before = await metrics();
    try {
      await body(f); assert.deepEqual(failures, []);
      if (verifyMetrics) assert.equal(await metrics() - before, requests.length, "Metrics count each actual guarded HTTP hop exactly once");
      cases++; console.log(`DAV shared DELETE: ${label}: PASS`);
    } finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); origin = savedOrigin; }
  }
  const due = (id: string) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(0) }).where(eq(eventOutbox.id, id));
  const outcome = async (result: NonNullable<Awaited<ReturnType<typeof deliverEventOutbox>>>, f: Fixture) => ({
    status: result.status, uncertain: result.uncertain, errorCode: result.errorCode, attempts: result.attempts, resultRef: result.resultRef,
    mapping: (await f.mapped()) ? { etag: (await f.mapped())!.etag, uid: (await f.mapped())!.icalUid, externalEventID: (await f.mapped())!.externalEventID } : null,
    snapshot: result.remoteSnapshot && { ...result.remoteSnapshot, observedAt: undefined },
  });
  const configure = (variant: string) => {
    mode = variant;
    if (variant === "changed") etag = '"changed"';
    if (variant === "weak") etag = 'W/"accepted"';
    if (variant === "missing-etag") etag = null;
    if (variant === "wrong-uid") data = data.replace(nativeUID, "other@example.test");
    if (variant === "missing-uid") data = data.replace(`UID:${nativeUID}\r\n`, "");
    if (variant === "duplicate-uid") data = data.replace(`UID:${nativeUID}`, `UID:${nativeUID}\r\nUID:${nativeUID}`);
    if (variant === "missing-dates") data = data.replace("DTSTART:20261025T090000Z\r\n", "").replace("DTEND:20261025T100000Z\r\n", "");
    if (variant === "cancelled") data = calendarData("STATUS:CANCELLED");
    if (variant === "broken-ical") data = "This is not an iCalendar resource";
    if (["organizer", "organizer-other", "principal-other-origin", "organizer-attendee"].includes(variant)) data = calendarData("ORGANIZER:mailto:owner@example.test" + (variant === "organizer-attendee" ? "\r\nATTENDEE:mailto:guest@example.test" : ""));
    if (variant === "orphan-attendee") data = calendarData("ATTENDEE:mailto:guest@example.test");
    if (variant === "extra-master") data = calendarData("", "BEGIN:VEVENT\r\nUID:other@example.test\r\nDTSTART:20261025T090000Z\r\nDTEND:20261025T100000Z\r\nEND:VEVENT");
  };
  const child = (operationId: string, at?: "beforeDelete" | "afterDelete") => {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./caldav_delete_process.fixture.ts", import.meta.url))], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    let output = "", stderr = "", entered!: () => void, rejectEntered!: (error: Error) => void;
    const checkpoint = new Promise<void>((resolve, reject) => { entered = resolve; rejectEntered = reject; });
    proc.stdout.on("data", chunk => { output += String(chunk); if (output.includes('"kind":"checkpoint"')) entered(); });
    proc.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; stderr: string }>((resolve, reject) => {
      proc.once("error", error => { clearTimeout(timer); rejectEntered(error); reject(error); });
      proc.once("close", (code, signal) => { clearTimeout(timer); rejectEntered(new Error("Worker exited before checkpoint")); resolve({ code, signal, output, stderr }); });
    });
    void checkpoint.catch(() => undefined); proc.stdin.end(JSON.stringify({ operationId, fixtureOrigin: origin, ...(at ? { pause: at } : {}) }));
    return { proc, checkpoint, exited };
  };
  try {
    const variants = ["success", "organizer", "organizer-other", "principal-other-origin", "organizer-attendee", "orphan-attendee", "extra-master",
      "read-404", "read-410", "read-400", "read-401", "read-403", "read-429", "read-500", "read-206", "range", "read-drop",
      "changed", "weak", "missing-etag", "wrong-uid", "missing-uid", "duplicate-uid", "cancelled", "broken-ical", "invalid-utf8", "missing-dates",
      "acl-400", "acl-401", "acl-403", "acl-404", "acl-410", "acl-429", "acl-500", "acl-denied", "acl-missing", "acl-malformed", "acl-drop",
      "preflight-404", "delete-200", "delete-201", "delete-404", "400", "401", "403", "410", "412", "429", "408", "500", "202", "lost",
      "get-redirect", "acl-redirect", "delete-redirect307", "delete-cross-origin307", "delete-redirect303"];
    for (const variant of variants) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`${variant} ${label} HTTP/host/hop-metric parity`, async f => {
          configure(variant); const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
          else { assert.equal(legacyCalls, 0); assert.equal(factoryCalls, 1); assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); }
          if (variant === "success") { assert.equal(result.status, "completed"); assert.equal(requests.length, 4); }
          if (variant === "organizer") { assert.equal(result.status, "completed"); assert.equal(requests.length, 6); }
          if (variant === "delete-redirect307" || variant === "delete-cross-origin307") assert.equal(requests.filter(value => value.method === "DELETE").length, 2);
          if (variant === "delete-cross-origin307") assert.equal(requests[requests.length - 1]?.authorization, undefined);
        });
      }
    }
    for (const variant of ["present", "changed", "404", "410"] as const) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`crashed claim recovery ${variant} ${label}`, async f => {
          assert(await claimEventOutbox(f.operationID)); await due(f.operationID);
          if (variant === "changed") etag = '"changed"';
          if (variant === "404") absent = true;
          if (variant === "410") mode = "read-410";
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          assert.equal(requests.filter(value => value.method === "DELETE").length, variant === "present" ? 1 : 0);
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); }
        });
      }
    }
    for (const inherited of [false, true]) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`429 retry inherited=${inherited} ${label}`, async f => {
          if (inherited) { assert(await claimEventOutbox(f.operationID)); await due(f.operationID); }
          mode = "429"; const first = await deliverEventOutbox(f.operationID, () => adapter); assert.equal(first?.uncertain, inherited);
          mode = "success"; await due(f.operationID); const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          assert.equal(result.status, "completed"); assert.equal(requests.filter(value => value.method === "DELETE").length, 2);
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); }
        });
      }
    }
    for (const retained of [false, true]) await fixture(`lost DELETE reply retained=${retained} resolves without a fresh version`, async f => {
      mode = retained ? "lost-retained" : "lost";
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "unconfirmed");
      mode = "success"; await due(f.operationID);
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, retained ? 2 : 1);
    });
    {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) await fixture(`null row UID reuses immutable admission ${label}`, async f => {
        await db.update(eventOutbox).set({ icalUid: null }).where(eq(eventOutbox.id, f.operationID));
        const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result); assert.equal(result.status, "completed"); assert.equal(requests.length, 4);
        if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
        else { assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); }
      });
    }
    await fixture("a completed predecessor cannot substitute a different admitted UID", async f => {
      const saved = await f.row(), id = randomUUID(), mutationID = randomUUID();
      const envelope = SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope);
      const previousEnvelope = { ...envelope, operationId: id, commandId: mutationID, acceptedRevision: saved.revision - 1,
        operation: { ...envelope.operation, action: "update" as const } };
      await db.insert(eventOutbox).values({ ...saved, id, mutationID, revision: saved.revision - 1, action: "update", status: "completed", uncertain: false,
        leaseToken: null, leaseUntil: null, predecessorID: null, resultRef: { externalEventId: resource(), etag: acceptedEtag, icalUid: "other@example.test" },
        payload: { ...saved.payload, event: { ...saved.payload.event, revision: saved.revision - 1 }, operationEnvelope: previousEnvelope } });
      assert.equal(decodeEventOutboxOperation(await f.row(id)).kind, "pinned-v1");
      await db.update(eventOutbox).set({ predecessorID: id, icalUid: null, payload: { ...saved.payload, operationEnvelope: { ...envelope, predecessorOperationId: id } } }).where(eq(eventOutbox.id, f.operationID));
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "operation-envelope-binding-mismatch");
      assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(requests.length, 0); assert.equal(legacyCalls, 0);
    });
    await fixture("account timestamp revision changes before DELETE reject dispatch", async f => {
      const before = await getOwnedCaldavAccountById(f.owner, f.accountID); assert(before);
      onPreflight = async () => { await db.update(caldavAccounts).set({ updatedAt: new Date(before.updatedAt.getTime() + 1) }).where(eq(caldavAccounts.id, f.accountID)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
    });
    await fixture("source generation changes after native preflight reject dispatch", async f => {
      onPreflight = async () => { await db.update(externalCalendars).set({ providerAccessRevision: 2 }).where(eq(externalCalendars.id, f.source.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked"); assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
    });
    await fixture("source retirement after accepted DELETE rejects ACK", async f => {
      afterDelete = async () => { await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked"); assert(await f.mapped());
    });
    await fixture("privacy epoch retirement after native preflight prevents dispatch", async f => {
      onPreflight = async () => { await db.update(events).set({ providerReadRetiredRevision: 2 }).where(eq(events.id, f.event.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
    });
    await fixture("a replacement lease prevents late native acceptance ACK", async f => {
      const replacement = randomUUID();
      afterDelete = async () => { await db.update(eventOutbox).set({ leaseToken: replacement, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(eventOutbox.id, f.operationID)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "attempting"); assert.equal(result?.leaseToken, replacement); assert(await f.mapped());
    });
    await fixture("newer mapping version cannot be removed by stale ACK", async f => {
      afterDelete = async () => { await db.update(externalEvents).set({ etag: '"newer"' }).where(eq(externalEvents.id, f.mapping.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "conflict"); assert.equal((await f.mapped())?.etag, '"newer"');
    });
    await fixture("retained pull conflict survives native acceptance", async f => {
      afterDelete = () => db.transaction(async tx => {
        await tx.select({ id: events.id }).from(events).where(eq(events.id, f.event.id)).for("update");
        await retainPendingEventPull(tx, f.event.id, f.calendar.id, "caldav", resource(), { title: "Provider edit", description: null, location: null,
          start: new Date("2026-10-25T09:00:00.000Z"), end: new Date("2026-10-25T10:00:00.000Z"), isAllDay: false, recurrence: null }, '"pulled"', nativeUID);
      });
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "conflict"); assert(await f.mapped());
    });
    await fixture("retained tombstone neither invents native absence nor disappears", async f => {
      const [tombstone] = await db.insert(externalEventTombstones).values({ externalCalendarLinkID: f.source.id, externalEventID: resource() }).returning();
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 1);
      assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.id, tombstone!.id))).length, 1);
    });
    await fixture("unknown schema blocks before account factory", async f => {
      const saved = await f.row(); await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked"); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    for (const profile of ["all-day", "recurring"] as const) await fixture(`nominal timed host with coherent ${profile} pinned profile cannot fall back`, async f => {
      const saved = await f.row(), envelope = SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope);
      const plan = envelope.nativePlan.data;
      const change = (value: unknown) => profile === "recurring" ? String(value).replace("END:VEVENT", "RRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT") :
        String(value).replace("DTSTART:20261025T090000Z", "DTSTART;VALUE=DATE:20261025").replace("DTEND:20261025T100000Z", "DTEND;VALUE=DATE:20261026");
      plan.replacementComponent = change(plan.replacementComponent); plan.createResource = change(plan.createResource);
      Object.assign(envelope.admittedProjection.data, profile === "recurring" ? { recurrence: "RRULE:FREQ=DAILY;COUNT=2" } :
        { isAllDay: true, start: "2026-10-25T00:00:00.000Z", end: "2026-10-25T00:00:00.000Z" });
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal(decodeEventOutboxOperation(await f.row()).kind, "pinned-v1", "The generic format remains valid; the selected kernel owns its narrow profile");
      const result = await deliverEventOutbox(f.operationID, () => newAdapter); assert.equal(result?.status, "blocked");
      assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(requests.length, 0); assert.equal(legacyCalls, 0);
    });
    for (const property of ["isAllDay", "isMeeting", "hasAttendees", "recurrence", "timeModel"] as const) await fixture(`unsupported host ${property} retains its guarded family`, async f => {
      const saved = await f.row(), event = { ...saved.payload.event, [property]: property === "recurrence" ? "RRULE:FREQ=DAILY" : property === "timeModel"
        ? { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-25T09:00:00", endLocal: "2026-10-25T10:00:00" } : true };
      await db.update(eventOutbox).set({ payload: { ...saved.payload, event } }).where(eq(eventOutbox.id, f.operationID));
      await deliverEventOutbox(f.operationID, () => newAdapter); assert.equal(factoryCalls, 0); assert.equal(sessions, 0);
    });
    await fixture("unregistered adapter keeps its original executor", async f => {
      assert.equal((await deliverEventOutbox(f.operationID, () => oldAdapter))?.status, "completed"); assert.equal(factoryCalls, 0);
    });
    await fixture("legacy payload keeps its original executor", async f => {
      const saved = await f.row(), { operationCapture, operationEnvelope, ...payload } = saved.payload;
      await db.update(eventOutbox).set({ payload }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed"); assert.equal(factoryCalls, 0); assert(legacyCalls > 0);
    });
    await fixture("ACK waiting on the canonical lock rolls back mapping removal after timeout", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["caldavPersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetchPinned(url, init, address) {
          const response = await bridge.ports.http.fetchPinned(url, init, address);
          if (init.method === "DELETE") { await blocker.query("BEGIN"); transaction = true; await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        assert.equal((await deliverSharedCaldavDelete(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 800, heartbeatMs: 5 }))?.status, "unconfirmed");
        assert(transaction); assert(await f.mapped()); await blocker.query("COMMIT"); transaction = false; await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert(await f.mapped());
      } finally { if (transaction) await blocker.query("ROLLBACK"); blocker.release(); }
    });
    await fixture("one heartbeat and ignored-signal DELETE cannot acknowledge late", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      let entered!: () => void, release!: () => void, intervals = 0;
      const dispatched = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { if (args[1] === 5) intervals++; return originalInterval(...args); }) as typeof setInterval;
      const factory: NonNullable<CalendarAdapter["caldavPersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetchPinned(url, init, address) {
          const response = await bridge.ports.http.fetchPinned(url, init, address); if (init.method === "DELETE") { entered(); await blocked; } return response;
        } } } };
      };
      try {
        const delivery = deliverSharedCaldavDelete(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await dispatched; assert.equal((await delivery)?.status, "unconfirmed"); assert.equal(intervals, 1); assert(await f.mapped());
        release(); await pause(35); assert.equal((await f.row()).status, "unconfirmed"); assert(await f.mapped());
        assert.equal(requests.length, 4);
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    await fixture("a DNS wait is bounded and cannot dispatch after cancellation", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      let entered!: () => void, release!: () => void;
      const resolving = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
      const factory: NonNullable<CalendarAdapter["caldavPersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, network: { ...bridge.ports.network, async lookupImpl(hostname, options) {
          entered(); await blocked; return bridge.ports.network.lookupImpl(hostname, options);
        } } } };
      };
      try {
        const delivery = deliverSharedCaldavDelete(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await Promise.race([resolving, delivery.then(() => { throw new Error("DNS lookup was not reached"); })]);
        assert.equal((await delivery)?.status, "retry"); assert.equal(requests.length, 0);
        release(); await pause(35); assert.equal((await f.row()).status, "retry"); assert.equal(requests.length, 0); assert(await f.mapped());
      } finally { release(); }
    }, true, true);
    for (const phase of ["beforeDelete", "afterDelete"] as const) await fixture(`SIGKILL at ${phase} resumes accepted conditional identity`, async f => {
      const payload = JSON.stringify((await f.row()).payload), worker = child(f.operationID, phase);
      try { await worker.checkpoint; } finally { worker.proc.kill("SIGKILL"); }
      assert.equal((await worker.exited).signal, "SIGKILL"); const before = requests.length;
      await due(f.operationID); const restarted = await child(f.operationID).exited; assert.equal(restarted.code, 0, restarted.stderr);
      assert.equal((await f.row()).status, "completed"); assert.equal(JSON.stringify((await f.row()).payload), payload);
      assert.equal(requests.filter(value => value.method === "DELETE").length, 1);
      assert.deepEqual(requests.slice(before).map(value => value.method), phase === "beforeDelete" ? ["GET", "PROPFIND", "GET", "DELETE"] : ["GET"]);
    }, false);
    console.log(`DAV shared DELETE PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    config.api.syncOperationV1EncoderEnabled = originalEncoder; server.closeAllConnections(); secondary.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => secondary.close(() => resolve()))]); await pool.end();
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
