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
  caldavAccounts, saveCaldavAccount, claimEventOutbox, createCalendar, createEvent, db, deleteExternalEvent, eventOutbox, events,
  externalCalendars, externalEvents, externalEventTombstones, getEvent, patchEventAndCalendarLinks,
  upsertExternalEvent, user, type EventOutboxIntent,
} from "@musubi/db";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { caldavAdapter } from "./adapters/caldav";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverSharedCaldavCreate } from "./caldav_shared_create_delivery";
import { encryptSecret } from "./crypto";
import { providerHttpMetricsRegistry } from "./provider_http_metrics";
import { encodeEventV1 } from "@musubi/sync-codec";

const authorization = `Basic ${Buffer.from("fixture:fixture-password").toString("base64")}`;
type Wire = { method: string; path: string; host: "primary" | "secondary"; body: string; authorization?: string;
  ifNoneMatch?: string; ifMatch?: string; accept?: string; depth?: string; contentType?: string; cacheControl?: string };
type HostProfile = "timed" | "all-day" | "recurring";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  assert.equal(config.security.federationAllowPrivateHosts, true, "Owned loopback needs its explicit QA policy");
  const originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let mode = "success", remote: string | null = null, nativeID = "", nativeUID = "", factoryCalls = 0, legacyCalls = 0, sessions = 0;
  let requests: Wire[] = [], failures: unknown[] = [];
  let onCalendar: (() => Promise<void>) | undefined, afterPost: (() => Promise<void>) | undefined;
  let origin = "", secondaryOrigin = "", collectionPath = "/dav/calendar/";
  const collection = () => origin + collectionPath;
  const xml = (href: string, value: string) => `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${value}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const handler = (host: Wire["host"]) => async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const url = new URL(req.url!, host === "primary" ? origin : secondaryOrigin), method = req.method!;
      const header = (name: string) => typeof req.headers[name] === "string" ? req.headers[name] as string : undefined;
      requests.push({ method, path: url.pathname + url.search, host, body, authorization: header("authorization"), ifNoneMatch: header("if-none-match"),
        ifMatch: header("if-match"), accept: header("accept"), depth: header("depth"), contentType: header("content-type"), cacheControl: header("cache-control") });
      assert.equal(header("authorization"), host === "secondary" ? undefined : authorization);
      const respond = (status: number, data = "", headers: Record<string, string> = {}) => { res.writeHead(status, headers); res.end(data); };
      if (method === "PROPFIND") {
        assert.equal(header("depth"), "0"); assert(body.includes("current-user-privilege-set"));
        await onCalendar?.();
        if (mode === "acl-drop") return res.destroy();
        if (/^acl-\d+$/.test(mode)) return respond(Number(mode.slice(4)), "", mode === "acl-429" ? { "retry-after": "1" } : {});
        if (mode === "acl-redirect" && url.pathname === "/dav/calendar/") return respond(307, "", { location: "/dav/acl-alias/" });
        if (mode === "acl-malformed") return respond(207, "<broken", { "content-type": "application/xml" });
        if (mode === "acl-range") res.setHeader("content-range", "items 0-0/2");
        const privilege = mode === "acl-write" ? "write" : mode === "acl-all" ? "all" : mode === "acl-write-content" ? "write-content" : "bind";
        const property = mode === "acl-missing" ? "<d:displayname>Calendar</d:displayname>" : `<d:current-user-privilege-set>${mode === "acl-denied" ? "" : `<d:privilege><d:${privilege}/></d:privilege>`}</d:current-user-privilege-set>`;
        return respond(207, xml(collection(), property), { "content-type": "application/xml" });
      }
      assert([new URL(nativeID).pathname, "/dav/calendar/alias.ics"].includes(url.pathname));
      if (method === "GET") {
        if (/^read-\d+$/.test(mode)) return respond(Number(mode.slice(5)), "", mode === "read-429" ? { "retry-after": "1" } : {});
        if (mode === "read-drop") return res.destroy();
        if (mode === "get-redirect" && url.pathname !== "/dav/calendar/alias.ics") return respond(302, "", { location: "/dav/calendar/alias.ics" });
        if (!remote || mode === "absent") return respond(404);
        let value = remote;
        if (mode === "cancelled" || mode === "cancelled-missing-date") value = value.replace("END:VEVENT", "STATUS:CANCELLED\r\nEND:VEVENT");
        if (mode === "wrong-uid") value = value.replace(`UID:${nativeUID}`, "UID:foreign@example.test");
        if (mode === "duplicate-uid") value = value.replace(`UID:${nativeUID}`, `UID:${nativeUID}\r\nUID:${nativeUID}`);
        if (mode === "duplicate-master") value = value.replace("END:VCALENDAR", value.slice(value.indexOf("BEGIN:VEVENT"), value.indexOf("END:VEVENT") + 10) + "\r\nEND:VCALENDAR");
        if (mode === "different-content") value = value.replace("Accepted CREATE A", "External change");
        if (mode === "missing-date" || mode === "cancelled-missing-date") value = value.replace(/^DTSTART.*\r?\n/m, "");
        if (mode === "broken") value = "not calendar data";
        if (mode === "recurrence") value = value.replace("END:VEVENT", "RRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT");
        if (mode === "orphan-attendee") value = value.replace("END:VEVENT", "ATTENDEE:mailto:guest@example.test\r\nEND:VEVENT");
        if (mode === "organizer-meeting") value = value.replace("END:VEVENT", "ORGANIZER:mailto:owner@example.test\r\nATTENDEE:mailto:guest@example.test\r\nEND:VEVENT");
        if (mode === "other-master") value = value.replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:other@example.test\r\nDTSTART:20261024T110000Z\r\nDTEND:20261024T120000Z\r\nSUMMARY:Other\r\nEND:VEVENT\r\nEND:VCALENDAR");
        const etag = mode === "nullable-read" ? null : mode === "weak-read" ? 'W/"read"' : mode === "empty-read" ? '""' : mode === "malformed-read" ? "unquoted" : '"created"';
        const headers = { "content-type": mode === "read-text-plain" ? "text/plain" : "text/calendar", ...(etag === null ? {} : { etag }), ...(mode === "range" ? { "content-range": "items 0-0/2" } : {}) };
        if (mode === "invalid-utf8") { res.writeHead(200, headers); return res.end(Buffer.from([0xc3, 0x28])); }
        return respond(200, value, headers);
      }
      assert.equal(method, "PUT"); assert.equal(header("if-none-match"), "*"); assert.equal(header("if-match"), undefined);
      assert.equal(header("content-type"), "text/calendar; charset=utf-8"); assert(body.includes(`UID:${nativeUID}`));
      if (url.pathname !== "/dav/calendar/alias.ics") {
        if (mode === "put-redirect303") return respond(303, "", { location: "/dav/calendar/alias.ics" });
        if (mode === "put-redirect307") return respond(307, "", { location: "/dav/calendar/alias.ics" });
        if (mode === "put-cross-origin307") return respond(307, "", { location: secondaryOrigin + "/dav/calendar/alias.ics" });
      }
      if (["202", "206", "400", "401", "403", "404", "408", "409", "410", "412", "429", "500"].includes(mode)) return respond(Number(mode), "", mode === "429" ? { "retry-after": "1" } : {});
      assert.equal(remote, null, "An already materialized CREATE cannot be overwritten"); remote = body;
      await afterPost?.();
      if (mode === "lost") return res.destroy();
      const etag = mode === "nullable-validator" ? null : mode === "weak-validator" ? 'W/"created"' : mode === "empty-validator" ? '""' : mode === "malformed-validator" ? "unquoted" : '"created"';
      return respond(mode === "200" ? 200 : mode === "204" ? 204 : 201, "", etag === null ? {} : { etag });
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned DAV CREATE fixture assertion failed"); }
  };
  const server = createServer(handler("primary")), secondary = createServer(handler("secondary"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => secondary.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  secondaryOrigin = `http://127.0.0.1:${(secondary.address() as { port: number }).port}`;
  const oldAdapter: CalendarAdapter = { ...caldavAdapter, caldavPersonalCreateV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...caldavAdapter,
    caldavPersonalCreateV1(userID, accountID, capture) {
      factoryCalls++;
      const bridge = caldavAdapter.caldavPersonalCreateV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.equal(target.connectionId, accountID);
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return caldavAdapter.assertEventWrite!(...args); },
    async pushCreate(...args) { legacyCalls++; return caldavAdapter.pushCreate(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function seed(operationID: string = randomUUID(), profile: HostProfile = "timed") {
    const owner = `dav-create-${randomUUID()}`;
    await db.insert(user).values({ id: owner, name: "DAV CREATE fixture", email: `${owner}@example.test` });
    const savedAccount = await saveCaldavAccount(owner, origin + "/", "fixture", encryptSecret("fixture-password"));
    const accountID = savedAccount.id, grantID = accountID;
    const calendar = await createCalendar({ creatorID: owner, name: "Create fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "caldav", userID: owner,
      accountID, externalCalendarID: collection(), providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: "Accepted CREATE A", description: "", location: "", color: "#112233",
      start: profile === "all-day" ? "2026-10-24T00:00:00.000Z" : "2026-10-24T09:00:00.000Z",
      end: profile === "all-day" ? "2026-10-24T00:00:00.000Z" : "2026-10-24T10:00:00.000Z",
      isAllDay: profile === "all-day", isCanceled: false, recurrence: profile === "recurring" ? "RRULE:FREQ=DAILY;COUNT=2" : null });
    const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
      eventID: event.id, calendarID: calendar.id, externalCalendarLinkID: source!.id, provider: "caldav", userID: owner,
      accountID, externalCalendarID: collection(), action: "create", payload: { event, createIdentityVersion: 1 } };
    await createEvent(event, event.calendars, [intent]);
    const row = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id)))[0];
    return { owner, accountID, grantID, calendar, source: source!, event, operationID, row, mapped };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const metrics = async () => (await providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!.get()).values
    .filter(value => value.labels.provider === "caldav" && value.labels.family === "event").reduce((sum, value) => sum + value.value, 0);
  async function fixture(label: string, body: (f: Fixture) => Promise<void>, operationID?: string, profile: HostProfile = "timed", verifyMetrics = true, hostname = false, path = "/dav/calendar/") {
    if (process.env.MUSUBI_CREATE_API_SCENARIO && !label.includes(process.env.MUSUBI_CREATE_API_SCENARIO)) return;
    const savedOrigin = origin, savedPath = collectionPath; collectionPath = path; if (hostname) origin = origin.replace("127.0.0.1", "localhost");
    mode = "success"; remote = null; requests = []; failures = []; onCalendar = afterPost = undefined;
    factoryCalls = legacyCalls = sessions = 0;
    const f = await seed(operationID, profile); const envelope = SyncOperationEnvelopeSchema.parse((await f.row()).payload.operationEnvelope); nativeUID = String(envelope.nativePlan.data.uid); nativeID = envelope.locator.resourceId!; const beforeMetrics = await metrics();
    try { await body(f); assert.deepEqual(failures, []); if (verifyMetrics) assert.equal(await metrics() - beforeMetrics, requests.length, "Every guarded native HTTP hop is counted once"); cases++; console.log(`Caldav shared CREATE: ${label}: PASS`); }
    finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); origin = savedOrigin; collectionPath = savedPath; }
  }
  const retry = async (f: Fixture) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
  const child = (operationId: string, at?: "beforeCreate" | "afterCreate") => {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./caldav_create_process.fixture.ts", import.meta.url))], {
      env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => { proc.kill("SIGKILL"); }, 15_000);
    let output = "", stderr = "", entered!: () => void, rejectEntered!: (error: Error) => void;
    const checkpoint = new Promise<void>((resolve, reject) => { entered = resolve; rejectEntered = reject; });
    proc.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.includes('"kind":"checkpoint"')) entered();
    });
    proc.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; stderr: string }>((resolve, reject) => {
      proc.once("error", error => { clearTimeout(timeout); rejectEntered(error); reject(error); });
      proc.once("close", (code, signal) => { clearTimeout(timeout); rejectEntered(new Error("Worker exited before its checkpoint.")); resolve({ code, signal, output, stderr }); });
    });
    // Healthy workers do not use checkpoint; keep an unexpected exit rejection handled.
    void checkpoint.catch(() => undefined);
    proc.stdin.end(JSON.stringify({ operationId, fixtureOrigin: origin, ...(at ? { pause: at } : {}) }));
    return { proc, checkpoint, exited };
  };
  const snapshot = async (result: NonNullable<Awaited<ReturnType<typeof deliverEventOutbox>>>, f: Fixture) => ({
    status: result.status, uncertain: result.uncertain, errorCode: result.errorCode, attempts: result.attempts,
    resultRef: result.resultRef, remoteSnapshot: result.remoteSnapshot && { ...result.remoteSnapshot, observedAt: undefined }, mapping: (await f.mapped()) ? { externalEventID: (await f.mapped())!.externalEventID, etag: (await f.mapped())!.etag } : null,
  });
  try {
    for (const variant of ["success", "200", "204", "nullable-validator", "weak-validator", "empty-validator", "malformed-validator", "lost", "202", "206", "400", "401", "403", "404", "408", "409", "410", "412", "429", "500", "acl-write", "acl-all", "acl-write-content", "acl-denied", "acl-missing", "acl-malformed", "acl-range", "acl-drop", "acl-400", "acl-401", "acl-403", "acl-404", "acl-408", "acl-410", "acl-412", "acl-429", "acl-500", "acl-redirect", "put-redirect303", "put-redirect307", "put-cross-origin307"]) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      const operationID = randomUUID();
      await fixture(`${variant} original pinned writer`, async f => {
        mode = variant;
        const result = await deliverEventOutbox(f.operationID, () => oldAdapter); assert(result);
        oldWire = structuredClone(requests); oldOutcome = await snapshot(result, f);
      }, operationID);
      await fixture(`${variant} shared writer parity`, async f => {
        mode = variant;
        const result = await deliverEventOutbox(f.operationID, () => newAdapter); assert(result);
        assert.equal(legacyCalls, 0); assert.equal(factoryCalls, 1);
        assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(result, f), oldOutcome);
        assert.equal(requests.filter(value => value.method === "PUT").length, oldWire.filter(value => value.method === "PUT").length);
      }, operationID);
    }
    for (const variant of ["success", "nullable-read", "weak-read", "empty-read", "malformed-read", "range", "cancelled", "wrong-uid", "duplicate-uid", "duplicate-master", "different-content", "broken", "missing-date", "cancelled-missing-date", "invalid-utf8", "recurrence", "orphan-attendee", "organizer-meeting", "other-master", "read-text-plain", "get-redirect", "read-drop", "read-400", "read-401", "read-403", "read-408", "read-410", "read-429", "read-500"]) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      const operationID = randomUUID();
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`${variant} recovery ${label}`, async f => {
          mode = "lost"; assert.equal((await deliverEventOutbox(f.operationID, () => adapter))?.status, "unconfirmed");
          assert.equal(requests.filter(value => value.method === "PUT").length, 1);
          mode = variant; await retry(f);
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          assert.equal(requests.filter(value => value.method === "PUT").length, 1, "Recovery never blindly creates a second resource");
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await snapshot(result, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(result, f), oldOutcome); }
        }, operationID);
      }
    }
    for (const path of ["/dav/calendar", "/dav/calendar%20encoded/"]) {
      const operationID = randomUUID(); let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) await fixture(`admitted URI ${path} remains literal ${label}`, async f => {
        const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result); assert.equal(result.status, "completed");
        assert.equal((await f.mapped())!.externalEventID, nativeID);
        if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await snapshot(result, f); }
        else { assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(result, f), oldOutcome); }
      }, operationID, "timed", true, false, path);
    }
    for (const rejected of ["408", "429"] as const) {
      const operationID = randomUUID(); let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) await fixture(`known ${rejected} rejection allows fresh conditional retry ${label}`, async f => {
        mode = rejected; const first = await deliverEventOutbox(f.operationID, () => adapter);
        assert.equal(first?.status, "retry"); assert.equal(first?.uncertain, false);
        mode = "success"; await retry(f); const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
        assert.equal(result.status, "completed"); assert.equal(requests.filter(value => value.method === "PUT").length, 2); assert.equal(requests.filter(value => value.method === "GET").length, 0);
        if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await snapshot(result, f); }
        else { assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(result, f), oldOutcome); }
      }, operationID);
    }
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`known 412 conflict never automatically reads or adopts ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      remote = String(SyncOperationEnvelopeSchema.parse((await f.row()).payload.operationEnvelope).nativePlan.data.createResource);
      mode = "412"; const first = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(first?.status, "conflict"); assert.equal(first?.uncertain, false); assert.equal(await f.mapped(), undefined);
      mode = "success"; const before = requests.length; assert.equal((await deliverEventOutbox(f.operationID, () => adapter))?.status, "conflict");
      assert.equal(requests.length, before); assert.equal(requests.filter(value => value.method === "GET").length, 0);
    });
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`known rejection keeps inherited uncertainty with same-identity recovery ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      mode = "lost"; await deliverEventOutbox(f.operationID, () => adapter); remote = null; mode = "429"; await retry(f);
      const rejected = await deliverEventOutbox(f.operationID, () => adapter); assert.equal(rejected?.status, "unconfirmed"); assert.equal(rejected?.uncertain, true);
      mode = "success"; await retry(f); assert.equal((await deliverEventOutbox(f.operationID, () => adapter))?.status, "completed");
      const puts = requests.filter(value => value.method === "PUT"); assert.equal(puts.length, 3); assert.deepEqual(puts[0], puts[1]); assert.deepEqual(puts[1], puts[2]);
    });
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`recovery 404 then native 412 stays conflict without read adoption ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      mode = "lost"; await deliverEventOutbox(f.operationID, () => adapter); remote = null; mode = "412"; await retry(f);
      const result = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(result?.status, "conflict"); assert.equal(result?.uncertain, true); assert.equal(await f.mapped(), undefined);
      assert.deepEqual(requests.map(value => value.method), ["PROPFIND", "PUT", "GET", "PROPFIND", "PUT"]);
    });
    for (const phase of ["first", "second"] as const) {
      const operationID = randomUUID(); let oldOutcome: unknown, oldWire: Wire[] = [];
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) await fixture(`${phase} Basic decryption failure ${label}`, async f => {
        const corrupt = async () => { await pool.query("UPDATE caldav_accounts SET encrypted_password=$2 WHERE id=$1", [f.accountID, "broken"]); };
        if (phase === "first") await corrupt(); else onCalendar = corrupt;
        const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
        assert.equal(result.status, phase === "first" ? "retry" : "unconfirmed"); assert.equal(result.uncertain, phase === "second");
        assert.equal(requests.length, phase === "first" ? 0 : 1); assert.equal(await f.mapped(), undefined);
        if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await snapshot(result, f); }
        else { assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(result, f), oldOutcome); }
      }, operationID);
    }
    await fixture("fresh PUT sends only the frozen admitted full resource", async f => {
      const plan = SyncOperationEnvelopeSchema.parse((await f.row()).payload.operationEnvelope).nativePlan.data;
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(requests.length, 2); assert.equal(requests[0]!.method, "PROPFIND"); assert.equal(requests[1]!.method, "PUT");
      assert.equal(requests[1]!.body, plan.createResource); assert.equal((await f.mapped())!.icalUid, plan.uid);
    });
    await fixture("recovery 404 retries only the same frozen ID and body", async f => {
      mode = "lost"; await deliverEventOutbox(f.operationID, () => newAdapter);
      const first = requests.find(value => value.method === "PUT")!;
      remote = null; mode = "success"; await retry(f);
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      const writes = requests.filter(value => value.method === "PUT"); assert.equal(writes.length, 2); assert.deepEqual(writes[1], first);
      assert.equal((await f.mapped())!.externalEventID, nativeID);
    });
    await fixture("retained deletion blocks before credentials and native requests", async f => {
      await db.insert(externalEventTombstones).values({ externalCalendarLinkID: f.source.id, externalEventID: nativeID });
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "provider-conflict");
      assert.equal(factoryCalls, 0); assert.equal(requests.length, 0); assert.equal(await f.mapped(), undefined);
    });
    await fixture("native deletion after PUT prevents delayed mapping adoption", async f => {
      afterPost = () => deleteExternalEvent("caldav", f.calendar.id, nativeID).then(() => undefined);
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "conflict"); assert.equal(await f.mapped(), undefined);
      assert.equal(requests.filter(value => value.method === "PUT").length, 1);
    });
    await fixture("pull echo before ACK preserves one canonical event", async f => {
      afterPost = async () => {
        await upsertExternalEvent("caldav", f.owner, f.calendar.id, collection(), nativeID, {
          title: f.event.title, description: f.event.description ?? null, location: f.event.location ?? null, recurrence: null,
          start: f.event.start, end: f.event.end, isAllDay: false,
          organizer: "", color: "#112233", url: null,
        }, '"created"', nativeUID, f.operationID);
        assert.equal((await getEvent(f.event.id)).revision, 1);
        assert.equal(await f.mapped(), undefined, "A projected pull is not a native mapping ACK");
      };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal((await db.select().from(events).where(eq(events.creatorID, f.owner))).length, 1);
      assert.equal((await f.mapped())!.externalEventID, nativeID);
    });
    await fixture("source generation changes before dispatch", async f => {
      onCalendar = async () => { await db.update(externalCalendars).set({ providerAccessRevision: 2 }).where(eq(externalCalendars.id, f.source.id)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "delivery-source-changed");
      assert.equal(requests.filter(value => value.method === "PUT").length, 0);
    });
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`owned account timestamp changes during ACL refuses PUT ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      onCalendar = async () => { await db.update(caldavAccounts).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(caldavAccounts.id, f.accountID)); };
      const result = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(result?.status, "blocked"); assert.equal(result?.uncertain, false); assert.equal(result?.errorCode, "delivery-source-changed");
      assert.equal(requests.length, 1); assert.equal(requests.filter(value => value.method === "PUT").length, 0); assert.equal(await f.mapped(), undefined);
    });
    await fixture("privacy retirement before credentials refuses native requests", async f => {
      await db.update(events).set({ providerReadRetiredRevision: 2 }).where(eq(events.id, f.event.id));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked"); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("a different canonical object cannot occupy the accepted resource", async f => {
      const other = EventSchema.parse({ ...f.event, id: randomUUID() }); await createEvent(other, other.calendars);
      afterPost = async () => { await db.insert(externalEvents).values({ provider: "caldav", eventID: other.id, calendarID: f.calendar.id,
        externalCalendarID: collection(), externalEventID: nativeID, icalUid: nativeUID, etag: '"other"' }); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter); assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "mapping-identity-changed"); assert.equal(await f.mapped(), undefined);
    });
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`changed pull before ACK is retained ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      afterPost = async () => { await upsertExternalEvent("caldav", f.owner, f.calendar.id, collection(), nativeID, {
        title: "Concurrent remote change", description: "Other notes", location: "Other place", recurrence: null,
        start: f.event.start, end: f.event.end, isAllDay: false, organizer: "", color: "#112233", url: null,
      }, '"pulled"', nativeUID, f.operationID); };
      const result = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(result?.status, "conflict"); assert.equal(result.remoteSnapshot?.values?.title, "Concurrent remote change"); assert.equal(await f.mapped(), undefined);
    });
    await fixture("an unresolved predecessor prevents a dependent CREATE claim", async f => {
      const next = randomUUID(), intent: EventOutboxIntent = { id: next, actorID: f.owner, mutationID: randomUUID(), position: 0, eventID: f.event.id, calendarID: f.calendar.id,
        externalCalendarLinkID: f.source.id, provider: "caldav", userID: f.owner, accountID: f.accountID, externalCalendarID: collection(), action: "create", payload: { event: f.event, createIdentityVersion: 1 } };
      await patchEventAndCalendarLinks(f.event.id, 1, { title: "Successor" }, false, [intent]);
      const result = await deliverEventOutbox(next, () => newAdapter); assert.equal(result?.status, "pending"); assert.equal(result?.predecessorID, f.operationID); assert.equal(requests.length, 0); assert.equal(factoryCalls, 0);
    });
    await fixture("unsupported schema never constructs a provider", async f => {
      const saved = await f.row(); let adapters = 0;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => { adapters++; return newAdapter; }))?.status, "blocked");
      assert.equal(adapters, 0); assert.equal(requests.length, 0); assert.equal(factoryCalls, 0);
    });
    for (const corruption of ["foreign-plan-uid", "foreign-planned-locator", "noncanonical-operation-id"] as const) await fixture(`${corruption} blocks without fallback`, async f => {
      const saved = await f.row(), envelope = structuredClone(SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope));
      if (corruption === "foreign-plan-uid") {
        const foreign = `musubi-${randomUUID()}`, plan = envelope.nativePlan.data;
        plan.uid = foreign; plan.createResource = String(plan.createResource).split(nativeUID).join(foreign); plan.replacementComponent = String(plan.replacementComponent).split(nativeUID).join(foreign);
      } else if (corruption === "foreign-planned-locator") envelope.locator.resourceId = collection() + "foreign.ics";
      else Object.assign(envelope, { operationId: `invalid-create-${randomUUID()}` });
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.length, 0); assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0);
    });
    for (const profile of ["all-day", "recurring"] as const) {
      await fixture(`timed host payload cannot fall back through a coherent ${profile} pinned projection`, async f => {
        const saved = await f.row(), envelope = structuredClone(SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope));
        const altered = EventSchema.parse({ ...f.event, ...(profile === "all-day" ? { isAllDay: true, start: "2026-10-24T00:00:00.000Z", end: "2026-10-24T00:00:00.000Z" } : { recurrence: "RRULE:FREQ=DAILY;COUNT=2" }) });
        const encoded = encodeEventV1("caldav", altered, undefined, { action: "create", operationId: f.operationID, acceptedAt: "2026-10-24T00:00:00.000Z" });
        envelope.admittedProjection = encoded.admittedProjection; envelope.nativePlan = encoded.nativePlan;
        await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
        const result = await deliverEventOutbox(f.operationID, () => newAdapter);
        assert.deepEqual(requests, [], "A nominal timed CREATE with an incompatible pinned profile cannot use a second writer");
        assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "operation-envelope-codec-unavailable");
        assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0);
      });
      await fixture(`genuine ${profile} host profile retains its existing pinned writer`, async f => {
        assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
        assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert(legacyCalls > 0);
        assert.equal(requests.filter(value => value.method === "PUT").length, 1);
      }, undefined, profile);
    }
    await fixture("unregistered adapter uses its existing pinned writer", async f => {
      assert.equal((await deliverEventOutbox(f.operationID, () => oldAdapter))?.status, "completed");
      assert.equal(factoryCalls, 0); assert.equal(requests.filter(value => value.method === "PUT").length, 1);
    });
    await fixture("legacy admission uses its existing writer", async f => {
      const saved = await f.row(); const { operationCapture, operationEnvelope, ...payload } = saved.payload;
      await db.update(eventOutbox).set({ payload }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(factoryCalls, 0); assert(legacyCalls > 0);
    });
    await fixture("source retirement after provider acceptance rejects ACK", async f => {
      afterPost = async () => { await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "operation-source-changed"); assert.equal(await f.mapped(), undefined);
    });
    await fixture("a later admitted revision does not reserialize pending CREATE", async f => {
      let successorID: string | undefined;
      onCalendar = async () => {
        successorID = randomUUID();
        const patch = { title: "Canonical B", description: "B notes", location: "B place" };
        const intent: EventOutboxIntent = { id: successorID, actorID: f.owner, mutationID: randomUUID(), position: 0,
          eventID: f.event.id, calendarID: f.calendar.id, externalCalendarLinkID: f.source.id, provider: "caldav", userID: f.owner,
          accountID: f.accountID, externalCalendarID: collection(), action: "update", payload: { event: f.event, patch } };
        assert.equal((await patchEventAndCalendarLinks(f.event.id, 1, patch, false, [intent])).status, "saved");
      };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert(successorID);
      const [successor] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, successorID));
      assert.equal(successor!.predecessorID, f.operationID); assert.equal(successor!.status, "pending");
      const body = requests.find(value => value.method === "PUT")!.body;
      assert(body.includes("SUMMARY:Accepted CREATE A")); assert(!body.includes("Canonical B"));
      assert.equal((await getEvent(f.event.id)).title, "Canonical B");
      assert.equal((await getEvent(f.event.id)).revision, 2);
    });
    await fixture("lease takeover after provider acceptance cannot adopt mapping", async f => {
      const replacement = randomUUID();
      afterPost = async () => { await db.update(eventOutbox).set({ leaseToken: replacement, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(eventOutbox.id, f.operationID)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "attempting"); assert.equal(result?.leaseToken, replacement); assert.equal(await f.mapped(), undefined);
      assert.equal(requests.filter(value => value.method === "PUT").length, 1);
    });
    await fixture("known time remains on its existing guarded family", async f => {
      const saved = await f.row();
      await db.update(eventOutbox).set({ payload: { ...saved.payload, event: { ...saved.payload.event,
        timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-24T09:00:00", endLocal: "2026-10-24T10:00:00" } } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("meeting classification without attendees retains the existing guarded route", async f => {
      const saved = await f.row();
      await db.update(eventOutbox).set({ payload: { ...saved.payload, event: { ...saved.payload.event,
        isMeeting: true, hasAttendees: false } } }).where(eq(eventOutbox.id, f.operationID));
      await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(factoryCalls, 0, "Read-only meeting classification cannot select the personal CREATE runtime");
      assert(legacyCalls > 0, "The existing guarded executor remains responsible for this unsupported profile");
    });
    await fixture("one heartbeat and ignored-signal PUT cannot ACK late", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      let entered!: () => void, release!: () => void, intervals = 0;
      const dispatched = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { if (args[1] === 5) intervals++; return originalInterval(...args); }) as typeof setInterval;
      const factory: NonNullable<CalendarAdapter["caldavPersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetchPinned(url, init, address) {
          const response = await bridge.ports.http.fetchPinned(url, init, address);
          if (init.method === "PUT") { entered(); await blocked; }
          return response;
        } } } };
      };
      try {
        const delivery = deliverSharedCaldavCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await dispatched; assert.equal((await delivery)?.status, "unconfirmed"); assert.equal(intervals, 1); assert.equal(await f.mapped(), undefined);
        release(); await pause(35); assert.equal((await f.row()).status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    await fixture("waiting ACK rolls back mapping adoption after timeout", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["caldavPersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetchPinned(url, init, address) {
          const response = await bridge.ports.http.fetchPinned(url, init, address);
          if (init.method === "PUT") { await blocker.query("BEGIN"); transaction = true; await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        const result = await deliverSharedCaldavCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 800, heartbeatMs: 5 });
        assert(transaction); assert.equal(result?.status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
        await blocker.query("COMMIT"); transaction = false; await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
      } finally { if (transaction) await blocker.query("ROLLBACK"); blocker.release(); }
    });
    await fixture("private host policy refuses loopback before any HTTP", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      const factory: NonNullable<CalendarAdapter["caldavPersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalCreateV1!(...args); return { ...bridge, ports: { ...bridge.ports, network: { ...bridge.ports.network, allowPrivate: false } } };
      };
      const result = await deliverSharedCaldavCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory);
      assert.equal(result?.status, "retry"); assert.equal(result?.uncertain, false); assert.equal(requests.length, 0); assert.equal(await f.mapped(), undefined);
    });
    await fixture("a DNS wait is bounded with no late HTTP or ACK", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
      const factory: NonNullable<CalendarAdapter["caldavPersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.caldavPersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, network: { ...bridge.ports.network, async lookupImpl(hostname, options) {
          entered(); await blocked; return bridge.ports.network.lookupImpl(hostname, options);
        } } } };
      };
      try {
        const delivery = deliverSharedCaldavCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 180, heartbeatMs: 5 });
        await Promise.race([waiting, delivery.then(() => { throw new Error("Expected the real DNS boundary"); })]);
        assert.equal((await delivery)?.status, "retry"); assert.equal(requests.length, 0); assert.equal(await f.mapped(), undefined);
        release(); await pause(35); assert.equal(requests.length, 0); assert.equal(await f.mapped(), undefined);
      } finally { release(); }
    }, undefined, "timed", true, true);
    for (const phase of ["beforeCreate", "afterCreate"] as const) {
      await fixture(`SIGKILL at ${phase} restarts with the original CREATE identity`, async f => {
        const payload = JSON.stringify((await f.row()).payload);
        const worker = child(f.operationID, phase);
        try { await worker.checkpoint; }
        finally { worker.proc.kill("SIGKILL"); }
        const killed = await worker.exited; assert.equal(killed.signal, "SIGKILL");
        const priorRequests = requests.length;
        await retry(f);
        const restarted = await child(f.operationID).exited;
        assert.equal(restarted.code, 0, restarted.stderr); assert.equal(restarted.signal, null);
        const lines = restarted.output.trim().split("\n");
        const receipt = JSON.parse(lines[lines.length - 1]!);
        assert.equal(receipt.status, "completed"); assert.equal((await f.row()).status, "completed");
        assert.equal(JSON.stringify((await f.row()).payload), payload);
        assert.equal(requests.filter(value => value.method === "PUT").length, 1);
        if (phase === "afterCreate") assert.deepEqual(requests.slice(priorRequests).map(value => value.method), ["GET"]);
        else assert.deepEqual(requests.slice(priorRequests).map(value => value.method), ["GET", "PROPFIND", "PUT"]);
        assert.equal((await f.mapped())!.externalEventID, nativeID);
      }, undefined, "timed", false);
    }
    assert(cases > 0, "The fixture filter must select at least one scenario");
    console.log(`Caldav shared CREATE PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    config.api.syncOperationV1EncoderEnabled = originalEncoder;
    await pool.end(); server.closeAllConnections(); secondary.closeAllConnections(); await Promise.all([server, secondary].map(value => new Promise<void>((resolve, reject) => value.close(error => error ? reject(error) : resolve()))));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
