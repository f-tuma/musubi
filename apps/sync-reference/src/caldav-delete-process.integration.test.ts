import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { REFERENCE_CALDAV_DELETE_PROFILE } from "./admission.js";
import type { ReferenceCaldavDeleteAdmission } from "./model.js";

const key = "ab".repeat(32), etag = '"original,opaque\\etag"', username = "owner@example.test", password = "synthetic-dav-process-password";
const content = { name: "Synthetic conditional DAV DELETE", notes: null, place: "Room", beginsAt: "2026-10-25T08:00:00.000Z", endsAt: "2026-10-25T09:00:00.000Z" };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deferred = () => { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined); assert(adminUrl, "Explicit disposable independent DB required");
  const name = `reference_caldav_delete_process_${randomUUID().replaceAll("-", "")}`, database = new URL(adminUrl); database.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: database.href, max: 4 }), store = new ReferenceStore(pool, key), children = new Set<ChildProcess>();
  let calendarUrl = "", resourceUrl = "", uid = "", mode = "healthy", absent = false, writes = 0, methods: string[] = [], errors: unknown[] = [], metrics = 0;
  const native = () => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Owned reference fixture//EN", "BEGIN:VTIMEZONE", "TZID:Owned/Unmodified", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", "END:STANDARD", "END:VTIMEZONE", "BEGIN:VEVENT",
    `UID:${mode === "changed-uid" ? "different-uid" : uid}`, mode === "all-day" ? "DTSTART;VALUE=DATE:20261025" : "DTSTART:20261025T080000Z", mode === "all-day" ? "DTEND;VALUE=DATE:20261026" : "DTEND:20261025T090000Z", `SUMMARY:${content.name}`, "LOCATION:Room", "X-PRIVATE:synthetic-private-extension",
    ...(mode === "recurring" ? ["RRULE:FREQ=DAILY"] : []), ...(mode === "attendee" ? ["ATTENDEE:mailto:guest@example.test"] : []), "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:synthetic-private-alarm", "END:VALARM", ...(mode === "nested-event" ? ["BEGIN:VEVENT", "UID:nested-unrelated-uid", "DTSTART:20261025T100000Z", "DTEND:20261025T110000Z", "END:VEVENT"] : []), "END:VEVENT",
    ...(mode === "multi-event" ? ["BEGIN:VEVENT", "UID:unrelated-resource-uid", "DTSTART:20261025T100000Z", "DTEND:20261025T110000Z", "END:VEVENT"] : []), "END:VCALENDAR", ""].join("\r\n");
  const server = createServer(async (req, res) => {
    try {
      methods.push(req.method!); assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
      const logical = new URL(req.url!, "https://dav.example.test");
      if (req.method === "PROPFIND") {
        assert.equal(logical.href, calendarUrl); assert.equal(req.headers.depth, "0"); let body = ""; for await (const chunk of req) body += chunk; assert(body.includes("current-user-privilege-set"));
        const href = mode === "wrong-acl-href" ? calendarUrl + "other/" : calendarUrl;
        const propstat = mode === "missing-acl" ? '<d:propstat><d:prop><d:current-user-privilege-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>'
          : `<d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:${mode === "denied-acl" ? "read" : "unbind"}/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
        res.writeHead(207, { "content-type": "application/xml" }); res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href>${propstat}</d:response></d:multistatus>`); return;
      }
      assert.equal(logical.href, resourceUrl);
      if (req.method === "GET") {
        if (mode === "gone") { res.writeHead(410); res.end(); return; }
        if (mode === "redirect") { res.writeHead(302, { location: resourceUrl + "?alias=1" }); res.end(); return; }
        if (writes && mode === "verify-denied") { res.writeHead(403); res.end(); return; }
        if (absent) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "text/calendar", etag: mode === "changed-etag" ? '"newer-native"' : mode === "weak-etag" ? 'W/"weak"' : etag }); res.end(native()); return;
      }
      assert.equal(req.method, "DELETE"); assert.equal(req.headers["if-match"], etag); assert.equal(req.headers["if-none-match"], undefined); let bytes = ""; for await (const chunk of req) bytes += chunk; assert.equal(bytes, ""); writes++;
      if (mode === "reject") { res.writeHead(429, { "retry-after": "9" }); res.end(); return; }
      if (!["lost-retained", "retained"].includes(mode)) absent = true;
      if (["lost", "lost-retained"].includes(mode)) { res.destroy(); return; }
      res.writeHead(204); res.end();
    } catch (error) { errors.push(error); res.statusCode = 500; res.end("Owned DAV fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  function child(action: "admit-caldav-delete" | "deliver" | "show", operationId: string, admission?: ReferenceCaldavDeleteAdmission, pause?: string) {
    const checkpoint = deferred(); let stdout = "", stderr = "";
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./process_fixture.child.ts", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { PATH: process.env.PATH, REFERENCE_TEST_CHILD: "true", REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe", "ipc"] }); children.add(proc);
    const timer = setTimeout(() => { checkpoint.reject(new Error("Owned DAV child timeout")); proc.kill("SIGKILL"); }, 30_000);
    proc.stdout!.on("data", value => stdout += value); proc.stderr!.on("data", value => stderr += value);
    proc.on("message", (message: any) => { if (message.type === "checkpoint") checkpoint.resolve(); if (message.type === "metric") metrics++; });
    const exited = once(proc, "exit").then(([code, signal]) => { clearTimeout(timer); children.delete(proc); return { code, signal, stdout, stderr }; });
    proc.stdin!.end(JSON.stringify({ action, operationId, admission, pause, fixtureOrigin: origin })); return { proc, checkpoint: checkpoint.promise, exited };
  }
  async function run(action: "admit-caldav-delete" | "deliver" | "show", operationId: string, admission?: ReferenceCaldavDeleteAdmission) {
    const result = await child(action, operationId, admission).exited; assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
    for (const secret of [password, Buffer.from(`${username}:${password}`).toString("base64"), "synthetic-private-alarm", "synthetic-private-extension"]) assert.equal((result.stdout + result.stderr).includes(secret), false);
    return JSON.parse(result.stdout);
  }
  async function kill(value: ReturnType<typeof child>) { await value.checkpoint; value.proc.kill("SIGKILL"); assert.equal((await value.exited).signal, "SIGKILL"); }
  const expire = (id: string) => pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1", [id]);
  async function fixture(label: string, body: (input: ReferenceCaldavDeleteAdmission, ids: { bindingId: string; objectId: string }) => Promise<void>) {
    mode = "healthy"; absent = false; writes = 0; methods = []; errors = []; metrics = 0;
    const id = randomUUID(), ids = { connectionId: `dav-connection:${id}`, objectId: `dav-object:${id}`, bindingId: `dav-binding:${id}` }; calendarUrl = `https://dav.example.test/calendars/${id}/`; resourceUrl = calendarUrl + "original.ics"; uid = `native-${id}@example.test`;
    await store.seedCaldavDeleteBinding({ ...ids, provider: "caldav", endpointProfile: REFERENCE_CALDAV_DELETE_PROFILE, calendarUrl, resourceUrl, uid, username, password, expiresAt: "2099-01-01T00:00:00.000Z", content, etag });
    const input = { bindingId: ids.bindingId, expectedRevision: 1, commandId: randomUUID(), operationId: randomUUID() }; await body(input, ids);
    assert.deepEqual(errors, []); assert.equal(metrics, methods.length); console.log(`Reference CalDAV conditional DELETE process: ${label}: PASS`);
  }
  async function ack(id: string, provider: "accepted" | "uncertain" | "not-dispatched") {
    const op = await store.inspectOperation(id); assert.equal(op.status, "acked"); assert.equal(op.provider, "caldav"); assert.equal(op.endpointProfile, REFERENCE_CALDAV_DELETE_PROFILE); assert.equal(op.acceptedUid, uid); assert.equal(op.binding.etag, etag); assert.equal(op.binding.destinationLifecycle, "absent"); assert.equal(op.receipt.provider.kind, provider); assert.equal(op.receipt.remote.kind, "confirmed"); return op;
  }
  try {
    await store.migrate();
    await fixture("older-uncertain-DAV-DELETE-keeps-truth-through-later429-and-exact404", async input => {
      await run("admit-caldav-delete", input.operationId, input); mode = "lost-retained"; await kill(child("deliver", input.operationId, undefined, "afterUncertain")); const pinned = hash((await store.inspectOperation(input.operationId)).payload);
      mode = "reject"; await expire(input.operationId); assert.equal((await run("deliver", input.operationId)).status, "hold"); const held = await store.inspectOperation(input.operationId); assert.equal(held.receipt.provider.kind, "uncertain"); assert.equal(held.dispatchPossible, true); assert.equal(await store.claim(input.operationId, randomUUID()), null);
      absent = true; mode = "healthy"; await expire(input.operationId); const before = methods.length; await run("deliver", input.operationId); await ack(input.operationId, "uncertain"); assert.equal(writes, 2); assert.deepEqual(methods.slice(before), ["GET"]); assert.equal(hash((await store.inspectOperation(input.operationId)).payload), pinned);
    });
    await fixture("prior-accepted-DAV-DELETE-status-survives-later-lost-conditional-response", async input => {
      await run("admit-caldav-delete", input.operationId, input); await kill(child("deliver", input.operationId, undefined, "afterAcceptance")); absent = false; mode = "lost"; await expire(input.operationId); assert.equal((await run("deliver", input.operationId)).status, "acked"); const op = await ack(input.operationId, "accepted"); assert.equal(op.deleteAcceptanceStatus, 204); assert.equal(writes, 2);
    });
    await fixture("SIGKILL-inside-admission-rolls-back-tombstone-and-intent", async (input, ids) => {
      await kill(child("admit-caldav-delete", input.operationId, input, "admissionCanonical")); assert.equal((await pool.query("SELECT revision FROM reference_objects WHERE id=$1", [ids.objectId])).rows[0].revision, "1"); assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1", [input.operationId])).rows[0].count, "0");
      await run("admit-caldav-delete", input.operationId, input); await run("deliver", input.operationId); await ack(input.operationId, "accepted"); assert.equal(writes, 1);
    });
    for (const phase of ["afterAdmission", "claim", "beforeDispatch", "afterAcceptance", "afterUncertain", "afterReadback", "afterAck"]) await fixture(`SIGKILL-restart-${phase}`, async input => {
      if (phase === "afterAdmission") await kill(child("admit-caldav-delete", input.operationId, input, phase));
      else { await run("admit-caldav-delete", input.operationId, input); if (phase === "afterUncertain") mode = "lost"; await kill(child("deliver", input.operationId, undefined, phase)); }
      const pinned = hash((await store.inspectOperation(input.operationId)).payload), start = methods.length;
      if (phase === "beforeDispatch") { assert.equal(writes, 0); assert.equal((await store.inspectOperation(input.operationId)).dispatchPossible, true); }
      mode = "healthy"; await expire(input.operationId); await run("deliver", input.operationId); assert.equal(hash((await ack(input.operationId, phase === "afterUncertain" ? "uncertain" : "accepted")).payload), pinned); assert.equal(writes, 1);
      if (["afterAcceptance", "afterUncertain", "afterReadback"].includes(phase)) assert.deepEqual(methods.slice(start), ["GET"]); if (phase === "afterAck") assert.deepEqual(methods.slice(start), []);
    });
    await fixture("lost-reply-retained-original-version-allows-same-identity-conditional-retry", async input => {
      await run("admit-caldav-delete", input.operationId, input); mode = "lost-retained"; await kill(child("deliver", input.operationId, undefined, "afterUncertain")); assert.equal(writes, 1); const original = await store.inspectOperation(input.operationId); assert.equal(original.dispatchPossible, true);
      const start = methods.length; mode = "healthy"; await expire(input.operationId); await run("deliver", input.operationId); await ack(input.operationId, "accepted"); assert.equal(writes, 2); assert.deepEqual(methods.slice(start), ["GET", "PROPFIND", "GET", "DELETE", "GET"]); assert.equal(hash((await store.inspectOperation(input.operationId)).payload), hash(original.payload));
    });
    for (const changed of ["changed-etag", "changed-uid"]) await fixture(`possible-dispatch-${changed}-cannot-rebase-or-resend`, async input => {
      await run("admit-caldav-delete", input.operationId, input); mode = "lost-retained"; await kill(child("deliver", input.operationId, undefined, "afterUncertain")); assert.equal(writes, 1); mode = changed; await expire(input.operationId); assert.notEqual((await run("deliver", input.operationId)).status, "acked"); assert.equal(writes, 1);
    });
    await fixture("429-respects-delay-and-later-retries-only-the-original-conditional-target", async input => {
      await run("admit-caldav-delete", input.operationId, input); mode = "reject"; assert.equal((await run("deliver", input.operationId)).status, "hold"); assert.equal(await store.claim(input.operationId, randomUUID()), null); assert.equal((await store.inspectOperation(input.operationId)).dispatchPossible, true);
      mode = "healthy"; await expire(input.operationId); await run("deliver", input.operationId); await ack(input.operationId, "accepted"); assert.equal(writes, 2);
    });
    for (const unsupported of ["gone", "redirect", "recurring", "all-day", "attendee", "multi-event", "nested-event", "weak-etag", "missing-acl", "denied-acl", "wrong-acl-href"]) await fixture(`initial-${unsupported}-cannot-delete-or-claim-absence`, async input => {
      await run("admit-caldav-delete", input.operationId, input); mode = unsupported; const result = await run("deliver", input.operationId); if (unsupported === "nested-event") assert.equal(result.status, "hold"); else assert.notEqual(result.status, "acked"); assert.equal(writes, 0); assert.equal((await store.inspectOperation(input.operationId)).binding.destinationLifecycle, "present");
    });
    await fixture("initial-exact404-confirms-scope-without-invented-acceptance", async input => { await run("admit-caldav-delete", input.operationId, input); absent = true; await run("deliver", input.operationId); await ack(input.operationId, "not-dispatched"); assert.equal(writes, 0); assert.deepEqual(methods, ["GET"]); });
    await fixture("verification-denial-keeps-actual-native-acceptance-until-later-exact404", async input => {
      await run("admit-caldav-delete", input.operationId, input); mode = "verify-denied"; assert.equal((await run("deliver", input.operationId)).status, "hold"); assert.equal((await store.inspectOperation(input.operationId)).receipt.provider.kind, "accepted"); mode = "healthy"; await expire(input.operationId); await run("deliver", input.operationId); await ack(input.operationId, "accepted"); assert.equal(writes, 1);
    });
    await fixture("standalone-DAV-CLI-uses-only-reference-configuration-and-no-OAuth-input", async () => {
      const cli = async (command: string, body: unknown) => {
        const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), command], { env: { PATH: process.env.PATH, REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY: key }, stdio: ["pipe", "pipe", "pipe"] }); children.add(proc); let output = "", error = ""; proc.stdout!.on("data", x => output += x); proc.stderr!.on("data", x => error += x); proc.stdin!.end(JSON.stringify(body)); const [code] = await once(proc, "exit"); children.delete(proc); assert.equal(code, 0, error); assert.equal(output.includes(password), false); return JSON.parse(output);
      };
      const id = randomUUID(), bindingId = `cli-binding:${id}`, operationId = randomUUID(); await cli("seed-caldav-delete", { provider: "caldav", endpointProfile: REFERENCE_CALDAV_DELETE_PROFILE, connectionId: `cli-connection:${id}`, objectId: `cli-object:${id}`, bindingId, calendarUrl, resourceUrl, uid, username, password, expiresAt: "2099-01-01T00:00:00.000Z", content, etag });
      const op = await cli("admit-caldav-delete", { bindingId, expectedRevision: 1, commandId: randomUUID(), operationId }); assert.equal(op.provider, "caldav"); assert.equal((await cli("show", { operationId })).acceptedUid, uid);
    });
    console.log("Reference CalDAV independent process/HTTP/PostgreSQL proof: PASS");
  } finally { for (const child of children) child.kill("SIGKILL"); await Promise.all([...children].map(child => once(child, "exit").catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
