import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import type { ReferenceAdmission, ReferenceContent, ReferenceOperation } from "./model.js";
import type { GoogleRequestMetric } from "@musubi/provider-google";

const key = "0123456789abcdef".repeat(4);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const before: ReferenceContent = { name: "Before", notes: "Before notes", place: "Before place", beginsAt: "2026-10-13T09:00:00.000Z", endsAt: "2026-10-13T10:00:00.000Z" };
const patch = { name: "Accepted A", notes: "Notes A", place: "Place A" };
const scope = "https://www.googleapis.com/auth/calendar.events";
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a;reject=b; }); return { promise, resolve, reject }; };

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "The parent harness requires a disposable test database");
  const adminUrl = process.env.REFERENCE_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const name = `reference_process_${randomUUID().replace(/-/g, "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const database = new URL(adminUrl); database.pathname = `/${name}`;
  const pool = new Pool({ connectionString: database.href, max: 4 });
  const store = new ReferenceStore(pool, key);
  const metrics: GoogleRequestMetric[] = [];
  const children = new Set<ChildProcess>();
  let remote: Record<string, any>, calendarId = "", eventId = "", mode = "healthy", writes = 0, requests = 0;
  let failures: unknown[] = [];
  const server = createServer(async (req,res) => {
    try {
      requests++;
      assert.equal(req.headers.authorization, "Bearer reference.fixture.token");
      const url = new URL(req.url!, "http://fixture.test");
      const json = (data: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (url.pathname === `/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`) return json({ id: calendarId, accessRole: "owner" });
      assert.equal(url.pathname, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      if (req.method === "GET") {
        if (mode === "partial") return json(remote, 206);
        if (mode === "range") { res.setHeader("content-range", "items 0-0/1"); return json(remote); }
        if (mode === "malformed") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{"); }
        if (mode === "missing-etag") { const { etag: _, ...data } = remote; return json(data); }
        if (mode === "wrong-id") return json({ ...remote, id: "different-native-event" });
        if (mode === "absent") return json({},404);
        if (mode === "cancelled") return json({ ...remote,status:"cancelled" });
        return json(remote);
      }
      assert.equal(req.method, "PATCH"); writes++;
      assert.equal(req.headers["if-match"], '"before"');
      let bytes = ""; for await (const chunk of req) bytes += chunk;
      assert.deepEqual(JSON.parse(bytes), { summary: patch.name, description: patch.notes, location: patch.place });
      if (mode === "412") return json({},412);
      Object.assign(remote, JSON.parse(bytes), { etag: '"after"' });
      if (mode === "lost") return res.destroy();
      return json(remote);
    } catch (error) { failures.push(error); res.statusCode=500;res.end("Owned fixture assertion failed"); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  function child(action: "admit"|"deliver"|"show", operationId: string, admission?: ReferenceAdmission, pause?: string) {
    const stopped = deferred<void>(); let stdout="",stderr="";
    const process = spawn(globalThis.process.execPath, ["--import","tsx",fileURLToPath(new URL("./process_fixture.child.ts",import.meta.url))], {
      cwd: fileURLToPath(new URL("../",import.meta.url)),
      // Prove the host does not inherit Musubi secrets/config or a product DB.
      env: { PATH: globalThis.process.env.PATH, REFERENCE_TEST_CHILD:"true", REFERENCE_DATABASE_URL: database.href, REFERENCE_CREDENTIAL_KEY:key },
      stdio:["pipe","pipe","pipe","ipc"],
    });
    children.add(process);
    const timer=setTimeout(()=>{stopped.reject(new Error("Owned child fixture deadline"));process.kill("SIGKILL");},30_000);
    process.stdout!.on("data",chunk=>{stdout+=chunk}); process.stderr!.on("data",chunk=>{stderr+=chunk});
    process.on("message",(message: any)=>{if(message.type==="checkpoint")stopped.resolve();if(message.type==="metric")metrics.push(message.metric);});
    const exited = once(process,"exit").then(([code,signal])=>{clearTimeout(timer);children.delete(process);return {code,signal,stdout,stderr};});
    process.stdin!.end(JSON.stringify({action,operationId,admission,pause,fixtureOrigin:`${origin}/`}));
    return {process,stopped:stopped.promise,exited};
  }
  async function run(action:"admit"|"deliver"|"show",operationId:string,admission?:ReferenceAdmission) {
    const result=await child(action,operationId,admission).exited;
    assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);
    assert.ok(!result.stdout.includes("reference.fixture.token")&&!result.stderr.includes("reference.fixture.token"));
    return JSON.parse(result.stdout);
  }
  async function expire(operationId:string) { await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[operationId]); }
  async function kill(process:ReturnType<typeof child>) { await process.stopped;process.process.kill("SIGKILL");assert.equal((await process.exited).signal,"SIGKILL"); }
  let cases=0;
  async function fixture(label:string,body:(ids:{bindingId:string;objectId:string;connectionId:string;operationId:string;admission:ReferenceAdmission})=>Promise<void>) {
    mode="healthy";writes=0;requests=0;metrics.length=0;failures=[];
    const nonce=randomUUID(), ids={bindingId:`binding:${nonce}`,objectId:`object:${nonce}`,connectionId:`connection:${nonce}`,operationId:`operation:${nonce}`};
    calendarId=`calendar/id+${nonce}@example.test`;eventId=`event/id +${nonce}`;
    remote={id:eventId,etag:'"before"',status:"confirmed",eventType:"default",summary:before.name,description:before.notes,location:before.place,
      start:{dateTime:before.beginsAt},end:{dateTime:before.endsAt},organizer:{self:true,email:"owned@example.test"},attendees:[]};
    await store.seedBinding({...ids,calendarId,eventId,accessToken:"reference.fixture.token",expiresAt:new Date(Date.now()+3600_000).toISOString(),scope,content:before,etag:'"before"'});
    const admission={bindingId:ids.bindingId,expectedRevision:1,commandId:`command:${nonce}`,operationId:ids.operationId,patch};
    await body({...ids,admission});
    assert.deepEqual(failures,[]);
    assert.equal(metrics.length,requests,"every completed/failed fixture dispatch is measured once across process restarts");
    for(const metric of metrics)assert.deepEqual(Object.keys(metric).sort(),["durationMs","family","method","provider","status"].sort());
    cases++;console.log(`Reference process fixture: ${label}: PASS`);
  }
  async function assertAck(operationId:string,provider:"accepted"|"uncertain") {
    const value=await store.inspectOperation(operationId);assert.equal(value.status,"acked");
    assert.equal(value.receipt.provider.kind,provider);assert.equal(value.receipt.remote.kind,"confirmed");
    assert.equal(value.receipt.local.kind,"committed");assert.equal(value.receipt.notification.kind,"not-requested");
    assert.equal(value.binding.etag,'"after"');return value;
  }
  try {
    await store.migrate();
    const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>row.tablename).sort();
    assert.deepEqual(tables,["reference_attempts","reference_bindings","reference_connections","reference_objects","reference_operations"]);
    await fixture("kill-inside-admission",async ids=>{
      const process=child("admit",ids.operationId,ids.admission,"admissionCanonical");await process.stopped;
      assert.equal((await pool.query("SELECT revision FROM reference_objects WHERE id=$1",[ids.objectId])).rows[0].revision,"1");
      await kill(process);
      assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1",[ids.operationId])).rows[0].count,"0");
      await run("admit",ids.operationId,ids.admission);await run("deliver",ids.operationId);await assertAck(ids.operationId,"accepted");assert.equal(writes,1);
    });
    for(const phase of ["afterAdmission","claim","beforeDispatch","afterAcceptance","afterReadback","afterAck"]){
      await fixture(`restart-${phase}`,async ids=>{
        let process:ReturnType<typeof child>;
        if(phase==="afterAdmission")process=child("admit",ids.operationId,ids.admission,phase);
        else{await run("admit",ids.operationId,ids.admission);process=child("deliver",ids.operationId,undefined,phase);}
        await kill(process);const original=await store.inspectOperation(ids.operationId),saved=hash(original.payload);
        await expire(ids.operationId);await run("deliver",ids.operationId);
        const value=await assertAck(ids.operationId,"accepted");
        assert.equal(hash(value.payload),saved);assert.equal(writes,1);
        const attempts=(await pool.query("SELECT count(*) FROM reference_attempts WHERE operation_id=$1",[ids.operationId])).rows[0].count;
        assert.equal(attempts,phase==="afterAck"||phase==="afterAdmission"?"1":"2");
      });
    }
    await fixture("lost-reply-real-process-restart",async ids=>{
      await run("admit",ids.operationId,ids.admission);const saved=hash((await store.inspectOperation(ids.operationId)).payload);
      mode="lost";await kill(child("deliver",ids.operationId,undefined,"afterUncertain"));mode="healthy";
      await expire(ids.operationId);await run("deliver",ids.operationId);assert.equal(writes,1);
      assert.equal(hash((await assertAck(ids.operationId,"uncertain")).payload),saved);
    });
    for(const invalid of ["partial","range","malformed","missing-etag","wrong-id","absent","cancelled"]){
      await fixture(`restart-${invalid}-GET`,async ids=>{
        await run("admit",ids.operationId,ids.admission);mode="lost";await kill(child("deliver",ids.operationId,undefined,"afterUncertain"));
        await expire(ids.operationId);mode=invalid;await run("deliver",ids.operationId);
        const value=await store.inspectOperation(ids.operationId);assert.notEqual(value.status,"acked");assert.equal(value.receipt.provider.kind,"uncertain");
        assert.equal(value.binding.etag,'"before"');assert.equal(writes,1);
      });
    }
    await fixture("412-refusal",async ids=>{
      await run("admit",ids.operationId,ids.admission);mode="412";await run("deliver",ids.operationId);
      const value=await store.inspectOperation(ids.operationId);assert.equal(value.status,"conflict");assert.equal(value.receipt.provider.kind,"rejected");
      if(value.receipt.provider.kind==="rejected")assert.equal(value.receipt.provider.error.code,"conflict");
      await run("deliver",ids.operationId);assert.equal(writes,1);assert.equal(value.binding.etag,'"before"');
    });
    for(const epoch of ["connection","source","privacy"]){for(const phase of ["afterCredentials","afterAcceptance","afterReadback"]){
      await fixture(`${epoch}-ABA-${phase}`,async ids=>{
        await run("admit",ids.operationId,ids.admission);const original=await store.inspectOperation(ids.operationId),saved=hash(original.payload);
        const process=child("deliver",ids.operationId,undefined,phase);await process.stopped;
        if(epoch==="connection"){await store.changeConnection(ids.connectionId,{scope:"https://www.googleapis.com/auth/calendar.events.readonly"});await store.changeConnection(ids.connectionId,{scope});}
        if(epoch==="source"){await store.changeBinding(ids.bindingId,{active:false});await store.changeBinding(ids.bindingId,{active:true});}
        if(epoch==="privacy"){await store.changePrivacy(ids.objectId,"public");await store.changePrivacy(ids.objectId,"private");}
        process.process.send!({type:"resume"});const exit=await process.exited;assert.equal(exit.code,0,exit.stderr);
        const value=await store.inspectOperation(ids.operationId);assert.equal(value.status,"hold");assert.equal(value.binding.etag,'"before"');assert.equal(hash(value.payload),saved);
        assert.equal(writes,phase==="afterCredentials"?0:1);
        if(phase!=="afterCredentials")assert.equal(value.receipt.provider.kind,"accepted");
      });
    }}
    for(const phase of ["afterCredentials","afterReadback"]){
      await fixture(`stale-lease-${phase}`,async ids=>{
        await run("admit",ids.operationId,ids.admission);const process=child("deliver",ids.operationId,undefined,phase);await process.stopped;
        await expire(ids.operationId);const successor=await store.claim(ids.operationId,randomUUID());assert.ok(successor);
        process.process.send!({type:"resume"});assert.equal((await process.exited).code,0);
        const held=await store.inspectOperation(ids.operationId);assert.equal(held.status,"running");assert.equal(held.leaseAttemptId,successor.attemptId);
        await expire(ids.operationId);await run("deliver",ids.operationId);await assertAck(ids.operationId,"accepted");assert.equal(writes,1);
      });
    }
    for(const bad of ["future","legacy","poison"]){
      await fixture(`${bad}-HOLD`,async ids=>{
        await run("admit",ids.operationId,ids.admission);
        const original=(await pool.query("SELECT * FROM reference_operations WHERE id=$1",[ids.operationId])).rows[0];
        const payload=structuredClone(original.payload);
        if(bad==="future")payload.operationEnvelope.schemaVersion=99;
        if(bad==="legacy")delete payload.operationEnvelope;
        if(bad==="poison")payload.operationEnvelope.nativePlan.data.body.summary="Unadmitted B";
        // Admin-only owned fixture INSERT of a version/corpus from a different host.
        await pool.query("DELETE FROM reference_operations WHERE id=$1",[ids.operationId]);
        const cols=Object.keys(original),values=cols.map(name=>name==="payload"?payload:original[name]);
        await pool.query(`INSERT INTO reference_operations(${cols.map(name=>`"${name}"`).join(",")}) VALUES(${cols.map((_,i)=>`$${i+1}`).join(",")})`,values);
        const saved=hash(payload);await run("deliver",ids.operationId);
        const value=await store.inspectOperation(ids.operationId);assert.equal(value.status,"hold");assert.equal(hash(value.payload),saved);assert.equal(requests,0);assert.equal(writes,0);
      });
    }
    console.log(`Reference real child-process/HTTP/PostgreSQL: ${cases} cases passed without Musubi DB/auth/config env or tables`);
  } finally {
    for(const child of children)child.kill("SIGKILL");
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool.end();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",[name]);
    await admin.query(`DROP DATABASE "${name}"`);await admin.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
