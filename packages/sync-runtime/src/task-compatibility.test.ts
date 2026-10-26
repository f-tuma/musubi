import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskSchema } from "@musubi/types";
import { runClaimedTaskCompatibility } from "./task-compatibility";
import type { ClaimedTaskCompatibility, ReadyTaskCompatibility, TaskCompatibilityFinish, TaskCompatibilityHostPorts, TaskCompatibilityNativePorts, TaskCompatibilitySavedProjection } from "./task-compatibility-ports";

function fixture(action: ClaimedTaskCompatibility["action"] = "update") {
  const task = TaskSchema.parse({ id: "canonical", creatorID: "owner", calendarID: "home", title: "After",
    due: "2026-10-26T14:45:12.123Z", start: "2026-10-25T10:11:12.456Z", recurrence: "RRULE:FREQ=DAILY;COUNT=3", percentComplete: 37 });
  const baseline = { title: "Before", description: "Untouched" }, target = { ...baseline, title: "After" };
  const prepared: ReadyTaskCompatibility = { kind: "ready", decoded: { kind: "legacy-v0", payload: { task } },
    profile: { kind: "host-only", family: "todo-home", representation: "retained-v0" }, task, authority: "home", dispatchAllowed: true,
    paired: { ref: { externalTaskId: action === "create" ? null : "native", etag: action === "create" ? null : 'W/"v1"', icalUid: null }, projectionBaseline: baseline, hasPredecessor: false },
    projectionBaseline: baseline, target, recovery: { kind: "response-address-only" } };
  const claim: ClaimedTaskCompatibility = { operationId: "operation", attemptId: "claim", action, reconciling: false };
  const calls: string[] = [], finishes: TaskCompatibilityFinish[] = [];
  let reads = 0;
  const host: TaskCompatibilityHostPorts = {
    async prepare() { calls.push("prepare"); return prepared; },
    async saveProjection(saved) { calls.push("save"); assert.deepEqual(saved.patch, { title: "After" }); return true; },
    async renew() { calls.push("renew"); return true; },
    async beforeMutation() { calls.push("mark"); return true; },
    async ack() { calls.push("ack"); return true; },
    async finish(outcome) { finishes.push(outcome); }, classifyError: () => undefined,
  };
  const native: TaskCompatibilityNativePorts = {
    async read(ref) { calls.push("read"); return { ref: { ...ref, etag: reads++ ? 'W/"v2"' : 'W/"v1"' }, projection: reads > 1 ? { title: "After", description: "Provider changed untouched field" } : baseline }; },
    async preflight(request) {
      calls.push("preflight"); assert.equal(request.task.due?.toISOString(), "2026-10-26T14:45:12.123Z");
      assert.equal(request.task.start?.toISOString(), "2026-10-25T10:11:12.456Z");
      assert.equal(request.task.recurrence, "RRULE:FREQ=DAILY;COUNT=3");
    },
    async create(_task, mark) { calls.push("create"); await mark(); return { externalTaskId: "created", etag: undefined }; },
    async update(_task, _ref, patch, mark) { calls.push("update"); assert.deepEqual(patch, { title: "After" }); await mark(); return { etag: 'W/"v2"' }; },
    async delete(_ref, mark) { calls.push("delete"); await mark(); },
  };
  return { claim, prepared, host, native, calls, finishes, run: () => runClaimedTaskCompatibility(claim, host, native) };
}

test("compatibility preserves exact canonical time, home recurrence, saved-mask readback and native call order", async () => {
  const f = fixture(), original = structuredClone(f.prepared.task);
  const result = await f.run();
  assert.equal(result.status, "acknowledged");
  assert.deepEqual(f.calls, ["prepare", "read", "save", "preflight", "update", "mark", "read", "ack"]);
  assert.deepEqual(f.prepared.task, original);
  assert.equal(result.facts.possibleDispatch, true); assert.equal(result.facts.writerFulfilled, true);
  assert.equal("provider" in result.facts, false, "existing writers expose no separate raw HTTP acceptance fact");
});

test("a void DELETE which observes absence is fulfillment without possible dispatch or claimed HTTP acceptance", async () => {
  const f = fixture("delete");
  f.native.delete = async () => { f.calls.push("delete-observed-absence"); };
  f.host.ack = async () => false;
  const result = await f.run();
  assert.equal(result.status, "finished");
  assert.equal(result.facts.writerFulfilled, true); assert.equal(result.facts.possibleDispatch, false);
  assert.equal("provider" in result.facts, false);
  const failed = f.finishes[0]; assert.equal(failed?.kind, "failed");
  if (failed?.kind === "failed") assert.equal(failed.error?.outcome, "unconfirmed", "failed ACK retains the old writer-return uncertainty boundary");
});

test("complete CREATE return keeps its address and optional undefined host fields", async () => {
  const f = fixture("create");
  f.native.read = async ref => ({ ref, projection: { title: "After", description: "Untouched" } });
  const result = await f.run();
  assert.equal(result.status, "acknowledged"); assert.equal(result.facts.writerFulfilled, true);
  assert.deepEqual(result.facts.resultRef, { externalTaskId: "created", etag: undefined });
});

