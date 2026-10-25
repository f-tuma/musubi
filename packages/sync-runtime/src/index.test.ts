import "./delete.test";
import "./create.test";
import "./microsoft-delete.test";
import "./caldav-delete.test";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { SyncOperationEnvelopeSchema } from "@musubi/types";
import type { GoogleRequestMetric } from "@musubi/provider-google";
import {
  runClaimedGooglePersonalUpdate, compareGooglePersonalUpdateShadow, evaluateGooglePersonalUpdateFact, SyncRuntimeHostError,
  type ClaimedGooglePersonalUpdate, type GooglePersonalUpdateHostPorts, type GoogleRuntimeProviderPorts,
  type GooglePersonalUpdatePolicy, type RuntimeNativeFacts, type RuntimeFinishOutcome, type RuntimeRecordedFrame,
  type RuntimeDecisionContext, type GoogleTimedProjection, validateRuntimeAttemptOptions,
} from "./index";
const reference: GooglePersonalUpdatePolicy = { completion: "exact-readback", ambiguousRecovery: "within-attempt", compareContent: "literal",
  untouchedPreflight: true, nativeProfile: "strict-reference", observeConflict: false };
const musubi: GooglePersonalUpdatePolicy = { completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty",
  untouchedPreflight: false, nativeProfile: "existing-google", observeConflict: true };
const projection: GoogleTimedProjection = { title: "New", description: null, location: "Room", start: "2026-10-13T08:00:00.000Z",
  end: "2026-10-13T09:00:00.000Z", isAllDay: false, recurrence: null };
const native = (title = "Old", etag = '"before"') => ({ id: "native/event", etag, summary: title, description: null, location: "Room",
  status: "confirmed", eventType: "default", start: { dateTime: projection.start }, end: { dateTime: projection.end }, organizer: { self: true } });
