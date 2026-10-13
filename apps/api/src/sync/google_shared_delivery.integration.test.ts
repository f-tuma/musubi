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
  compareGooglePersonalUpdateShadow, type GooglePersonalUpdatePolicy, type RuntimeDecisionContext,
  type RuntimeRecordedFrame,
} from "@musubi/sync-runtime";
import { googleAdapter } from "./adapters/google";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverSharedGoogleEvent } from "./google_shared_delivery";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policy: GooglePersonalUpdatePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty",
  untouchedPreflight: false, nativeProfile: "existing-google", observeConflict: true };
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
  let remote = originalNative(), mode = "success", factoryCalls = 0, legacyCalls = 0, sessions = 0;
  let requests: { method: string; path: string; body: unknown; ifMatch: string | undefined }[] = [];
  let observedPreflight = structuredClone(remote), patchApplied = false, failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const url = new URL(req.url!, "http://fixture.test"), method = req.method!;
      requests.push({ method, path: url.pathname, body: bytes ? JSON.parse(bytes) : null,
        ifMatch: typeof req.headers["if-match"] === "string" ? req.headers["if-match"] : undefined });
      const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      assert.equal(req.headers.authorization, "Bearer c06.fixture.access");
      if (url.pathname.includes("/calendarList/")) return json({ id: nativeCalendar, accessRole: "owner" });
      assert.equal(url.pathname, `/calendar/v3/calendars/${encodeURIComponent(nativeCalendar)}/events/${encodeURIComponent(nativeId)}`);
      if (method === "GET") { if (!patchApplied) observedPreflight = structuredClone(remote); return json(remote); }
      assert.equal(method, "PATCH"); assert.equal(req.headers["if-match"], remote.etag);
      if (mode === "412") return json({}, 412);
      Object.assign(remote, JSON.parse(bytes), { etag: mode === "successor" && remote.etag === '"written"' ? '"written-B"' : '"written"' });
      patchApplied = true;
      if (mode === "nullable-empty") { remote.description = null; remote.location = null; }
      if (mode === "lost" || mode === "nullable-empty") return res.destroy();
      if (mode === "nullable-validator") return json({});
      return json(remote);
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://www.googleapis.com", "This fixture never uses a real provider or OAuth endpoint");
    return originalFetch(`${origin}${url.pathname}${url.search}`, init);
  };
  const oldAdapter: CalendarAdapter = { ...googleAdapter, googlePersonalContentV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...googleAdapter,
    googlePersonalContentV1(userID, accountID, capture) {
      factoryCalls++;
      const bridge = googleAdapter.googlePersonalContentV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.notEqual(target.connectionId, accountID,
          "Physical grant identity stays separate from the logical row binding");
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return googleAdapter.assertEventWrite!(...args); },
    async pushUpdate(...args) { legacyCalls++; return googleAdapter.pushUpdate(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function fixture(label: string, body: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
    remote = originalNative(); requests = []; failures = []; patchApplied = false; factoryCalls = legacyCalls = sessions = 0;
    const f = await seed();
    try { await body(f); assert.deepEqual(failures, []); cases++; console.log(`Google shared runtime: ${label}: PASS`); }
    finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); }
  }
  async function seed() {
    const owner = `shared-${randomUUID()}`, accountID = `logical-${randomUUID()}`, grantID = randomUUID();
    await db.insert(user).values({ id: owner, name: "Shared runtime fixture", email: `${owner}@example.test` });
    await db.insert(account).values({ id: grantID, userId: owner, providerId: "google", accountId: accountID, scope,
      accessToken: "c06.fixture.access", refreshToken: "c06.fixture.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Shared fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "google", userID: owner,
      accountID, externalCalendarID: nativeCalendar, providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: remote.summary, description: remote.description, location: remote.location, color: "#112233",
      start: remote.start.dateTime, end: remote.end.dateTime, isAllDay: false, isCanceled: false });
    await createEvent(event, event.calendars);
    const [mapping] = await db.insert(externalEvents).values({ provider: "google", eventID: event.id, calendarID: calendar.id,
      externalCalendarID: nativeCalendar, externalEventID: nativeId, etag: remote.etag }).returning();
    const admit = async (revision: number, patch: { title: string; description?: string | null; location?: string | null }) => {
      const operationID = randomUUID();
      const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
        eventID: event.id, calendarID: calendar.id, externalCalendarLinkID: source!.id, provider: "google", userID: owner,
        accountID, externalCalendarID: nativeCalendar, externalEventID: nativeId, expectedEtag: '"accepted"', action: "update", payload: { event, patch } };
      assert.equal((await patchEventAndCalendarLinks(event.id, revision, patch, false, [intent])).status, "saved");
      return operationID;
    };
    const operationID = await admit(1, { title: "Accepted A", description: "", location: "" });
    const row = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.id, mapping!.id)))[0]!;
    return { owner, event, operationID, row, mapped, admit };
  }
  try {
    for (const paired of ["success", "nullable-validator", "lost", "nullable-empty"] as const) {
      let oldWire: typeof requests = [], oldOutcome: unknown;
      await fixture(`${paired} old pinned authority and captured shadow`, async f => {
        mode = paired;
        const saved = await f.row(), envelope = SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope);
        let result = await deliverEventOutbox(f.operationID, () => oldAdapter); assert(result);
        const frames: RuntimeRecordedFrame[] = [{ fact: { kind: "preflight", event: structuredClone(observedPreflight) }, authoritative: { decision: "dispatch" } }];
        if (paired === "lost" || paired === "nullable-empty") {
          assert.equal(result.status, "unconfirmed"); assert.equal(requests.filter(r => r.method === "PATCH").length, 1);
          frames.push({ fact: { kind: "failure", error: { code: "provider-write-failed", outcome: "unconfirmed", phase: "mutation" } }, authoritative: { decision: "uncertain" } });
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
          result = await deliverEventOutbox(f.operationID, () => oldAdapter); assert(result);
          frames.push({ fact: { kind: "recovery-read", read: { kind: "present", event: structuredClone(remote), etag: remote.etag } }, authoritative: { decision: "confirmed" } });
        } else frames.push({ fact: { kind: "write", write: { kind: "written", etag: paired === "nullable-validator" ? null : '"written"' } }, authoritative: { decision: "accepted" } });
        assert.equal(result.status, "completed");
        const context: RuntimeDecisionContext = { projection: envelope.admittedProjection.data as unknown as RuntimeDecisionContext["projection"],
          acceptedEtag: '"accepted"', body: (envelope.nativePlan.data as { body: Record<string, string | null> }).body, policy };
        const beforeShadow = { requests: requests.length, sessions, row: hash(await f.row()), mapping: hash(await f.mapped()) };
        const report = compareGooglePersonalUpdateShadow(structuredClone(context), structuredClone(frames));
        assert.equal(report.matches, true, "Shared decisions agree with the actual old registered pinned executor facts");
        assert.deepEqual({ requests: requests.length, sessions, row: hash(await f.row()), mapping: hash(await f.mapped()) }, beforeShadow,
          "Pure shadow has zero HTTP, credential or DB effects");
        oldWire = structuredClone(requests); oldOutcome = { status: result.status, uncertain: result.uncertain, etag: (await f.mapped()).etag,
          errorCode: result.errorCode, resultEtag: result.resultRef?.etag, attempts: result.attempts };
      });
      await fixture(`${paired} shared authority wire and outcome parity`, async f => {
        mode = paired;
        let result = await deliverEventOutbox(f.operationID, () => newAdapter); assert(result);
        if (paired === "lost" || paired === "nullable-empty") {
          assert.equal(requests.length, 3, "Ambiguous reply defers exact GET to a later claim");
          await db.update(eventOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
          result = await deliverEventOutbox(f.operationID, () => newAdapter); assert(result);
        }
        assert.equal(legacyCalls, 0, "The selected shared writer never falls back to wide adapter calls");
        assert.equal(factoryCalls, result.attempts, "One registered native factory per claimed attempt");
        assert.deepEqual(requests, oldWire); assert.deepEqual({ status: result.status, uncertain: result.uncertain, etag: (await f.mapped()).etag,
          errorCode: result.errorCode, resultEtag: result.resultRef?.etag, attempts: result.attempts }, oldOutcome);
      });
    }
    await fixture("successor coverage and predecessor validator handoff", async f => {
      mode = "successor";
      const b = await f.admit(2, { title: "Accepted B" });
      const first = await deliverEventOutbox(f.operationID, () => newAdapter); assert.equal(first?.status, "completed");
      assert.equal((await f.mapped()).etag, '"written"', "Known successor coverage permits the earlier A ACK");
      const second = await deliverEventOutbox(b, () => newAdapter); assert.equal(second?.status, "completed");
      assert.deepEqual(requests.filter(r => r.method === "PATCH").map(r => r.ifMatch), ['"accepted"', '"written"']);
      assert.equal(remote.summary, "Accepted B"); assert.equal(legacyCalls, 0);
    });
    await fixture("public legitimate long timeout and invalid timeout before claim", async f => {
      mode = "success";
      await assert.rejects(deliverEventOutbox(f.operationID, () => newAdapter, { timeoutMs: Infinity }), RangeError);
      assert.equal((await f.row()).attempts, 0); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
      const result = await deliverEventOutbox(f.operationID, () => newAdapter, { timeoutMs: 60_000 });
      assert.equal(result?.status, "completed"); assert.equal(result.attempts, 1); assert.equal(factoryCalls, 1);
    });
    await fixture("known time remains its existing pinned family guard", async f => {
      const saved = await f.row();
      await db.update(eventOutbox).set({ payload: { ...saved.payload, event: { ...saved.payload.event,
        timeModel: { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-13T09:00:00", endLocal: "2026-10-13T10:00:00" } } } }).where(eq(eventOutbox.id, f.operationID));
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("unknown envelope HOLD precedes adapter factory", async f => {
      const saved = await f.row(); let adapters = 0;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      const result = await deliverEventOutbox(f.operationID, () => { adapters++; return newAdapter; });
      assert.equal(result?.status, "blocked"); assert.equal(adapters, 0); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("one heartbeat and late signal-ignoring PATCH cannot ACK", async f => {
      const row = await claimEventOutbox(f.operationID); assert(row);
      let intervals = 0, dispatch!: () => void;
      const entered = new Promise<void>(resolve => { dispatch = resolve; });
      let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { if (args[1] === 5) intervals++; return originalInterval(...args); }) as typeof setInterval;
      const factory: NonNullable<CalendarAdapter["googlePersonalContentV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalContentV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          if (init.method === "PATCH") { const result = await bridge.ports.http.fetch(url, init); dispatch(); await blocked; return result; }
          return bridge.ports.http.fetch(url, init);
        } } } };
      };
      try {
        const delivery = deliverSharedGoogleEvent(row, SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), factory, { timeoutMs: 500, heartbeatMs: 5 });
        await entered;
        const result = await delivery; assert.equal(result?.status, "unconfirmed"); assert.equal(intervals, 1);
        assert.equal(result.attempts, 1); assert.equal((await f.mapped()).etag, '"accepted"');
        release(); await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert.equal((await f.mapped()).etag, '"accepted"');
        assert.equal(requests.filter(r => r.method === "PATCH").length, 1);
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    await fixture("timeout during waiting ACK rolls back mapping but retains acceptance evidence", async f => {
      const row = await claimEventOutbox(f.operationID); assert(row);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["googlePersonalContentV1"]> = (...args) => {
        const bridge = newAdapter.googlePersonalContentV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "PATCH") { await blocker.query("BEGIN"); transaction = true;
            await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        const result = await deliverSharedGoogleEvent(row, SyncOperationEnvelopeSchema.parse(row.payload.operationEnvelope), factory, { timeoutMs: 700, heartbeatMs: 5 });
        assert.equal(transaction, true); assert.equal(result?.status, "unconfirmed");
        assert.equal(result.resultRef?.etag, '"written"'); assert.equal((await f.mapped()).etag, '"accepted"');
        await blocker.query("COMMIT"); transaction = false; await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert.equal((await f.mapped()).etag, '"accepted"');
      } finally { if (transaction) await blocker.query("ROLLBACK"); blocker.release(); }
    });
    console.log(`Google shared runtime PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    globalThis.fetch = originalFetch; config.api.syncOperationV1EncoderEnabled = originalEncoder;
    await pool.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
