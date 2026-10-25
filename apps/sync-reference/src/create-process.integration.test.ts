import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { referenceCreateEventID } from "./admission.js";
import type { ReferenceCreateAdmission, ReferenceContent, ReferenceAdmission } from "./model.js";

const key = "ab".repeat(32), content: ReferenceContent = { name: "Immutable synthetic CREATE", notes: " Exact notes ", place: "Room", beginsAt: "2026-10-24T08:00:00.123Z", endsAt: "2026-10-24T09:00:00.456Z" };
const scope = "https://www.googleapis.com/auth/calendar.events";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deferred = () => { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
  assert(adminUrl, "Disposable independent DB required");
  const name = `reference_create_process_${randomUUID().replace(/-/g, "")}`, database = new URL(adminUrl); database.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: database.href, max: 4 }), store = new ReferenceStore(pool, key), children = new Set<ChildProcess>();
  let calendarId = "", eventId = "", operationId = "", mode = "healthy", writes = 0, methods: string[] = [], failures: unknown[] = [], metrics = 0;
  let remote: Record<string, unknown> | null = null, postBodies: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method!); assert.equal(req.headers.authorization, "Bearer synthetic-process-token");
      const url = new URL(req.url!, "http://owned.test"), collection = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url.pathname === `/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`) return json({ id: calendarId, accessRole: "owner" });
      if (req.method === "GET") {
        assert.equal(url.pathname, `${collection}/${eventId}`);
        if (mode === "gone") return json({}, 410);
        if (!remote) return json({}, 404);
        if (mode === "foreign-marker") return json({ ...remote, extendedProperties: { private: { musubiOperationID: randomUUID() } } });
        if (mode === "changed-content") return json({ ...remote, summary: "Different remote content" });
        if (mode === "weak") return json({ ...remote, etag: 'W/"weak"' });
        if (mode === "cancelled") return json({ ...remote, status: "cancelled" });
        return json(remote);
      }
      if (req.method === "PATCH" || req.method === "DELETE") {
        assert.equal(url.pathname, `${collection}/${eventId}`); assert(remote);
        assert.equal(req.headers["if-match"], remote.etag);
        if (req.method === "DELETE") { remote = null; res.writeHead(204); return res.end(); }
        let bytes = ""; for await (const chunk of req) bytes += chunk;
        const admitted = await store.inspectOperation(operationId), body = (admitted.payload as { operationEnvelope: { nativePlan: { data: { body: Record<string, unknown> } } } }).operationEnvelope.nativePlan.data.body;
        assert.equal(bytes, JSON.stringify(body)); remote = { ...remote, ...body, etag: '"updated"' }; return json(remote);
      }
      assert.equal(req.method, "POST"); assert.equal(url.pathname, collection); writes++;
      let bytes = ""; for await (const chunk of req) bytes += chunk; postBodies.push(bytes);
      const admitted = await store.inspectOperation(operationId), body = (admitted.payload as { operationEnvelope: { nativePlan: { data: { body: Record<string, unknown> } } } }).operationEnvelope.nativePlan.data.body;
      assert.equal(bytes, JSON.stringify(body), "Every POST uses the originally admitted JSON bytes");
      assert.equal(body.id, eventId); assert.deepEqual(body.extendedProperties, { private: { musubiOperationID: operationId } });
      assert.equal(req.headers["if-match"], undefined); assert.equal(req.headers["if-none-match"], undefined);
      if (mode === "reject") { res.setHeader("retry-after", "9"); return json({}, 429); }
      if (remote || mode === "collision") return json({}, 409);
      remote = { ...body, etag: '"created"', status: "confirmed", eventType: "default", organizer: { self: true } };
      if (mode === "lost") return res.destroy();
      return json(remote, 201);
    } catch (error) { failures.push(error); res.statusCode = 500; res.end("Owned CREATE fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  type Action = "admit-create" | "admit" | "admit-delete" | "deliver" | "show";
  function child(action: Action, admission?: ReferenceCreateAdmission | ReferenceAdmission, pause?: string) {
    const checkpoint = deferred(); let stdout = "", stderr = "";
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./process_fixture.child.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"],
    }); children.add(proc);
    const timer = setTimeout(() => { checkpoint.reject(new Error("Owned CREATE process timeout")); proc.kill("SIGKILL"); }, 30_000);
    proc.stdout!.on("data", chunk => stdout += chunk); proc.stderr!.on("data", chunk => stderr += chunk);
    proc.on("message", (message: any) => { if (message.type === "checkpoint") checkpoint.resolve(); if (message.type === "metric") metrics++; });
    const exited = once(proc, "exit").then(([code, signal]) => { clearTimeout(timer); children.delete(proc); return { code, signal, stdout, stderr }; });
    proc.stdin!.end(JSON.stringify({ action, operationId, admission, pause, fixtureOrigin: origin }));
    return { proc, checkpoint: checkpoint.promise, exited };
  }
  async function run(action: Action, admission?: ReferenceCreateAdmission | ReferenceAdmission) {
    const result = await child(action, admission).exited; assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
    assert.equal(result.stdout.includes("synthetic-process-token"), false); return JSON.parse(result.stdout);
  }
  async function kill(value: ReturnType<typeof child>) { await value.checkpoint; value.proc.kill("SIGKILL"); assert.equal((await value.exited).signal, "SIGKILL"); }
  const expire = () => pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [operationId]);
  async function fixture(label: string, body: (ids: { connectionId: string; objectId: string; bindingId: string; input: ReferenceCreateAdmission }) => Promise<void>) {
    mode = "healthy"; remote = null; writes = 0; methods = []; failures = []; metrics = 0; postBodies = [];
    const nonce = randomUUID(), ids = { connectionId: `connection:${nonce}`, objectId: `object:${nonce}`, bindingId: `binding:${nonce}` };
    calendarId = `calendar/${nonce}+id`; operationId = randomUUID(); eventId = referenceCreateEventID(operationId);
    await store.seedCreateBinding({ ...ids, calendarId, operationId, accessToken: "synthetic-process-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content });
    const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: `command:${nonce}`, operationId };
    await body({ ...ids, input }); assert.deepEqual(failures, []); assert.equal(metrics, methods.length);
    console.log(`Reference CREATE process fixture: ${label}: PASS`);
  }
  async function ack(provider: "accepted" | "uncertain") {
    const op = await store.inspectOperation(operationId); assert.equal(op.status, "acked"); assert.equal(op.action, "create");
    assert.equal(op.canonical.lifecycle, "active"); assert.equal(op.binding.destinationLifecycle, "present"); assert.equal(op.binding.sourceGeneration, 2);
    assert.equal(op.binding.etag, '"created"'); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.receipt.remote.kind, "confirmed");
    assert.equal(op.receipt.notification.kind, "not-requested"); return op;
  }
  try {
    await store.migrate();
    await fixture("older-uncertainty-404-known429-later-owned-GET-ACKs-uncertain", async ids => {
      await run("admit-create", ids.input); mode = "lost"; await kill(child("deliver", undefined, "afterUncertain"));
      const original = remote; assert(original); const pinned = hash((await store.inspectOperation(operationId)).payload);
      remote = null; mode = "reject"; await expire(); const retryStart = methods.length; assert.equal((await run("deliver")).status, "hold");
      const held = await store.inspectOperation(operationId); assert.equal(held.dispatchPossible, true); assert.equal(await store.claim(operationId, randomUUID()), null);
      assert.deepEqual(methods.slice(retryStart), ["GET", "GET", "POST"]); assert.equal(writes, 2); assert.equal(postBodies[0], postBodies[1]);
      remote = original; mode = "healthy"; await expire(); const observeStart = methods.length; assert.equal((await run("deliver")).status, "acked");
      await ack("uncertain"); assert.equal(held.receipt.provider.kind, "uncertain"); assert.equal(writes, 2); assert.deepEqual(methods.slice(observeStart), ["GET"]);
      assert.equal(hash((await store.inspectOperation(operationId)).payload), pinned); assert.equal((await run("deliver")).status, "unclaimed"); assert.equal(writes, 2);
    });
    await fixture("prior-accepted-CREATE-fact-survives-later-same-ID-POST-lost-reply", async ids => {
      await run("admit-create", ids.input); await kill(child("deliver", undefined, "afterAcceptance"));
      assert.equal((await store.inspectOperation(operationId)).receipt.provider.kind, "accepted"); remote = null; mode = "lost"; await expire();
      assert.equal((await run("deliver")).status, "acked"); await ack("accepted"); assert.equal(writes, 2); assert.equal(postBodies[0], postBodies[1]); assert(remote);
    });
    await fixture("known429-next404-new-POST-lost-applied-GET-ACKs-uncertain", async ids => {
      await run("admit-create", ids.input); mode = "reject"; assert.equal((await run("deliver")).status, "hold");
      assert.equal((await store.inspectOperation(operationId)).receipt.provider.kind, "rejected"); assert.equal(await store.claim(operationId, randomUUID()), null);
      mode = "lost"; await expire(); const before = methods.length; assert.equal((await run("deliver")).status, "acked"); await ack("uncertain");
      assert.equal(writes, 2); assert.equal(postBodies[0], postBodies[1]); assert.deepEqual(methods.slice(before), ["GET", "GET", "POST", "GET"]); assert(remote);
      assert.equal((await run("deliver")).status, "unclaimed"); assert.equal(writes, 2);
    });
    await fixture("SIGKILL-inside-canonical-admission-rolls-back", async ids => {
      await kill(child("admit-create", ids.input, "admissionCanonical"));
      assert.equal((await pool.query("SELECT revision FROM reference_objects WHERE id=$1", [ids.objectId])).rows[0].revision, "1");
      assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1", [operationId])).rows[0].count, "0");
      await run("admit-create", ids.input); await run("deliver"); await ack("accepted"); assert.equal(writes, 1);
    });
    for (const phase of ["afterAdmission", "claim", "beforeDispatch", "afterAcceptance", "afterReadback", "afterAck"]) {
      await fixture(`SIGKILL-restart-${phase}`, async ids => {
        if (phase === "afterAdmission") await kill(child("admit-create", ids.input, phase));
        else { await run("admit-create", ids.input); await kill(child("deliver", undefined, phase)); }
        const pinned = hash((await store.inspectOperation(operationId)).payload), before = methods.length;
        await expire(); await run("deliver"); const op = await ack("accepted"); assert.equal(hash(op.payload), pinned); assert.equal(writes, 1);
        if (["afterAcceptance", "afterReadback"].includes(phase)) assert.deepEqual(methods.slice(before), ["GET"]);
        if (phase === "afterAck") assert.deepEqual(methods.slice(before), []);
      });
    }
    await fixture("lost-reply-SIGKILL-restart-GET-only", async ids => {
      await run("admit-create", ids.input); mode = "lost"; await kill(child("deliver", undefined, "afterUncertain"));
      const before = methods.length; mode = "healthy"; await expire(); await run("deliver"); await ack("uncertain");
      assert.equal(writes, 1); assert.deepEqual(methods.slice(before), ["GET"]);
    });
    await fixture("possible-dispatch-before-HTTP-404-retries-same-ID-body", async ids => {
      await run("admit-create", ids.input); await kill(child("deliver", undefined, "beforeDispatch"));
      assert.equal(writes, 0); const pinned = hash((await store.inspectOperation(operationId)).payload);
      await expire(); await run("deliver"); await ack("accepted"); assert.equal(writes, 1); assert.equal(hash((await store.inspectOperation(operationId)).payload), pinned);
    });
    for (const invalid of ["gone", "cancelled", "foreign-marker", "changed-content", "weak"]) {
      await fixture(`lost-reply-recovery-${invalid}-does-not-resend`, async ids => {
        await run("admit-create", ids.input); mode = "lost"; await kill(child("deliver", undefined, "afterUncertain"));
        const before = methods.length; mode = invalid; await expire(); const result = await run("deliver");
        assert.notEqual(result.status, "acked"); assert.equal(writes, 1); assert.deepEqual(methods.slice(before), ["GET"]);
        const op = await store.inspectOperation(operationId); assert.equal(op.binding.destinationLifecycle, "reserved"); assert.equal(op.binding.etag, null);
      });
    }
    await fixture("known-409-no-read-adoption", async ids => {
      await run("admit-create", ids.input); mode = "collision"; const result = await run("deliver"); assert.equal(result.status, "hold");
      assert.deepEqual(methods, ["GET", "POST"]); assert.equal((await store.inspectOperation(operationId)).receipt.provider.kind, "rejected");
    });
    await fixture("429-then-404-retries-same-body-and-preserves-one-resource", async ids => {
      await run("admit-create", ids.input); mode = "reject"; assert.equal((await run("deliver")).status, "hold");
      assert.equal(await store.claim(operationId, randomUUID()), null); mode = "healthy"; await expire(); await run("deliver"); await ack("accepted");
      assert.equal(writes, 2); assert.equal(postBodies[0], postBodies[1]); assert(remote);
    });
    await fixture("rejected-CREATE-owned-target-remains-HOLD-without-resend", async ids => {
      await run("admit-create", ids.input); mode = "reject"; assert.equal((await run("deliver")).status, "hold");
      const admitted = await store.inspectOperation(operationId);
      const body = (admitted.payload as { operationEnvelope: { nativePlan: { data: { body: Record<string, unknown> } } } }).operationEnvelope.nativePlan.data.body;
      remote = { ...body, etag: '"created"', status: "confirmed", eventType: "default", organizer: { self: true } };
      const before = methods.length; mode = "healthy"; await expire(); assert.equal((await run("deliver")).status, "hold");
      assert.equal(writes, 1); assert.deepEqual(methods.slice(before), ["GET"]);
      const observed = await store.inspectOperation(operationId); assert.equal(observed.receipt.provider.kind, "rejected"); assert.equal(observed.receipt.remote.kind, "confirmed");
      assert.equal(observed.binding.destinationLifecycle, "reserved");
    });
    await fixture("serial-CREATE-UPDATE-DELETE-uses-confirmed-binding-and-validator", async ids => {
      await run("admit-create", ids.input); await run("deliver"); await ack("accepted");
      operationId = randomUUID();
      await run("admit", { bindingId: ids.bindingId, expectedRevision: 2, commandId: randomUUID(), operationId, patch: { name: "After CREATE" } });
      assert.equal((await run("deliver")).status, "acked");
      const updated = await store.inspectOperation(operationId); assert.equal(updated.binding.etag, '"updated"'); assert.equal(updated.capture.sourceGeneration, 2);
      operationId = randomUUID();
      await run("admit-delete", { bindingId: ids.bindingId, expectedRevision: 3, commandId: randomUUID(), operationId });
      assert.equal((await run("deliver")).status, "acked");
      const deleted = await store.inspectOperation(operationId); assert.equal(deleted.binding.destinationLifecycle, "absent"); assert.equal(deleted.canonical.lifecycle, "tombstoned");
      assert.equal(writes, 1); assert.equal(methods.filter(method => method === "PATCH").length, 1); assert.equal(methods.filter(method => method === "DELETE").length, 1); assert.equal(remote, null);
    });
    await fixture("standalone-CLI-seed-create-admit-show-REFERENCE-env-only", async () => {
      const cli = async (command: string, body: unknown) => {
        const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), command], {
          env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"],
        }); children.add(proc); let output = "", error = ""; proc.stdout!.on("data", value => output += value); proc.stderr!.on("data", value => error += value);
        proc.stdin!.end(JSON.stringify(body)); const [code] = await once(proc, "exit"); children.delete(proc); assert.equal(code, 0, error);
        assert.equal(output.includes("synthetic-process-token"), false); return JSON.parse(output);
      };
      const nonce = randomUUID(), planned = randomUUID(), bindingId = `cli-binding:${nonce}`;
      const seeded = await cli("seed-create", { connectionId: `cli-connection:${nonce}`, objectId: `cli-object:${nonce}`, bindingId, calendarId,
        operationId: planned, accessToken: "synthetic-process-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content });
      assert.equal(seeded.status, "reserved");
      const admitted = await cli("admit-create", { bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: planned }); assert.equal(admitted.action, "create");
      const shown = await cli("show", { operationId: planned }); assert.equal(shown.binding.destinationLifecycle, "reserved"); assert.equal(shown.binding.etag, null); assert.equal(shown.binding.baseline, null);
    });
    console.log("Reference CREATE independent process crash and CLI proof: PASS");
  } finally {
    for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => once(child, "exit").catch(() => {})));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end();
    try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
