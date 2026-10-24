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
  account, claimEventOutbox, createCalendar, createEvent, db, deleteExternalEvent, eventOutbox, events,
  externalCalendars, externalEvents, externalEventTombstones, getEvent, patchEventAndCalendarLinks,
  upsertExternalEvent, user, type EventOutboxIntent,
} from "@musubi/db";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { googleAdapter } from "./adapters/google";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverSharedGoogleCreate } from "./google_shared_create_delivery";

const scope = "https://www.googleapis.com/auth/calendar.events";
const nativeCalendar = "create/calendar+id@example.test";
type Wire = { method: string; path: string; body: unknown; ifMatch: string | undefined };
type HostProfile = "timed" | "all-day" | "recurring";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const originalFetch = globalThis.fetch, originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let mode = "success", remote: any = null, nativeID = "", factoryCalls = 0, legacyCalls = 0, sessions = 0;
  let requests: Wire[] = [], failures: unknown[] = [];
  let onCalendar: (() => Promise<void>) | undefined, afterPost: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const url = new URL(req.url!, "http://fixture.test"), method = req.method!;
      const body = bytes ? JSON.parse(bytes) : null;
      requests.push({ method, path: url.pathname, body,
        ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined });
      assert.equal(req.headers.authorization, "Bearer create.fixture.access");
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname.includes("/calendarList/")) {
        await onCalendar?.();
        return json({ id: nativeCalendar, accessRole: "owner" });
      }
      const collection = `/calendar/v3/calendars/${encodeURIComponent(nativeCalendar)}/events`;
      if (method === "GET") {
        assert.equal(url.pathname, `${collection}/${nativeID}`);
        if (mode === "gone") return json({}, 410);
        if (mode === "partial") return json({}, 206);
        if (!remote || mode === "absent") return json({}, 404);
        const value = structuredClone(remote);
        if (mode === "cancelled") value.status = "cancelled";
        if (mode === "wrong-marker") value.extendedProperties.private.musubiOperationID = randomUUID();
        if (mode === "different-content") value.summary = "External change";
        if (mode === "nullable-read") { delete value.etag; value.description = null; value.location = null; }
        if (mode === "range") res.setHeader("content-range", "items 0-0/2");
        return json(value);
      }
      assert.equal(url.pathname, collection); assert.equal(method, "POST"); assert.equal(req.headers["if-match"], undefined);
      assert.equal(body.id, nativeID);
      if (["400", "401", "403", "409", "412", "429", "500"].includes(mode)) {
        if (mode === "429") res.setHeader("retry-after", "1");
        return json({}, Number(mode));
      }
      assert.equal(remote, null, "An already materialized CREATE must never be sent again");
      remote = { ...body, status: "confirmed", etag: '\"created\"', organizer: { self: true }, attendees: [] };
      await afterPost?.();
      if (mode === "lost") return res.destroy();
      if (mode === "wrong-id") return json({ id: "foreign" }, 201);
      if (mode === "malformed") { res.writeHead(201, { "content-type": "application/json" }); return res.end('{"id":'); }
      if (mode === "nullable-validator") return json({ id: nativeID }, 201);
      if (mode === "weak-validator") return json({ id: nativeID, etag: 'W/"weak"' }, 201);
      return json(remote, 201);
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://www.googleapis.com", "Only the owned HTTP fixture is reachable");
    return originalFetch(`${origin}${url.pathname}${url.search}`, init).then(response => {
      Object.defineProperty(response, "url", { value: url.href }); return response;
    });
  };
  const oldAdapter: CalendarAdapter = { ...googleAdapter, googlePersonalCreateV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...googleAdapter,
    googlePersonalCreateV1(userID, accountID, capture) {
      factoryCalls++;
      const bridge = googleAdapter.googlePersonalCreateV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.notEqual(target.connectionId, accountID);
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return googleAdapter.assertEventWrite!(...args); },
    async pushCreate(...args) { legacyCalls++; return googleAdapter.pushCreate(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function seed(operationID: string = randomUUID(), profile: HostProfile = "timed") {
    const owner = `create-${randomUUID()}`, accountID = `logical-${randomUUID()}`, grantID = randomUUID();
    await db.insert(user).values({ id: owner, name: "Shared CREATE fixture", email: `${owner}@example.test` });
    await db.insert(account).values({ id: grantID, userId: owner, providerId: "google", accountId: accountID, scope,
      accessToken: "create.fixture.access", refreshToken: "create.fixture.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Create fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google", userID: owner,
      accountID, externalCalendarID: nativeCalendar, providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: "Accepted CREATE A", description: "", location: "", color: "#112233",
      start: profile === "all-day" ? "2026-10-24T00:00:00.000Z" : "2026-10-24T09:00:00.000Z",
      end: profile === "all-day" ? "2026-10-24T00:00:00.000Z" : "2026-10-24T10:00:00.000Z",
      isAllDay: profile === "all-day", isCanceled: false, recurrence: profile === "recurring" ? "RRULE:FREQ=DAILY;COUNT=2" : null });
    const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
      eventID: event.id, calendarID: calendar.id, externalCalendarLinkID: source!.id, provider: "google", userID: owner,
      accountID, externalCalendarID: nativeCalendar, action: "create", payload: { event, createIdentityVersion: 1 } };
    await createEvent(event, event.calendars, [intent]);
    const row = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id)))[0];
    return { owner, accountID, grantID, calendar, source: source!, event, operationID, row, mapped };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function fixture(label: string, body: (f: Fixture) => Promise<void>, operationID?: string, profile: HostProfile = "timed") {
    mode = "success"; remote = null; requests = []; failures = []; onCalendar = afterPost = undefined;
    factoryCalls = legacyCalls = sessions = 0;
    const f = await seed(operationID, profile); nativeID = `musubi${f.operationID.replace(/-/g, "")}`;
    try { await body(f); assert.deepEqual(failures, []); cases++; console.log(`Google shared CREATE: ${label}: PASS`); }
    finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); }
  }
  const retry = async (f: Fixture) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
  const child = (operationId: string, at?: "beforePost" | "afterPost") => {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./google_create_process.fixture.ts", import.meta.url))], {
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
    resultRef: result.resultRef, mapping: (await f.mapped()) ? { externalEventID: (await f.mapped())!.externalEventID, etag: (await f.mapped())!.etag } : null,
  });
  try {
    for (const variant of ["success", "nullable-validator", "weak-validator", "lost", "malformed", "wrong-id", "400", "401", "403", "409", "412", "429", "500"]) {
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
        assert.equal(requests.filter(value => value.method === "POST").length, 1);
      }, operationID);
    }
    for (const variant of ["success", "nullable-read", "gone", "partial", "range", "cancelled", "wrong-marker", "different-content"]) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      const operationID = randomUUID();
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`${variant} recovery ${label}`, async f => {
          mode = "lost"; assert.equal((await deliverEventOutbox(f.operationID, () => adapter))?.status, "unconfirmed");
          assert.equal(requests.filter(value => value.method === "POST").length, 1);
          mode = variant; await retry(f);
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          assert.equal(requests.filter(value => value.method === "POST").length, 1, "Recovery never blindly creates a second resource");
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await snapshot(result, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(result, f), oldOutcome); }
        }, operationID);
      }
    }
    await fixture("recovery 404 retries only the same frozen ID and body", async f => {
      mode = "lost"; await deliverEventOutbox(f.operationID, () => newAdapter);
      const first = requests.find(value => value.method === "POST")!;
      remote = null; mode = "success"; await retry(f);
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      const writes = requests.filter(value => value.method === "POST"); assert.equal(writes.length, 2); assert.deepEqual(writes[1], first);
      assert.equal((await f.mapped())!.externalEventID, nativeID);
    });
    await fixture("retained deletion blocks before credentials and native requests", async f => {
      await db.insert(externalEventTombstones).values({ externalCalendarLinkID: f.source.id, externalEventID: nativeID });
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "provider-conflict");
      assert.equal(factoryCalls, 0); assert.equal(requests.length, 0); assert.equal(await f.mapped(), undefined);
    });
    await fixture("native deletion after POST prevents delayed mapping adoption", async f => {
      afterPost = () => deleteExternalEvent("google", f.calendar.id, nativeID).then(() => undefined);
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "conflict"); assert.equal(await f.mapped(), undefined);
      assert.equal(requests.filter(value => value.method === "POST").length, 1);
    });
    await fixture("pull echo before ACK preserves one canonical event", async f => {
      afterPost = async () => {
        await upsertExternalEvent("google", f.owner, f.calendar.id, nativeCalendar, nativeID, {
          title: remote.summary, description: remote.description, location: remote.location, recurrence: null,
          start: new Date(remote.start.dateTime), end: new Date(remote.end.dateTime), isAllDay: false,
          organizer: "", color: "#112233", url: null,
        }, remote.etag, null, f.operationID);
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
      assert.equal(requests.filter(value => value.method === "POST").length, 0);
    });
    await fixture("grant reconnect ABA cannot dispatch", async f => {
      onCalendar = async () => {
        await db.update(account).set({ syncStatus: "blocked" }).where(eq(account.id, f.grantID));
        await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, f.grantID));
      };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "POST").length, 0);
    });
    await fixture("narrowed scope after preflight cannot dispatch", async f => {
      onCalendar = async () => { await db.update(account).set({ scope: "openid" }).where(eq(account.id, f.grantID)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "POST").length, 0);
    });
    await fixture("unsupported schema never constructs a provider", async f => {
      const saved = await f.row(); let adapters = 0;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => { adapters++; return newAdapter; }))?.status, "blocked");
      assert.equal(adapters, 0); assert.equal(requests.length, 0); assert.equal(factoryCalls, 0);
    });
    for (const corruption of ["foreign-body-identity", "foreign-planned-locator", "noncanonical-operation-id"] as const) {
      await fixture(`${corruption} blocks before the registered writer can fall back`, async f => {
        const saved = await f.row();
        const envelope = structuredClone(SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope));
        const body = envelope.nativePlan.data.body as Record<string, unknown>;
        const foreignOperation = randomUUID(), foreignID = `musubi${foreignOperation.replace(/-/g, "")}`;
        if (corruption === "foreign-body-identity") {
          body.id = foreignID;
          body.extendedProperties = { private: { musubiOperationID: foreignOperation } };
          envelope.locator.resourceId = foreignID;
          nativeID = foreignID;
        } else if (corruption === "foreign-planned-locator") envelope.locator.resourceId = foreignID;
        else Object.assign(envelope, { operationId: `invalid-create-${randomUUID()}` });
        await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
        const result = await deliverEventOutbox(f.operationID, () => newAdapter);
        assert.deepEqual(requests, [], "Malformed pinned CREATE identity must never reach provider HTTP through a fallback");
        assert.equal(result?.status, "blocked");
        assert.equal(result?.errorCode, corruption === "noncanonical-operation-id" ? "operation-envelope-binding-mismatch" : "operation-envelope-codec-unavailable");
        assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0);
        assert.equal(await f.mapped(), undefined);
      });
    }
    for (const profile of ["all-day", "recurring"] as const) {
      await fixture(`timed host payload cannot fall back through a coherent ${profile} pinned projection`, async f => {
        const saved = await f.row(), envelope = structuredClone(SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope));
        const body = envelope.nativePlan.data.body as Record<string, unknown>;
        if (profile === "all-day") {
          Object.assign(envelope.admittedProjection.data, { isAllDay: true, start: "2026-10-24T00:00:00.000Z", end: "2026-10-24T00:00:00.000Z" });
          Object.assign(body, { start: { date: "2026-10-24" }, end: { date: "2026-10-25" } });
        } else {
          envelope.admittedProjection.data.recurrence = "RRULE:FREQ=DAILY;COUNT=2";
          body.recurrence = ["RRULE:FREQ=DAILY;COUNT=2"];
        }
        await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
        const result = await deliverEventOutbox(f.operationID, () => newAdapter);
        assert.deepEqual(requests, [], "A nominal timed CREATE with an incompatible pinned profile cannot use a second writer");
        assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "operation-envelope-codec-unavailable");
        assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0);
      });
      await fixture(`genuine ${profile} host profile retains its existing pinned writer`, async f => {
        assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
        assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert(legacyCalls > 0);
        assert.equal(requests.filter(value => value.method === "POST").length, 1);
      }, undefined, profile);
    }
    await fixture("unregistered adapter uses its existing pinned writer", async f => {
      assert.equal((await deliverEventOutbox(f.operationID, () => oldAdapter))?.status, "completed");
      assert.equal(factoryCalls, 0); assert.equal(requests.filter(value => value.method === "POST").length, 1);
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
          eventID: f.event.id, calendarID: f.calendar.id, externalCalendarLinkID: f.source.id, provider: "google", userID: f.owner,
          accountID: f.accountID, externalCalendarID: nativeCalendar, action: "update", payload: { event: f.event, patch } };
        assert.equal((await patchEventAndCalendarLinks(f.event.id, 1, patch, false, [intent])).status, "saved");
      };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert(successorID);
      const [successor] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, successorID));
      assert.equal(successor!.predecessorID, f.operationID); assert.equal(successor!.status, "pending");
      const body = requests.find(value => value.method === "POST")!.body as Record<string, unknown>;
      assert.equal(body.summary, "Accepted CREATE A"); assert.equal(body.description, ""); assert.equal(body.location, "");
      assert.equal((await getEvent(f.event.id)).title, "Canonical B");
      assert.equal((await getEvent(f.event.id)).revision, 2);
    });
    await fixture("lease takeover after provider acceptance cannot adopt mapping", async f => {
      const replacement = randomUUID();
      afterPost = async () => { await db.update(eventOutbox).set({ leaseToken: replacement, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(eventOutbox.id, f.operationID)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "attempting"); assert.equal(result?.leaseToken, replacement); assert.equal(await f.mapped(), undefined);
      assert.equal(requests.filter(value => value.method === "POST").length, 1);
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
    await fixture("one heartbeat and ignored-signal POST cannot ACK late", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      let entered!: () => void, release!: () => void, intervals = 0;
      const dispatched = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { if (args[1] === 5) intervals++; return originalInterval(...args); }) as typeof setInterval;
      const factory: NonNullable<CalendarAdapter["googlePersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "POST") { entered(); await blocked; }
          return response;
        } } } };
      };
      try {
        const delivery = deliverSharedGoogleCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await dispatched; assert.equal((await delivery)?.status, "unconfirmed"); assert.equal(intervals, 1); assert.equal(await f.mapped(), undefined);
        release(); await pause(35); assert.equal((await f.row()).status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    await fixture("waiting ACK rolls back mapping adoption after timeout", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["googlePersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "POST") { await blocker.query("BEGIN"); transaction = true; await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        const result = await deliverSharedGoogleCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 800, heartbeatMs: 5 });
        assert(transaction); assert.equal(result?.status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
        await blocker.query("COMMIT"); transaction = false; await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
      } finally { if (transaction) await blocker.query("ROLLBACK"); blocker.release(); }
    });
    for (const phase of ["beforePost", "afterPost"] as const) {
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
        assert.equal(requests.filter(value => value.method === "POST").length, 1);
        if (phase === "afterPost") assert.deepEqual(requests.slice(priorRequests).map(value => value.method), ["GET"]);
        else assert.deepEqual(requests.slice(priorRequests).map(value => value.method), ["GET", "GET", "POST"]);
        assert.equal((await f.mapped())!.externalEventID, nativeID);
      });
    }
    console.log(`Google shared CREATE PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    globalThis.fetch = originalFetch; config.api.syncOperationV1EncoderEnabled = originalEncoder;
    await pool.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
