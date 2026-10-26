import { referenceTestDatabaseName } from "../conformance/database-name.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { ReferenceStore, ReferenceHoldError } from "./store.js";
import { acceptedEnvelope, initialReceipt, projection } from "./admission.js";
import type { ReferenceDeleteAdmission, ReferenceClaim, ReferenceContent } from "./model.js";

const adminUrl = process.env.REFERENCE_DATABASE_URL ?? (process.env.ENVIRONMENT === "test" ? process.env.DATABASE_URL : undefined);
if (!adminUrl) throw new Error("Explicit independent or disposable test DB required");
const databaseName = referenceTestDatabaseName("reference_delete_");
const database = new URL(adminUrl); database.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const pool = new Pool({ connectionString: database.href, max: 4 });
const key = "ab".repeat(32), store = new ReferenceStore(pool, key);
const content: ReferenceContent = { name: "Original", notes: null, place: "Room", beginsAt: "2026-10-13T08:00:00.000Z", endsAt: "2026-10-13T09:00:00.000Z" };
const scope = "https://www.googleapis.com/auth/calendar.events";
let legacy: Awaited<ReturnType<typeof fixture>>, legacyPayload: unknown, legacyReceipt: unknown, oldOids: unknown;
async function fixture() {
  const nonce = randomUUID(), ids = { connectionId: `connection:${nonce}`, objectId: `object:${nonce}`, bindingId: `binding:${nonce}`, calendarId: `calendar/${nonce}`, eventId: `event/${nonce}` };
  await store.seedBinding({ ...ids, accessToken: "own-reference-token", expiresAt: "2099-01-01T00:00:00.000Z", scope, content, etag: '"old"' });
  const input: ReferenceDeleteAdmission = { bindingId: ids.bindingId, expectedRevision: 1, commandId: `command:${nonce}`, operationId: `operation:${nonce}` };
  return { ...ids, input };
}
async function claimed() { const f = await fixture(); await store.admitDelete(f.input); const claim = await store.claim(f.input.operationId, randomUUID()); assert(claim); return { ...f, claim }; }
async function absence(claim: ReferenceClaim, provider: "accepted" | "uncertain" | "not-dispatched" = "accepted") {
  if (provider !== "not-dispatched") await store.markDispatch(claim);
  await store.recordEvidence(claim, { provider, ...(provider === "accepted" ? { acceptanceStatus: 204 as const } : {}), remote: "confirmed", observationId: randomUUID() });
}
const complete = (claim: ReferenceClaim, signal?: AbortSignal) => store.completeDelete(claim, { kind: "exact-absence", read: { kind: "absent", status: 404 } }, signal);
before(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  // Start from the literal old standalone C05/C06 migration and nonempty history.
  await pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  legacy = await fixture();
  const input = { ...legacy.input, patch: { name: "Old accepted" } };
  const admitted = acceptedEnvelope(input, { ...content, name: "Old accepted" }, { ...legacy, capture: { connectionGeneration: 1, sourceGeneration: 1, privacyGeneration: 1, acceptedRevision: 2 } });
  legacyPayload = { operationEnvelope: admitted }; legacyReceipt = { ...initialReceipt(admitted), provider: { kind: "accepted", validator: { kind: "etag", value: '"old-accepted"' } } };
  await pool.query("UPDATE reference_objects SET revision=2,content=$2 WHERE id=$1", [legacy.objectId, { ...content, name: "Old accepted" }]);
  await pool.query(`INSERT INTO reference_operations(id,command_id,binding_id,object_id,connection_id,calendar_id,event_id,accepted_revision,connection_generation,source_generation,privacy_generation,accepted_etag,fingerprint,payload,receipt,dispatch_possible)
    VALUES($1,$2,$3,$4,$5,$6,$7,2,1,1,1,'"old"','old-fingerprint',$8,$9,true)`, [legacy.input.operationId, legacy.input.commandId, legacy.bindingId, legacy.objectId, legacy.connectionId, legacy.calendarId, legacy.eventId, legacyPayload, legacyReceipt]);
  await pool.query("INSERT INTO reference_attempts(id,operation_id,receipt,recovery,dispatch_possible) VALUES('legacy-attempt',$1,$2,true,true)", [legacy.input.operationId, legacyReceipt]);
  oldOids = (await pool.query("SELECT oid,relname FROM pg_class WHERE relname IN ('reference_connections','reference_objects','reference_bindings','reference_operations','reference_attempts') ORDER BY relname")).rows;
  await store.migrate();
});
after(async () => { await pool.end(); try { await admin.query(`DROP DATABASE "${databaseName}"`); } finally { await admin.end(); } });

