import assert from "node:assert/strict";
import { test } from "node:test";
import { EventSchema } from "@musubi/types";
import { runClaimedEventCompatibility } from "./event-compatibility";
import type { EventCompatibilityFamily, EventCompatibilityHostPorts, EventCompatibilityNativePorts, EventCompatibilityPreparation, EventCompatibilityCompletion, EventCompatibilityFacts } from "./event-compatibility-ports";
import type { NormalizedEvent } from "./event-compatibility-types";

class NativeFailure extends Error { constructor(readonly code: string, readonly outcome: "not-written" | "unconfirmed" = "not-written") { super(code); } }
function fixture(family: EventCompatibilityFamily = "generic") {
  const event = EventSchema.parse({ id: "event", creatorID: "owner", calendars: ["calendar"], title: "Accepted", color: "#112233", organizer: "owner",
    start: "2026-10-26T10:11:12.123Z", end: "2026-10-26T11:12:13.456Z", isAllDay: false, isCanceled: false });
  const ref = { externalEventId: "native", etag: '"v1"' }, calls: string[] = [], completions: EventCompatibilityCompletion[] = [], failures: EventCompatibilityFacts[] = [];
  const observation: NormalizedEvent = { externalId: "native", status: "active", title: event.title, start: event.start, end: event.end, isAllDay: false,
    description: null, location: null, organizer: "owner", recurrence: null, url: null, etag: '"v2"' };
  const prepared: EventCompatibilityPreparation = { family, profile: "shared-host-compatibility", operationId: "operation", provider: family.startsWith("caldav") ? "caldav" : "google",
    action: "update", attempts: 1, reconciling: false, event, priorDispatch: false, caldavDispatchPossible: false, expectedRef: ref, canReadEvent: false, skipConflictRead: false,
    generic: { expected: event, saveProjection: false, identity: false, predecessor: false, findCreated: true, patch: { title: event.title } } };
  const claim = { reconciling: false, caldavDispatchPossible: false };
  const host: EventCompatibilityHostPorts = {
    async prepare() { calls.push("prepare"); return prepared; },
    async prepareNative(family, capture) { calls.push(`prepareNative:${family}`); capture(ref); }, nativeRef: () => ref,
    async confirm(kind) { calls.push(`confirm:${kind}`); return true; },
    async checkDestination(uncertain) { calls.push(`destination:${uncertain}`); return true; },
    async mark(kind, accepted) { calls.push(`mark:${kind}:${accepted}`); return true; },
    async complete(input) { calls.push(`complete:${input.family}`); completions.push(input); return true; },
    async stop(kind) { calls.push(`stop:${kind}`); return true; },
    async expectedRef() { calls.push("expectedRef"); return ref; }, async saveProjection() { calls.push("saveProjection"); return true; },
    async acceptedUpdate() { return null; }, knownCreateId: () => undefined, deletedCreate: async () => false, matches: () => true,
    prepareGraphFamilyObservation() { calls.push("prepareFamilyObservation"); }, async finish(input) { calls.push(`finish:${input.code}`); },
    async fail(_error, facts) { calls.push("fail"); failures.push(facts); }, failure: (code, outcome) => new NativeFailure(code, outcome),
    errorInfo: error => error instanceof NativeFailure ? error : undefined, sameAcceptedVersion: (expected, actual) => expected.etag === actual.etag,
    async renew() { calls.push("renew"); return true; }, now: () => 0,
  };
  const native: EventCompatibilityNativePorts = {
    async read(input) { calls.push(`read:${input.family}`); return { ref, event: observation, state: undefined }; },
    async deliver(input) { calls.push(`deliver:${input.family}`); if ("mark" in input) await input.mark(); if ("accepted" in input) await input.accepted?.();
      return { kind: "observed", observation: { ref: { ...ref, etag: '"v2"' }, event: observation } }; },
    async preflight(event) { calls.push("preflight"); assert.equal(event.start.toISOString(), "2026-10-26T10:11:12.123Z"); },
  };
  return { event, observation, ref, prepared, claim, host, native, calls, completions, failures,
    run: () => runClaimedEventCompatibility(claim, host, native) };
}

for (const family of ["graphOccurrenceContent", "graphMeetingCancellation", "organizer", "reminderInstance", "graphSeriesDeletion", "graphSeriesCreate", "caldavAlarm", "caldavSplit", "caldavSeriesDeletion", "caldavSeries", "googleOccurrence", "microsoftRsvp", "caldavRsvp", "googleRsvp", "reminderEdit", "generic"] as const)
  test(`${family} executes its actual claimed lifecycle through separated typed ports`, async () => {
    const f = fixture(family), result = await f.run();
    assert.equal(result.settled, true); assert.equal(f.failures.length, 0); assert.equal(f.completions[0]?.family, family);
    assert.equal(f.calls[0], "prepare"); assert(f.calls.indexOf(`complete:${family}`) > 0);
    if (["graphOccurrenceContent", "graphMeetingCancellation", "organizer"].includes(family)) {
      assert(f.calls.includes(`mark:${family}:false`)); assert(f.calls.includes(`mark:${family}:true`));
    }
    if (family === "graphSeriesCreate") { assert(f.calls.includes("prepareFamilyObservation")); assert.equal(result.facts.resultRef, null, "No master-only durable ref is fabricated"); }
    if (["caldavSplit", "caldavSeries", "caldavSeriesDeletion"].includes(family)) assert.equal(result.facts.mutationStarted, true, "Historical pessimistic uncertainty remains distinct from native HTTP acceptance");
  });

