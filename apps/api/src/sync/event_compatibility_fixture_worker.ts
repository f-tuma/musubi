import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { fork, type ChildProcess } from "node:child_process";
import { EVENT_COMPATIBILITY_TABLES, eventCompatibilityFamily, eventCompatibilityProductionFingerprint, eventCompatibilityHarnessFingerprint, eventCompatibilityNormalizedWitnessInput, eventCompatibilityAlarmWitnessInput, eventCompatibilityNormalizedAlarmWitnessInput, eventCompatibilityDataHash, type EventCompatibilityWitness, type EventCompatibilityEchoObservation, type EventCompatibilitySerializerClock, type EventCompatibilityAlarmWitness } from "./event_compatibility_fixture_manifest";

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type Row = Record<string, unknown>;
type QueryResult = { rows: Row[] };
type Observer = { query(text: string, values?: unknown[]): Promise<QueryResult>; end(): Promise<void> };
type NativeWire = { url: string; method: string; headers: Record<string, string>; body: string | null; redirect: string | null; status?: number; responseHeaders?: Record<string, string>; responseBody?: string };
type Cohort = { id: number; active: number; count: number; records: DeliveryRecord[] };
type CohortReceipt = { id: number; count: number; after: Row | null; state: Record<string, Row[]> };
type DeliveryRecord = { id: string; family: string; fixtureCase?: string; before: Row | null; returned: unknown; after: Row | null; state: Record<string, Row[]>; wireStart: number; wireEnd: number; cohort?: CohortReceipt };
type ModuleHooks = { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown;
  _resolveFilename: (request: string, parent?: { filename?: string }, isMain?: boolean) => string;
  _cache: Record<string, { exports: unknown; loaded?: boolean; filename?: string }> };