const response = (value: unknown, status = 200, headers?: Record<string,string>) => new Response(JSON.stringify(value), { status, headers });
const calendar = () => response({ id: "native/calendar", accessRole: "writer" });
const deferred = <T>() => { let resolve!: (value:T) => void; const promise = new Promise<T>(yes => { resolve=yes; }); return { promise, resolve }; };
function fixture(responses: (Response|Error)[], policy: GooglePersonalUpdatePolicy = reference) {
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "update", version: 1 },
    serializer: { id: "google-personal-event", version: 1 }, commandId: "command:one", operationId: "operation:one", hostObjectId: "object:one",
    locator: { provider: "google", connectionId: "logical:account", collectionId: "native/calendar", resourceId: "native/event" },
    sourceEpoch: { sourceId: "source:one", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:one", allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: { ...projection } }, nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: { summary: "New" } } } });
  const input: ClaimedGooglePersonalUpdate = { operationId: envelope.operationId, attemptId: "attempt:one", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "update", operationId: envelope.operationId, commandId: envelope.commandId, hostObjectId: envelope.hostObjectId,
      provider: "google", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: envelope.locator.resourceId,
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account-row", connectionGeneration: "11", calendarId: "native/calendar", eventId: "native/event" },
    acceptedEtag: '"before"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
  const calls: {url:string;init:RequestInit}[] = [], metrics: GoogleRequestMetric[] = [], evidence: RuntimeNativeFacts[] = [], finishes: RuntimeFinishOutcome[] = [];
  const frames: RuntimeRecordedFrame[] = [], contexts: RuntimeDecisionContext[] = [], acknowledgements: unknown[] = [];
  let credentials=0, renewals=0, marks=0, identifiers=0, time=0;
  const host: GooglePersonalUpdateHostPorts = {
    async renew() { renewals++; return true; },
    accountSession: { async open(connection) { credentials++; return { ...connection, accessToken: "CREDENTIAL_NOT_IN_RESULTS", eventWriteAllowed: true }; } },
    async beforeMutation() { marks++; }, async recordEvidence(facts) { evidence.push(facts); },
    async ack(value) { acknowledgements.push(value); return {kind:"acknowledged"}; }, async finish(value) { finishes.push(value); },
    observationId() { return `observation:${++identifiers}`; }, recordDecision(context, frame) { contexts.push(context);frames.push(frame); },
  };
  const ports: GoogleRuntimeProviderPorts = {
    http: { async fetch(url,init) { calls.push({url,init}); const item=responses.shift();if(!item)throw new Error("Unexpected owned dispatch");if(item instanceof Error)throw item;return item; } },
    clock: { nowEpochMs:()=>Date.parse("2026-10-13T00:00:00Z"),nowMonotonicMs:()=>time+=5 },telemetry:{record(m){metrics.push(m);}},
  };
  const run = (options={}) => runClaimedGooglePersonalUpdate(input,host,ports,policy,options);
  return {input,host,ports,calls,metrics,evidence,finishes,frames,contexts,acknowledgements,run,counts:()=>({credentials,renewals,marks,identifiers})};
}

test("one core preserves each host's deliberate completion wire sequence and physical identity", async()=>{
  const ordinary=fixture([calendar(),response(native()),response({etag:'"after"'})],musubi);
  assert.equal((await ordinary.run()).status,"acked");assert.deepEqual(ordinary.calls.map(c=>c.init.method),["GET","GET","PATCH"]);
  assert.equal((ordinary.acknowledgements[0] as any).kind,"provider-response");assert.equal(ordinary.evidence.at(-1)!.remote.kind,"unobserved");
  const exact=fixture([calendar(),response(native()),response({etag:'"after"'}),response(native("New",'"after"'))]);
  assert.equal((await exact.run()).status,"acked");assert.deepEqual(exact.calls.map(c=>c.init.method),["GET","GET","PATCH","GET"]);
  assert.equal((exact.acknowledgements[0] as any).kind,"exact-readback");assert.equal(exact.evidence.at(-1)!.remote.kind,"confirmed");
  for(const f of[ordinary,exact]){
    assert.equal(f.metrics.length,f.calls.length);assert.equal(f.counts().marks,1);
    assert.equal(new Headers(f.calls[2]!.init.headers).get("if-match"),'"before"');
    assert.deepEqual(JSON.parse(f.calls[2]!.init.body as string),{summary:"New"});
    assert.ok(!JSON.stringify(await Promise.resolve(f.frames)).includes("CREDENTIAL_NOT_IN_RESULTS"));
  }
});

test("Musubi response ACK retains a nullable native validator without extra GET",async()=>{
  const f=fixture([calendar(),response(native()),response({})],musubi);
  assert.equal((await f.run()).status,"acked");assert.equal((f.acknowledgements[0] as any).validator,null);assert.equal(f.calls.length,3);
});

test("unknown/legacy/binding/plan/specialized envelopes HOLD before prepare, credentials, network and renewal",async()=>{
  for(const mutate of[(i:any)=>{i.payload.operationEnvelope.schemaVersion=2;},(i:any)=>{delete i.payload.operationEnvelope;},
    (i:any)=>{i.binding.collectionId="wrong";},(i:any)=>{i.payload.operationEnvelope.nativePlan.data.body.summary="Poison";},
    (i:any)=>{i.payload.operationEnvelope.admittedProjection.data.isAllDay=true;},(i:any)=>{i.nativeTarget.eventId="other";}]){
    const f=fixture([]);let prepared=0;f.host.prepare=async()=>{prepared++;return{acceptedEtag:'"before"'};};mutate(f.input);
    assert.equal((await f.run()).status,"hold");assert.equal(prepared,0);assert.equal(f.calls.length,0);
    assert.deepEqual(f.counts(),{credentials:0,renewals:0,marks:0,identifiers:0});assert.equal(f.finishes.length,1);
  }
});

test("saved native data, row binding, prior evidence and policy snapshot precede asynchronous prepare",async()=>{
  const policy={...reference},f=fixture([calendar(),response(native()),response({etag:'"after"'}),response(native("New",'"after"'))],policy);
  const entered=deferred<void>(),resume=deferred<void>();f.host.prepare=async()=>{entered.resolve();await resume.promise;return{acceptedEtag:'"before"'};};
  const pending=f.run();await entered.promise;
  (f.input.payload as any).operationEnvelope.nativePlan.data.body.summary="Late B";
  (f.input.payload as any).operationEnvelope.admittedProjection.data.title="Late B";
  f.input.binding.collectionId="late" as any;(f.input.nativeTarget as any).eventId="late";policy.completion="provider-response";
  resume.resolve();assert.equal((await pending).status,"acked");assert.equal(f.calls.length,4);
  assert.deepEqual(JSON.parse(f.calls[2]!.init.body as string),{summary:"New"});assert.ok(f.calls[2]!.url.endsWith("native%2Fevent"));
});

test("successor validator resolved by host.prepare stays inside the single lifecycle",async()=>{
  const f=fixture([calendar(),response(native("Old",'"successor"')),response({etag:'"after"'})],musubi);
  f.host.prepare=async()=>({acceptedEtag:'"successor"'});assert.equal((await f.run()).status,"acked");
  assert.equal(new Headers(f.calls[2]!.init.headers).get("if-match"),'"successor"');
});

test("literal and nullable-empty recovery policies remain separate",async()=>{
  for(const [policy,expected]of[[musubi,"acked"],[reference,"conflict"]]as const){
    const f=fixture([response({...native("New",'"after"'),description:""})],policy);
    (f.input.recovery as any).required=true;(f.input.recovery as any).possibleDispatch=true;
    (f.input as any).priorProvider={kind:"uncertain"};assert.equal((await f.run()).status,expected);assert.equal(f.calls.length,1);
  }
});

test("existing Google untouched-preflight policy accepts native DATE endpoints while strict reference refuses",async()=>{
  const observed={...native(),start:{date:"2026-10-13"},end:{date:"2026-10-14"}};
  const old=fixture([calendar(),response(observed),response({etag:'"after"'})],musubi);
  assert.equal((await old.run()).status,"acked");assert.equal(old.calls.length,3);
  const strict=fixture([calendar(),response(observed)]);assert.equal((await strict.run()).status,"conflict");assert.equal(strict.counts().marks,0);
  const recovery=fixture([response(observed),calendar(),response(observed),response({etag:'"after"'})],musubi);
  (recovery.input.recovery as any).required=true;(recovery.input.recovery as any).possibleDispatch=true;
  assert.equal((await recovery.run()).status,"acked");assert.equal(recovery.calls.length,4);
});

test("ambiguous reply is deferred in Musubi and observed within the same reference budget",async()=>{
  const old=fixture([calendar(),response(native()),new Error("lost")],musubi);
  assert.equal((await old.run()).status,"hold");assert.equal(old.calls.length,3);assert.equal(old.finishes[0]!.facts.provider.kind,"uncertain");
  const exact=fixture([calendar(),response(native()),new Error("lost"),response(native("New",'"after"'))]);
  assert.equal((await exact.run()).status,"acked");assert.equal(exact.calls.length,4);
  assert.equal(exact.evidence.at(-1)!.provider.kind,"uncertain");assert.equal(exact.evidence.at(-1)!.remote.kind,"confirmed");
});

test("HTTP 412 conflict observation is a host policy, never a second mutation",async()=>{
  for(const policy of[musubi,reference]){
    const f=fixture([calendar(),response(native()),response({},412),...(policy.observeConflict?[response(native())]:[])],policy);
    assert.equal((await f.run()).status,"conflict");assert.equal(f.calls.filter(c=>c.init.method==="PATCH").length,1);
    assert.equal(f.calls.length,policy.observeConflict?4:3);assert.equal(f.finishes[0]!.facts.provider.kind,"rejected");
    if(f.finishes[0]!.facts.provider.kind==="rejected")assert.deepEqual(f.finishes[0]!.facts.provider.error,{code:"conflict",retry:"never"});
  }
});

test("rate limit and reconnect native rejections preserve typed retry metadata",async()=>{
  const limited=fixture([calendar(),response(native()),response({},429,{"retry-after":"120"})]);
  assert.equal((await limited.run()).status,"hold");assert.equal(limited.finishes[0]!.retryAfterMs,120_000);
  assert.deepEqual((limited.finishes[0]!.facts.provider as any).error,{code:"rate-limited",retry:"after-delay",retryAfterMs:120_000});
  for(const status of[401,403]){
    const f=fixture([calendar(),response(native()),response({},status)]);assert.equal((await f.run()).status,"hold");
    assert.equal(f.finishes[0]!.retryAfterMs,Infinity);assert.deepEqual((f.finishes[0]!.facts.provider as any).error,{code:"permission-denied",retry:"after-reconnect"});
  }
});

test("observation failure preserves a known native rejection, acceptance or uncertainty",async()=>{
  for(const prior of[{kind:"accepted",validator:'"accepted"'}, {kind:"uncertain"},
    {kind:"rejected",error:{code:"rate-limited",retry:"after-delay",retryAfterMs:1000}}]as const){
    const f=fixture([response({},429,{"retry-after":"30"})]);(f.input as any).priorProvider=prior;
    (f.input.recovery as any).required=true;(f.input.recovery as any).possibleDispatch=true;
    assert.equal((await f.run()).status,"hold");assert.deepEqual(f.finishes[0]!.facts.provider,prior);
  }
});

test("known rejection plus fresh confirmed target may converge without fabricating acceptance",async()=>{
  const f=fixture([response(native("New",'"externally-fulfilled"'))]);(f.input.recovery as any).required=true;
  (f.input.recovery as any).possibleDispatch=true;(f.input as any).priorProvider={kind:"rejected",error:{code:"rate-limited",retry:"after-delay",retryAfterMs:1000}};
  assert.equal((await f.run()).status,"acked");assert.equal(f.calls.length,1);assert.equal(f.evidence[0]!.provider.kind,"rejected");
});

test("ignored AbortSignal GET returns within deadline and detached continuation cannot use another capability",async()=>{
  const f=fixture([]),late=deferred<Response>();f.ports.http.fetch=async(url,init)=>{f.calls.push({url,init});return late.promise;};
  const start=Date.now();const result=await f.run({timeoutMs:20,heartbeatMs:5});assert.ok(Date.now()-start<500);assert.equal(result.status,"hold");
  const renewed=f.counts().renewals;assert.equal(f.finishes.length,1);assert.equal(f.calls.length,1);
  late.resolve(calendar());await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(f.counts().renewals,renewed);assert.equal(f.calls.length,1);assert.equal(f.evidence.length,0);assert.equal(f.acknowledgements.length,0);assert.equal(f.finishes.length,1);
});

test("ignored AbortSignal PATCH cannot gain a late ACK, evidence, recovery GET or second finish",async()=>{
  const f=fixture([calendar(),response(native())]),late=deferred<Response>();const fetch=f.ports.http.fetch;
  f.ports.http.fetch=async(url,init)=>{if(init.method!=="PATCH")return fetch(url,init);f.calls.push({url,init});return late.promise;};
  const result=await f.run({timeoutMs:20});assert.equal(result.status,"hold");assert.equal(result.facts.provider.kind,"uncertain");assert.equal(f.finishes.length,1);
  late.resolve(response({etag:'"late"'}));await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(f.calls.length,3);assert.equal(f.evidence.length,0);assert.equal(f.acknowledgements.length,0);assert.equal(f.finishes.length,1);
});

test("lease loss bounds a noncooperating transport with exactly one lifecycle",async()=>{
  const f=fixture([]);f.host.renew=async()=>false;f.ports.http.fetch=async(url,init)=>{f.calls.push({url,init});return new Promise<Response>(()=>{});};
  const result=await f.run({timeoutMs:100,heartbeatMs:5});assert.equal(result.error!.interruption,"lease-lost");assert.equal(f.calls.length,1);assert.equal(f.finishes.length,1);
});

test("prepare ignoring cancellation cannot send a later request or claim another time budget",async()=>{
  const f=fixture([]),resume=deferred<{acceptedEtag:string}>();f.host.prepare=async()=>resume.promise;
  const result=await f.run({timeoutMs:20});assert.equal(result.status,"hold");resume.resolve({acceptedEtag:'"before"'});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.calls.length,0);assert.equal(f.acknowledgements.length,0);assert.equal(f.finishes.length,1);
});

