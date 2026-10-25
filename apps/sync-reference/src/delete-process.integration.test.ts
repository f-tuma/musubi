import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import type { ReferenceDeleteAdmission, ReferenceContent } from "./model.js";

const key = "ab".repeat(32), content: ReferenceContent = { name: "Own event", notes: null, place: "Room", beginsAt: "2026-10-13T08:00:00.000Z", endsAt: "2026-10-13T09:00:00.000Z" };
const scope = "https://www.googleapis.com/auth/calendar.events";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deferred = () => { let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; };
async function main() {
  const adminUrl=process.env.REFERENCE_DATABASE_URL??(process.env.ENVIRONMENT === "test"?process.env.DATABASE_URL:undefined);assert(adminUrl,"Disposable independent DB required");
  const name=`reference_delete_process_${randomUUID().replace(/-/g,"")}`,database=new URL(adminUrl);database.pathname=`/${name}`;
  const admin=new Pool({connectionString:adminUrl,max:1});await admin.query(`CREATE DATABASE "${name}"`);
  const pool=new Pool({connectionString:database.href,max:4}),store=new ReferenceStore(pool,key),children=new Set<ChildProcess>();
  let calendarId="",eventId="",mode="healthy",absent=false,writes=0,methods:string[]=[],failures:unknown[]=[],metrics=0;
  const server=createServer(async(req,res)=>{
    try{
      methods.push(req.method!);assert.equal(req.headers.authorization,"Bearer own-process-token");
      const url=new URL(req.url!,"http://owned.test"),json=(body:unknown,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));};
      if(url.pathname===`/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`)return json({id:calendarId,accessRole:"owner"});
      assert.equal(url.pathname,`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      const native={id:eventId,etag:mode === "changed"?'"changed"':mode === "weak"?'W/"weak"':'"old"',status:"confirmed",eventType:"default",organizer:{self:true},attendees:[],summary:content.name,description:null,location:content.place,start:{dateTime:content.beginsAt},end:{dateTime:content.endsAt}};
      if(req.method === "GET"){
        if(mode === "cancelled")return json({id:eventId,status:"cancelled"});
        if(absent)return json({},mode === "gone"?410:404);
        if(mode === "missing")delete (native as {etag?:string}).etag;
        return json(native);
      }
      assert.equal(req.method,"DELETE");writes++;assert.equal(req.headers["if-match"],'"old"');let bytes="";for await(const chunk of req)bytes+=chunk;assert.equal(bytes,"");
      if(mode === "reject") {res.setHeader("retry-after","120");return json({},429);}
      absent=true;if(mode === "lost")return res.destroy();res.writeHead(204);res.end();
    }catch(error){failures.push(error);res.statusCode=500;res.end("Owned assertion failed");}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  function child(action:"admit-delete"|"deliver"|"show",operationId:string,admission?:ReferenceDeleteAdmission,pause?:string){
    const checkpoint=deferred();let stdout="",stderr="";
    const proc=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./process_fixture.child.ts",import.meta.url))],{cwd:fileURLToPath(new URL("../",import.meta.url)),env:{PATH:process.env.PATH,REFERENCE_TEST_CHILD:"true",REFERENCE_DATABASE_URL:database.href,REFERENCE_CREDENTIAL_KEY:key},stdio:["pipe","pipe","pipe","ipc"]});children.add(proc);
    const timer=setTimeout(()=>{checkpoint.reject(new Error("Owned process timeout"));proc.kill("SIGKILL");},30000);
    proc.stdout!.on("data",chunk=>stdout+=chunk);proc.stderr!.on("data",chunk=>stderr+=chunk);
    proc.on("message",(message:any)=>{if(message.type === "checkpoint")checkpoint.resolve();if(message.type === "metric")metrics++;});
    const exited=once(proc,"exit").then(([code,signal])=>{clearTimeout(timer);children.delete(proc);return{code,signal,stdout,stderr};});
    proc.stdin!.end(JSON.stringify({action,operationId,admission,pause,fixtureOrigin:origin}));return{proc,checkpoint:checkpoint.promise,exited};
  }
  async function run(action:"admit-delete"|"deliver"|"show",operationId:string,admission?:ReferenceDeleteAdmission){const exit=await child(action,operationId,admission).exited;assert.equal(exit.code,0,exit.stderr);assert.equal(exit.signal,null);assert(!exit.stdout.includes("own-process-token"));return JSON.parse(exit.stdout);}
  async function kill(value:ReturnType<typeof child>){await value.checkpoint;value.proc.kill("SIGKILL");assert.equal((await value.exited).signal,"SIGKILL");}
  const expire=(operationId:string)=>pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second',not_before=NULL WHERE id=$1",[operationId]);
  async function fixture(label:string,body:(ids:{connectionId:string;objectId:string;bindingId:string;input:ReferenceDeleteAdmission})=>Promise<void>){
    mode="healthy";absent=false;writes=0;methods=[];metrics=0;failures=[];const nonce=randomUUID(),ids={connectionId:`conn:${nonce}`,objectId:`own:${nonce}`,bindingId:`binding:${nonce}`};calendarId=`calendar/${nonce}+id`;eventId=`event/${nonce}+id`;
    await store.seedBinding({...ids,calendarId,eventId,accessToken:"own-process-token",expiresAt:"2099-01-01T00:00:00.000Z",scope,content,etag:'"old"'});
    const input={bindingId:ids.bindingId,expectedRevision:1,commandId:`command:${nonce}`,operationId:`operation:${nonce}`};await body({...ids,input});assert.deepEqual(failures,[]);assert.equal(metrics,methods.length);console.log(`Reference DELETE process fixture: ${label}: PASS`);
  }
  async function ack(operationId:string,provider:"accepted"|"uncertain"|"not-dispatched"|"rejected"){
    const op=await store.inspectOperation(operationId);assert.equal(op.status,"acked");assert.equal(op.canonical.lifecycle,"tombstoned");assert.equal(op.binding.destinationLifecycle,"absent");assert.equal(op.binding.etag,'"old"');assert.equal(op.receipt.provider.kind,provider);assert.equal(op.receipt.remote.kind,"confirmed");assert.equal(op.receipt.notification.kind,"not-requested");return op;
  }
  try{
    await store.migrate();
    await fixture("older-uncertain-DELETE-keeps-truth-through-later429-and-GET-absence",async ids=>{
      await run("admit-delete",ids.input.operationId,ids.input);mode="lost";await kill(child("deliver",ids.input.operationId,undefined,"afterUncertain"));const pinned=hash((await store.inspectOperation(ids.input.operationId)).payload);
      absent=false;mode="reject";await expire(ids.input.operationId);assert.equal((await run("deliver",ids.input.operationId)).status,"hold");const held=await store.inspectOperation(ids.input.operationId);assert.equal(held.receipt.provider.kind,"uncertain");assert.equal(held.dispatchPossible,true);assert.equal(await store.claim(ids.input.operationId,randomUUID()),null);
      absent=true;mode="healthy";await expire(ids.input.operationId);const before=methods.length;await run("deliver",ids.input.operationId);await ack(ids.input.operationId,"uncertain");assert.equal(writes,2);assert.deepEqual(methods.slice(before),["GET"]);assert.equal(hash((await store.inspectOperation(ids.input.operationId)).payload),pinned);
    });
    await fixture("prior-accepted-DELETE-status-survives-a-later-lost-conditional-response",async ids=>{
      await run("admit-delete",ids.input.operationId,ids.input);await kill(child("deliver",ids.input.operationId,undefined,"afterAcceptance"));absent=false;mode="lost";await expire(ids.input.operationId);assert.equal((await run("deliver",ids.input.operationId)).status,"acked");const op=await ack(ids.input.operationId,"accepted");assert.equal(op.deleteAcceptanceStatus,204);assert.equal(writes,2);
    });
    await fixture("kill-inside-atomic-tombstone-admission",async ids=>{
      const value=child("admit-delete",ids.input.operationId,ids.input,"admissionCanonical");await value.checkpoint;
      const object=(await pool.query("SELECT revision,canonical_lifecycle FROM reference_objects WHERE id=$1",[ids.objectId])).rows[0];assert.equal(object.revision,"1");assert.equal(object.canonical_lifecycle,"active");await kill(value);
      assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE id=$1",[ids.input.operationId])).rows[0].count,"0");
      await run("admit-delete",ids.input.operationId,ids.input);await run("deliver",ids.input.operationId);await ack(ids.input.operationId,"accepted");assert.equal(writes,1);
    });
    for(const phase of ["afterAdmission","claim","beforeDispatch","afterAcceptance","afterReadback","afterAck"]){
      await fixture(`SIGKILL-restart-${phase}`,async ids=>{
        let value:ReturnType<typeof child>;if(phase === "afterAdmission")value=child("admit-delete",ids.input.operationId,ids.input,phase);else{await run("admit-delete",ids.input.operationId,ids.input);value=child("deliver",ids.input.operationId,undefined,phase);}
        await kill(value);const original=await store.inspectOperation(ids.input.operationId),pinned=hash(original.payload),before=methods.length;await expire(ids.input.operationId);await run("deliver",ids.input.operationId);
        const op=await ack(ids.input.operationId,"accepted");assert.equal(hash(op.payload),pinned);assert.equal(writes,1);
        if(["afterAcceptance","afterReadback"].includes(phase))assert.deepEqual(methods.slice(before),["GET"]);
        if(phase === "afterAck")assert.deepEqual(methods.slice(before),[]);
      });
    }
    await fixture("accepted-DELETE-lost-reply-SIGKILL-restart-GET-only",async ids=>{
      await run("admit-delete",ids.input.operationId,ids.input);mode="lost";await kill(child("deliver",ids.input.operationId,undefined,"afterUncertain"));const before=methods.length;mode="healthy";
      await expire(ids.input.operationId);await run("deliver",ids.input.operationId);await ack(ids.input.operationId,"uncertain");assert.equal(writes,1);assert.deepEqual(methods.slice(before),["GET"]);
    });
    for(const invalid of ["changed","weak","missing"]){await fixture(`restart-${invalid}-present-validator`,async ids=>{
      await run("admit-delete",ids.input.operationId,ids.input);mode="lost";await kill(child("deliver",ids.input.operationId,undefined,"afterUncertain"));const before=methods.length;mode=invalid;absent=false;
      await expire(ids.input.operationId);const result=await run("deliver",ids.input.operationId);assert.notEqual(result.status,"acked");assert.equal(writes,1);assert.deepEqual(methods.slice(before),["GET"]);
      assert.equal((await store.inspectOperation(ids.input.operationId)).binding.destinationLifecycle,"present");
    });}
    for(const absentMode of ["absent","gone","cancelled"]){await fixture(`GET-only-${absentMode}-initial-destination`,async ids=>{
      await run("admit-delete",ids.input.operationId,ids.input);mode=absentMode;absent=true;await run("deliver",ids.input.operationId);await ack(ids.input.operationId,"not-dispatched");assert.equal(writes,0);assert.deepEqual(methods,["GET"]);
    });}
    await fixture("rejected-DELETE-then-external-absence-preserves-rejection",async ids=>{
      await run("admit-delete",ids.input.operationId,ids.input);mode="reject";const initial=await run("deliver",ids.input.operationId);assert.equal(initial.status,"hold");assert.equal(writes,1);
      const before=methods.length;mode="healthy";absent=true;await expire(ids.input.operationId);await run("deliver",ids.input.operationId);await ack(ids.input.operationId,"rejected");assert.equal(writes,1);assert.deepEqual(methods.slice(before),["GET"]);
    });
    await fixture("standalone-admit-delete-and-show-REFERENCE-env-only",async ids=>{
      async function cli(command:string,body:unknown){const proc=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./cli.ts",import.meta.url)),command],{env:{PATH:process.env.PATH,REFERENCE_DATABASE_URL:database.href,REFERENCE_CREDENTIAL_KEY:key},stdio:["pipe","pipe","pipe"]});children.add(proc);let output="",error="";proc.stdout!.on("data",chunk=>output+=chunk);proc.stderr!.on("data",chunk=>error+=chunk);proc.stdin!.end(JSON.stringify(body));const[code]=await once(proc,"exit");children.delete(proc);assert.equal(code,0,error);assert(!output.includes("own-process-token"));return JSON.parse(output);}
      const op=await cli("admit-delete",ids.input);assert.equal(op.action,"delete");const shown=await cli("show",{operationId:ids.input.operationId});assert.equal(shown.canonical.lifecycle,"tombstoned");assert.equal(shown.binding.destinationLifecycle,"present");
    });
    console.log("Reference DELETE independent process crash and CLI proof: PASS");
  }finally{
    for(const child of children)child.kill("SIGKILL");await Promise.all([...children].map(child=>once(child,"exit").catch(()=>{})));server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();try{await admin.query(`DROP DATABASE "${name}"`);}finally{await admin.end();}
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
