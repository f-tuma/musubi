import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { REFERENCE_GRAPH_CREATE_PROFILE } from "./admission.js";
import type { ReferenceGraphCreateAdmission } from "./model.js";

const key = "ab".repeat(32), token = "synthetic-graph-create-process-token", weak = 'W/"readback-version"';
const content = { name: "Immutable Graph CREATE", notes: " Exact notes ", place: " Room ", beginsAt: "2026-10-25T08:00:00.123Z", endsAt: "2026-10-25T09:00:00.456Z" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deferred = () => { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); assert(adminUrl, "Disposable independent DB required");
  const name = referenceTestDatabaseName("reference_graph_create_process_"), database = new URL(adminUrl); database.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: database.href, max: 4 }), store = new ReferenceStore(pool, key), children = new Set<ChildProcess>();
  let calendarId = "", nativeId = "", operationId = "", mode = "healthy", writes = 0, methods: string[] = [], errors: unknown[] = [], metrics = 0, textPreferences = 0;
  let remote: Record<string, unknown> | null = null, acceptanceValidator: string | null = "raw-response-not-conditional";
  const event = (body: Record<string, unknown>) => ({ ...body, id: nativeId, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false,
    recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null, "@odata.etag": mode === "null-validator" ? null : weak });
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method!); assert.equal(req.headers.authorization, `Bearer ${token}`);
      const url = new URL(req.url!, "http://owned.test"), collection = `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`;
      const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/v1.0/me") return json({ id: "native-self", mail: "owner@example.test", userPrincipalName: "owner@example.test" });
      if (url.pathname === `/v1.0/me/calendars/${encodeURIComponent(calendarId)}`) return json({ id: calendarId, canEdit: mode !== "calendar-denied", owner: { address: mode === "foreign-owner" ? "other@example.test" : "OWNER@example.test" } });
      assert.equal(url.pathname, collection, "CREATE recovery always lists the complete captured collection, never guessed-ID GET");
      if (req.method === "POST") {
        writes++; let bytes = ""; for await (const chunk of req) bytes += chunk;
        const op = await store.inspectOperation(operationId), body = (op.payload as { operationEnvelope: { nativePlan: { data: { body: Record<string, unknown> } } } }).operationEnvelope.nativePlan.data.body;
        assert.equal(bytes, JSON.stringify(body)); assert.equal(body.transactionId, operationId); assert.equal(Object.hasOwn(body, "id"), false); assert.equal(req.headers["if-match"], undefined); assert.equal(req.headers["if-none-match"], undefined);
        if (mode === "reject") { res.setHeader("retry-after", "9"); return json({}, 429); }
        assert.equal(remote, null, "One admitted operation cannot POST another native resource");
        if (mode !== "lost-not-applied") remote = event(body);
        if (["lost", "lost-not-applied"].includes(mode)) return res.destroy();
        return json({ id: nativeId, "@odata.etag": acceptanceValidator }, 201);
      }
      assert.equal(req.method, "GET");
      assert.equal(url.searchParams.get("$select")?.includes("@odata.etag") ?? false, false, "ETag is an annotation, not a selectable property");
      const wantsText = req.headers.prefer?.includes('outlook.body-content-type="text"') === true; if (wantsText) textPreferences++;
      const page = url.searchParams.get("page"); if (page === "2" && mode === "partial-denied") return json({}, 403);
      let observed: Record<string, unknown> | null = remote ? { ...remote } : null;
      if (observed) {
        if (!wantsText || mode === "html-despite-prefer") observed.body = { contentType: "html", content: "<p>Exact notes</p>" };
        if (mode === "wrong-marker") observed.transactionId = "other-operation";
        if (mode === "changed-content") observed.subject = "Different remote content";
        if (mode === "recurring") observed.recurrence = { pattern: { type: "daily", interval: 1 } };
        if (mode === "attendee") observed.attendees = [{ emailAddress: { address: "guest@example.test" } }];
        if (mode === "all-day") observed.isAllDay = true;
        if (mode === "cancelled") observed.isCancelled = true;
        if (mode === "strong-validator") observed["@odata.etag"] = '"not-a-native-weak-version"';
      }
      if (["partial-denied", "paged-duplicate"].includes(mode) && page !== "2") return json({ value: observed ? [observed] : [], "@odata.nextLink": `https://graph.microsoft.com${collection}?page=2` });
      if (mode === "paged-success" && page !== "2") return json({ value: [], "@odata.nextLink": `https://graph.microsoft.com${collection}?page=2` });
      const values = observed ? [observed] : [];
      if (mode === "duplicate" && observed) values.push({ ...observed, id: "second-native-id" });
      if (mode === "paged-duplicate" && observed) return json({ value: [{ ...observed, id: "second-native-id" }] });
      return json({ value: values });
    } catch (error) { errors.push(error); res.statusCode = 500; res.end("Owned Graph CREATE fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  function child(action: "admit-graph-create" | "deliver" | "show", admission?: ReferenceGraphCreateAdmission, pause?: string) {
    const checkpoint = deferred(); let stdout = "", stderr = "";
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./process_fixture.child.ts", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"] }); children.add(proc);
    const timer = setTimeout(() => { checkpoint.reject(new Error("Owned Graph CREATE process timeout")); proc.kill("SIGKILL"); }, 30_000);
    proc.stdout!.on("data", value => stdout += value); proc.stderr!.on("data", value => stderr += value); proc.on("message", (message: any) => { if (message.type === "checkpoint") checkpoint.resolve(); if (message.type === "metric") metrics++; });
    const exited = once(proc, "exit").then(([code, signal]) => { clearTimeout(timer); children.delete(proc); return { code, signal, stdout, stderr }; });
    proc.stdin!.end(JSON.stringify({ action, operationId, admission, pause, fixtureOrigin: origin })); return { proc, checkpoint: checkpoint.promise, exited };
  }
  async function run(action: "admit-graph-create" | "deliver" | "show", admission?: ReferenceGraphCreateAdmission) {
    const result = await child(action, admission).exited; assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); assert.equal((result.stdout + result.stderr).includes(token), false); return JSON.parse(result.stdout);
  }
  async function kill(value: ReturnType<typeof child>) { await value.checkpoint; value.proc.kill("SIGKILL"); assert.equal((await value.exited).signal, "SIGKILL"); }
  const expire = () => pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [operationId]);
  async function fixture(label: string, body: (input: ReferenceGraphCreateAdmission, ids: { connectionId: string; objectId: string; bindingId: string }) => Promise<void>) {
    mode = "healthy"; writes = 0; methods = []; errors = []; metrics = 0; textPreferences = 0; remote = null; acceptanceValidator = "raw-response-not-conditional";
    const id = randomUUID(), ids = { connectionId: `graph-create-connection:${id}`, objectId: `graph-create-object:${id}`, bindingId: `graph-create-binding:${id}` }; calendarId = `calendar/${id}+id`; nativeId = `assigned/${id}+id`; operationId = randomUUID();
    await store.seedGraphCreateBinding({ ...ids, provider: "microsoft", endpointProfile: REFERENCE_GRAPH_CREATE_PROFILE, calendarId, operationId, accessToken: token, expiresAt: "2099-01-01T00:00:00.000Z", scope: "Calendars.ReadWrite", content });
    const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId }; await body(input, ids); assert.deepEqual(errors, []); assert.equal(metrics, methods.length); console.log(`Reference Graph CREATE process: ${label}: PASS`);
  }
  async function ack(provider: "accepted" | "uncertain") {
    const op = await store.inspectOperation(operationId); assert.equal(op.status, "acked"); assert.equal(op.binding.destinationLifecycle, "present"); assert.equal(op.binding.sourceGeneration, 2); assert.equal(op.graphCreate?.bindingEventId, nativeId); assert.equal(op.graphCreate?.candidateEventId, nativeId); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.receipt.remote.kind, "confirmed");
    assert.equal((await pool.query("SELECT event_id FROM reference_operations WHERE id=$1", [operationId])).rows[0].event_id, null); assert.equal((op.payload as { operationEnvelope: { locator: { resourceId: unknown } } }).operationEnvelope.locator.resourceId, null); assert(textPreferences > 0); return op;
  }
  try {
    await store.migrate();
    await fixture("SIGKILL-inside-admission-rolls-back-revision-and-intent", async (input, ids) => { await kill(child("admit-graph-create", input, "admissionCanonical")); assert.equal((await pool.query("SELECT revision FROM reference_objects WHERE id=$1", [ids.objectId])).rows[0].revision, "1"); assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1", [operationId])).rows[0].count, "0"); await run("admit-graph-create", input); await run("deliver"); await ack("accepted"); assert.equal(writes, 1); });
    for (const phase of ["afterAdmission", "claim", "afterAcceptance", "afterUncertain", "afterReadback", "afterAck"]) await fixture(`SIGKILL-restart-${phase}`, async input => {
      if (phase === "afterAdmission") await kill(child("admit-graph-create", input, phase)); else { await run("admit-graph-create", input); if (phase === "afterUncertain") mode = "lost"; await kill(child("deliver", undefined, phase)); }
      const pinned = hash((await store.inspectOperation(operationId)).payload), start = methods.length; mode = "healthy"; await expire(); await run("deliver"); assert.equal(hash((await ack(phase === "afterUncertain" ? "uncertain" : "accepted")).payload), pinned); assert.equal(writes, 1);
      if (["afterAcceptance", "afterUncertain", "afterReadback"].includes(phase)) assert.deepEqual(methods.slice(start), ["GET"]); if (phase === "afterAck") assert.deepEqual(methods.slice(start), []);
    });
    await fixture("SIGKILL-before-HTTP-keeps-permanent-marker-and-missing-listing-never-reposts", async input => { await run("admit-graph-create", input); await kill(child("deliver", undefined, "beforeDispatch")); assert.equal(writes, 0); assert.equal((await store.inspectOperation(operationId)).dispatchPossible, true); await expire(); const start = methods.length; assert.equal((await run("deliver")).status, "hold"); assert.deepEqual(methods.slice(start), ["GET"]); assert.equal(writes, 0); });
    await fixture("uncertain-candidate-persisted-before-SIGKILL-cannot-adopt-another-unique-ID", async input => { await run("admit-graph-create", input); mode = "lost"; await kill(child("deliver", undefined, "afterReadback")); const op = await store.inspectOperation(operationId); assert.equal(op.receipt.provider.kind, "uncertain"); assert.equal(op.graphCreate?.candidateEventId, nativeId); assert.equal(op.graphCreate?.acceptanceStatus, null); assert(remote); remote.id = "different-unique-id"; mode = "healthy"; await expire(); const start = methods.length; assert.equal((await run("deliver")).status, "conflict"); assert.deepEqual(methods.slice(start), ["GET"]); assert.equal(writes, 1); assert.equal((await store.inspectOperation(operationId)).graphCreate?.candidateEventId, nativeId); });
    await fixture("lost-applied-reply-confirms-by-complete-listing-without-new-POST", async input => { await run("admit-graph-create", input); mode = "lost"; assert.equal((await run("deliver")).status, "acked"); const op = await ack("uncertain"); assert.equal(op.graphCreate?.acceptanceStatus, null); assert.equal(writes, 1); });
    await fixture("lost-unapplied-reply-remains-HOLD-after-repeated-complete-empty-listings", async input => { await run("admit-graph-create", input); mode = "lost-not-applied"; assert.equal((await run("deliver")).status, "hold"); mode = "healthy"; for (let i = 0; i < 2; i++) { await expire(); const start = methods.length; assert.equal((await run("deliver")).status, "hold"); assert.deepEqual(methods.slice(start), ["GET"]); } assert.equal(writes, 1); assert.equal((await store.inspectOperation(operationId)).binding.destinationLifecycle, "reserved"); });
    await fixture("429-delay-and-reference-one-shot-hold-do-not-adopt-a-later-resource", async input => { await run("admit-graph-create", input); mode = "reject"; assert.equal((await run("deliver")).status, "hold"); assert.equal(await store.claim(operationId, randomUUID()), null); mode = "healthy"; await expire(); assert.equal((await run("deliver")).status, "hold"); const op = await store.inspectOperation(operationId), body = (op.payload as { operationEnvelope: { nativePlan: { data: { body: Record<string, unknown> } } } }).operationEnvelope.nativePlan.data.body; remote = event(body); await expire(); assert.equal((await run("deliver")).status, "hold"); assert.equal(writes, 1); assert.equal((await store.inspectOperation(operationId)).graphCreate?.bindingEventId, null); assert.equal((await store.inspectOperation(operationId)).receipt.provider.kind, "rejected"); });
    for (const unsupported of ["duplicate", "paged-duplicate", "partial-denied", "wrong-marker", "changed-content", "recurring", "attendee", "all-day", "cancelled", "strong-validator", "html-despite-prefer"]) await fixture(`accepted-${unsupported}-keeps-native-facts-without-ACK`, async input => { await run("admit-graph-create", input); mode = unsupported; assert.notEqual((await run("deliver")).status, "acked"); assert.equal(writes, 1); const op = await store.inspectOperation(operationId); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.graphCreate?.candidateEventId, nativeId); assert.equal(op.graphCreate?.acceptanceStatus, 201); assert.equal(op.graphCreate?.acceptanceValidator, acceptanceValidator); assert.equal(op.receipt.provider.kind, "accepted"); });
    for (const denied of ["foreign-owner", "calendar-denied"]) await fixture(`fresh-${denied}-cannot-POST`, async input => { await run("admit-graph-create", input); mode = denied; assert.equal((await run("deliver")).status, "hold"); assert.equal(writes, 0); });
    for (const positive of ["null-validator", "paged-success", "lossless-raw-acceptance"]) await fixture(`fresh-${positive}-uses-complete-plain-text-correlation`, async input => { await run("admit-graph-create", input); mode = positive; if (positive === "lossless-raw-acceptance") acceptanceValidator = "NUL\0raw\ud800metadata"; await run("deliver"); const op = await ack("accepted"); assert.equal(op.graphCreate?.acceptanceValidator, acceptanceValidator); assert.equal(op.binding.etag, positive === "null-validator" ? null : weak); assert.equal(writes, 1); const start = methods.length; assert.equal((await run("deliver")).status, "unclaimed"); assert.equal(methods.length, start); });
    await fixture("native-ID-scope-collision-after-acceptance-refuses-partial-adoption", async (input, ids) => { await run("admit-graph-create", input); await kill(child("deliver", undefined, "afterAcceptance")); const objectId = `occupied-object:${randomUUID()}`; await pool.query("INSERT INTO reference_objects(id,content) VALUES($1,$2)", [objectId, content]); await pool.query("INSERT INTO reference_bindings(id,connection_id,object_id,calendar_id,event_id,etag,baseline) VALUES($1,$2,$3,$4,$5,$6,$7)", [`occupied-binding:${randomUUID()}`, ids.connectionId, objectId, calendarId, nativeId, weak, {}]); await expire(); assert.equal((await run("deliver")).status, "hold"); const op = await store.inspectOperation(operationId); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.graphCreate?.bindingEventId, null); assert.equal(op.graphCreate?.candidateEventId, nativeId); assert.equal(writes, 1); });
    await fixture("connection-ABA-after-native-acceptance-keeps-evidence-and-blocks-ACK", async (input, ids) => { await run("admit-graph-create", input); await kill(child("deliver", undefined, "afterAcceptance")); await store.changeConnection(ids.connectionId, { status: "retired" }); await store.changeConnection(ids.connectionId, { status: "active" }); await expire(); const start = methods.length; assert.equal((await run("deliver")).status, "hold"); assert.deepEqual(methods.slice(start), []); assert.equal((await store.inspectOperation(operationId)).graphCreate?.candidateEventId, nativeId); assert.equal((await store.inspectOperation(operationId)).binding.destinationLifecycle, "reserved"); assert.equal(writes, 1); });
    await fixture("standalone-Graph-CREATE-CLI-needs-only-reference-configuration", async () => {
      const cli = async (command: string, body: unknown) => { const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), command], { env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] }); children.add(proc); let output = "", error = ""; proc.stdout!.on("data", x => output += x); proc.stderr!.on("data", x => error += x); proc.stdin!.end(JSON.stringify(body)); const [code] = await once(proc, "exit"); children.delete(proc); assert.equal(code, 0, error); assert.equal(output.includes(token), false); return JSON.parse(output); };
      const id = randomUUID(), operationId = randomUUID(), bindingId = `cli-binding:${id}`; await cli("seed-graph-create", { provider: "microsoft", endpointProfile: REFERENCE_GRAPH_CREATE_PROFILE, connectionId: `cli-connection:${id}`, objectId: `cli-object:${id}`, bindingId, calendarId, operationId, accessToken: token, scope: "Calendars.ReadWrite", expiresAt: "2099-01-01T00:00:00.000Z", content }); const admitted = await cli("admit-graph-create", { bindingId, expectedRevision: 1, commandId: randomUUID(), operationId }); assert.equal(admitted.binding.destinationLifecycle, "reserved"); assert.equal((await cli("show", { operationId })).graphCreate.bindingEventId, null);
    });
    console.log("Reference Graph CREATE independent process/HTTP/PostgreSQL proof: PASS");
  } finally { for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => once(child, "exit").catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