test("known atomic ACK wins timeout while the losing finish waits, including finish rejection",async()=>{
  for(const failFinish of[false,true]){
    const f=fixture([calendar(),response(native()),response({etag:'"after"'})],musubi),commit=deferred<void>(),ackReturned=deferred<void>();
    f.host.ack=async()=>{await commit.promise;ackReturned.resolve();return{kind:"acknowledged"};};
    f.host.finish=async outcome=>{f.finishes.push(outcome);commit.resolve();await ackReturned.promise;await Promise.resolve();if(failFinish)throw new Error("Losing finish failed");};
    const result=await f.run({timeoutMs:20});assert.equal(result.status,"acked");assert.equal(f.finishes.length,1);
  }
});

test("post-ACK ignored checkpoint is bounded and cannot downgrade committed truth",async()=>{
  const f=fixture([calendar(),response(native()),response({etag:'"after"'})],musubi);
  f.host.checkpoint=async phase=>{if(phase==="afterAck")await new Promise<void>(()=>{});};
  assert.equal((await f.run({timeoutMs:20})).status,"acked");assert.equal(f.finishes.length,0);
});

test("host errors retain only validated typed metadata and never raw causes/messages in results",async()=>{
  const f=fixture([]);f.host.accountSession.open=async()=>{throw new SyncRuntimeHostError({code:"safe-permission",outcome:"not-written",providerStatus:403,
    retryAfterMs:17.5,capability:"event-write",evidence:"denied"});};
  const result=await f.run();assert.deepEqual(result.error,{code:"safe-permission",outcome:"not-written",phase:"credentials",providerStatus:403,retryAfterMs:17.5,capability:"event-write",evidence:"denied"});
  assert.equal(f.calls.length,0);assert.equal(f.finishes[0]!.retryAfterMs,18);
  const raw=fixture([]);raw.host.accountSession.open=async()=>{throw new Error("RAW_SECRET_MUST_STAY_LOCAL");};
  const sanitized=await raw.run();assert.ok(!JSON.stringify(sanitized).includes("RAW_SECRET"));assert.ok(!JSON.stringify(sanitized.trace).includes("physical"));
});

