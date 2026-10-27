import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { REFERENCE_GRAPH_DELETE_PROFILE } from "./admission.js";
import type { ReferenceGraphDeleteAdmission, ReferenceContent } from "./model.js";

const key = "ab".repeat(32), etag = 'W/"accepted-native-version"';
const content: ReferenceContent = { name: "Synthetic Graph DELETE", notes: null, place: "Room", beginsAt: "2026-10-24T08:00:00.000Z", endsAt: "2026-10-24T09:00:00.000Z" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deferred = () => { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); assert(adminUrl, "Disposable independent DB required");
  const name = referenceTestDatabaseName("reference_graph_delete_process_"), database = new URL(adminUrl); database.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: database.href, max: 4 }), store = new ReferenceStore(pool, key), children = new Set<ChildProcess>();
  let calendarId = "", eventId = "", mode = "healthy", absent = false, writes = 0, methods: string[] = [], errors: unknown[] = [], metrics = 0, raceObserved = false;
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method!); assert.equal(req.headers.authorization, "Bearer synthetic-graph-process-token");
      const url = new URL(req.url!, "http://owned.test"), json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/v1.0/me") return json({ id: "native-owner", mail: "owner@example.test", userPrincipalName: "owner@example.test" });
      if (url.pathname === `/v1.0/me/calendars/${encodeURIComponent(calendarId)}`) return json({ id: calendarId, canEdit: true, owner: { address: mode === "foreign-owner" ? "other@example.test" : "owner@example.test" } });
      assert.equal(url.pathname, `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      const native = { id: eventId, "@odata.etag": mode === "changed" ? 'W/"changed-native"' : etag, type: "singleInstance", isCancelled: false, isOrganizer: true, isDraft: false, isAllDay: false,
        recurrence: null, attendees: [], isOnlineMeeting: false, onlineMeeting: null, onlineMeetingUrl: null,
        subject: content.name, body: { contentType: "text", content: "" }, location: { displayName: content.place },
        start: { dateTime: "2026-10-24T08:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-24T09:00:00.0000000", timeZone: "UTC" } };
      if (req.method === "GET") {
        if (writes && mode === "verify-denied") return json({}, 403);
        if (mode === "gone") return json({}, 410);
        return absent ? json({}, 404) : json(native);
      }
      assert.equal(req.method, "DELETE"); assert.equal(req.headers["if-match"], etag); let bytes = ""; for await (const chunk of req) bytes += chunk; assert.equal(bytes, ""); writes++;
      if (mode === "reject") { res.setHeader("retry-after", "9"); return json({}, 429); }
      if (mode === "race") { native["@odata.etag"] = 'W/"changed-after-preflight"'; raceObserved = true; }
      if (mode !== "lost-retained" && mode !== "retained") absent = true;
      if (mode === "lost" || mode === "lost-retained") return res.destroy();
      res.writeHead(204); res.end();
    } catch (error) { errors.push(error); res.statusCode = 500; res.end("Owned Graph fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  function child(action: "admit-graph-delete" | "deliver" | "show", operationId: string, admission?: ReferenceGraphDeleteAdmission, pause?: string) {
    const checkpoint = deferred(); let stdout = "", stderr = "";
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./process_fixture.child.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"],
    }); children.add(proc);
    const timer = setTimeout(() => { checkpoint.reject(new Error("Owned Graph child timeout")); proc.kill("SIGKILL"); }, 30_000);
    proc.stdout!.on("data", value => stdout += value); proc.stderr!.on("data", value => stderr += value);
    proc.on("message", (message: any) => { if (message.type === "checkpoint") checkpoint.resolve(); if (message.type === "metric") metrics++; });
    const exited = once(proc, "exit").then(([code, signal]) => { clearTimeout(timer); children.delete(proc); return { code, signal, stdout, stderr }; });
    proc.stdin!.end(JSON.stringify({ action, operationId, admission, pause, fixtureOrigin: origin })); return { proc, checkpoint: checkpoint.promise, exited };
  }
  async function run(action: "admit-graph-delete" | "deliver" | "show", operationId: string, admission?: ReferenceGraphDeleteAdmission) {
    const result = await child(action, operationId, admission).exited; assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
    assert.equal(result.stdout.includes("synthetic-graph-process-token"), false); return JSON.parse(result.stdout);
  }
  async function kill(value: ReturnType<typeof child>) { await value.checkpoint; value.proc.kill("SIGKILL"); assert.equal((await value.exited).signal, "SIGKILL"); }
  const expire = (operationId: string) => pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [operationId]);
  async function fixture(label: string, body: (ids: { connectionId: string; objectId: string; bindingId: string; input: ReferenceGraphDeleteAdmission }) => Promise<void>) {
    mode = "healthy"; absent = false; writes = 0; methods = []; metrics = 0; errors = []; raceObserved = false;
    const nonce = randomUUID(), ids = { connectionId: `graph-connection:${nonce}`, objectId: `graph-object:${nonce}`, bindingId: `graph-binding:${nonce}` }; calendarId = `calendar/${nonce}+id`; eventId = `event/${nonce}+id`;
    await store.seedGraphDeleteBinding({ ...ids, provider: "microsoft", endpointProfile: REFERENCE_GRAPH_DELETE_PROFILE, calendarId, eventId,
      accessToken: "synthetic-graph-process-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "Calendars.ReadWrite", content, etag });
    const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: `graph-operation:${nonce}` };
    await body({ ...ids, input }); assert.deepEqual(errors, []); assert.equal(metrics, methods.length); console.log(`Reference Graph guarded DELETE process: ${label}: PASS`);
  }
  async function ack(operationId: string, provider: "accepted" | "uncertain" | "not-dispatched" | "rejected") {
    const op = await store.inspectOperation(operationId); assert.equal(op.status, "acked"); assert.equal(op.provider, "microsoft"); assert.equal(op.endpointProfile, REFERENCE_GRAPH_DELETE_PROFILE);
    assert.equal(op.canonical.lifecycle, "tombstoned"); assert.equal(op.binding.destinationLifecycle, "absent"); assert.equal(op.binding.etag, etag);
    assert.equal(op.receipt.provider.kind, provider); assert.equal(op.receipt.remote.kind, "confirmed"); assert.equal(op.receipt.notification.kind, "not-requested"); return op;
  }
  try {
    await store.migrate();
    await fixture("SIGKILL-inside-admission-rolls-back-tombstone-and-intent", async ids => {
      await kill(child("admit-graph-delete", ids.input.operationId, ids.input, "admissionCanonical"));
      assert.equal((await pool.query("SELECT revision,canonical_lifecycle FROM reference_objects WHERE id=$1", [ids.objectId])).rows[0].revision, "1");
      assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1", [ids.input.operationId])).rows[0].count, "0");
      await run("admit-graph-delete", ids.input.operationId, ids.input); await run("deliver", ids.input.operationId); await ack(ids.input.operationId, "accepted"); assert.equal(writes, 1);
    });
    for (const phase of ["afterAdmission", "claim", "afterAcceptance", "afterReadback", "afterAck"]) await fixture(`SIGKILL-restart-${phase}`, async ids => {
      if (phase === "afterAdmission") await kill(child("admit-graph-delete", ids.input.operationId, ids.input, phase));
      else { await run("admit-graph-delete", ids.input.operationId, ids.input); await kill(child("deliver", ids.input.operationId, undefined, phase)); }
      const pinned = hash((await store.inspectOperation(ids.input.operationId)).payload), before = methods.length; await expire(ids.input.operationId); await run("deliver", ids.input.operationId);
      assert.equal(hash((await ack(ids.input.operationId, "accepted")).payload), pinned); assert.equal(writes, 1);
      if (["afterAcceptance", "afterReadback"].includes(phase)) assert.deepEqual(methods.slice(before), ["GET"]); if (phase === "afterAck") assert.deepEqual(methods.slice(before), []);
    });
    await fixture("possible-dispatch-before-HTTP-never-replays-at-same-version", async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); await kill(child("deliver", ids.input.operationId, undefined, "beforeDispatch")); assert.equal(writes, 0);
      const before = methods.length; await expire(ids.input.operationId); assert.equal((await run("deliver", ids.input.operationId)).status, "hold"); assert.equal(writes, 0); assert.deepEqual(methods.slice(before), ["GET"]);
      absent = true; await expire(ids.input.operationId); await run("deliver", ids.input.operationId); await ack(ids.input.operationId, "uncertain"); assert.equal(writes, 0);
    });
    await fixture("lost-accepted-reply-SIGKILL-restart-GET-only", async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); mode = "lost"; await kill(child("deliver", ids.input.operationId, undefined, "afterUncertain"));
      const before = methods.length; mode = "healthy"; await expire(ids.input.operationId); await run("deliver", ids.input.operationId); await ack(ids.input.operationId, "uncertain");
      assert.equal(writes, 1); assert.deepEqual(methods.slice(before), ["GET"]);
    });
    for (const retainedMode of ["lost-retained", "retained"]) await fixture(`${retainedMode}-remains-observe-only-even-unchanged-or-new-ETag`, async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); mode = retainedMode; assert.equal((await run("deliver", ids.input.operationId)).status, "hold");
      for (const observed of ["healthy", "changed"]) { const before = methods.length; mode = observed; await expire(ids.input.operationId); assert.equal((await run("deliver", ids.input.operationId)).status, "hold"); assert.equal(writes, 1); assert.deepEqual(methods.slice(before), ["GET"]); }
      assert.equal((await store.inspectOperation(ids.input.operationId)).binding.destinationLifecycle, "present");
    });
    await fixture("429-rejection-respects-delay-and-never-resends", async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); mode = "reject"; assert.equal((await run("deliver", ids.input.operationId)).status, "hold"); assert.equal(await store.claim(ids.input.operationId, randomUUID()), null);
      const before = methods.length; mode = "healthy"; await expire(ids.input.operationId); assert.equal((await run("deliver", ids.input.operationId)).status, "hold"); assert.equal(writes, 1); assert.deepEqual(methods.slice(before), ["GET"]);
      absent = true; await expire(ids.input.operationId); await run("deliver", ids.input.operationId); await ack(ids.input.operationId, "rejected"); assert.equal(writes, 1);
    });
    for (const invalidMode of ["gone", "foreign-owner", "changed"]) await fixture(`initial-${invalidMode}-cannot-delete-or-claim-absence`, async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); mode = invalidMode; assert.notEqual((await run("deliver", ids.input.operationId)).status, "acked"); assert.equal(writes, 0);
      assert.equal((await store.inspectOperation(ids.input.operationId)).binding.destinationLifecycle, "present");
    });
    await fixture("verification-403-keeps-native-acceptance-unconfirmed-until-later-404", async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); mode = "verify-denied"; assert.equal((await run("deliver", ids.input.operationId)).status, "hold");
      assert.equal((await store.inspectOperation(ids.input.operationId)).receipt.provider.kind, "accepted"); mode = "healthy"; await expire(ids.input.operationId); await run("deliver", ids.input.operationId); await ack(ids.input.operationId, "accepted"); assert.equal(writes, 1);
    });
    await fixture("documented-read-write-race-is-not-misrepresented-as-CAS", async ids => {
      await run("admit-graph-delete", ids.input.operationId, ids.input); mode = "race"; await run("deliver", ids.input.operationId); await ack(ids.input.operationId, "accepted"); assert.equal(writes, 1); assert.equal(raceObserved, true);
    });
    await fixture("standalone-Graph-CLI-requires-explicit-profile-and-reference-env-only", async () => {
      const cli = async (command: string, body: unknown) => {
        const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), command], { env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] }); children.add(proc);
        let output = "", error = ""; proc.stdout!.on("data", value => output += value); proc.stderr!.on("data", value => error += value); proc.stdin!.end(JSON.stringify(body)); const [code] = await once(proc, "exit"); children.delete(proc); assert.equal(code, 0, error); assert.equal(output.includes("synthetic-graph-process-token"), false); return JSON.parse(output);
      };
      const nonce = randomUUID(), bindingId = `cli-binding:${nonce}`, operationId = randomUUID();
      await cli("seed-graph-delete", { provider: "microsoft", endpointProfile: REFERENCE_GRAPH_DELETE_PROFILE, connectionId: `cli-connection:${nonce}`, objectId: `cli-object:${nonce}`, bindingId, calendarId, eventId,
        accessToken: "synthetic-graph-process-token", expiresAt: "2099-01-01T00:00:00.000Z", scope: "Calendars.ReadWrite", content, etag });
      const admitted = await cli("admit-graph-delete", { bindingId, expectedRevision: 1, commandId: randomUUID(), operationId }); assert.equal(admitted.provider, "microsoft"); assert.equal(admitted.endpointProfile, REFERENCE_GRAPH_DELETE_PROFILE);
      const shown = await cli("show", { operationId }); assert.equal(shown.binding.etag, etag); assert.equal(shown.canonical.lifecycle, "tombstoned");
    });
    console.log("Reference Graph guarded DELETE independent process/HTTP/PostgreSQL proof: PASS");
  } finally {
    for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => once(child, "exit").catch(() => {})));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