test("original recovery metadata is snapshotted before asynchronous preparation", async () => {
  const f = fixture(), prepare = f.host.prepare;
  f.host.prepare = async signal => { f.claim.reconciling = true; return prepare(signal); };
  const result = await f.run(); assert(f.calls.includes("destination:false")); assert.equal(f.calls.includes("destination:true"), false, "Caller mutation does not change original pre-dispatch recovery authority");
  assert.equal(result.facts.mutationStarted, true);
});

test("native preflight cannot poison canonical Dates or the writer's original content", async () => {
  const f = fixture(), preflight = f.native.preflight, deliver = f.native.deliver;
  f.native.preflight = async (...args) => {
    await preflight(...args); args[0].title = "Injected preflight"; args[0].start.setTime(0);
    f.prepared.event.title = "Injected caller"; f.prepared.event.start.setTime(0);
  };
  f.native.deliver = async input => { if (input.family === "generic") { assert.equal(input.event.title, "Accepted"); assert.equal(input.event.start.toISOString(), "2026-10-26T10:11:12.123Z"); } return deliver(input, new AbortController().signal); };
  assert.equal((await f.run()).settled, true);
});

test("committed completion remains authoritative when cancellation races its return", async () => {
  const f = fixture(), controller = new AbortController();
  f.host.complete = async input => { f.completions.push(input); controller.abort(); return true; };
  const result = await runClaimedEventCompatibility(f.claim, f.host, f.native, { signal: controller.signal });
  assert.equal(result.settled, true); assert.equal(f.failures.length, 0);
});

test("closed attempts refuse detached native callbacks and late completion", async () => {
  const f = fixture("organizer"); let resume!: () => void;
  f.native.deliver = async input => { await new Promise<void>(resolve => { resume = resolve; }); if ("mark" in input) await input.mark(); return { kind: "deleted" }; };
  const result = await runClaimedEventCompatibility(f.claim, f.host, f.native, { timeoutMs: 20 });
  assert.equal(result.settled, false); resume(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => call.startsWith("mark:")), false); assert.equal(f.completions.length, 0); assert.equal(f.failures.length, 1);
});

test("prepared accessors and callbacks are refused without evaluation", async () => {
  for (const mode of ["getter", "callback"] as const) {
    const f = fixture(); let evaluated = 0;
    if (mode === "getter") Object.defineProperty(f.prepared, "event", { enumerable: true, get() { evaluated++; throw new Error("private"); } });
    else Object.assign(f.prepared, { callback() { evaluated++; } });
    assert.equal((await f.run()).settled, false); assert.equal(evaluated, 0); assert.deepEqual(f.calls, ["prepare", "fail"]);
  }
});

for (const [family, kind] of [["organizer", "unconfirmed"], ["organizer", "absent"], ["organizer", "observed"], ["microsoftRsvp", "unconfirmed"], ["microsoftRsvp", "absent"]] as const)
  test(`closed ${family} attempt refuses late ${kind} outcomes without native callbacks`, async () => {
    const f = fixture(family), controller = new AbortController(); let resume!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    for (const [name, port] of Object.entries(f.host)) (f.host as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      f.calls.push(`entry:${name}`); return (port as (...values: unknown[]) => unknown)(...args);
    };
    f.native.deliver = async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return { kind }; };
    const running = runClaimedEventCompatibility(f.claim, f.host, f.native, { signal: controller.signal });
    await ready; controller.abort(); assert.equal((await running).settled, false);
    const closed = [...f.calls]; resume(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, closed, "A late complete native return cannot re-enter any host capability");
    assert.equal(f.failures.length, 1); assert.equal(f.completions.length, 0);
  });

test("closed generic CREATE attempt refuses a late missing-identity observation", async () => {
  const f = fixture(), controller = new AbortController(); let resume!: () => void, entered!: () => void;
  Object.assign(f.prepared, { action: "create", provider: "microsoft", reconciling: true }); Object.assign(f.prepared.generic!, { identity: true });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.native.read = async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return null; };
  const running = runClaimedEventCompatibility(f.claim, f.host, f.native, { signal: controller.signal });
  await ready; controller.abort(); assert.equal((await running).settled, false);
  const closed = [...f.calls]; resume(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, closed); assert.equal(f.failures.length, 1); assert.equal(f.completions.length, 0);
});