test("literal boundary validation invokes no coercion/getter hooks",async()=>{
  const f=fixture([]),policy:any={...reference};let invoked=0;
  policy.completion={toString(){invoked++;return"exact-readback";}};
  assert.equal((await runClaimedGooglePersonalUpdate(f.input,f.host,f.ports,policy)).status,"hold");assert.equal(invoked,0);assert.equal(f.calls.length,0);
});

test("pure shadow replays native facts under one host policy and receives zero capabilities",async()=>{
  const f=fixture([calendar(),response(native()),response({etag:'"after"'})],musubi);assert.equal((await f.run()).status,"acked");
  const before={calls:f.calls.length,counts:f.counts(),evidence:f.evidence.length,acks:f.acknowledgements.length,finish:f.finishes.length};
  const report=compareGooglePersonalUpdateShadow(f.contexts[0]!,f.frames);assert.equal(report.matches,true);assert.ok(report.compared>=2);
  const corrupted=f.frames.map(frame=>({...frame,authoritative:{decision:"hold" as const}}));
  assert.deepEqual(compareGooglePersonalUpdateShadow(f.contexts[0]!,corrupted).mismatches,["decision"]);
  assert.deepEqual({calls:f.calls.length,counts:f.counts(),evidence:f.evidence.length,acks:f.acknowledgements.length,finish:f.finishes.length},before);
  assert.deepEqual(compareGooglePersonalUpdateShadow(f.contexts[0]!,Array(33).fill(f.frames[0])).mismatches,["too-many-frames"]);
  assert.ok(!JSON.stringify(report).includes("New"));
});

