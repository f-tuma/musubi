import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { config } from "@musubi/config";
import {
  account, claimEventOutbox, createCalendar, createEvent, db, eventOutbox, events, externalCalendars,
  externalEvents, patchEventAndCalendarLinks, user, type EventOutboxIntent,
} from "@musubi/db";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import {
  compareGooglePersonalDeleteShadow, type GooglePersonalDeletePolicy, type RuntimeDeleteDecisionContext,
  type RuntimeDeleteRecordedFrame,
} from "@musubi/sync-runtime";
import { googleAdapter } from "./adapters/google";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverSharedGoogleDelete } from "./google_shared_delete_delivery";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const policy: GooglePersonalDeletePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-google", observeConflict: true };
const scope = "https://www.googleapis.com/auth/calendar.events";
const nativeCalendar = "paired/calendar+id@example.test", nativeId = "paired/event+id";
const originalNative = () => ({ id: nativeId, etag: '"accepted"', status: "confirmed", summary: "Before",
  description: "Before notes" as string | null, location: "Before place" as string | null,
  start: { dateTime: "2026-10-13T09:00:00.000Z" }, end: { dateTime: "2026-10-13T10:00:00.000Z" },
  organizer: { self: true }, attendees: [] });

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const originalFetch = globalThis.fetch, originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let remote: any = originalNative(), mode = "success", factoryCalls = 0, legacyCalls = 0, sessions = 0;
  let requests: { method: string; path: string; body: unknown; ifMatch: string | undefined }[] = [];
  let absent = false, reads = 0, failures: unknown[] = [];
  let onCalendar: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const url = new URL(req.url!, "http://fixture.test"), method = req.method!;
      requests.push({ method, path: url.pathname, body: bytes ? JSON.parse(bytes) : null,
        ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined });
      const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      assert.equal(req.headers.authorization, "Bearer c07.fixture.access");
      if (url.pathname.includes("/calendarList/")) {
        await onCalendar?.();
        return json({ id: nativeCalendar, accessRole: "owner" });
      }
      assert.equal(url.pathname, `/calendar/v3/calendars/${encodeURIComponent(nativeCalendar)}/events/${encodeURIComponent(nativeId)}`);
      if (method === "GET") {
        reads++;
        if (absent || mode === "absent-404" || mode === "preflight-absent" && reads === 2) return json({}, 404);
        if (mode === "absent-410") return json({}, 410);
        return json(remote);
      }
      assert.equal(method, "DELETE"); assert.equal(req.headers["if-match"], remote.etag);
      if (["401", "403", "412", "429", "500"].includes(mode)) {
        if (mode === "429") res.setHeader("retry-after", "1");
        return json({}, Number(mode));
      }
      absent = true;
      if (mode === "lost") return res.destroy();
      res.writeHead(mode === "delete-404" ? 404 : mode === "delete-410" ? 410 : 204); res.end();
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://www.googleapis.com", "This fixture never uses a real provider or OAuth endpoint");
    return originalFetch(`${origin}${url.pathname}${url.search}`, init).then(response => {
      // The owned fixture routes the original Google URL to loopback without
      // pretending that a real redirect or target-address change occurred.
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    });
  };
  const oldAdapter: CalendarAdapter = { ...googleAdapter, googlePersonalDeleteV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...googleAdapter,
    googlePersonalDeleteV1(userID, accountID, capture) {
      factoryCalls++;
      const bridge = googleAdapter.googlePersonalDeleteV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.notEqual(target.connectionId, accountID,
          "Physical grant identity stays separate from the logical row binding");
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return googleAdapter.assertEventWrite!(...args); },
    async pushDelete(...args) { legacyCalls++; return googleAdapter.pushDelete(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function fixture(label: string, body: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
    remote = originalNative(); requests = []; failures = []; absent = false; reads = 0; onCalendar = undefined; factoryCalls = legacyCalls = sessions = 0;
    const f = await seed();
    try { await body(f); assert.deepEqual(failures, []); cases++; console.log(`Google shared DELETE: ${label}: PASS`); }
    finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); }
  }
  async function seed() {
    const owner = `shared-${randomUUID()}`, accountID = `logical-${randomUUID()}`, grantID = randomUUID();
    await db.insert(user).values({ id: owner, name: "Shared runtime fixture", email: `${owner}@example.test` });
    await db.insert(account).values({ id: grantID, userId: owner, providerId: "google", accountId: accountID, scope,
      accessToken: "c07.fixture.access", refreshToken: "c07.fixture.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Shared fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google", userID: owner,
      accountID, externalCalendarID: nativeCalendar, providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: remote.summary, description: remote.description, location: remote.location, color: "#112233",
      start: remote.start.dateTime, end: remote.end.dateTime, isAllDay: false, isCanceled: false });
    await createEvent(event, event.calendars);
    const [mapping] = await db.insert(externalEvents).values({ provider: "google", eventID: event.id, calendarID: calendar.id,
      externalCalendarID: nativeCalendar, externalEventID: nativeId, etag: remote.etag }).returning();
    const operationID = randomUUID();
    const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
      eventID: event.id, calendarID: calendar.id, externalCalendarLinkID: source!.id, provider: "google", userID: owner,
      accountID, externalCalendarID: nativeCalendar, externalEventID: nativeId, expectedEtag: '"accepted"', action: "delete", payload: { event } };
    assert.equal((await patchEventAndCalendarLinks(event.id, 1, { calendars: [] }, true, [intent])).status, "saved");
    // Local unlink removes its old mapping. Retain an exact pending native
    // receipt as can occur during pull so ACK CAS/removal and rollback are real.
    await db.insert(externalEvents).values(mapping!);
    const row = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.id, mapping!.id)))[0]!;
    return { owner, event, operationID, row, mapped, source: source!, grantID };
  }
  try {
    const variants = ["success", "lost", "absent-404", "absent-410", "cancelled", "preflight-absent", "delete-404", "delete-410",
      "weak", "missing", "changed", "attendee-copy", "false-without-email", "email-without-self", "attendees-omitted", "meeting", "unknown-organizer", "401", "403", "412", "429", "500"];
    for (const variant of variants) {
      let oldWire: typeof requests = [], oldOutcome: unknown;
      const configure = () => {
        mode = variant;
        if (variant === "cancelled") remote.status = "cancelled";
        if (variant === "weak") remote.etag = 'W/"accepted"';
        if (variant === "missing") delete remote.etag;
        if (variant === "changed") remote.etag = '"changed"';
        if (variant === "attendee-copy") { remote.organizer = { self: false, email: "other@example.test" }; remote.attendees = [{ email: "guest@example.test" }]; }
        if (variant === "false-without-email") remote.organizer = { self: false };
        if (variant === "email-without-self") remote.organizer = { email: "other@example.test" };
        if (variant === "attendees-omitted") remote.attendeesOmitted = true;
        if (variant === "meeting") remote.attendees = [{ email: "guest@example.test" }];
        if (variant === "unknown-organizer") remote.organizer = {};
      };
      const outcome = async (result: NonNullable<Awaited<ReturnType<typeof deliverEventOutbox>>>, f: Awaited<ReturnType<typeof seed>>) => ({
        status: result.status, uncertain: result.uncertain, errorCode: result.errorCode,
        attempts: result.attempts, mapped: !!await f.mapped(), resultRef: result.resultRef,
        snapshot: result.remoteSnapshot && { ...result.remoteSnapshot, observedAt: undefined, values: undefined },
      });
      await fixture(`${variant} actual old pinned executor`, async f => {
        configure(); const initial = structuredClone(remote);
        let result = await deliverEventOutbox(f.operationID, () => oldAdapter); assert(result);
        const frames: RuntimeDeleteRecordedFrame[] = [];
        if (variant === "success" || variant === "lost") {
          frames.push({ fact: { kind: "delete-read", read: { kind: "present", event: initial, etag: initial.etag } }, authoritative: { decision: "preflight" } },
            { fact: { kind: "preflight", event: initial, etag: initial.etag }, authoritative: { decision: "dispatch" } });
          frames.push(variant === "success" ? { fact: { kind: "delete", deletion: { kind: "deleted", status: 204 } }, authoritative: { decision: "accepted" } } :
            { fact: { kind: "failure", error: { code: "provider-write-failed", outcome: "unconfirmed", phase: "mutation" } }, authoritative: { decision: "uncertain" } });
        }
        if (variant === "lost") {
          assert.equal(result.status, "unconfirmed");
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
          result = await deliverEventOutbox(f.operationID, () => oldAdapter); assert(result);
          frames.push({ fact: { kind: "delete-read", read: { kind: "absent", status: 404 } }, authoritative: { decision: "confirmed" } });
        }
        if (frames.length) {
          const context: RuntimeDeleteDecisionContext = { acceptedEtag: '"accepted"', policy };
          const before = { requests: requests.length, sessions, row: hash(await f.row()), mapping: hash(await f.mapped()) };
          assert.equal(compareGooglePersonalDeleteShadow(structuredClone(context), structuredClone(frames)).matches, true);
          assert.deepEqual({ requests: requests.length, sessions, row: hash(await f.row()), mapping: hash(await f.mapped()) }, before);
        }
        oldWire = structuredClone(requests); oldOutcome = await outcome(result, f);
      });
      await fixture(`${variant} shared DELETE wire and outcome parity`, async f => {
        configure(); let result = await deliverEventOutbox(f.operationID, () => newAdapter); assert(result);
        if (variant === "lost") {
          assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
          assert.equal(requests.length, 4, "Lost reply defers recovery until another claim");
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
          result = await deliverEventOutbox(f.operationID, () => newAdapter); assert(result);
          assert.equal(requests.filter(r => r.method === "DELETE").length, 1, "Exact absence settles without another DELETE");
        }
        assert.equal(legacyCalls, 0); assert.equal(factoryCalls, result.attempts);
        if (variant === "preflight-absent") {
          assert.equal(oldWire.filter(r => r.method === "DELETE").length, 1);
          assert.equal(requests.filter(r => r.method === "DELETE").length, 0,
            "Safety correction: exact absence during fresh preflight settles without a redundant mutation");
          assert.deepEqual(requests, oldWire.filter(r => r.method !== "DELETE"));
        } else assert.deepEqual(requests, oldWire);
        assert.deepEqual(await outcome(result, f), oldOutcome);
      });
    }
    await fixture("source generation changes before conditional dispatch", async f => {
      mode = "success";
      onCalendar = async () => { await db.update(externalCalendars).set({ providerAccessRevision: 2 }).where(eq(externalCalendars.id, f.source.id)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "delivery-source-changed");
      assert.equal(requests.filter(r => r.method === "DELETE").length, 0); assert(await f.mapped());
    });
    await fixture("grant reconnect before final mutation fence", async f => {
      mode = "success";
      onCalendar = async () => {
        await db.update(account).set({ syncStatus: "blocked" }).where(eq(account.id, f.grantID));
        await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, f.grantID));
      };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(requests.filter(r => r.method === "DELETE").length, 0); assert(await f.mapped());
    });
    await fixture("unknown envelope precedes all adapter and credential factories", async f => {
      const saved = await f.row(); let adapters = 0;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => { adapters++; return newAdapter; }))?.status, "blocked");
      assert.equal(adapters, 0); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("missing native registration remains existing pinned writer", async f => {
      mode = "success"; const result = await deliverEventOutbox(f.operationID, () => oldAdapter);
      assert.equal(result?.status, "completed"); assert.equal(factoryCalls, 0); assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
    });
    await fixture("missing envelope remains explicit legacy writer", async f => {
      mode = "success"; const saved = await f.row();
      const { operationEnvelope, operationCapture, ...payload } = saved.payload;
      await db.update(eventOutbox).set({ payload }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(factoryCalls, 0); assert(legacyCalls > 0);
    });
    await fixture("known time remains its pinned family guard", async f => {
      const saved = await f.row();
      await db.update(eventOutbox).set({ payload: { ...saved.payload, event: { ...saved.payload.event,
        timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-13T09:00:00", endLocal: "2026-10-13T10:00:00" } } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("canonical purge retains accepted scoped DELETE authority", async f => {
      mode = "success";
      await db.delete(events).where(eq(events.id, f.event.id));
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "completed"); assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
    });
    await fixture("mapping validator changes after provider acceptance", async f => {
      mode = "success";
      const row = await claimEventOutbox(f.operationID); assert(row);
      const factory: NonNullable<CalendarAdapter["googlePersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "DELETE") await db.update(externalEvents).set({ etag: '\"new-mapping\"' }).where(eq(externalEvents.eventID, f.event.id));
          return response;
        } } } };
      };
      const result = await deliverSharedGoogleDelete(row, SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), factory);
      assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "mapping-version-changed");
      assert.equal((await f.mapped()).etag, '\"new-mapping\"'); assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
    });
    await fixture("source retirement after provider acceptance rejects stale ACK", async f => {
      mode = "success";
      const row = await claimEventOutbox(f.operationID); assert(row);
      const factory: NonNullable<CalendarAdapter["googlePersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "DELETE") await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id));
          return response;
        } } } };
      };
      const result = await deliverSharedGoogleDelete(row, SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), factory);
      assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "operation-source-changed"); assert(await f.mapped()); assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
    });
    await fixture("one heartbeat and late signal-ignoring DELETE cannot ACK", async f => {
      mode = "success"; const row = await claimEventOutbox(f.operationID); assert(row);
      let intervals = 0, dispatch!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { dispatch = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { if (args[1] === 5) intervals++; return originalInterval(...args); }) as typeof setInterval;
      const factory: NonNullable<CalendarAdapter["googlePersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "DELETE") { dispatch(); await blocked; }
          return response;
        } } } };
      };
      try {
        const delivery = deliverSharedGoogleDelete(row, SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await entered; assert.equal((await delivery)?.status, "unconfirmed"); assert.equal(intervals, 1); assert(await f.mapped());
        release(); await pause(35); assert.equal((await f.row()).status, "unconfirmed"); assert(await f.mapped());
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    await fixture("waiting ACK rolls back mapping removal after timeout", async f => {
      mode = "success"; const row = await claimEventOutbox(f.operationID); assert(row);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["googlePersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "DELETE") { await blocker.query("BEGIN"); transaction = true;
            await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        const result = await deliverSharedGoogleDelete(row, SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), factory, { timeoutMs: 800, heartbeatMs: 5 });
        assert(transaction); assert.equal(result?.status, "unconfirmed"); assert.equal(result.resultRef, null); assert(await f.mapped());
        await blocker.query("COMMIT"); transaction = false; await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert(await f.mapped());
      } finally { if (transaction) await blocker.query("ROLLBACK"); blocker.release(); }
    });
    console.log(`Google shared DELETE PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    globalThis.fetch = originalFetch; config.api.syncOperationV1EncoderEnabled = originalEncoder;
    await pool.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