test("closed native preparation refuses late reference capture", async () => {
  const f = fixture("googleRsvp"), controller = new AbortController(); let resume!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.host.prepareNative = async (_family, capture) => { entered(); await new Promise<void>(resolve => { resume = resolve; }); capture(f.ref); };
  const running = runClaimedEventCompatibility(f.claim, f.host, f.native, { signal: controller.signal });
  await ready; controller.abort(); const result = await running, closed = [...f.calls]; resume(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, closed); assert.equal(result.facts.expectedRef, null); assert.equal(f.failures.length, 1);
});

test("accepted update metadata is owned separately for read, preflight and writer", async () => {
  const f = fixture(); Object.assign(f.prepared, { reconciling: true });
  const metadata = { operationId: "accepted-operation", attemptId: "accepted-attempt", serializer: { id: "google-personal-event" as const, version: 1 as const }, connectionId: "connection", connectionGeneration: 7 };
  f.host.acceptedUpdate = async () => metadata;
  f.host.matches = kind => kind !== "delivered";
  const contexts: unknown[] = [];
  f.native.read = async input => {
    assert.equal(input.family, "generic"); if (input.family !== "generic") throw new Error("Expected generic read");
    assert.equal(input.acceptedUpdate!.serializer.id, "google-personal-event"); contexts.push(input.acceptedUpdate);
    Object.assign(input.acceptedUpdate!.serializer, { id: "injected-by-read" });
    return { ref: f.ref, event: f.observation };
  };
  f.native.preflight = async (_event, ref, _patch, accepted) => {
    assert.equal(accepted!.serializer.id, "google-personal-event"); contexts.push(accepted);
    Object.assign(accepted!.serializer, { id: "injected-by-preflight" }); ref!.etag = '"poisoned"';
    Object.assign(metadata.serializer, { id: "injected-by-caller" });
  };
  f.native.deliver = async input => {
    assert.equal(input.family, "generic"); if (input.family !== "generic") throw new Error("Expected generic writer");
    assert.equal(input.acceptedUpdate!.serializer.id, "google-personal-event"); assert.equal(input.ref!.etag, '"v1"'); contexts.push(input.acceptedUpdate);
    await input.acceptedUpdate!.beforeMutation(); return { kind: "observed", observation: { ref: f.ref } };
  };
  assert.equal((await f.run()).settled, true);
  assert.equal(new Set(contexts).size, 3); assert(f.calls.includes("renew")); assert.equal(f.completions[0]!.family, "generic");
});

test("accepted metadata accessors are refused before evaluation or native entry", async () => {
  const f = fixture(); let evaluated = 0;
  const metadata = { operationId: "operation", attemptId: "attempt", connectionId: "connection", connectionGeneration: 1 };
  Object.defineProperty(metadata, "serializer", { enumerable: true, get() { evaluated++; return { id: "google-personal-event", version: 1 }; } });
  f.host.acceptedUpdate = async () => metadata as Awaited<ReturnType<typeof f.host.acceptedUpdate>>;
  assert.equal((await f.run()).settled, false); assert.equal(evaluated, 0); assert.equal(f.calls.includes("preflight"), false);
});

test("a durable mark granted after close cannot release native mutation permission", async () => {
  const f = fixture("organizer"), controller = new AbortController(); let resume!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); let nativeMutations = 0;
  f.host.mark = async () => { entered(); await new Promise<void>(resolve => { resume = resolve; }); return true; };
  f.native.deliver = async input => { if (input.family !== "organizer") throw new Error("Expected organizer"); await input.mark(); nativeMutations++; return { kind: "deleted" }; };
  const running = runClaimedEventCompatibility(f.claim, f.host, f.native, { signal: controller.signal });
  await ready; controller.abort(); assert.equal((await running).settled, false);
  resume(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(nativeMutations, 0, "An already-entered durable mark may finish, but a closed callback cannot grant a following native send");
});

for (const family of ["googleOccurrence", "reminderEdit"] as const)
  test(`${family} writer gets a mutable ref without changing its paired original`, async () => {
    const f = fixture(family); let reminderChecks = 0;
    f.host.matches = kind => kind === "reminder-intent" ? reminderChecks++ > 0 : kind !== "occurrence-desired";
    f.native.deliver = async input => {
      if (!("ref" in input) || !input.ref) throw new Error("Expected native ref"); input.ref.etag = '"native-local-change"';
      return { kind: "observed", observation: { ref: { ...f.ref, etag: '"v2"' }, event: f.observation } };
    };
    assert.equal((await f.run()).settled, true);
    assert.equal((f.completions[0] as { expectedRef: typeof f.ref }).expectedRef.etag, '"v1"');
  });