test("same native empty content deliberately differs under the two host compare policies",()=>{
  const fact={kind:"recovery-read" as const,read:{kind:"present" as const,event:{...native("New",'"after"'),description:""},etag:'"after"'}};
  const base={projection,acceptedEtag:'"before"',body:{summary:"New"}};
  assert.equal(evaluateGooglePersonalUpdateFact({...base,policy:musubi},fact).decision,"confirmed");
  assert.equal(evaluateGooglePersonalUpdateFact({...base,policy:reference},fact).decision,"conflict");
});

test("private diagnostic failures and invalid timer options do not add effects",async()=>{
  const f=fixture([calendar(),response(native()),response({etag:'"after"'})],musubi);f.host.recordDecision=()=>{throw new Error("diagnostic failed");};
  assert.equal((await f.run()).status,"acked");assert.equal(f.calls.length,3);
  const untouched=fixture([]);await assert.rejects(untouched.run({timeoutMs:0}),RangeError);assert.equal(untouched.finishes.length,0);
});

test("runtime dependency boundary contains no storage/auth/env/product DTO imports",()=>{
  for(const name of readdirSync(new URL("./",import.meta.url)).filter(name=>name.endsWith(".ts")&&!name.endsWith(".test.ts"))){
    const source=readFileSync(new URL(name,import.meta.url),"utf8");
    assert.doesNotMatch(source,/@musubi\/(?:db|auth|config)|apps\/api|process\.env|(?:Event|Task)Schema|encodeEventV1|encodeTaskV1/);
  }
  const deps=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).dependencies;
  assert.deepEqual(Object.keys(deps).sort(),["@musubi/provider-caldav","@musubi/provider-google","@musubi/provider-microsoft","@musubi/sync-codec","@musubi/types"]);
});