test("old migration upgrades and replays preserving five table identities, UPDATE rows, attempts, FKs and checks", async () => {
  await store.migrate(); await store.migrate();
  assert.deepEqual((await pool.query("SELECT oid,relname FROM pg_class WHERE relname IN ('reference_connections','reference_objects','reference_bindings','reference_operations','reference_attempts') ORDER BY relname")).rows, oldOids);
  const op = await store.inspectOperation(legacy.input.operationId); assert.equal(op.action,"update"); assert.deepEqual(op.payload,legacyPayload); assert.deepEqual(op.receipt,legacyReceipt);
  assert.equal(op.dispatchPossible,true); assert.equal(op.capture.canonicalGeneration,1); assert.equal(op.canonical.lifecycle,"active"); assert.equal(op.binding.destinationLifecycle,"present");
  assert.equal((await pool.query("SELECT count(*) FROM reference_attempts WHERE operation_id=$1",[legacy.input.operationId])).rows[0].count,"1");
  assert.equal((await pool.query("SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid IN ('reference_bindings'::regclass,'reference_operations'::regclass,'reference_attempts'::regclass)")).rows[0].count,"6");
  await assert.rejects(pool.query("INSERT INTO reference_objects(id,content,lifecycle_generation) VALUES($1,$2,0)",[randomUUID(),content]));
  await assert.rejects(pool.query("UPDATE reference_operations SET action='delete' WHERE id=$1",[legacy.input.operationId]),/immutable/);
});
test("DELETE CAS atomically tombstones canonical object and captures the post-CAS incarnation with immutable action/address", async () => {
  const f = await fixture(); const op = await store.admitDelete(f.input);
  assert.equal(op.action,"delete"); assert.equal(op.capture.acceptedRevision,2); assert.equal(op.capture.canonicalGeneration,2);
  assert.deepEqual(op.canonical,{lifecycle:"tombstoned",generation:2,revision:2}); assert.equal(op.binding.destinationLifecycle,"present");
  assert.equal((await store.admitDelete(f.input)).operationId,op.operationId);
  for(const field of ["action='update'","canonical_generation=3","source_generation=3","event_id='elsewhere'","payload='{}'::jsonb"]) await assert.rejects(pool.query(`UPDATE reference_operations SET ${field} WHERE id=$1`,[op.operationId]),/immutable/);
  await assert.rejects(store.admitDelete({...f.input,operationId:randomUUID()}),/command-reused/);
});
test("revision conflict and one-pending UPDATE/DELETE causal barrier never leave a tombstone", async () => {
  const f = await fixture(); await assert.rejects(store.admitDelete({...f.input,expectedRevision:2}),/revision-conflict/);
  await store.admitUpdate({...f.input,patch:{name:"A"}});
  await assert.rejects(store.admitDelete({...f.input,expectedRevision:2,commandId:randomUUID(),operationId:randomUUID()}),/causal-barrier/);
  assert.equal((await pool.query("SELECT canonical_lifecycle FROM reference_objects WHERE id=$1",[f.objectId])).rows[0].canonical_lifecycle,"active");
});
test("concurrent DELETE revision-CAS admits exactly one intent", async () => {
  const f=await fixture();const results=await Promise.allSettled([store.admitDelete(f.input),store.admitDelete({...f.input,commandId:randomUUID(),operationId:randomUUID()})]);
  assert.equal(results.filter(result=>result.status === "fulfilled").length,1); assert.equal((await pool.query("SELECT count(*) FROM reference_operations WHERE binding_id=$1",[f.bindingId])).rows[0].count,"1");
});
test("typed absence ACK atomically marks destination absent and retains historical validator/baseline", async () => {
  const f=await claimed();await absence(f.claim);assert.equal(await complete(f.claim),true);
  const op=await store.inspectOperation(f.input.operationId);assert.equal(op.status,"acked");assert.equal(op.binding.destinationLifecycle,"absent");
  assert.equal(op.binding.etag,'"old"');assert.deepEqual(op.binding.baseline,projection(content));assert.equal(op.receipt.provider.kind,"accepted");assert.equal(op.deleteAcceptanceStatus,204);
  assert.equal(op.canonical.lifecycle,"tombstoned");assert.equal(await store.claim(op.operationId,randomUUID()),null);assert.equal((await store.admitDelete(f.input)).status,"acked");
  await assert.rejects(store.admitUpdate({...f.input,expectedRevision:2,commandId:randomUUID(),operationId:randomUUID(),patch:{name:"B"}}),/lifecycle-unavailable/);
  await store.migrate();assert.equal((await store.inspectOperation(op.operationId)).binding.destinationLifecycle,"absent");
});
test("initial GET-only absence ACK retains not-dispatched and no invented ETag/status", async () => {
  const f=await claimed();await absence(f.claim,"not-dispatched");assert.equal(await complete(f.claim),true);
  const op=await store.inspectOperation(f.input.operationId);assert.equal(op.receipt.provider.kind,"not-dispatched");assert.equal(op.deleteAcceptanceStatus,null);assert.equal(op.dispatchPossible,false);
});
test("accepted DELETE rejects fake validator, untyped absence, or UPDATE completion", async () => {
  const f=await claimed();await store.markDispatch(f.claim);
  await assert.rejects(store.recordEvidence(f.claim,{provider:"accepted",validator:'"fake"',remote:"confirmed"}),/invalid-protocol-evidence/);
  await assert.rejects(store.recordEvidence(f.claim,{provider:"accepted",remote:"confirmed"}),/invalid-protocol-evidence/);
  await assert.rejects(store.completeDelete(f.claim,{kind:"exact-absence",read:{kind:"absent",status:200}} as never),/invalid-protocol-absence/);
  assert.equal(await store.complete(f.claim,{etag:'"fake"',projection:projection(content)}),false);
  assert.equal((await store.inspectOperation(f.input.operationId)).status,"running");
});
for(const axis of ["canonical","source","privacy","connection"] as const) test(`DELETE ${axis} ABA refuses dispatch and ACK while retaining native evidence`,async()=>{
  const f=await claimed();await absence(f.claim);
  if(axis === "canonical") {await pool.query("UPDATE reference_objects SET canonical_lifecycle='active' WHERE id=$1",[f.objectId]);await pool.query("UPDATE reference_objects SET canonical_lifecycle='tombstoned',revision=2,lifecycle_generation=2 WHERE id=$1",[f.objectId]);}
  if(axis === "source") {await store.changeBinding(f.bindingId,{active:false});await store.changeBinding(f.bindingId,{active:true});}
  if(axis === "privacy") {await store.changePrivacy(f.objectId,"public");await store.changePrivacy(f.objectId,"private");}
  if(axis === "connection") {await store.changeConnection(f.connectionId,{status:"retired"});await store.changeConnection(f.connectionId,{status:"active"});}
  await assert.rejects(store.markDispatch(f.claim),/authority-changed/);assert.equal(await complete(f.claim),false);
  const op=await store.inspectOperation(f.input.operationId);assert.equal(op.binding.destinationLifecycle,"present");assert.equal(op.receipt.provider.kind,"accepted");
  if(axis === "canonical") {assert.equal(op.canonical.generation,4);assert.equal(op.canonical.revision,4);}
});
test("destination presence ABA advances source generation and fences an admitted tombstone",async()=>{
  const f=await claimed();await pool.query("UPDATE reference_bindings SET destination_lifecycle='absent' WHERE id=$1",[f.bindingId]);await pool.query("UPDATE reference_bindings SET destination_lifecycle='present',source_generation=1 WHERE id=$1",[f.bindingId]);
  await assert.rejects(store.markDispatch(f.claim),/authority-changed/);assert.equal((await store.inspectOperation(f.input.operationId)).binding.sourceGeneration,3);
});
test("rejected possible DELETE dispatch survives claim and externally fulfilled absence without another write",async()=>{
  const f=await claimed();await store.markDispatch(f.claim);await store.recordEvidence(f.claim,{provider:"rejected",remote:"unobserved",error:{code:"rate-limited",retry:"after-delay",retryAfterMs:120000}});await store.finish(f.claim);
  const next=await store.claim(f.input.operationId,randomUUID());assert(next);assert.equal(next.recovery,true);assert.equal(next.receipt.provider.kind,"rejected");
  await store.recordEvidence(next,{provider:"uncertain",remote:"confirmed",observationId:"external-absence"});assert.equal(await complete(next),true);
  assert.equal((await store.inspectOperation(f.input.operationId)).receipt.provider.kind,"rejected");
});
test("stale lease cannot ACK absent or overwrite newer operation receipt; its native evidence remains on old attempt",async()=>{
  const f=await claimed();await store.markDispatch(f.claim);await pool.query("UPDATE reference_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.input.operationId]);
  const next=await store.claim(f.input.operationId,randomUUID());assert(next);
  assert.equal(await store.recordEvidence(f.claim,{provider:"accepted",acceptanceStatus:204,remote:"confirmed",observationId:"old-absence"}),false);assert.equal(await complete(f.claim),false);
  const op=await store.inspectOperation(f.input.operationId);assert.equal(op.binding.destinationLifecycle,"present");assert.equal(op.receipt.provider.kind,"uncertain");assert.equal(op.deleteAcceptanceStatus,null);
  assert.equal((await pool.query("SELECT delete_acceptance_status FROM reference_attempts WHERE id=$1",[f.claim.attemptId])).rows[0].delete_acceptance_status,204);
});
test("DELETE admission snapshots before waiting pool acquisition",async()=>{
  const f=await fixture(),single=new Pool({connectionString:database.href,max:1}),held=await single.connect(),isolated=new ReferenceStore(single,key);let released=false;
  try {const input={...f.input};const pending=isolated.admitDelete(input);await pause(20);assert.equal(single.waitingCount,1);input.bindingId="other";input.expectedRevision=99;input.commandId="other";input.operationId="other";held.release();released=true;
    const op=await pending;assert.equal(op.operationId,f.input.operationId);assert.equal(op.capture.acceptedRevision,2);
  }finally{if(!released)held.release();await single.end();}
});
test("DELETE evidence, completion and finish snapshot caller fields before waiting pool acquisition",async()=>{
  const f=await claimed(),single=new Pool({connectionString:database.href,max:1}),isolated=new ReferenceStore(single,key);
  try {
    let held=await single.connect();const evidence={provider:"accepted" as const,acceptanceStatus:204 as const,remote:"confirmed" as const,observationId:"A"};const dto={...f.claim};
    const recording=isolated.recordEvidence(dto,evidence);await pause(20);assert.equal(single.waitingCount,1);(dto as any).operationId="other";(dto as any).attemptId="other";(evidence as any).acceptanceStatus=404;held.release();assert.equal(await recording,true);assert.equal((await store.inspectOperation(f.input.operationId)).deleteAcceptanceStatus,204);
    held=await single.connect();const observation={kind:"exact-absence" as const,read:{kind:"absent" as const,status:404 as const}};const completing=isolated.completeDelete(f.claim,observation);await pause(20);(observation.read as any).kind="present";held.release();assert.equal(await completing,true);
    const other=await claimed();held=await single.connect();const finish={code:"A",retryAfterMs:60000};const finishing=isolated.finish(other.claim,"hold",finish);await pause(20);finish.retryAfterMs=0;held.release();assert.equal(await finishing,true);assert.equal(await store.claim(other.input.operationId,randomUUID()),null);
  }finally{await single.end();}
});
test("DELETE ACK cancellation while waiting authority lock rolls back before COMMIT",async()=>{
  const f=await claimed();await absence(f.claim);const blocker=await pool.connect();const cancellation=new AbortController();let blocked=false;
  try {await blocker.query("BEGIN");blocked=true;await blocker.query("SELECT id FROM reference_connections WHERE id=$1 FOR UPDATE",[f.connectionId]);
    const pending=complete(f.claim,cancellation.signal);await pause(30);cancellation.abort(new Error("Owned cancellation"));await blocker.query("COMMIT");blocked=false;await assert.rejects(pending,/Owned cancellation/);
    const op=await store.inspectOperation(f.input.operationId);assert.equal(op.status,"running");assert.equal(op.binding.destinationLifecycle,"present");assert.equal(op.receipt.remote.kind,"confirmed");
  }finally{if(blocked)await blocker.query("ROLLBACK");blocker.release();}
});
test("known committed DELETE ACK wins later caller cancellation",async()=>{
  const f=await claimed();await absence(f.claim);const cancellation=new AbortController();assert.equal(await complete(f.claim,cancellation.signal),true);cancellation.abort();assert.equal((await store.inspectOperation(f.input.operationId)).status,"acked");
});

test("UPDATE requires active canonical object and present destination at session, dispatch and ACK",async()=>{
  for(const axis of ["canonical","destination"]){
    const f=await fixture();await store.admitUpdate({...f.input,patch:{name:"Updated"}});const claim=await store.claim(f.input.operationId,randomUUID());assert(claim);
    await store.markDispatch(claim);await store.recordEvidence(claim,{provider:"accepted",validator:'"after"',remote:"confirmed",observationId:"update-read"});
    if(axis === "canonical")await pool.query("UPDATE reference_objects SET canonical_lifecycle='tombstoned' WHERE id=$1",[f.objectId]);
    else await pool.query("UPDATE reference_bindings SET destination_lifecycle='absent' WHERE id=$1",[f.bindingId]);
    await assert.rejects(store.getSession(claim,Date.now()),/authority-changed/);await assert.rejects(store.markDispatch(claim),/authority-changed/);
    assert.equal(await store.complete(claim,{etag:'"after"',projection:projection({...content,name:"Updated"})}),false);
    assert.equal((await store.inspectOperation(f.input.operationId)).binding.etag,'"old"');
  }
});
test("DELETE admission snapshots caller identity before waiting on a real PostgreSQL object lock",async()=>{
  const f=await fixture(),blocker=await pool.connect();let blocked=false;
  try{await blocker.query("BEGIN");blocked=true;await blocker.query("SELECT id FROM reference_objects WHERE id=$1 FOR UPDATE",[f.objectId]);const input={...f.input};const pending=store.admitDelete(input);await pause(30);
    input.bindingId="other";input.expectedRevision=99;input.commandId="other";input.operationId="other";await blocker.query("COMMIT");blocked=false;
    const op=await pending;assert.equal(op.operationId,f.input.operationId);assert.equal(op.capture.canonicalGeneration,2);assert.equal(op.canonical.lifecycle,"tombstoned");
  }finally{if(blocked)await blocker.query("ROLLBACK");blocker.release();}
});
test("connection and binding patch DTOs snapshot before blocked pool acquisition",async()=>{
  const f=await fixture(),single=new Pool({connectionString:database.href,max:1}),isolated=new ReferenceStore(single,key);let held=await single.connect(),released=false;
  try{
    const patch={status:"retired" as const};const changing=isolated.changeConnection(f.connectionId,patch);await pause(20);assert.equal(single.waitingCount,1);(patch as any).status="active";held.release();released=true;await changing;
    assert.equal((await pool.query("SELECT status FROM reference_connections WHERE id=$1",[f.connectionId])).rows[0].status,"retired");
    held=await single.connect();released=false;const source={active:false,eventId:"A"};const changingSource=isolated.changeBinding(f.bindingId,source);await pause(20);source.active=true;source.eventId="B";held.release();released=true;await changingSource;
    const binding=(await pool.query("SELECT active,event_id FROM reference_bindings WHERE id=$1",[f.bindingId])).rows[0];assert.deepEqual(binding,{active:false,event_id:"A"});
  }finally{if(!released)held.release();await single.end();}
});