type DeliveryModule = Record<string, unknown> & { deliverEventOutbox: (...args: unknown[]) => Promise<unknown> };
type ProcessPhase = "before-native-send" | "raw-native-response" | "before-ack" | "ack-committed";
type ProcessReceipt = { family: string; phase: ProcessPhase; operationId: string; before: Row; checkpoint: Row; afterKill: Row; afterRestart: Row;
  checkpointState: Record<string, Row[]>; afterKillState: Record<string, Row[]>; finalState: Record<string, Row[]>; wireStart: number; recoveryWireStart: number; wireEnd: number; killedSignal: string | null };

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const [entry, output, label] = process.argv.slice(2); assert(entry && output && (label === "old" || label === "new"));
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), require = createRequire(import.meta.url);
  const productionStart = await eventCompatibilityProductionFingerprint(root), harnessManifest = await eventCompatibilityHarnessFingerprint(root), harnessSha256 = harnessManifest.sha256;
  const fixtureSeed = process.env.MUSUBI_EVENT_COMPATIBILITY_UUID_SEED; assert(fixtureSeed);
  const crypto = require("node:crypto") as typeof import("node:crypto");
  let sequence = 0;
  const originalUuid = crypto.randomUUID;
  crypto.randomUUID = (() => {
    const raw = createHash("sha256").update(`${fixtureSeed}:${sequence++}`).digest("hex").slice(0, 32);
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}` as ReturnType<typeof randomUUID>;
  });
  const webcrypto = globalThis.crypto, originalWebUuid = webcrypto.randomUUID;
  webcrypto.randomUUID = crypto.randomUUID;
  syncBuiltinESMExports();
  const pg = require("pg") as typeof import("pg"), ownedPools = new Set<import("pg").Pool>(), closedPools = new WeakSet<object>();
  const connect = pg.Pool.prototype.connect, end = pg.Pool.prototype.end;
  pg.Pool.prototype.connect = function (this: import("pg").Pool, ...args: unknown[]): unknown {
    ownedPools.add(this); return Reflect.apply(connect, this, args);
  } as typeof connect;
  pg.Pool.prototype.end = function (this: import("pg").Pool, ...args: unknown[]): unknown {
    closedPools.add(this); return Reflect.apply(end, this, args);
  } as typeof end;
  const echoObservations: EventCompatibilityEchoObservation[] = [], activeRows = new Map<string, Row>();
  const originalClientQuery = pg.Client.prototype.query;
  const pendingEcho = new WeakMap<object, Omit<EventCompatibilityEchoObservation, "sequence" | "committed">[]>();
  pg.Client.prototype.query = function (this: import("pg").Client, ...args: unknown[]): unknown {
    const config = args[0] as string | { text?: string; values?: unknown[] }, text = typeof config === "string" ? config : config?.text;
    const values = Array.isArray(args[1]) ? args[1] : typeof config === "string" ? undefined : config?.values;
    const fixtureCase = (globalThis as typeof globalThis & { __musubiEventCompatibilityFixtureCase?: string }).__musubiEventCompatibilityFixtureCase;
    let echo: Omit<EventCompatibilityEchoObservation, "sequence" | "committed" | "rowCount"> | undefined;
    if (fixtureCase === "delete-sweep-echo" && typeof text === "string" && /^update "event_outbox"/i.test(text) && text.includes('"remote_snapshot"') && Array.isArray(values)) {
      const evidence = values.flatMap(value => { if (typeof value !== "string") return []; try { const data = JSON.parse(value); return data?.isEcho === true ? [data as Row] : []; } catch { return []; } })[0];
      if (evidence) {
        const where = /where\s+"event_outbox"\."id"\s*=\s*\$(\d+)/i.exec(text); assert(where, "Record only a precisely scoped actual echo UPDATE");
        const operationId = String(values[Number(where[1]) - 1]), row = activeRows.get(operationId); assert(row, "An echo must belong to an observed actual delivery");
        const intent = (row.payload as Row).caldavSeriesDeletion as { context: { mappings: Row[] } }; assert(intent);
        const mapping = intent.context.mappings.find(value => value.externalEventID === evidence.externalEventId); assert(mapping, "A captured echo must name an admitted owned resource member");
        echo = { operationId, fixtureCase, evidence, mapping, updateSql: text, ownership: Object.fromEntries(["actor_id", "provider", "user_id", "account_id", "calendar_id", "external_calendar_link_id", "external_calendar_id"].map(key => [key, row[key]])) };
      }
    }
    const result = Reflect.apply(originalClientQuery, this, args);
    if (echo) return Promise.resolve(result).then(value => { const rowCount = (value as { rowCount: number }).rowCount; assert.equal(rowCount, 1); const pending = pendingEcho.get(this) ?? []; pending.push({ ...echo!, rowCount }); pendingEcho.set(this, pending); return value; });
    if (typeof text === "string" && ["commit", "rollback"].includes(text.trim().toLowerCase())) return Promise.resolve(result).then(value => {
      if (text.trim().toLowerCase() === "commit") for (const entry of pendingEcho.get(this) ?? []) echoObservations.push({ ...entry, sequence: echoObservations.length, committed: true });
      pendingEcho.delete(this); return value;
    });
    return result;
  } as typeof originalClientQuery;
  const observer = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) as unknown as Observer;
  const http = require("node:http") as typeof import("node:http"), listen = http.Server.prototype.listen;
  const origins: { origin: string; alias: string }[] = [], servers = new Set<import("node:http").Server>();
  http.Server.prototype.listen = function (this: import("node:http").Server, ...args: unknown[]): unknown {
    servers.add(this); const ordinal = servers.size;
    this.once("listening", () => { const address = this.address(); if (address && typeof address !== "string") origins.push({ origin: `http://127.0.0.1:${address.port}`, alias: `<owned-fixture-origin:${ordinal}>` }); });
    return Reflect.apply(listen, this, args);
  } as typeof listen;
  const originalFetch = globalThis.fetch, wire: NativeWire[] = [], records: DeliveryRecord[] = [], captures = new WeakMap<Function, typeof fetch>();
  const nested = new AsyncLocalStorage<boolean>(), responseBodies: Promise<unknown>[] = [];
  const relayCalls = new Map<string, { implementation: typeof fetch; input: RequestInfo | URL; init: RequestInit | undefined; error?: unknown; responseUrl?: string }>();
  const relayWire: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  let relaySequence = 0, relayOrigin = "";
  const relay = http.createServer((request, response) => { void (async () => {
    const id = request.headers["x-musubi-fixture-call"]; assert.equal(typeof id, "string");
    const call = relayCalls.get(id as string); assert(call, "Only an owned native call can use the loopback relay");
    let body = ""; for await (const bytes of request) body += String(bytes);
    const logical = new URL(call.input instanceof Request ? call.input.url : String(call.input));
    const method = call.init?.method ?? (call.input instanceof Request ? call.input.method : "GET");
    assert.equal(request.method, method); assert.equal(request.url, logical.pathname + logical.search);
    assert.equal(body, call.init?.body == null ? "" : String(call.init.body));
    const headers = new Headers(call.init?.headers ?? (call.input instanceof Request ? call.input.headers : undefined));
    for (const [name, value] of headers.entries()) assert.equal(request.headers[name], value, `Actual native HTTP must preserve ${name}`);
    relayWire.push({ method, path: request.url!, headers: Object.fromEntries(headers.entries()), body });
    try {
      const native = await nested.run(true, () => call.implementation(call.input, call.init)); call.responseUrl = native.url;
      response.writeHead(native.status, Object.fromEntries(native.headers.entries()));
      if (native.body) Readable.fromWeb(native.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
      else response.end();
    } catch (error) { call.error = error; response.writeHead(500); response.end(); }
    finally { response.once("close", () => relayCalls.delete(id as string)); }
  })().catch(error => { console.error(error); response.writeHead(500); response.end(); }); });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  const relayAddress = relay.address(); assert(relayAddress && typeof relayAddress !== "string"); relayOrigin = `http://127.0.0.1:${relayAddress.port}`;
  const throughRelay = async (implementation: typeof fetch, input: RequestInfo | URL, init?: RequestInit) => {
    const logical = new URL(input instanceof Request ? input.url : String(input)), id = String(relaySequence++), call = { implementation, input, init } as { implementation: typeof fetch; input: RequestInfo | URL; init: RequestInit | undefined; error?: unknown; responseUrl?: string };
    relayCalls.set(id, call);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)); headers.set("x-musubi-fixture-call", id);
    const response = await originalFetch(`${relayOrigin}${logical.pathname}${logical.search}`, { ...init, headers });
    if (call.error !== undefined) throw call.error;
    Object.defineProperty(response, "url", { value: call.responseUrl ?? logical.href }); return response;
  };
  const providers = new Set(["https://www.googleapis.com", "https://tasks.googleapis.com", "https://graph.microsoft.com", "https://oauth2.googleapis.com", "https://login.microsoftonline.com"]);
  const existingFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let effectiveFetch = originalFetch;
  const wrap = (implementation: typeof fetch): typeof fetch => {
    const known = captures.get(implementation); if (known) return known;
    const wrapped: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert(providers.has(url.origin) || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "No live provider fallback is permitted");
      if (providers.has(url.origin)) assert.notEqual(implementation, originalFetch, "An actual provider address must be routed by the owned fixture");
      // A fixture's transport closure forwards logical requests to its actual
      // loopback server. Record the logical provider call once, plus all DAV
      // calls (which are already addressed to that owned server).
      const record = !nested.getStore() && (providers.has(url.origin) || ["PROPFIND", "REPORT", "PUT", "DELETE"].includes(init?.method?.toUpperCase() ?? "") || url.pathname.includes("/dav/") || url.pathname.endsWith(".ics"));
      const item: NativeWire | undefined = record ? { url: url.href, method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()),
        body: init?.body == null ? null : String(init.body), redirect: init?.redirect ?? null } : undefined;
      if (item) wire.push(item);
      try {
        const response = providers.has(url.origin) && !nested.getStore() ? await throughRelay(implementation, input, init) : await nested.run(true, () => implementation(input, init));
        if (item) {
          item.status = response.status; item.responseHeaders = Object.fromEntries(response.headers.entries());
          // Observe a clone in parallel. Never add a body-read await between
          // actual response headers and the provider's acceptance callback.
          responseBodies.push(response.clone().text().then(body => { item.responseBody = body; }, () => { item.responseBody = "<unreadable-response-body>"; }));
        }
        return response;
      } catch (error) { if (item) item.status = 0; throw error; }
    };
    captures.set(implementation, wrapped); captures.set(wrapped, wrapped); return wrapped;
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, enumerable: true, get: () => effectiveFetch, set: value => { effectiveFetch = wrap(value); } });
  effectiveFetch = wrap(originalFetch);
  const module = require("node:module") as ModuleHooks, load = module._load, resolve = module._resolveFilename;
  const deliveryPath = fileURLToPath(new URL("./event_delivery.ts", import.meta.url));
  const baseline = process.env.MUSUBI_EVENT_COMPATIBILITY_OLD_PATH;
  if (label === "old") assert(baseline, "Historical replay requires its immutable production source");
  let replacing = false, executor: DeliveryModule | undefined, executorSourceSha256 = "";
  const observations = new Set<Promise<void>>();
  let cohortSequence = 0; const cohorts = new Map<string, Cohort>();
  const processFamily = process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS_FAMILY, processPhase = process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS_PHASE as ProcessPhase | undefined;
  if (processFamily) { assert(process.send, "Process acceptance must be supervised through IPC"); assert(processPhase && ["before-native-send", "raw-native-response", "before-ack", "ack-committed"].includes(processPhase)); }
  let resolveProcess!: (receipt: ProcessReceipt) => void, processReceipt: ProcessReceipt | undefined, processStarted = false;
  let processRuntime: { killedPid: number; recoveryPid: number; killedExit: { code: number | null; signal: NodeJS.Signals | null }; recoveryExit: { code: number | null; signal: NodeJS.Signals | null } } | undefined;
  const processTransport: { phase: string; requestId: number; method: string; url: string; headersSent: boolean; bodyChunksSent: number; bodyDeferredUntilDeath: boolean }[] = [];
  const processDone = new Promise<ProcessReceipt>(resolve => { resolveProcess = resolve; }), nestedChildren = new Set<ChildProcess>();
  const snapshot = async () => {
    // One statement gives all relations one PostgreSQL MVCC snapshot, rather
    // than mixing separate READ COMMITTED table reads during race fixtures.
    const fields = EVENT_COMPATIBILITY_TABLES.map(table => `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(value)), '[]'::jsonb) FROM "${table}" value)`);
    return (await observer.query(`SELECT jsonb_build_object(${fields.join(",")}) AS value`)).rows[0]!.value as Record<string, Row[]>;
  };
  const startExecutor = (id: string, provider: string, phase: ProcessPhase | "recover", options: unknown) => {
    const captured = require("@musubi/config") as { config: { api: unknown; security: unknown } };
    const child = fork(fileURLToPath(new URL("./event_compatibility_executor.fixture.ts", import.meta.url)), [label, id, provider, phase], {
      execArgv: ["--import", "tsx"], cwd: root, serialization: "advanced", env: { ...process.env, MUSUBI_EVENT_COMPATIBILITY_QA: "1",
        MUSUBI_EVENT_COMPATIBILITY_UUID_SEED: `${fixtureSeed}:${id}:${phase}`, MUSUBI_EVENT_COMPATIBILITY_CONFIG: JSON.stringify({ api: captured.config.api, security: captured.config.security }),
        MUSUBI_EVENT_COMPATIBILITY_DELIVERY_OPTIONS: JSON.stringify(options ?? {}) }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    nestedChildren.add(child); let output = "";
    child.stdout?.on("data", value => { output += String(value); }); child.stderr?.on("data", value => { output += String(value); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => { nestedChildren.delete(child); resolve({ code, signal }); }));
    const controllers = new Map<number, AbortController>();
    const receipt = new Promise<{ kind: "checkpoint" | "result"; phase?: string; result?: unknown }>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Actual executor process ${id}/${phase} omitted its receipt: ${output}`)); }, 30_000);
      child.on("message", (message: { kind: string; id?: number; url?: string; init?: RequestInit; phase?: string; result?: unknown }) => {
        if (message.kind === "fetch-abort") { controllers.get(message.id!)?.abort(new Error("Child native call was cancelled")); return; }
        if (message.kind === "fetch") {
          const controller = new AbortController(); controllers.set(message.id!, controller);
          void (async () => {
            try {
              const response = await effectiveFetch(message.url!, { ...message.init, signal: controller.signal });
              const method = message.init?.method ?? "GET", url = new URL(message.url!);
              const eventMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method) && url.hostname !== "oauth2.googleapis.com" && url.hostname !== "login.microsoftonline.com" && !url.pathname.includes("/token");
              const defer = phase === "raw-native-response" && eventMutation && [200, 201, 202, 204].includes(response.status);
              const transport = { phase, requestId: message.id!, method, url: url.href, headersSent: true, bodyChunksSent: 0, bodyDeferredUntilDeath: defer }; processTransport.push(transport);
              if (child.connected) child.send({ kind: "fetch-headers", id: message.id, status: response.status, headers: [...response.headers.entries()], url: response.url }, () => {});
              // Header receipt is independent of reading the body. At the
              // raw-header cut deliberately deliver no body chunks at all;
              // the actual executor dies before its adapter gets Response.
              if (defer) return;
              if (response.body) {
                const reader = response.body.getReader();
                try { for (;;) { const part = await reader.read(); if (part.done) break; if (child.connected) { child.send({ kind: "fetch-chunk", id: message.id, body: Buffer.from(part.value).toString("base64") }, () => {}); transport.bodyChunksSent++; } } }
                finally { reader.releaseLock(); }
              }
              if (child.connected) child.send({ kind: "fetch-end", id: message.id }, () => {});
            } catch (error) { if (child.connected) child.send({ kind: "fetch-error", id: message.id, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "Native fixture failed" } }, () => {}); }
            finally { controllers.delete(message.id!); }
          })(); return;
        }
        if (message.kind === "checkpoint" || message.kind === "result") { clearTimeout(timeout); resolve(message as { kind: "checkpoint" | "result"; phase?: string; result?: unknown }); }
      });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`Actual executor process exited ${code}/${signal}: ${output}`)); } });
    });
    return { child, receipt, exited };
  };
  const processEligible = (row: Row, args: unknown[]) => {
    if (!processFamily || processStarted || eventCompatibilityFamily({ provider: String(row.provider), payload: row.payload as Row }) !== processFamily || row.status !== "pending" || row.attempts !== 0) return false;
    const payload = row.payload as Row;
    // Select the fixture's successful create representative rather than its
    // deliberately preceding organizer no-op/disabled-admission scenarios.
    if ((processFamily === "organizer:google" || processFamily === "organizer:microsoft") && row.action !== "create") return false;
    const flags = (require("@musubi/config") as { config: { api: Record<string, unknown> } }).config.api;
    if (processFamily === "organizer:caldav" && (!flags.caldavOrganizerEditsEnabled || row.action === "create" && !flags.icloudOrganizerCreateEnabled)) return false;
    if (processFamily === "caldavSplit" && (payload.caldavSplit as Row).sourceOperationID !== row.id) return false;
    const method = processFamily === "organizer:google" ? "organizer" : processFamily === "organizer:microsoft" ? "microsoftOrganizer" : processFamily === "organizer:caldav" ? "caldavOrganizer" :
      processFamily === "graphOccurrenceContent" ? "updateGraphOccurrenceContent" : processFamily === "caldavSplit" ? "writeCaldavSplitSource" : undefined;
    if (!method || typeof args[1] !== "function") return false;
    const offered = (args[1] as (provider: string) => Record<string, unknown> | null)(String(row.provider));
    const moduleName = row.provider === "google" ? "google" : row.provider === "microsoft" ? "microsoft" : "caldav";
    const native = require(`./adapters/${moduleName}`) as Record<string, Record<string, unknown>>;
    return offered?.[method] === native[`${moduleName}Adapter`]?.[method];
  };
  const probeProcess = async (before: Row, options: unknown): Promise<never> => {
    processStarted = true; assert(processPhase && processFamily);
    const id = String(before.id), provider = String(before.provider), wireStart = wire.length;
    const worker = startExecutor(id, provider, processPhase, options);
    try {
      const checkpointReceipt = await worker.receipt; assert.equal(checkpointReceipt.kind, "checkpoint"); assert.equal(checkpointReceipt.phase, processPhase);
      const checkpoint = (await observer.query("SELECT to_jsonb(value) AS value FROM event_outbox value WHERE id=$1", [id])).rows[0]!.value as Row;
      const checkpointState = await snapshot();
      assert.equal(checkpoint.status, processPhase === "ack-committed" ? "completed" : "attempting");
      if (processPhase === "raw-native-response") { const deferred = processTransport.filter(call => call.bodyDeferredUntilDeath); assert.equal(deferred.length, 1); assert.equal(deferred[0]!.headersSent, true); assert.equal(deferred[0]!.bodyChunksSent, 0, "The native raw-header process cut must precede every body chunk"); }
      if (processFamily !== "caldavSplit") {
        const payload = checkpoint.payload as Row, intent = payload[processFamily === "graphOccurrenceContent" ? "graphOccurrenceContent" : "organizer"] as Row;
        const dispatch = intent.dispatch as Row;
        assert.equal(typeof dispatch?.startedAt, "string", "The permanent possible-notification marker must commit before the native mutation checkpoint");
        if (processPhase === "before-native-send" || processPhase === "raw-native-response") assert.equal(dispatch.acceptedAt, undefined, "Receiving native response bytes is separate from durable adapter acceptance");
        else assert.equal(typeof dispatch.acceptedAt, "string", "Accepted native outcome must persist before specialized host ACK");
      }
      worker.child.kill("SIGKILL"); const killed = await worker.exited; assert.equal(killed.signal, "SIGKILL");
      const afterKill = (await observer.query("SELECT to_jsonb(value) AS value FROM event_outbox value WHERE id=$1", [id])).rows[0]!.value as Row;
      assert.deepEqual(afterKill, checkpoint, "Process death cannot invent a host ACK or process journal");
      const afterKillState = await snapshot();
      const ordered = (state: Record<string, Row[]>) => Object.fromEntries(Object.entries(state).map(([table, rows]) => [table, rows.map(value => JSON.stringify(value)).sort()]));
      assert.deepEqual(ordered(afterKillState), ordered(checkpointState), "SIGKILL before ACK rolls back every canonical/mapping/family relation; committed ACK remains intact");
      if (processPhase !== "ack-committed") await observer.query("UPDATE event_outbox SET lease_until=to_timestamp(0), next_attempt_at=to_timestamp(0) WHERE id=$1", [id]);
      const recoveryWireStart = wire.length, recovery = startExecutor(id, provider, "recover", options);
      const recovered = await recovery.receipt; assert.equal(recovered.kind, "result"); const recoveryExit = await recovery.exited; assert.equal(recoveryExit.code, 0);
      assert(worker.child.pid && recovery.child.pid); assert.notEqual(worker.child.pid, recovery.child.pid);
      processRuntime = { killedPid: worker.child.pid, recoveryPid: recovery.child.pid, killedExit: killed, recoveryExit };
      const afterRestart = (await observer.query("SELECT to_jsonb(value) AS value FROM event_outbox value WHERE id=$1", [id])).rows[0]!.value as Row;
      const segment = wire.slice(wireStart), mutations = segment.filter(request => ["POST", "PATCH", "PUT", "DELETE"].includes(request.method));
      if (processPhase === "ack-committed") { assert.equal(afterRestart.status, "completed"); assert.equal(wire.length, recoveryWireStart, "Completed ACK must remain authoritative without native replay"); }
      else if (processPhase === "before-native-send" && processFamily !== "caldavSplit") { assert.equal(mutations.length, 0, "A durable possible-notification marker cannot grant another send"); assert.notEqual(afterRestart.status, "completed"); }
      else {
        assert.equal(mutations.length, 1, "Resource proof or read-only recovery cannot duplicate an applied mutation");
        if (processFamily === "graphOccurrenceContent" && processPhase === "raw-native-response") {
          // Graph's family completion requires its acceptedAt proof. Provider
          // outcome equality alone cannot manufacture a lost durable callback.
          assert.equal(afterRestart.status, "unconfirmed"); assert.equal(afterRestart.uncertain, true); assert.equal(afterRestart.result_ref, null);
          const final = await snapshot(); assert.deepEqual(final.events, checkpointState.events); assert.deepEqual(final.external_events, checkpointState.external_events);
        } else assert.equal(afterRestart.status, "completed");
      }
      if (processPhase !== "before-native-send") assert(wire.slice(recoveryWireStart).every(request => ["GET", "PROPFIND", "REPORT"].includes(request.method)), "Recovery after an applied native response only observes scoped evidence");
      processReceipt = { family: processFamily, phase: processPhase, operationId: id, before, checkpoint, afterKill, afterRestart, checkpointState, afterKillState, finalState: await snapshot(),
        wireStart, recoveryWireStart, wireEnd: wire.length, killedSignal: killed.signal };
      resolveProcess(processReceipt); await new Promise<never>(() => {});
    } finally { if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill("SIGKILL"); await worker.exited; } }
    throw new Error("Unreachable process probe continuation");
  };
  module._load = function (request, parent, isMain) {
    let resolved: string;
    try { resolved = Reflect.apply(resolve, module, [request, parent, isMain]); } catch { return Reflect.apply(load, module, [request, parent, isMain]); }
    if (resolved !== deliveryPath || replacing) return Reflect.apply(load, module, [request, parent, isMain]);
    if (executor) return executor;
    replacing = true;
    let actual: DeliveryModule;
    try { executorSourceSha256 = createHash("sha256").update(readFileSync(label === "old" ? baseline! : deliveryPath)).digest("hex");
      actual = Reflect.apply(load, module, [label === "old" ? baseline : request, parent, isMain]) as DeliveryModule; }
    finally { replacing = false; }
    assert.equal(typeof actual.deliverEventOutbox, "function", "The fixture must invoke an actual production executor");
    executor = { ...actual, async deliverEventOutbox(...args: unknown[]) {
      let release!: () => void; const observed = new Promise<void>(resolve => { release = resolve; }); observations.add(observed);
      try {
      const id = String(args[0]); let cohort = cohorts.get(id);
      const fixtureCase = (globalThis as typeof globalThis & { __musubiEventCompatibilityFixtureCase?: string }).__musubiEventCompatibilityFixtureCase;
      if (!cohort || cohort.active === 0) { cohort = { id: cohortSequence++, active: 0, count: 0, records: [] }; cohorts.set(id, cohort); }
      cohort.active++; cohort.count++;
      const before = (await observer.query("SELECT to_jsonb(value) AS value FROM event_outbox value WHERE id=$1", [id])).rows[0]?.value as Row | undefined;
      if (before) activeRows.set(id, before);
      if (before && processEligible(before, args)) return probeProcess(before, args[2]);
      const wireStart = wire.length, returned = await actual.deliverEventOutbox(...args);
      const after = (await observer.query("SELECT to_jsonb(value) AS value FROM event_outbox value WHERE id=$1", [id])).rows[0]?.value as Row | undefined;
      const record = { id, family: before ? eventCompatibilityFamily({ provider: String(before.provider), payload: before.payload as Row }) : "unclaimed",
        ...(fixtureCase ? { fixtureCase } : {}), before: before ?? null, returned, after: after ?? null, state: await snapshot(), wireStart, wireEnd: wire.length };
      records.push(record); cohort.records.push(record); cohort.active--;
      if (!cohort.active && cohort.count > 1) {
        const final = (await observer.query("SELECT to_jsonb(value) AS value FROM event_outbox value WHERE id=$1", [id])).rows[0]?.value as Row | undefined;
        const receipt: CohortReceipt = { id: cohort.id, count: cohort.count, after: final ?? null, state: await snapshot() };
        for (const member of cohort.records) member.cohort = receipt;
      }
      return returned;
      } finally { release(); observations.delete(observed); }
    } };
    // Node's dynamic import of a CJS module can read the cache surface instead
    // of the value returned by _load. Publish the exact same wrapped exports
    // there so static and dynamic fixture imports select one actual executor.
    const cached = module._cache[deliveryPath];
    if (cached) cached.exports = executor;
    else {
      const Constructor = module as unknown as { new (id: string, parent?: { filename?: string }): { exports: unknown; loaded: boolean; filename: string } };
      const owned = new Constructor(deliveryPath, parent); owned.exports = executor; owned.loaded = true; owned.filename = deliveryPath; module._cache[deliveryPath] = owned;
    }
    return executor;
  };
  const executorGlobal = globalThis as typeof globalThis & { __musubiEventCompatibilityExecutor?: () => unknown; __musubiEventCompatibilityDrain?: () => Promise<void> };
  executorGlobal.__musubiEventCompatibilityExecutor = () => module._load(deliveryPath);
  executorGlobal.__musubiEventCompatibilityDrain = async () => { while (observations.size) await Promise.all([...observations]); };
  let failure: unknown;
  try {
    const loaded = await import(pathToFileURL(entry).href) as { eventCompatibilityFixtureDone?: Promise<unknown>; default?: { eventCompatibilityFixtureDone?: Promise<unknown> } };
    const done = loaded.eventCompatibilityFixtureDone ?? loaded.default?.eventCompatibilityFixtureDone; assert(done, "The existing fixture promise must be awaited");
    if (processFamily) {
      const result = await Promise.race([done.then(() => "fixture" as const), processDone.then(() => "process" as const)]);
      assert.equal(result, "process", "The requested real process checkpoint cannot silently disappear");
    } else { await done; assert.equal(process.exitCode ?? 0, 0, "The existing independent fixture assertions must all pass"); assert(records.length, "The fixture cannot silently omit production delivery"); }
    await Promise.all(responseBodies);
  } catch (error) { failure = error; }
  finally {
    module._load = load;
    delete executorGlobal.__musubiEventCompatibilityExecutor;
    delete executorGlobal.__musubiEventCompatibilityDrain;
    for (const child of nestedChildren) { const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited; }
    if (existingFetchDescriptor) Object.defineProperty(globalThis, "fetch", existingFetchDescriptor); else globalThis.fetch = originalFetch;
    for (const server of servers) if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await observer.end();
    for (const pool of ownedPools) if (!closedPools.has(pool)) { closedPools.add(pool); await Reflect.apply(end, pool, []); }
    pg.Pool.prototype.connect = connect; pg.Pool.prototype.end = end; pg.Client.prototype.query = originalClientQuery; http.Server.prototype.listen = listen; crypto.randomUUID = originalUuid; webcrypto.randomUUID = originalWebUuid; syncBuiltinESMExports();
  }
  const sourceSha256 = createHash("sha256").update(await readFile(entry)).digest("hex");
  const witnesses = new Map<string, EventCompatibilityWitness>();
  const hashes = require("@musubi/db") as { graphMeetingVersion: (input: unknown) => string; graphContentVersion: (input: unknown) => string };
  const hash = hashes.graphMeetingVersion;
  const collectWitnesses = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectWitnesses); return; }
    const item = value as Row, request = item.request as Row | undefined;
    let kind: EventCompatibilityWitness["kind"] | undefined, input: unknown, rawHash: unknown;
    if (request && typeof request.expectedSeriesVersion === "string" && item.context && item.baseline && item.identity) {
      kind = item.native ? "graph-content" : "graph-cancellation";
      input = { context: item.context, baseline: item.baseline, identity: item.identity, ...(item.native ? { native: item.native } : {}), ...(item.nativeExceptions ? { nativeExceptions: item.nativeExceptions } : {}) }; rawHash = request.expectedSeriesVersion;
    } else if (request && typeof request.expectedVersion === "string" && item.initial) { kind = "graph-move"; input = item.initial; rawHash = request.expectedVersion; }
    if (kind) {
      const compute = kind === "graph-content" ? hashes.graphContentVersion : hash;
      const recomputedRawHash = compute(input); assert.equal(rawHash, recomputedRawHash, "A raw admitted Graph witness must equal its actual production hash function(input); altered witnesses cannot be normalized away");
      if (kind === "graph-move") {
        const initial = input as Row;
        const content = { context: initial.context, baseline: initial.baseline, identity: initial.identity, native: initial.native, ...(initial.nativeExceptions ? { nativeExceptions: initial.nativeExceptions } : {}) };
        const recomputed = hashes.graphContentVersion(content); assert.equal(initial.version, recomputed);
        witnesses.set(recomputed, { kind: "graph-content", input: content, rawHash: recomputed, recomputedRawHash: recomputed, normalizedHash: hashes.graphContentVersion(eventCompatibilityNormalizedWitnessInput(content)) });
      }
      witnesses.set(rawHash as string, { kind, input, rawHash: rawHash as string, recomputedRawHash, normalizedHash: compute(eventCompatibilityNormalizedWitnessInput(input)) });
    }
    Object.values(item).forEach(collectWitnesses);
  };
  try { collectWitnesses({ records, processReceipt }); } catch (error) { failure ??= error; }
  const serializerClocks = new Map<string, EventCompatibilitySerializerClock>();
  const serializer = require("./adapters/caldav_organizer") as { caldavOrganizerDesired: (...args: unknown[]) => unknown };
  const collectSerializerClock = (row: Row | null | undefined) => {
    if (!row || row.provider !== "caldav") return;
    const intent = (row.payload as Row | undefined)?.organizer as Row | undefined, request = intent?.request as Row | undefined, desired = intent?.desired as Row | undefined;
    if (!request || request.provider !== "caldav" || !desired) return;
    const collection = row.external_calendar_id ?? row.externalCalendarID;
    const rebuilt = serializer.caldavOrganizerDesired(collection, request, intent!.baseline, desired.proof, desired.stamp);
    assert.deepEqual(rebuilt, desired, "Only the actual production serializer's exact saved desired resource can establish generated-clock provenance");
    assert.equal(typeof desired.data, "string"); assert.equal(typeof desired.stamp, "string"); assert.equal(typeof desired.id, "string"); assert.equal(typeof desired.iCalUID, "string");
    const proof: EventCompatibilitySerializerClock = { operationId: String(row.id), resourceUrl: desired.id as string, uid: desired.iCalUID as string, stamp: desired.stamp as string,
      desiredResource: desired.data as string, resourceSha256: createHash("sha256").update(desired.data as string).digest("hex"), serializer: "caldavOrganizerDesired", verified: true,
      generatedProperty: request.action === "create" || desired.rescheduled === true };
    const previous = serializerClocks.get(proof.operationId); if (previous) assert.deepEqual(proof, previous); serializerClocks.set(proof.operationId, proof);
  };
  try {
    for (const record of records) { collectSerializerClock(record.before); collectSerializerClock(record.after); collectSerializerClock(record.returned as Row | null); for (const row of record.state.event_outbox ?? []) collectSerializerClock(row); }
    if (processReceipt) { for (const row of [processReceipt.before, processReceipt.checkpoint, processReceipt.afterKill, processReceipt.afterRestart]) collectSerializerClock(row);
      for (const state of [processReceipt.checkpointState, processReceipt.afterKillState, processReceipt.finalState]) for (const row of state.event_outbox ?? []) collectSerializerClock(row); }
  } catch (error) { failure ??= error; }
  const alarmWitnesses = new Map<string, EventCompatibilityAlarmWitness>();
  const alarmVersion = (require("@musubi/db") as { caldavAlarmVersion: (context: unknown, before: string) => string }).caldavAlarmVersion;
  const collectAlarmWitness = (row: Row | null | undefined) => {
    if (!row || row.provider !== "caldav") return;
    const payload = row.payload as Row | undefined, intent = payload?.caldavAlarm as { context: Parameters<typeof eventCompatibilityAlarmWitnessInput>[0]; before: string; request: { expectedStateVersion: string } } | undefined;
    if (!intent) return;
    const input = eventCompatibilityAlarmWitnessInput(intent.context, intent.before), rawHash = intent.request.expectedStateVersion, recomputedRawHash = alarmVersion(intent.context, intent.before);
    assert.equal(rawHash, recomputedRawHash, "Actual production CalDAV alarm hash must prove its complete raw admission input");
    assert.equal(eventCompatibilityDataHash(input), rawHash, "Independently prove the exact seven-element raw producer tuple");
    const resolution = payload?.resolution as { expectedReminderStateVersion?: string } | undefined;
    if (resolution?.expectedReminderStateVersion !== undefined) assert.equal(resolution.expectedReminderStateVersion, rawHash, "Copied resolution witness must equal this exact current alarm admission");
    const normalized = eventCompatibilityNormalizedAlarmWitnessInput(input, origins);
    const context = { ...intent.context, mapping: { ...intent.context.mapping, ref: { ...intent.context.mapping.ref, externalEventId: normalized[2] } } };
    const normalizedHash = alarmVersion(context, intent.before); assert.equal(eventCompatibilityDataHash(normalized), normalizedHash);
    const proof = { operationId: String(row.id), input, rawHash, recomputedRawHash, normalizedHash };
    const previous = alarmWitnesses.get(proof.operationId); if (previous) assert.deepEqual(proof, previous); alarmWitnesses.set(proof.operationId, proof);
  };
  try {
    for (const record of records) { collectAlarmWitness(record.before); collectAlarmWitness(record.after); collectAlarmWitness(record.returned as Row | null); for (const row of record.state.event_outbox ?? []) collectAlarmWitness(row); }
    if (processReceipt) { for (const row of [processReceipt.before, processReceipt.checkpoint, processReceipt.afterKill, processReceipt.afterRestart]) collectAlarmWitness(row);
      for (const state of [processReceipt.checkpointState, processReceipt.afterKillState, processReceipt.finalState]) for (const row of state.event_outbox ?? []) collectAlarmWitness(row); }
  } catch (error) { failure ??= error; }
  const productionEnd = await eventCompatibilityProductionFingerprint(root), sourceStable = productionStart.sha256 === productionEnd.sha256;
  const harnessEnd = await eventCompatibilityHarnessFingerprint(root), harnessStable = harnessEnd.sha256 === harnessManifest.sha256;
  await writeFile(output, JSON.stringify({ schemaVersion: 1, label, sourceSha256, harnessSha256, harnessManifest, harnessEnd, harnessStable, executorSourceSha256, productionStart, productionEnd, sourceStable,
    records, wire, relayWire, origins, witnesses: [...witnesses.values()], serializerClocks: [...serializerClocks.values()], alarmWitnesses: [...alarmWitnesses.values()], echoObservations, ...(processReceipt ? { processReceipt, processRuntime, processTransport } : {}), ownedPoolsClosed: ownedPools.size, passed: failure === undefined }, null, 2));
  if (!sourceStable && process.env.MUSUBI_EVENT_COMPATIBILITY_ALLOW_INTERMEDIATE !== "1") throw new Error("Production source changed during this fixture; receipt is intermediate, not final acceptance");
  if (!harnessStable && process.env.MUSUBI_EVENT_COMPATIBILITY_ALLOW_INTERMEDIATE !== "1") throw new Error("Fixture or harness source changed during this fixture; receipt is intermediate, not final acceptance");
  if (failure) throw failure;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