test("target and saved mask stay immutable while a native initial read yields", async () => {
  const f = fixture(), read = f.native.read;
  f.native.read = async (ref, signal) => {
    f.prepared.target.title = "Injected after admission";
    return read(ref, signal);
  };
  assert.equal((await f.run()).status, "acknowledged");
});

test("a detached late preflight cannot invoke a writer after the attempt closes", async () => {
  const f = fixture();
  let resume!: () => void, reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  f.native.preflight = async () => { reached(); await new Promise<void>(resolve => { resume = resolve; }); };
  const pending = runClaimedTaskCompatibility(f.claim, f.host, f.native, { timeoutMs: 20 });
  await waiting; assert.equal((await pending).status, "finished"); resume();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.includes("update"), false); assert.equal(f.calls.includes("mark"), false);
  assert.equal(f.finishes.length, 1);
});

test("committed ACK remains authoritative when cancellation races its return", async () => {
  const f = fixture(), controller = new AbortController();
  f.host.ack = async () => { controller.abort(); return true; };
  const result = await runClaimedTaskCompatibility(f.claim, f.host, f.native, { signal: controller.signal });
  assert.equal(result.status, "acknowledged"); assert.equal(f.finishes.length, 0);
});

for (const source of ["paired", "admitted"] as const) test(`the ${source} baseline is captured before a yielding native read can poison the recovery mask`, async () => {
  const f = fixture(), historical = { title: "Before", description: "Untouched" }, read = f.native.read;
  let saved: TaskCompatibilitySavedProjection | undefined;
  (f.claim as { reconciling: boolean }).reconciling = true;
  if (source === "paired") {
    (f.prepared as { projectionBaseline: null }).projectionBaseline = null;
    Object.assign(f.prepared.paired, { hasPredecessor: true, projectionBaseline: historical });
  } else (f.prepared as { projectionBaseline: object }).projectionBaseline = historical;
  f.host.saveProjection = async value => { saved = value; return true; };
  f.native.read = async (ref, signal) => { historical.title = "After"; return read(ref, signal); };
  const result = await f.run();
  assert.equal(result.status, "acknowledged"); assert.deepEqual(saved?.patch, { title: "After" });
  assert.equal(result.facts.acknowledgementProjection?.title, "After");
  assert.equal(f.calls.filter(call => call === "update").length, 1, "Historical mutation cannot turn an unapplied target into an empty-mask ACK");
});

test("authority and rich canonical task snapshots survive native read and preflight mutations", async () => {
  const f = fixture(), read = f.native.read, preflight = f.native.preflight, update = f.native.update;
  f.native.read = async (ref, signal) => {
    Object.assign(f.prepared, { dispatchAllowed: false, authority: "secondary" });
    f.prepared.task.title = "Injected title"; f.prepared.task.due!.setTime(0);
    return read(ref, signal);
  };
  f.native.preflight = async (request, signal) => {
    assert.equal(request.secondary, false); await preflight(request, signal);
    request.task.title = "Injected by preflight"; request.task.due!.setTime(0);
  };
  f.native.update = async (task, ...args) => {
    assert.equal(task.title, "After"); assert.equal(task.due?.toISOString(), "2026-10-26T14:45:12.123Z");
    assert.equal(task.start?.toISOString(), "2026-10-25T10:11:12.456Z"); assert.equal(task.percentComplete, 37);
    return update(task, ...args);
  };
  assert.equal((await f.run()).status, "acknowledged");
});

for (const source of ["authority", "task", "decoded"] as const) test(`prepared ${source} getters are refused without evaluation or a native call`, async () => {
  const f = fixture(); let evaluations = 0;
  const object = source === "authority" ? f.prepared : source === "task" ? f.prepared.task : f.prepared.decoded;
  const key = source === "authority" ? "dispatchAllowed" : source === "task" ? "title" : "payload";
  Object.defineProperty(object, key, { enumerable: true, get() { evaluations++; throw new Error("Getter must not run"); } });
  const result = await f.run();
  assert.equal(result.status, "finished"); assert.equal(evaluations, 0);
  assert.deepEqual(f.calls, ["prepare"]); assert.equal(f.finishes.length, 1);
});

test("prepared callbacks are refused rather than retained as data", async () => {
  const f = fixture(); let callbacks = 0;
  Object.assign(f.prepared.decoded, { callback() { callbacks++; } });
  assert.equal((await f.run()).status, "finished"); assert.equal(callbacks, 0); assert.deepEqual(f.calls, ["prepare"]);
});

test("retained decoded claim metadata keeps its legacy size and depth floor", async () => {
  const f = fixture(); let deep: unknown = { retained: true };
  for (let depth = 0; depth < 24; depth++) deep = { child: deep };
  assert.equal(f.prepared.decoded.kind, "legacy-v0");
  if (f.prepared.decoded.kind === "legacy-v0") Object.assign(f.prepared.decoded.payload, {
    ignoredMetadata: { deep, entries: Array.from({ length: 257 }, (_, index) => index),
      fields: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`retained${index}`, index])),
      nativeId: "x".repeat(2_049), optional: undefined },
  });
  assert.equal((await f.run()).status, "acknowledged");
});