test("credential failure during UPDATE does not become a native PATCH rejection or recovery write",async()=>{
  for(const prior of[{kind:"accepted",validator:'"previous"'},{kind:"uncertain"},
    {kind:"rejected",error:{code:"rate-limited",retry:"after-delay",retryAfterMs:1000}}]as const){
    const f=fixture([response(native()),calendar(),response(native())],reference);
    (f.input.recovery as any).required=true;(f.input.recovery as any).possibleDispatch=true;(f.input as any).priorProvider=prior;
    let opened=0;const open=f.host.accountSession.open;
    f.host.accountSession.open=async(...args)=>{if(++opened===3)throw new SyncRuntimeHostError({code:"host-session-failed",outcome:"unconfirmed",providerStatus:401});return open(...args);};
    const result=await f.run();assert.equal(result.status,"hold");assert.equal(result.error!.phase,"credentials");
    assert.deepEqual(result.facts.provider,prior);assert.equal(f.calls.filter(c=>c.init.method==="PATCH").length,0);assert.equal(f.calls.length,3);
  }
});

test("C01 configurable finite timer bounds remain compatible while defaults stay bounded",()=>{
  assert.deepEqual(validateRuntimeAttemptOptions({timeoutMs:60_000,heartbeatMs:30_000}),{timeoutMs:60_000,heartbeatMs:30_000,signal:undefined});
  assert.equal(validateRuntimeAttemptOptions().timeoutMs,45_000);assert.equal(validateRuntimeAttemptOptions().heartbeatMs,20_000);
  assert.equal(validateRuntimeAttemptOptions({timeoutMs:2_147_483_647}).timeoutMs,2_147_483_647);
  assert.throws(()=>validateRuntimeAttemptOptions({timeoutMs:2_147_483_648}),RangeError);
  assert.throws(()=>validateRuntimeAttemptOptions({heartbeatMs:Infinity}),RangeError);
});


test("negative native decisions are captured for pure shadow without another read or write",async()=>{
  const f=fixture([calendar(),response(native()),response({},412)],reference);
  assert.equal((await f.run()).status,"conflict");
  const failed=f.frames.filter(frame=>frame.fact.kind==="failure");assert.equal(failed.length,1);
  assert.equal(failed[0]!.authoritative.decision,"conflict");
  assert.equal(compareGooglePersonalUpdateShadow(f.contexts[0]!,f.frames).matches,true);assert.equal(f.calls.length,3);
});

test("prior native rejection snapshot survives caller mutation while prepare is waiting",async()=>{
  const f=fixture([response({},429,{"retry-after":"30"})]),started=deferred<void>(),resume=deferred<void>();
  (f.input.recovery as any).required=true;(f.input.recovery as any).possibleDispatch=true;
  (f.input as any).priorProvider={kind:"rejected",error:{code:"rate-limited",retry:"after-delay",retryAfterMs:120_000}};
  f.host.prepare=async()=>{started.resolve();await resume.promise;return{acceptedEtag:'"before"'};};
  const pending=f.run();await started.promise;
  (f.input.priorProvider as any).error.code="conflict";(f.input.priorProvider as any).error.retry="never";
  resume.resolve();const result=await pending;
  assert.deepEqual(result.facts.provider,{kind:"rejected",error:{code:"rate-limited",retry:"after-delay",retryAfterMs:120_000}});
});
