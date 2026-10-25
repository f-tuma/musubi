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
import { microsoftAdapter } from "./adapters/microsoft";
import type { CalendarAdapter } from "./adapter";
import { deliverEventOutbox } from "./event_delivery";
import { deliverSharedMicrosoftCreate } from "./microsoft_shared_create_delivery";
import { providerHttpMetricsRegistry } from "./provider_http_metrics";

const scope = "Calendars.ReadWrite";
const nativeCalendar = "create/calendar+id@example.test";
type Wire = { method: string; path: string; body: unknown; ifMatch?: string; prefer?: string; cacheControl?: string; contentType?: string };
type HostProfile = "timed" | "all-day" | "recurring";

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const originalFetch = globalThis.fetch, originalEncoder = config.api.syncOperationV1EncoderEnabled;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let mode = "success", remote: any = null, nativeID = "", factoryCalls = 0, legacyCalls = 0, sessions = 0;
  let requests: Wire[] = [], failures: unknown[] = [], dispatches = 0;
  let onCalendar: (() => Promise<void>) | undefined, afterPost: (() => Promise<void>) | undefined, onRefresh: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    try {
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      const url = new URL(req.url!, "http://fixture.test"), method = req.method!;
      const body = bytes ? req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(bytes)) : JSON.parse(bytes) : null;
      const header = (name: string) => typeof req.headers[name] === "string" ? req.headers[name] as string : undefined;
      requests.push({ method, path: url.pathname + url.search, body, ifMatch: header("if-match"),
        prefer: header("prefer"), cacheControl: header("cache-control"), contentType: header("content-type") });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname.endsWith("/oauth2/v2.0/token")) {
        assert.equal(body.grant_type, "refresh_token"); assert.equal(body.refresh_token, "create.fixture.refresh");
        await onRefresh?.();
        if (mode === "refresh-http-failure") return json({ error: "temporarily_unavailable" }, 503);
        if (mode === "refresh-network-failure") return res.destroy();
        if (mode === "refresh-invalid-grant") return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "create.fixture.access", expires_in: 3600, scope: mode === "refresh-narrowed" ? "openid" : scope });
      }
      assert.equal(req.headers.authorization, "Bearer create.fixture.access");
      const calendar = `/v1.0/me/calendars/${encodeURIComponent(nativeCalendar)}`;
      if (url.pathname === calendar || url.pathname === "/calendar-redirect") {
        await onCalendar?.();
        if (mode === "preflight-redirect" && url.pathname === calendar) { res.writeHead(302, { location: "/calendar-redirect" }); return res.end(); }
        if (mode === "preflight-invalid-json") { res.writeHead(200); return res.end("{"); }
        if (mode === "preflight-null") return json(null);
        if (mode === "preflight-string") return json("calendar");
        if (mode === "preflight-missing") return json({});
        if (mode === "preflight-false") return json({ canEdit: false });
        if (mode === "preflight-nonboolean") return json({ canEdit: "true" });
        if (mode.startsWith("preflight-status-")) return json({ canEdit: true }, Number(mode.slice(17)));
        return json({ id: "deliberately-unchecked-legacy-id", canEdit: true }, mode === "preflight-201" ? 201 : mode === "preflight-206" ? 206 : 200);
      }
      const collection = `${calendar}/events`;
      assert.equal(url.pathname, collection);
      if (method === "GET") {
        if (!url.searchParams.has("loop")) assert.equal(url.searchParams.get("$select"), "id,transactionId,subject,start,end,isAllDay,isCancelled,body,location,organizer,recurrence,onlineMeeting,onlineMeetingUrl");
        assert.equal(header("prefer"), 'outlook.timezone="UTC"');
        if (mode === "gone") return json({}, 410);
        if (mode.startsWith("list-status-")) { res.setHeader("retry-after", "1"); return json({}, Number(mode.slice(12))); }
        if (mode === "partial") return json({}, 206);
        if (mode === "list-invalid-json") { res.writeHead(200); return res.end("{"); }
        if (mode === "list-null") return json(null);
        if (mode === "list-nonarray") return json({ value: {} });
        if (mode === "list-null-item") return json({ value: [null] });
        if (mode === "range") res.setHeader("content-range", "items 0-0/2");
        const value = remote ? structuredClone(remote) : null;
        if (value) {
          if (mode === "cancelled") value.isCancelled = true;
          if (mode === "removed") value["@removed"] = { reason: "deleted" };
          if (mode === "recurrence") value.recurrence = {};
          if (mode === "wrong-marker") value.transactionId = "00000000-0000-4000-8000-000000000001";
          if (mode === "different-content") value.subject = "External change";
          if (mode === "nullable-read") { delete value["@odata.etag"]; value.body.content = "  "; value.location.displayName = "  "; }
          if (mode === "malformed-subject") value.subject = {};
          if (mode === "empty-read-validator") value["@odata.etag"] = "";
          if (mode === "malformed-read-validator") value["@odata.etag"] = "unquoted opaque";
          if (mode === "nonstring-read-validator") value["@odata.etag"] = 7;
          if (mode === "html-body") value.body = { contentType: "html", content: "<p>Changed</p>" };
          if (mode === "nullable-fields") { value.body = null; value.location = null; }
          if (mode === "native-attendees") value.attendees = [{ emailAddress: { address: "guest@example.test" }, type: "required" }];
          if (mode === "native-occurrence") { value.type = "occurrence"; value.seriesMasterId = "external-master"; }
          if (mode === "malformed-body") value.body.content = {};
          if (mode === "malformed-location") value.location.displayName = {};
          if (mode === "malformed-start") value.start.dateTime = "not-a-date";
          if (mode === "fractional-utc") { value.start.dateTime = "2026-10-24T09:00:00.0000000"; value.end.dateTime = "2026-10-24T10:00:00.0000000"; }
        }
        const values = !value || mode === "absent" || mode === "loop" || mode === "page-cap" ? [] : mode === "duplicate" ? [value, { ...value, id: "second-native-event" }] : [value];
        const next = mode === "foreign-next" ? "https://foreign.example.invalid/events" : mode === "wrong-path-next" ? "https://graph.microsoft.com/v1.0/me/events" : mode === "loop" ? `https://graph.microsoft.com${collection}?loop=1` : mode === "empty-next" ? "" : mode === "whitespace-next" ? " next " : mode === "nonstring-next" ? 7 :
          mode === "page-cap" ? `https://graph.microsoft.com${collection}?page=${Number(url.searchParams.get("page") ?? 0) + 1}&$select=${encodeURIComponent(url.searchParams.get("$select")!)}` : mode === "second-page" && !url.searchParams.has("page") ? `https://graph.microsoft.com${collection}?page=2&$select=${encodeURIComponent(url.searchParams.get("$select")!)}` : undefined;
        return json({ value: mode === "page-cap" ? `https://graph.microsoft.com${collection}?page=${Number(url.searchParams.get("page") ?? 0) + 1}&$select=${encodeURIComponent(url.searchParams.get("$select")!)}` : mode === "second-page" && !url.searchParams.has("page") ? [] : values, ...(next === undefined ? {} : { "@odata.nextLink": next }) });
      }
      assert.equal(method, "POST"); assert.equal(header("if-match"), undefined);
      assert.equal(body.transactionId, operationIDForNative());
      if (["200", "204", "202", "400", "401", "403", "404", "408", "409", "410", "412", "429", "500"].includes(mode)) {
        if (mode === "429") res.setHeader("retry-after", "1");
        if (mode !== "200") return json({}, Number(mode));
      }
      assert.equal(remote, null, "An already materialized CREATE must never be sent again");
      remote = { ...body, id: nativeID, "@odata.etag": 'W/"created"', isCancelled: false, organizer: { emailAddress: { address: "self@example.test" } }, attendees: [] };
      await afterPost?.();
      if (mode === "lost") return res.destroy();
      if (mode === "missing-id") return json({ "@odata.etag": remote["@odata.etag"] }, 201);
      if (mode === "malformed") { res.writeHead(201, { "content-type": "application/json" }); return res.end('{"id":'); }
      if (mode === "nullable-validator") return json({ id: nativeID }, 201);
      if (mode === "empty-validator") return json({ id: nativeID, "@odata.etag": "" }, 201);
      if (mode === "malformed-validator") return json({ id: nativeID, "@odata.etag": "unquoted opaque" }, 201);
      return json(remote, mode === "200" ? 200 : 201);
    } catch (error) { failures.push(error); res.writeHead(500); res.end("Owned fixture assertion failed"); }
  });
  const operationIDForNative = () => nativeID.slice("native-".length);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert(["https://graph.microsoft.com", "https://login.microsoftonline.com"].includes(url.origin), "Only owned Graph/OAuth HTTP fixtures are reachable");
    dispatches++; return originalFetch(`${origin}${url.pathname}${url.search}`, init).then(response => {
      Object.defineProperty(response, "url", { value: url.href }); return response;
    });
  };
  const oldAdapter: CalendarAdapter = { ...microsoftAdapter, microsoftPersonalCreateV1: undefined };
  const newAdapter: CalendarAdapter = {
    ...microsoftAdapter,
    microsoftPersonalCreateV1(userID, accountID, capture) {
      factoryCalls++;
      const bridge = microsoftAdapter.microsoftPersonalCreateV1!(userID, accountID, capture);
      return { ...bridge, ports: { ...bridge.ports, accountSession: { async open(target, signal) {
        sessions++; assert.equal(target.connectionId, capture.connectionId); assert.notEqual(target.connectionId, accountID);
        return bridge.ports.accountSession.open(target, signal);
      } } } };
    },
    async assertEventWrite(...args) { legacyCalls++; return microsoftAdapter.assertEventWrite!(...args); },
    async pushCreate(...args) { legacyCalls++; return microsoftAdapter.pushCreate(...args); },
  };
  config.api.syncOperationV1EncoderEnabled = true;
  let cases = 0;
  async function seed(operationID: string = randomUUID(), profile: HostProfile = "timed") {
    const owner = `create-${randomUUID()}`, accountID = `logical-${randomUUID()}`, grantID = randomUUID();
    await db.insert(user).values({ id: owner, name: "Shared CREATE fixture", email: `${owner}@example.test` });
    await db.insert(account).values({ id: grantID, userId: owner, providerId: "microsoft", accountId: accountID, scope,
      accessToken: "create.fixture.access", refreshToken: "create.fixture.refresh", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) });
    const calendar = await createCalendar({ creatorID: owner, name: "Create fixture", color: "#112233" });
    const [source] = await db.insert(externalCalendars).values({ calendarID: calendar.id, provider: "microsoft", userID: owner,
      accountID, externalCalendarID: nativeCalendar, providerAccessRole: "owner", providerAccessRevision: 1 }).returning();
    const event = EventSchema.parse({ id: randomUUID(), creatorID: owner, organizer: owner, calendars: [calendar.id], originCalendarID: calendar.id,
      title: "Accepted CREATE A", description: "", location: "", color: "#112233",
      start: profile === "all-day" ? "2026-10-24T00:00:00.000Z" : "2026-10-24T09:00:00.000Z",
      end: profile === "all-day" ? "2026-10-24T00:00:00.000Z" : "2026-10-24T10:00:00.000Z",
      isAllDay: profile === "all-day", isCanceled: false, recurrence: profile === "recurring" ? "RRULE:FREQ=DAILY;COUNT=2" : null });
    const intent: EventOutboxIntent = { id: operationID, actorID: owner, mutationID: randomUUID(), position: 0,
      eventID: event.id, calendarID: calendar.id, externalCalendarLinkID: source!.id, provider: "microsoft", userID: owner,
      accountID, externalCalendarID: nativeCalendar, action: "create", payload: { event, createIdentityVersion: 1 } };
    await createEvent(event, event.calendars, [intent]);
    const row = async () => (await db.select().from(eventOutbox).where(eq(eventOutbox.id, operationID)))[0]!;
    const mapped = async () => (await db.select().from(externalEvents).where(eq(externalEvents.eventID, event.id)))[0];
    return { owner, accountID, grantID, calendar, source: source!, event, operationID, row, mapped };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const metrics = async () => (await providerHttpMetricsRegistry.getSingleMetric("musubi_provider_http_requests_total")!.get()).values
    .filter(value => value.labels.provider === "microsoft" && value.labels.family === "event").reduce((sum, value) => sum + value.value, 0);
  async function fixture(label: string, body: (f: Fixture) => Promise<void>, operationID?: string, profile: HostProfile = "timed", verifyMetrics = true) {
    if (process.env.MUSUBI_CREATE_API_SCENARIO && !label.includes(process.env.MUSUBI_CREATE_API_SCENARIO)) return;
    mode = "success"; remote = null; requests = []; failures = []; dispatches = 0; onCalendar = afterPost = onRefresh = undefined;
    factoryCalls = legacyCalls = sessions = 0;
    const f = await seed(operationID, profile); nativeID = `native-${f.operationID}`; const beforeMetrics = await metrics();
    try { await body(f); assert.deepEqual(failures, []); if (verifyMetrics) assert.equal(await metrics() - beforeMetrics, dispatches, "Metrics count each existing fetch boundary exactly once, including native automatic redirect completion"); cases++; console.log(`Microsoft shared CREATE: ${label}: PASS`); }
    finally { await db.delete(eventOutbox).where(eq(eventOutbox.userID, f.owner)); await db.delete(user).where(eq(user.id, f.owner)); }
  }
  const retry = async (f: Fixture) => db.update(eventOutbox).set({ nextAttemptAt: new Date(0), leaseUntil: new Date(0) }).where(eq(eventOutbox.id, f.operationID));
  const child = (operationId: string, at?: "beforePost" | "afterPost") => {
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./microsoft_create_process.fixture.ts", import.meta.url))], {
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
    for (const variant of ["success", "nullable-validator", "empty-validator", "malformed-validator", "lost", "malformed", "missing-id", "200", "204", "202", "400", "401", "403", "404", "408", "409", "410", "412", "429", "500", "preflight-201", "preflight-206", "preflight-redirect", "preflight-invalid-json", "preflight-null", "preflight-string", "preflight-missing", "preflight-false", "preflight-nonboolean", "preflight-status-400", "preflight-status-401", "preflight-status-403", "preflight-status-408", "preflight-status-429", "preflight-status-500"]) {
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
        assert.equal(requests.filter(value => value.method === "POST").length, oldWire.filter(value => value.method === "POST").length);
      }, operationID);
    }
    for (const variant of ["success", "nullable-read", "empty-read-validator", "malformed-read-validator", "nonstring-read-validator", "html-body", "nullable-fields", "native-attendees", "native-occurrence", "gone", "partial", "range", "cancelled", "removed", "recurrence", "wrong-marker", "different-content", "duplicate", "absent", "list-invalid-json", "list-null", "list-nonarray", "list-null-item", "malformed-subject", "malformed-body", "malformed-location", "malformed-start", "fractional-utc", "foreign-next", "wrong-path-next", "loop", "empty-next", "whitespace-next", "nonstring-next", "second-page", "page-cap", "list-status-400", "list-status-401", "list-status-403", "list-status-408", "list-status-429", "list-status-500"]) {
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
    for (const status of ["408", "429"] as const) {
      let oldWire: Wire[] = [], oldOutcome: unknown;
      const operationID = randomUUID();
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`known not-written ${status} permits fresh retry ${label}`, async f => {
          mode = status;
          const first = await deliverEventOutbox(f.operationID, () => adapter);
          assert.equal(first?.status, "retry"); assert.equal(first?.uncertain, false);
          mode = "success"; await retry(f);
          const completed = await deliverEventOutbox(f.operationID, () => adapter); assert(completed);
          assert.equal(completed.status, "completed"); assert.equal(requests.filter(value => value.method === "POST").length, 2);
          if (label === "original") { oldWire = structuredClone(requests); oldOutcome = await snapshot(completed, f); }
          else { assert.deepEqual(requests, oldWire); assert.deepEqual(await snapshot(completed, f), oldOutcome); }
        }, operationID);
      }
    }
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`inherited possible acceptance stays observe-only ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      mode = "lost"; await deliverEventOutbox(f.operationID, () => adapter);
      mode = "list-status-429"; await retry(f);
      assert.equal((await deliverEventOutbox(f.operationID, () => adapter))?.uncertain, true);
      mode = "absent"; await retry(f);
      const held = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(held?.status, "blocked"); assert.equal(held?.errorCode, "create-outcome-unknown"); assert.equal(held?.uncertain, true);
      assert.equal(requests.filter(value => value.method === "POST").length, 1);
    });
    await fixture("native deletion after POST prevents delayed mapping adoption", async f => {
      afterPost = () => deleteExternalEvent("microsoft", f.calendar.id, nativeID).then(() => undefined);
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "conflict"); assert.equal(await f.mapped(), undefined);
      assert.equal(requests.filter(value => value.method === "POST").length, 1);
    });
    await fixture("pull echo before ACK preserves one canonical event", async f => {
      afterPost = async () => {
        await upsertExternalEvent("microsoft", f.owner, f.calendar.id, nativeCalendar, nativeID, {
          title: remote.subject, description: remote.body.content, location: remote.location.displayName, recurrence: null,
          start: new Date(remote.start.dateTime), end: new Date(remote.end.dateTime), isAllDay: false,
          organizer: "", color: "#112233", url: null,
        }, remote["@odata.etag"], null, f.operationID);
        assert.equal((await getEvent(f.event.id)).revision, 1);
        assert.equal(await f.mapped(), undefined, "A projected pull is not a native mapping ACK");
      };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert.equal((await db.select().from(events).where(eq(events.creatorID, f.owner))).length, 1);
      assert.equal((await f.mapped())!.externalEventID, nativeID);
    });
    await fixture("privacy retirement before native factory is fenced", async f => {
      await db.update(events).set({ providerReadRetiredRevision: 2 }).where(eq(events.id, f.event.id));
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
      assert.equal(requests.length, 0); assert.equal(factoryCalls, 0); assert.equal(await f.mapped(), undefined);
    });
    await fixture("a different local object cannot occupy the returned native identity", async f => {
      const other = EventSchema.parse({ ...f.event, id: randomUUID() }); await createEvent(other, other.calendars);
      afterPost = async () => { await db.insert(externalEvents).values({ provider: "microsoft", eventID: other.id, calendarID: f.calendar.id,
        externalCalendarID: nativeCalendar, externalEventID: nativeID, etag: 'W/"other"' }); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "conflict"); assert.equal(result?.errorCode, "mapping-identity-changed"); assert.equal(await f.mapped(), undefined);
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
    const secondSessionAudit: { variant: string; original?: unknown; shared?: unknown }[] = [];
    for (const variant of ["http-failure", "network-failure", "invalid-grant", "narrowed", "reconnect"] as const) {
      const audit: { variant: string; original?: unknown; shared?: unknown } = { variant }, operationID = randomUUID();
      for (const [label, adapter] of [["original", oldAdapter], ["shared", newAdapter]] as const) {
        await fixture(`second credential refresh ${variant} ${label}`, async f => {
          onCalendar = async () => { await db.update(account).set({ accessTokenExpiresAt: new Date(0) }).where(eq(account.id, f.grantID)); };
          mode = `refresh-${variant}`;
          if (variant === "reconnect") onRefresh = async () => {
            await db.update(account).set({ syncStatus: "blocked" }).where(eq(account.id, f.grantID));
            await db.update(account).set({ syncStatus: "active", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }).where(eq(account.id, f.grantID));
          };
          const result = await deliverEventOutbox(f.operationID, () => adapter); assert(result);
          audit[label] = { ...await snapshot(result, f), requests: requests.length,
            nativePosts: requests.filter(value => value.method === "POST" && value.path.includes("/events")).length,
            credentialPosts: requests.filter(value => value.path.endsWith("/oauth2/v2.0/token")).length };
        }, operationID);
      }
      if (audit.original || audit.shared) { secondSessionAudit.push(audit); console.log("Second-session audit: " + JSON.stringify(audit)); }
    }
    for (const audit of secondSessionAudit) {
      if (audit.variant !== "narrowed" && audit.variant !== "reconnect") {
        assert.deepEqual(audit.shared, audit.original, "Second credential failures preserve legacy outcomes and coarse uncertainty");
      } else {
        const original = audit.original as Record<string, unknown>, shared = audit.shared as Record<string, unknown>;
        assert.equal(original.status, "blocked"); assert.equal(original.uncertain, true); assert.equal(original.errorCode, "operation-source-changed");
        assert.equal(original.nativePosts, 1); assert.equal(original.requests, 3); assert(original.resultRef);
        // The shared owned-session fence deliberately stops the old unsafe POST
        // while retaining the legacy host's conservative uncertainty boundary.
        assert.deepEqual(shared, { ...original, errorCode: "provider-permission-unknown", resultRef: null, requests: 2, nativePosts: 0 });
      }
    }
    for (const narrowed of [false, true]) await fixture(`${narrowed ? "narrowed scope" : "reconnected grant"} during real token refresh blocks before Graph HTTP`, async f => {
      await db.update(account).set({ accessTokenExpiresAt: new Date(0) }).where(eq(account.id, f.grantID));
      if (narrowed) mode = "refresh-narrowed";
      else onRefresh = async () => {
        await db.update(account).set({ syncStatus: "blocked" }).where(eq(account.id, f.grantID));
        await db.update(account).set({ syncStatus: "active", accessTokenExpiresAt: new Date(Date.now() + 3_600_000) }).where(eq(account.id, f.grantID));
      };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.status, "blocked"); assert.equal(await f.mapped(), undefined);
      assert.equal(requests.length, 1); assert(requests[0]!.path.endsWith("/oauth2/v2.0/token"));
    });
    await fixture("lost lease during preflight fences the selected POST", async f => {
      const replacement = randomUUID();
      onCalendar = async () => { await db.update(eventOutbox).set({ leaseToken: replacement, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(eventOutbox.id, f.operationID)); };
      const result = await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(result?.leaseToken, replacement); assert.equal(requests.filter(value => value.method === "POST").length, 0); assert.equal(await f.mapped(), undefined);
    });
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`actual changed pull before ACK is retained ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      afterPost = async () => { await upsertExternalEvent("microsoft", f.owner, f.calendar.id, nativeCalendar, nativeID, {
        title: "Concurrent remote edit", description: "Other notes", location: "Other place", recurrence: null,
        start: new Date(remote.start.dateTime), end: new Date(remote.end.dateTime), isAllDay: false, organizer: "", color: "#112233", url: null,
      }, 'W/"pulled"', null, f.operationID); };
      const result = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(result?.status, "conflict"); assert.equal(result?.remoteSnapshot?.values?.title, "Concurrent remote edit"); assert.equal(await f.mapped(), undefined);
      assert.equal((await db.select().from(events).where(eq(events.creatorID, f.owner))).length, 1);
    });
    for (const adapter of [oldAdapter, newAdapter]) await fixture(`uncovered canonical revision refuses fresh dispatch ${adapter === oldAdapter ? "original" : "shared"}`, async f => {
      await patchEventAndCalendarLinks(f.event.id, 1, { title: "Changed without a successor" });
      const result = await deliverEventOutbox(f.operationID, () => adapter);
      assert.equal(result?.status, "blocked"); assert.equal(result?.uncertain, false); assert.equal(requests.length, 0); assert.equal(await f.mapped(), undefined);
    });
    await fixture("a dependent CREATE waits for its unresolved predecessor", async f => {
      const nextID = randomUUID(), patch = { title: "Second admitted create" };
      const intent: EventOutboxIntent = { id: nextID, actorID: f.owner, mutationID: randomUUID(), position: 0, eventID: f.event.id,
        calendarID: f.calendar.id, externalCalendarLinkID: f.source.id, provider: "microsoft", userID: f.owner, accountID: f.accountID,
        externalCalendarID: nativeCalendar, action: "create", payload: { event: f.event, createIdentityVersion: 1 } };
      assert.equal((await patchEventAndCalendarLinks(f.event.id, 1, patch, false, [intent])).status, "saved");
      const next = await deliverEventOutbox(nextID, () => newAdapter);
      assert.equal(next?.status, "pending"); assert.equal(next?.predecessorID, f.operationID); assert.equal(factoryCalls, 0); assert.equal(requests.length, 0);
    });
    await fixture("unsupported schema never constructs a provider", async f => {
      const saved = await f.row(); let adapters = 0;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: { ...saved.payload.operationEnvelope!, schemaVersion: 99 } } }).where(eq(eventOutbox.id, f.operationID));
      assert.equal((await deliverEventOutbox(f.operationID, () => { adapters++; return newAdapter; }))?.status, "blocked");
      assert.equal(adapters, 0); assert.equal(requests.length, 0); assert.equal(factoryCalls, 0);
    });
    for (const corruption of ["foreign-transaction-id", "non-null-locator", "noncanonical-operation-id"] as const) {
      await fixture(`${corruption} blocks before the registered writer can fall back`, async f => {
        const saved = await f.row(), envelope = structuredClone(SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope));
        if (corruption === "foreign-transaction-id") (envelope.nativePlan.data.body as Record<string, unknown>).transactionId = randomUUID();
        else if (corruption === "non-null-locator") envelope.locator.resourceId = "invented-native-id";
        else Object.assign(envelope, { operationId: `invalid-create-${randomUUID()}` });
        await db.update(eventOutbox).set({ payload: { ...saved.payload, operationEnvelope: envelope } }).where(eq(eventOutbox.id, f.operationID));
        assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "blocked");
        assert.deepEqual(requests, []); assert.equal(factoryCalls, 0); assert.equal(sessions, 0); assert.equal(legacyCalls, 0); assert.equal(await f.mapped(), undefined);
      });
    }
    for (const profile of ["all-day"] as const) {
      await fixture(`timed host payload cannot fall back through a coherent ${profile} pinned projection`, async f => {
        const saved = await f.row(), envelope = structuredClone(SyncOperationEnvelopeSchema.parse(saved.payload.operationEnvelope));
        const body = envelope.nativePlan.data.body as Record<string, unknown>;
        Object.assign(envelope.admittedProjection.data, { isAllDay: true, start: "2026-10-24T00:00:00.000Z", end: "2026-10-24T00:00:00.000Z" });
        Object.assign(body, { isAllDay: true, start: { dateTime: "2026-10-24T00:00:00", timeZone: "UTC" }, end: { dateTime: "2026-10-25T00:00:00", timeZone: "UTC" } });
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
    for (const classification of ["hasAttendees", "recurrence", "seriesID", "isCanceled"] as const) await fixture(`genuine ${classification} host family remains on its legacy route`, async f => {
      const saved = await f.row(), value = classification === "recurrence" ? "RRULE:FREQ=DAILY;COUNT=2" : classification === "seriesID" ? randomUUID() : true;
      await db.update(eventOutbox).set({ payload: { ...saved.payload, event: { ...saved.payload.event, [classification]: value } } }).where(eq(eventOutbox.id, f.operationID));
      await deliverEventOutbox(f.operationID, () => newAdapter);
      assert.equal(factoryCalls, 0); assert.equal(sessions, 0);
    });
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
          eventID: f.event.id, calendarID: f.calendar.id, externalCalendarLinkID: f.source.id, provider: "microsoft", userID: f.owner,
          accountID: f.accountID, externalCalendarID: nativeCalendar, action: "update", payload: { event: f.event, patch } };
        assert.equal((await patchEventAndCalendarLinks(f.event.id, 1, patch, false, [intent])).status, "saved");
      };
      assert.equal((await deliverEventOutbox(f.operationID, () => newAdapter))?.status, "completed");
      assert(successorID);
      const [successor] = await db.select().from(eventOutbox).where(eq(eventOutbox.id, successorID));
      assert.equal(successor!.predecessorID, f.operationID); assert.equal(successor!.status, "pending");
      const body = requests.find(value => value.method === "POST")!.body as Record<string, unknown>;
      assert.equal(body.subject, "Accepted CREATE A"); assert.equal((body.body as { content: string }).content, ""); assert.equal((body.location as { displayName: string }).displayName, "");
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
      const factory: NonNullable<CalendarAdapter["microsoftPersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.microsoftPersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "POST") { entered(); await blocked; }
          return response;
        } } } };
      };
      try {
        const delivery = deliverSharedMicrosoftCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 600, heartbeatMs: 5 });
        await dispatched; assert.equal((await delivery)?.status, "unconfirmed"); assert.equal(intervals, 1); assert.equal(await f.mapped(), undefined);
        release(); await pause(35); assert.equal((await f.row()).status, "unconfirmed"); assert.equal(await f.mapped(), undefined);
      } finally { release(); globalThis.setInterval = originalInterval; }
    });
    await fixture("waiting ACK rolls back mapping adoption after timeout", async f => {
      const claimed = await claimEventOutbox(f.operationID); assert(claimed);
      const blocker = await pool.connect(); let transaction = false;
      const factory: NonNullable<CalendarAdapter["microsoftPersonalCreateV1"]> = (...args) => {
        const bridge = newAdapter.microsoftPersonalCreateV1!(...args);
        return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
          const response = await bridge.ports.http.fetch(url, init);
          if (init.method === "POST") { await blocker.query("BEGIN"); transaction = true; await blocker.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [f.event.id]); }
          return response;
        } } } };
      };
      try {
        const result = await deliverSharedMicrosoftCreate(claimed, SyncOperationEnvelopeSchema.parse(claimed.payload.operationEnvelope), factory, { timeoutMs: 800, heartbeatMs: 5 });
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
        assert.equal(receipt.status, phase === "afterPost" ? "completed" : "blocked"); assert.equal((await f.row()).status, receipt.status);
        assert.equal(JSON.stringify((await f.row()).payload), payload);
        assert.equal(requests.filter(value => value.method === "POST").length, phase === "afterPost" ? 1 : 0);
        if (phase === "afterPost") assert.deepEqual(requests.slice(priorRequests).map(value => value.method), ["GET"]);
        else assert.deepEqual(requests.slice(priorRequests).map(value => value.method), ["GET"]);
        if (phase === "afterPost") assert.equal((await f.mapped())!.externalEventID, nativeID); else assert.equal(await f.mapped(), undefined);
      }, undefined, "timed", false);
    }
    assert(cases > 0, "The API fixture filter must select at least one scenario");
    console.log(`Microsoft shared CREATE PostgreSQL/HTTP: ${cases} scenarios passed`);
  } finally {
    globalThis.fetch = originalFetch; config.api.syncOperationV1EncoderEnabled = originalEncoder;
    await pool.end(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
