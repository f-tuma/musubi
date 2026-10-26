import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { deliverReferenceOperation, type ReferenceRunnerStore } from "./runner.js";
import { REFERENCE_GRAPH_CREATE_PROFILE } from "./admission.js";
import type { ReferenceClaim, ReferenceGraphCreateObservation } from "./model.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const content = { name: "Same native identity", notes: "Synthetic notes", place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" };
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  const adminURL = process.env.REFERENCE_DATABASE_URL; assert.ok(adminURL, "An explicit disposable reference admin database is required");
  const name = referenceTestDatabaseName("reference_cross_account_"), url = new URL(adminURL); url.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminURL, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  console.log(JSON.stringify({ fixture: { database: name, boundary: "paired-independent-reference" } }));
  const pool = new Pool({ connectionString: url.href, max: 5 }), store = new ReferenceStore(pool, "ab".repeat(32));
  const calendarId = "same-native-calendar", eventId = "same-native-event", etag = 'W/"same-native-version"';
  type Account = { connectionId: string; objectId: string; bindingId: string; operationId: string; token: string; owner: string; writable: boolean; native: Record<string, unknown> | null; methods: string[]; metrics: number };
  const accounts = new Map<string, Account>(); let fixtureFailure: unknown;
  const server = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, ""), a = token ? accounts.get(token) : undefined; assert.ok(a, "Only closed synthetic sessions are allowed");
      a.methods.push(req.method!); const target = new URL(req.url!, "http://closed.test"), collection = `/v1.0/me/calendars/${calendarId}/events`;
      if (target.pathname === "/v1.0/me") return json({ id: a.owner, mail: `${a.owner}@example.test`, userPrincipalName: `${a.owner}@example.test` });
      if (target.pathname === `/v1.0/me/calendars/${calendarId}`) return json({ id: calendarId, canEdit: a.writable, owner: { address: `${a.owner}@example.test` } });
      assert.equal(target.pathname, collection);
      if (req.method === "POST") {
        assert.equal(a.writable, true); assert.equal(a.native, null, "No second POST is permitted for one admitted operation");
        let bytes = ""; for await (const chunk of req) bytes += chunk; const parsedBody = JSON.parse(bytes);
        assert.ok(parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)); const body = parsedBody as Record<string, unknown>;
        const operation = await store.inspectOperation(a.operationId), plan = (operation.payload as { operationEnvelope: { nativePlan: { data: { body: unknown } } } }).operationEnvelope.nativePlan.data.body;
        assert.deepEqual(body, plan); assert.equal(body.transactionId, a.operationId); assert.equal(Object.hasOwn(body, "id"), false);
        a.native = { ...body, id: eventId, "@odata.etag": etag, type: "singleInstance", isCancelled: false, isOrganizer: true,
          isDraft: false, isAllDay: false, recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null };
        return json({ id: eventId, "@odata.etag": etag }, 201);
      }
      assert.equal(req.method, "GET"); assert.ok(req.headers.prefer?.includes('outlook.body-content-type="text"'));
      return json({ value: a.native ? [a.native] : [] });
    } catch (error) { fixtureFailure = error; return json({ error: "Owned cross-account fixture failed" }, 500); }
  });
  const gates: ReturnType<typeof deferred>[] = [], activeRuns: Promise<unknown>[] = [];
  try {
    await store.migrate(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ports = { http: { fetch: async (input: string, init: RequestInit) => {
      const target = new URL(input); assert.equal(target.origin, "https://graph.microsoft.com");
      const response = await fetch(`${origin}${target.pathname}${target.search}`, init);
      // The closed transport preserves the requested native response identity;
      // actual provider redirect and scoped-URL guards remain enabled.
      Object.defineProperty(response, "url", { value: target.href }); return response;
    } },
      clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record() {} } };
    async function seed(label: string, writable = true) {
      const id = randomUUID(), a: Account = { connectionId: `cross:${label}:${id}`, objectId: `object:${id}`, bindingId: `binding:${id}`, operationId: randomUUID(),
        token: `synthetic-token:${id}`, owner: `owner-${label}-${id}`, writable, native: null, methods: [], metrics: 0 };
      accounts.set(a.token, a);
      await store.seedGraphCreateBinding({ provider: "microsoft", endpointProfile: REFERENCE_GRAPH_CREATE_PROFILE, connectionId: a.connectionId,
        objectId: a.objectId, bindingId: a.bindingId, calendarId, operationId: a.operationId, accessToken: a.token, scope: "Calendars.ReadWrite", expiresAt: "2099-01-01T00:00:00.000Z", content });
      await store.admitGraphCreate({ bindingId: a.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: a.operationId }); return a;
    }
    const a = await seed("a"), b = await seed("b"), entered = deferred(), release = deferred(); gates.push(release);
    const claims = new Map<string, ReferenceClaim>(), observations = new Map<string, ReferenceGraphCreateObservation>();
    const actual: ReferenceRunnerStore = new Proxy(store, { get(target, key) {
      if (key === "claim") return async (...args: Parameters<ReferenceStore["claim"]>) => { const claim = await target.claim(...args); if (claim) claims.set(claim.operationId, claim); return claim; };
      if (key === "completeGraphCreate") return async (claim: ReferenceClaim, observation: ReferenceGraphCreateObservation, signal?: AbortSignal) => {
        observations.set(claim.operationId, structuredClone(observation)); if (observations.size === 2) entered.resolve();
        await release.promise; signal?.throwIfAborted(); return target.completeGraphCreate(claim, observation, signal);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const deliveries = [a, b].map(account => deliverReferenceOperation(actual, account.operationId,
      { ...ports, telemetry: { record() { account.metrics++; } } }, { deadlineMs: 10_000 }));
    activeRuns.push(...deliveries);
    const timer = setTimeout(() => { release.resolve(); }, 9000);
    try {
      await Promise.race([entered.promise, Promise.all(deliveries).then(results => {
        throw new Error(`Graph completions missing: ${JSON.stringify({ results: results.map(result => ({ status: result.status, code: result.code })),
          methods: [a.methods, b.methods], fixtureFailure: fixtureFailure instanceof Error ? fixtureFailure.message : undefined })}`);
      })]);
      const claimA = claims.get(a.operationId)!, claimB = claims.get(b.operationId)!, observationA = observations.get(a.operationId)!, observationB = observations.get(b.operationId)!;
      assert.equal(observationA.eventId, observationB.eventId); assert.equal(observationA.etag, observationB.etag); assert.deepEqual(observationA.projection, observationB.projection);
      assert.notEqual(observationA.correlation.operationId, observationB.correlation.operationId);
      const snapshot = async () => ({ a: await store.inspectOperation(a.operationId), b: await store.inspectOperation(b.operationId),
        attempts: (await pool.query("SELECT id,operation_id,receipt,create_candidate_id,create_acceptance_status FROM reference_attempts WHERE operation_id=ANY($1::text[]) ORDER BY id", [[a.operationId, b.operationId]])).rows });
      const before = await snapshot(), foreignClaim = { ...claimA, attemptId: claimB.attemptId };
      await assert.rejects(store.recordGraphCreateEvidence(foreignClaim, { provider: "accepted", candidateEventId: eventId,
        createAcceptance: { status: 201, validator: etag }, remote: "confirmed", observationId: "foreign-receipt" }), /attempt-missing/);
      assert.equal(await store.completeGraphCreate(foreignClaim, observationA), false);
      await assert.rejects(store.completeGraphCreate(claimA, observationB), /observation-conflict/);
      assert.deepEqual(await snapshot(), before, "Foreign receipt/adoption/ACK cannot partially mutate either owner");
      release.resolve(); const results = await Promise.all(deliveries); assert.ok(results.every(result => result.status === "acked"));
      for (const account of [a, b]) { const operation = await store.inspectOperation(account.operationId); assert.equal(operation.status, "acked");
        assert.equal(operation.binding.destinationLifecycle, "present"); assert.equal(operation.binding.sourceGeneration, 2); assert.equal(operation.graphCreate?.bindingEventId, eventId);
        assert.equal(operation.receipt.operationId, account.operationId); const local = operation.receipt.local;
        assert.ok(local.kind === "committed"); assert.equal(local.hostObjectId, account.objectId);
        assert.deepEqual(account.methods, ["GET", "GET", "POST", "GET"]); assert.equal(account.metrics, account.methods.length); }
      const bindings = (await pool.query("SELECT connection_id,calendar_id,event_id FROM reference_bindings WHERE id=ANY($1::text[]) ORDER BY connection_id", [[a.bindingId, b.bindingId]])).rows;
      assert.equal(bindings.length, 2); assert.ok(bindings.every(row => row.calendar_id === calendarId && row.event_id === eventId)); assert.notEqual(bindings[0].connection_id, bindings[1].connection_id);
    } finally { clearTimeout(timer); release.resolve(); await Promise.allSettled(deliveries); }
    const denied = await seed("denied", false), healthy = await seed("healthy");
    const rightsRuns = [denied, healthy].map(account => deliverReferenceOperation(store, account.operationId,
      { ...ports, telemetry: { record() { account.metrics++; } } }, { deadlineMs: 10_000 }));
    activeRuns.push(...rightsRuns); const rights = await Promise.all(rightsRuns);
    assert.equal(rights[0]!.status, "hold"); assert.equal(rights[1]!.status, "acked"); assert.equal(denied.methods.includes("POST"), false);
    assert.equal(healthy.methods.filter(method => method === "POST").length, 1); assert.equal((await store.inspectOperation(denied.operationId)).binding.destinationLifecycle, "reserved");
    assert.equal(fixtureFailure, undefined);
    console.log(JSON.stringify({ schemaVersion: 1, suite: "reference-cross-account", results: [
      { id: "paired-identical-native-locators-foreign-receipt-adoption-ack", status: "passed" }, { id: "denied-a-does-not-authorize-or-block-b", status: "passed" }], liveProvider: false }));
  } finally {
    for (const gate of gates) gate.resolve(); await Promise.allSettled(activeRuns); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end();
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].count, 0);
    await admin.query(`DROP DATABASE "${name}"`); assert.equal((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount, 0);
    console.log(JSON.stringify({ cleanup: { database: name, sessionsBeforeDrop: 0, plainDrop: true, databaseAbsent: true } })); await admin.end();
  }
}
await main();
