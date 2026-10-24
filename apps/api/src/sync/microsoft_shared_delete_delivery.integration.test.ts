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
  account, CALENDAR_SCOPE, claimEventOutbox, commitEventDeliveryResolution, createCalendar, createEvent, db,
  eventOutbox, events, externalCalendars, externalEvents, externalEventTombstones,
  patchEventAndCalendarLinks, requestEventDeliveryRetry, user, type EventOutboxIntent,
} from "@musubi/db";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { microsoftAdapter } from "./adapters/microsoft";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { prepareEventDeliveryResolution } from "./event_resolution";
import { deliverSharedMicrosoftDelete } from "./microsoft_shared_delete_delivery";
import { retainPendingEventPull } from "../../../../packages/db/src/queries/event-outbox-pull";

const nativeCalendar = "delete/calendar+id@example.test", nativeID = "delete/event+id", acceptedEtag = 'W/"accepted"';
type Wire = { method: string; path: string; body: string; ifMatch?: string; prefer?: string; cacheControl?: string; contentType?: string };
const initialNative = () => ({ id: nativeID, "@odata.etag": acceptedEtag, subject: "Personal DELETE A", type: "singleInstance",
  isCancelled: false, isOrganizer: true, isDraft: false, recurrence: null, seriesMasterId: null, attendees: [],
  isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, isAllDay: false,
  start: { dateTime: "2026-10-24T09:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-24T10:00:00", timeZone: "UTC" },
  body: { contentType: "text", content: "Before notes" }, location: { displayName: "Before place" } });

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const originalFetch = globalThis.fetch, originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let mode = "success", remote: any = initialNative(), absent = false, reads = 0, calendars = 0;
  let requests: Wire[] = [], failures: unknown[] = [], factoryCalls = 0, sessions = 0, legacyCalls = 0;
  let onCalendar: (() => Promise<void>) | undefined, afterDelete: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const url = new URL(req.url!, "http://fixture.test"), method = req.method!;
      const header = (name: string) => typeof req.headers[name] === "string" ? req.headers[name] as string : undefined;
      requests.push({ method, path: url.pathname + url.search, body, ifMatch: header("if-match"),
        prefer: header("prefer"), cacheControl: header("cache-control"), contentType: header("content-type") });
      assert.equal(req.headers.authorization, "Bearer graph.delete.fixture.access");
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/v1.0/me") return json({ id: "self", mail: "owner@example.test" });
      if (url.pathname === `/v1.0/me/calendars/${encodeURIComponent(nativeCalendar)}`) {
        calendars++; await onCalendar?.();
        return json({ id: nativeCalendar, canEdit: mode !== "canedit-false", owner: { address: mode === "owner-other" ? "other@example.test" : "owner@example.test" } });
      }
      assert.equal(url.pathname, `/v1.0/me/calendars/${encodeURIComponent(nativeCalendar)}/events/${encodeURIComponent(nativeID)}`);
      if (method === "GET") {
        reads++;
        if (mode === "absent-410") return json({}, 410);
        if (mode === "initial-partial") return json({}, 206);
        if (mode === "initial-range") res.setHeader("content-range", "items 0-0/2");
        if (mode === "verify-denied" && requests.some(value => value.method === "DELETE")) return json({}, 403);
        if (mode === "preflight-absent" && reads >= 2 || mode === "final-preflight-absent" && reads >= 3) absent = true;
        if (absent || mode === "absent-404") return json({}, 404);
        return json(remote);
      }
      assert.equal(method, "DELETE"); assert.equal(body, ""); assert.equal(header("if-match"), acceptedEtag);
      if (["400", "401", "403", "412", "429", "500", "408", "202", "200", "delete-410"].includes(mode)) {
        if (mode === "429") res.setHeader("retry-after", "1");
        return json({}, mode === "delete-410" ? 410 : Number(mode));
      }
      if (mode !== "retained" && mode !== "lost-retained") absent = true;
      await afterDelete?.();
      if (mode === "lost" || mode === "lost-retained") return res.destroy();
      res.writeHead(mode === "delete-404" ? 404 : 204); res.end();
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned Graph fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://graph.microsoft.com", "Only the owned provider fixture is reachable");
    return originalFetch(`${origin}${url.pathname}${url.search}`, init).then(response => {
      Object.defineProperty(response, "url", { value: url.href }); return response;
    });
  };
  const oldAdapter: CalendarAdapter = { ...microsoftAdapter, microsoftPersonalDeleteV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...microsoftAdapter,
    microsoftPersonalDeleteV1(userID, accountID, capture) {
      factoryCalls++; const bridge = microsoftAdapter.microsoftPersonalDeleteV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.notEqual(target.connectionId, accountID);
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return microsoftAdapter.assertEventWrite!(...args); },
    async pushDelete(...args) { legacyCalls++; return microsoftAdapter.pushDelete(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function seed() {
    const owner = `graph-delete-${randomUUID()}`, accountID = `logical-${randomUUID()}`, grantID = randomUUID();
    await db.insert(user).values({ id: owner, name: "Graph DELETE fixture", email: `${owner}@example.test` });
    await db.insert(account).values({ id: grantID, userId: owner, providerId: "microsoft", accountId: accountID, scope: CALENDAR_SCOPE.microsoft,
      accessToken: "graph.delete.fixture.access", refreshToken: "graph.delete.fixture.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Graph DELETE fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "microsoft", userID: owner,
      accountID, externalCalendarID: nativeCalendar, providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: remote.subject, description: remote.body.content, location: remote.location.displayName, color: "#112233",
      start: "2026-10-24T09:00:00.000Z", end: "2026-10-24T10:00:00.000Z", isAllDay: false, isCanceled: false });
    await createEvent(event, event.calendars);
    const [mapping] = await db.insert(externalEvents).values({ provider: "microsoft", eventID: event.id, calendarID: calendar.id,
      externalCalendarID: nativeCalendar, externalEventID: nativeID, etag: acceptedEtag }).returning();
    const operationID = randomUUID();
    const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0, eventID: event.id,
      calendarID: calendar.id, externalCalendarLinkID: source!.id, provider: "microsoft", userID: owner, accountID,
      externalCalendarID: nativeCalendar, externalEventID: nativeID, expectedEtag: acceptedEtag, action: "delete", payload: { event } };
    assert.equal((await patchEventAndCalendarLinks(event.id, 1, { calendars: [] }, true, [intent])).status, "saved");
    // A pull can retain a mapping while this accepted unlink is unresolved.
    // Keep real ACK version/removal fences exercised rather than a no-map shortcut.
    await db.insert(externalEvents).values(mapping!);
    const row = async (id: string = operationID) => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, id)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.id, mapping!.id)))[0];
    return { owner, accountID, grantID, calendar, source: source!, event, operationID, row, mapped, mapping: mapping! };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function fixture(label: string, body: (f: Fixture) => Promise<void>) {
    mode = "success"; remote = initialNative(); absent = false; reads = calendars = 0; requests = []; failures = [];
    factoryCalls = sessions = legacyCalls = 0; onCalendar = afterDelete = undefined;
    const f = await seed();
    try { await body(f); assert.deepEqual(failures, []); cases++; console.log(`Graph shared DELETE: ${label}: PASS`); }
    finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); }
  }
  const due = (id: string) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(0) }).where(eq(eventOutbox.id, id));
  const outcome = async (result: NonNullable<Awaited<ReturnType<typeof deliverEventOutbox>>>, f: Fixture) => ({
    status: result.status, uncertain: result.uncertain, errorCode: result.errorCode, attempts: result.attempts, resultRef: result.resultRef,
    mapping: (await f.mapped()) ? { etag: (await f.mapped())!.etag, externalEventID: (await f.mapped())!.externalEventID } : null,
    snapshot: result.remoteSnapshot && { ...result.remoteSnapshot, observedAt: undefined },
  });
  const resolve = async (f: Fixture, operationID: string = f.operationID) => {
    const { preview, proof } = await prepareEventDeliveryResolution(f.owner, f.event.id, operationID, () => newAdapter);
    assert.equal(preview.canResolve, true); assert.equal(preview.action, "delete");
    const request = { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision, expectedLatestOperationId: preview.latestOperationId,
      expectedRemoteExists: preview.remote !== null, expectedRemoteEtag: preview.remoteEtag };
    const id = await commitEventDeliveryResolution(f.owner, proof, request);
    return { id, proof, request, preview };
  };
  const child = (operationId: string, at?: "beforeDelete" | "afterDelete") => {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./microsoft_delete_process.fixture.ts", import.meta.url))], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    let output = "", stderr = "", entered!: () => void, rejectEntered!: (error: Error) => void;
    const checkpoint = new Promise<void>((resolve, reject) => { entered = resolve; rejectEntered = reject; });
    proc.stdout.on("data", chunk => { output += String(chunk); if (output.includes('"kind":"checkpoint"')) entered(); });
    proc.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; stderr: string }>((resolve, reject) => {
      proc.once("error", error => { clearTimeout(timer); rejectEntered(error); reject(error); });
      proc.once("close", (code, signal) => { clearTimeout(timer); rejectEntered(new Error("Worker exited before checkpoint")); resolve({ code, signal, output, stderr }); });
    });
    void checkpoint.catch(() => undefined);
    proc.stdin.end(JSON.stringify({ operationId, fixtureOrigin: origin, ...(at ? { pause: at } : {}) }));
    return { proc, checkpoint, exited };
  };
  try {
    const variants = ["success", "absent-404", "absent-410", "initial-partial", "initial-range", "changed", "missing-validator", "strong-validator",
      "meeting", "missing-attendees", "occurrence", "cancelled", "owner-other", "canedit-false", "preflight-absent", "final-preflight-absent",
      "delete-404", "delete-410", "400", "401", "403", "412", "429", "500", "408", "202", "lost", "retained", "verify-denied", "malformed-subject", "malformed-body", "malformed-location", "removed-record"];
    for (const variant of variants) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`${variant} ${label} HTTP/host parity`, async f => {
          mode = variant;
          if (variant === "changed") remote["@odata.etag"] = 'W/"changed"';
          if (variant === "missing-validator") delete remote["@odata.etag"];
          if (variant === "strong-validator") remote["@odata.etag"] = '"strong"';
          if (variant === "meeting") remote.attendees = [{}];
          if (variant === "missing-attendees") delete remote.attendees;
          if (variant === "occurrence") remote.type = "occurrence";
          if (variant === "cancelled") remote.isCancelled = true;
          if (variant === "malformed-subject") remote.subject = 42;
          if (variant === "malformed-body") remote.body.content = 42;
          if (variant === "malformed-location") remote.location.displayName = { malformed: true };
          if (variant === "removed-record") remote["@removed"] = { reason: "deleted" };
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
          else {
            assert.equal(legacyCalls, 0); assert.equal(factoryCalls, 1);
            assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome);
          }
          if (variant === "success") { assert.equal(requests.length, 9); assert.equal(result.status, "completed"); }
          assert(requests.filter(value => value.method === "DELETE").length <= 1);
          if (variant === "429") assert(result.nextAttemptAt.getTime() - Date.now() >= 900);
        });
      }
    }
    for (const variant of ["present", "changed", "missing-validator", "404", "410", "malformed-subject", "malformed-body", "malformed-location", "removed-record"] as const) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`possible dispatch recovery ${variant} ${label}`, async f => {
          assert(await claimEventOutbox(f.operationID)); await due(f.operationID);
          if (variant === "changed") remote["@odata.etag"] = 'W/"changed"';
          if (variant === "missing-validator") delete remote["@odata.etag"];
          if (variant === "malformed-subject") remote.subject = 42;
          if (variant === "malformed-body") remote.body.content = 42;
          if (variant === "malformed-location") remote.location.displayName = { malformed: true };
          if (variant === "removed-record") remote["@removed"] = { reason: "deleted" };
          if (variant === "404") absent = true;
          if (variant === "410") mode = "absent-410";
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
          if (["present", "changed", "missing-validator"].includes(variant)) {
            assert.equal(result.status, "unconfirmed"); assert(result.remoteSnapshot); assert(result.nextAttemptAt.getTime() - Date.now() > 3_590_000);
          }
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); assert.equal(legacyCalls, 0); }
        });
      }
    }
    for (const status of ["429", "500"] as const) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`${status} next claim ${label} preserves dispatch certainty`, async f => {
          mode = status; const first = await deliverEventOutbox(f.operationID, () => adapter);
          assert.equal(first?.uncertain, status === "500"); mode = "success"; await due(f.operationID);
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          assert.equal(result.status, status === "429" ? "completed" : "unconfirmed");
          assert.equal(requests.filter(value => value.method === "DELETE").length, status === "429" ? 2 : 1);
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await outcome(result, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); assert.equal(legacyCalls, 0); }
        });
      }
    }
    await fixture("lost accepted reply recovers exact absence without another DELETE", async f => {
      mode = "lost"; assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "unconfirmed");
      assert.equal(requests.length, 8); mode = "success"; await due(f.operationID);
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 1); assert.equal(requests.length, 9);
    });
    await fixture("retained remote requires a fresh explicit intent and its first attempt only", async f => {
      mode = "lost-retained";
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "unconfirmed");
      await requestEventDeliveryRetry(f.owner, f.event.id, f.operationID); await due(f.operationID);
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "unconfirmed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 1);
      await assert.rejects(() => requestEventDeliveryRetry(f.owner, f.event.id, f.operationID), (error: any) => error.code === "delivery-conflict-unresolved");
      const fresh = await resolve(f); assert.notEqual(fresh.id, f.operationID);
      assert.equal(await commitEventDeliveryResolution(f.owner, fresh.proof, fresh.request), fresh.id, "Exact resolution replay returns its original new intent");
      assert.equal((await f.row()).status, "cancelled"); assert.equal((await f.row()).uncertain, true);
      assert.equal((await f.row(fresh.id)).uncertain, true, "Explicit resolution never erases earlier possible dispatch");
      assert.equal((await deliverEventOutbox(fresh.id, () => newAdapter))?.status, "unconfirmed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 2);
      mode = "success"; await due(fresh.id);
      assert.equal((await deliverEventOutbox(fresh.id, () => newAdapter))?.status, "unconfirmed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 2, "The second attempt cannot reuse a resolution's one send");
      const newest = await resolve(f, fresh.id);
      assert.equal((await deliverEventOutbox(newest.id, () => newAdapter))?.status, "completed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 3);
    });
    for (const comparison of ["wrong-version", "remote-absent"] as const) {
      await fixture(`resolution ${comparison} comparison never grants a new DELETE`, async f => {
        mode = "lost-retained"; await deliverEventOutbox(f.operationID, () => newAdapter); await due(f.operationID);
        await deliverEventOutbox(f.operationID, () => newAdapter); const fresh = await resolve(f), saved = await f.row(fresh.id);
        const resolution = { ...saved.payload.resolution!, ...(comparison === "wrong-version"
          ? { expectedRemoteEtag: 'W/"different-comparison"' } : { expectedRemoteExists: false }) };
        await db.update(eventOutbox).set({ payload: { ...saved.payload, resolution } }).where(eq(eventOutbox.id, fresh.id));
        const before = requests.length, deletes = requests.filter(value => value.method === "DELETE").length;
        const result = await deliverEventOutbox(fresh.id, () => newAdapter);
        assert.equal(result?.status, "unconfirmed"); assert.equal(result?.attempts, 1); assert.equal(result?.uncertain, true);
        assert.deepEqual(requests.slice(before).map(value => value.method), ["GET"]);
        assert.equal(requests.filter(value => value.method === "DELETE").length, deletes);
      });
    }
    {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`explicit resolution 429 ${label} cannot clear inherited uncertainty`, async f => {
          mode = "lost-retained"; await deliverEventOutbox(f.operationID, () => adapter); await due(f.operationID);
          await deliverEventOutbox(f.operationID, () => adapter); const fresh = await resolve(f);
          const before = requests.length; mode = "429";
          const rejected = await deliverEventOutbox(fresh.id, () => adapter);
          assert.equal(rejected?.status, "unconfirmed"); assert.equal(rejected?.uncertain, true);
          assert.equal(rejected?.attempts, 1, "The one fresh resolution dispatch received a conclusive rejection");
          mode = "success"; await due(fresh.id);
          const result = await deliverEventOutbox(fresh.id, () => adapter); assert(result);
          assert.equal(result.status, "unconfirmed"); assert.equal(result.uncertain, true); assert(result.remoteSnapshot);
          const wire = requests.slice(before);
          assert.equal(wire.filter(value => value.method === "DELETE").length, 1,
            "A 429 for the new intent cannot resolve its older possible acceptance");
          assert.equal(wire[wire.length - 1]?.method, "GET");
          assert.equal(wire.filter(value => value.method === "DELETE")[0]?.ifMatch, acceptedEtag);
          if (label === "original") { oldWire = structuredClone(wire); oldOutcome = await outcome(result, f); }
          else { assert.deepEqual(wire, oldWire); assert.deepEqual(await outcome(result, f), oldOutcome); }
        });
      }
    }
    await fixture("fresh explicit resolution of actual absence observes without DELETE", async f => {
      mode = "lost"; await deliverEventOutbox(f.operationID, () => newAdapter);
      const fresh = await resolve(f); assert.equal(fresh.preview.remote, null);
      assert.equal((await f.row(fresh.id)).payload.resolution?.expectedRemoteExists, false);
      const before = requests.length, deletes = requests.filter(value => value.method === "DELETE").length;
      assert.equal((await deliverEventOutbox(fresh.id, () => newAdapter))?.status, "completed");
      assert.deepEqual(requests.slice(before).map(value => value.method), ["GET"]);
      assert.equal(requests.filter(value => value.method === "DELETE").length, deletes);
    });
    await fixture("source generation changes after final preflight block dispatch", async f => {
      onCalendar = async () => { if (calendars === 2) await db.update(externalCalendars).set({ providerAccessRevision: 2 }).where(eq(externalCalendars.id, f.source.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 0); assert(await f.mapped());
    });
    await fixture("scope narrowing after final preflight blocks dispatch", async f => {
      onCalendar = async () => { if (calendars === 2) await db.update(account).set({ scope: "Calendars.Read" }).where(eq(account.id, f.grantID)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
    });
    await fixture("grant reconnect ABA after final preflight blocks dispatch", async f => {
      onCalendar = async () => { if (calendars === 2) {
        await db.update(account).set({ syncStatus: "blocked" }).where(eq(account.id, f.grantID));
        await db.update(account).set({ syncStatus: "active" }).where(eq(account.id, f.grantID));
      } };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
    });
    await fixture("source retired after accepted DELETE prevents stale ACK", async f => {
      afterDelete = async () => { await db.update(externalCalendars).set({ disabled: true }).where(eq(externalCalendars.id, f.source.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked"); assert(await f.mapped());
    });
    await fixture("mapping version changed before ACK is retained", async f => {
      afterDelete = async () => { await db.update(externalEvents).set({ etag: 'W/"new-mapping"' }).where(eq(externalEvents.id, f.mapping.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "conflict");
      assert.equal((await f.mapped())?.etag, 'W/"new-mapping"');
    });
    await fixture("lease takeover after DELETE prevents late mapping removal", async f => {
      const replacement = randomUUID();
      afterDelete = async () => { await db.update(eventOutbox).set({ leaseToken: replacement, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(eventOutbox.id, f.operationID)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "attempting"); assert.equal(result?.leaseToken, replacement); assert(await f.mapped());
    });
    await fixture("privacy retirement after final preflight prevents DELETE", async f => {
      onCalendar = async () => { if (calendars === 2) await db.update(events).set({ providerReadRetiredRevision: 2 }).where(eq(events.id, f.event.id)); };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 0);
    });
    await fixture("an actual retained pull conflict cannot be erased by a later 404 ACK", async f => {
      afterDelete = () => db.transaction(async tx => {
        await tx.select({ id: events.id }).from(events).where(eq(events.id, f.event.id)).for("update");
        await retainPendingEventPull(tx, f.event.id, f.calendar.id, "microsoft", nativeID, {
          title: "Concurrent provider edit", description: "Provider notes", location: "Other place", recurrence: null,
          start: new Date("2026-10-24T09:00:00.000Z"), end: new Date("2026-10-24T10:00:00.000Z"), isAllDay: false,
        }, 'W/"pulled"', null);
      });
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "conflict");
      assert.equal((await f.row()).remoteSnapshot?.values?.title, "Concurrent provider edit"); assert(await f.mapped());
    });
    await fixture("an actual pulled DELETE echo retains the active ACK lease", async f => {
      afterDelete = () => db.transaction(async tx => {
        await tx.select({ id: events.id }).from(events).where(eq(events.id, f.event.id)).for("update");
        await retainPendingEventPull(tx, f.event.id, f.calendar.id, "microsoft", nativeID, null, null, null);
      });
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(await f.mapped(), undefined); assert.equal((await f.row()).remoteSnapshot?.isEcho, true);
      assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.externalCalendarLinkID, f.source.id))).length, 0);
    });
    await fixture("retained tombstone alone neither settles DELETE nor changes its target", async f => {
      const [tombstone] = await db.insert(externalEventTombstones).values({ externalCalendarLinkID: f.source.id, externalEventID: nativeID }).returning();
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal(requests.filter(value => value.method === "DELETE").length, 1);
      assert.equal((await db.select().from(externalEventTombstones).where(eq(externalEventTombstones.id, tombstone!.id))).length, 1);
    });
    for (const change of ["mapping", "tombstone", "pending-proof"] as const) {
      await fixture(`stale explicit resolution ${change} comparison is rejected atomically`, async f => {
        mode = "lost-retained"; await deliverEventOutbox(f.operationID, () => newAdapter); await due(f.operationID);
        await deliverEventOutbox(f.operationID, () => newAdapter);
        const { preview, proof } = await prepareEventDeliveryResolution(f.owner, f.event.id, f.operationID, () => newAdapter);
        assert.equal(preview.canResolve, true);
        if (change === "mapping") await db.update(externalEvents).set({ etag: 'W/"newer-mapping"' }).where(eq(externalEvents.id, f.mapping.id));
        else if (change === "tombstone") await db.insert(externalEventTombstones).values({ externalCalendarLinkID: f.source.id, externalEventID: nativeID });
        else await db.update(eventOutbox).set({ errorCode: "new-observation" }).where(eq(eventOutbox.id, f.operationID));
        const deletes = requests.filter(value => value.method === "DELETE").length;
        await assert.rejects(() => commitEventDeliveryResolution(f.owner, proof, { mutationId: randomUUID(), expectedLocalRevision: preview.localRevision,
          expectedLatestOperationId: preview.latestOperationId, expectedRemoteExists: preview.remote !== null, expectedRemoteEtag: preview.remoteEtag }),
        (error: any) => error.code === "delivery-state-changed");
        assert.equal((await f.row()).status, "unconfirmed");
        assert.equal((await db.select().from(eventOutbox).where(eq(eventOutbox.userID, f.owner))).length, 1);
        assert.equal(requests.filter(value => value.method === "DELETE").length, deletes);
      });
    }
    await fixture("unknown schema is blocked before adapter factory", async f => {
      const saved = await f.row(); let adapters = 0;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => { adapters++; return newAdapter; }))?.status, "blocked");
      assert.equal(adapters, 0); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("nominal timed DELETE with all-day pinned profile cannot fall back", async f => {
      const saved = await f.row(), envelope = SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope);
      Object.assign(envelope.admittedProjection.data, { isAllDay: true, start: "2026-10-24T00:00:00.000Z", end: "2026-10-24T00:00:00.000Z" });
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0); assert.equal(requests.length, 0);
    });
    for (const validator of [null, '"strong"']) {
      await fixture(`invalid admitted validator ${validator} blocks without a fallback`, async f => {
        await db.update(eventOutbox).set({ expectedEtag: validator }).where(eq(eventOutbox.id, f.operationID));
        const result = await deliverEventOutbox(f.operationID, () => newAdapter);
        assert.equal(result?.status, "blocked"); assert.equal(result?.errorCode, "provider-version-unavailable");
        assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0); assert.equal(requests.length, 0);
      });
    }
    await fixture("unregistered adapter retains its prior executor", async f => {
      assert.equal((await deliverEventOutbox(f.operationID, () => oldAdapter))?.status, "completed"); assert.equal(factoryCalls, 0); assert.equal(requests.length, 9);
    });
    await fixture("legacy payload retains its prior executor", async f => {
      const saved = await f.row(), { operationEnvelope, operationCapture, ...payload } = saved.payload;
      await db.update(eventOutbox).set({ payload }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed"); assert.equal(factoryCalls, 0); assert(legacyCalls > 0);
    });
    for (const property of ["isAllDay", "isMeeting", "hasAttendees", "recurrence", "timeModel"] as const) {
      await fixture(`unsupported host ${property} keeps its existing guarded route`, async f => {
        const saved = await f.row(), event = { ...saved.payload.event, [property]: property === "recurrence" ? "RRULE:FREQ=DAILY" : property === "timeModel"
          ? { kind: "zoned", timeZone: "UTC", startLocal: "2026-10-24T09:00:00", endLocal: "2026-10-24T10:00:00" } : true };
        await db.update(eventOutbox).set({ payload: { ...saved.payload, event } }).where(eq(eventOutbox.id, f.operationID));
        await deliverEventOutbox(f.operationID, () => newAdapter); assert.equal(factoryCalls, 0); assert.equal(sessions, 0);
      });
    }
    await fixture("waiting ACK rolls back mapping removal after timeout", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["microsoftPersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.microsoftPersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "DELETE") { await blocker.query("BEGIN"); transaction = true; await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        assert.equal((await deliverSharedMicrosoftDelete(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 800, heartbeatMs: 5 }))?.status, "unconfirmed");
        assert(transaction); assert(await f.mapped()); await blocker.query("COMMIT"); transaction = false; await pause(35);
        assert.equal((await f.row()).status, "unconfirmed"); assert(await f.mapped());
      } finally { if (transaction) await blocker.query("ROLLBACK"); blocker.release(); }
    });
    await fixture("one heartbeat and ignored-signal DELETE cannot ACK after timeout", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      let entered!: () => void, release!: () => void, intervals = 0;
      const dispatched = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
      const originalInterval = globalThis.setInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { if (args[1] === 5) intervals++; return originalInterval(...args); }) as typeof setInterval;
      const factory: NonNullable<CalendarAdapter["microsoftPersonalDeleteV1"]> = (...args) => {
        const bridge = newAdapter.microsoftPersonalDeleteV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init); if (init.method === "DELETE") { entered(); await blocked; } return response;
        } } } };
      };
      try {
        const delivery = deliverSharedMicrosoftDelete(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await dispatched; assert.equal((await delivery)?.status, "unconfirmed"); assert.equal(intervals, 1); assert(await f.mapped());
        release(); await pause(35); assert.equal((await f.row()).status, "unconfirmed"); assert(await f.mapped());
        assert.equal(requests.length, 8, "An aborted late continuation cannot verify or acknowledge");
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    for (const phase of ["beforeDelete", "afterDelete"] as const) {
      await fixture(`SIGKILL at ${phase} is read-only after restart`, async f => {
        const payload = JSON.stringify((await f.row()).payload), worker = child(f.operationID, phase);
        try { await worker.checkpoint; } finally { worker.proc.kill("SIGKILL"); }
        assert.equal((await worker.exited).signal, "SIGKILL"); const before = requests.length;
        await due(f.operationID); const restarted = await child(f.operationID).exited;
        assert.equal(restarted.code, 0, restarted.stderr); assert.equal(restarted.signal, null);
        assert.equal(JSON.stringify((await f.row()).payload), payload); assert.deepEqual(requests.slice(before).map(value => value.method), ["GET"]);
        assert.equal(requests.filter(value => value.method === "DELETE").length, phase === "beforeDelete" ? 0 : 1);
        assert.equal((await f.row()).status, phase === "beforeDelete" ? "unconfirmed" : "completed");
      });
    }
    await fixture("SIGKILL consumes a fresh resolution's sole dispatch permission", async f => {
      mode = "lost-retained"; await deliverEventOutbox(f.operationID, () => newAdapter); await due(f.operationID);
      await deliverEventOutbox(f.operationID, () => newAdapter); const fresh = await resolve(f);
      const worker = child(fresh.id, "beforeDelete"); try { await worker.checkpoint; } finally { worker.proc.kill("SIGKILL"); }
      assert.equal((await worker.exited).signal, "SIGKILL"); const count = requests.filter(value => value.method === "DELETE").length;
      await due(fresh.id); const restarted = await child(fresh.id).exited; assert.equal(restarted.code, 0, restarted.stderr);
      assert.equal((await f.row(fresh.id)).status, "unconfirmed"); assert.equal(requests.filter(value => value.method === "DELETE").length, count);
    });
    console.log(`Graph shared DELETE PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    globalThis.fetch = originalFetch; config.api.syncOperationV1EncoderEnabled = originalEncoder;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end();
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
