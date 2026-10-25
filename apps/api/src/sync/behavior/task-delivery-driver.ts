import { readFile, stat } from "node:fs/promises";
import { mock } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { TaskSchema, SyncJsonValueSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import type { TaskOutboxRow } from "@musubi/db";
import type { CalendarAdapter, TaskReadEvidence } from "../adapter";

export class TaskDeliveryScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "invalid-arguments" | "unknown-scenario" | "unexpected-port" | "unconsumed-port" | "expectation-mismatch" | "suite-unavailable" | "concurrent-run", message: string) { super(message); this.name = "TaskDeliveryScenarioFailure"; }
}
const text = z.string().max(512);
const projection = z.object({ title: text, notes: text.nullable(), status: z.enum(["needsAction", "completed"]), due: text.nullable() }).strict();
const reference = z.object({ externalTaskId: z.literal("native-task"), etag: text.nullable(), icalUid: z.null() }).strict();
const expectedReference = reference.extend({ externalTaskId: z.literal("native-task").nullable() }).strict();
const dispatch = z.object({ version: z.literal(1), projection, baseline: projection.nullable(), patch: projection.partial() }).strict();
const readStep = z.object({ method: z.literal("readTask"), result: z.object({ ref: reference, projection }).strict().nullable(), mutatePredecessorEtag: text.optional(), waitForAbort: z.boolean().optional() }).strict();
const assertStep = z.object({ method: z.literal("assertTaskWrite") }).strict();
const updateStep = z.object({ method: z.literal("pushTaskUpdate"), result: z.object({ etag: text }).strict() }).strict();
const createStep = z.object({ method: z.literal("pushTaskCreate"), result: reference }).strict();
const deleteStep = z.object({ method: z.literal("pushTaskDelete") }).strict();
const summarySchema = z.object({
  boundary: z.literal("actual-task-delivery-with-fixture-db-and-adapter-ports"),
  events: z.array(text).max(80), adapterCalls: z.array(text).max(8),
  savedProjection: dispatch.nullable(), updatePatch: projection.partial().nullable(),
  updatePlanBody: projection.nullable(), updateTaskTitle: text.nullable(), updateAcceptedEtag: text.nullable(), createPlanBody: projection.nullable(),
  ackCalls: z.number().int().min(0).max(1), ackSignalPassed: z.boolean().nullable(),
  ackSignalSame: z.boolean().nullable(), ackCancelledWait: z.boolean(), ackProjection: projection.nullable(),
  ackRef: reference.nullable(), ackDeletionRef: reference.nullable(), ackExpectedRef: expectedReference.nullable(),
  finishRef: reference.nullable(), finishSnapshot: projection.nullable(),
  finishes: z.array(z.object({ status: text, code: text.nullable(), uncertain: z.boolean() }).strict()).max(1),
  returnedStatus: text,
}).strict();
const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/),
  row: z.object({ action: z.enum(["create", "update", "delete"]), reconciling: z.boolean(), projectionBaseline: projection.nullable(), dispatchProjection: dispatch.nullable(), predecessorRef: reference.optional() }).strict(),
  adapter: z.array(z.discriminatedUnion("method", [readStep, assertStep, updateStep, createStep, deleteStep])).max(8),
  ack: z.object({ result: z.boolean(), requireSignal: z.boolean(), waitForAbort: z.boolean(), inspectExpectedRef: z.boolean() }).strict(),
  returned: z.object({ status: z.enum(["completed", "attempting", "retry", "blocked", "conflict", "unconfirmed"]) }).strict(),
  expected: summarySchema,
}).strict();
const suiteSchema = z.object({ schemaVersion: z.literal(1), driver: z.literal("task-delivery"), scenarios: z.array(scenarioSchema).min(1).max(32) }).strict();
export type TaskDeliveryScenario = z.infer<typeof scenarioSchema>;
export type TaskDeliverySuite = z.infer<typeof suiteSchema>;
export type TaskDeliverySummary = z.infer<typeof summarySchema>;
export function parseTaskDeliverySuite(value: unknown): TaskDeliverySuite {
  // Reject executable/accessor/coercing values before a schema can read a property.
  if (!SyncJsonValueSchema.safeParse(value).success) throw new TaskDeliveryScenarioFailure("invalid-suite", "Expected bounded plain JSON data.");
  const parsed = suiteSchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.scenarios.map(item => item.id)).size !== parsed.data.scenarios.length)
    throw new TaskDeliveryScenarioFailure("invalid-suite", "Task delivery suite does not match schema version 1.");
  return structuredClone(parsed.data);
}
export async function loadTaskDeliverySuite(): Promise<TaskDeliverySuite> {
  const path = new URL("./task-delivery.json", import.meta.url);
  if ((await stat(path)).size > 512_000) throw new TaskDeliveryScenarioFailure("invalid-suite", "Task delivery suite exceeds its size bound.");
  return parseTaskDeliverySuite(JSON.parse(await readFile(path, "utf8")));
}

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef";
const TASK_ID = "abcdef01-abcd-4000-8000-abcdefabcdea";
const TASK = TaskSchema.parse({ id: TASK_ID, creatorID: "fixture-owner", calendarID: "fixture-calendar", originCalendarID: "fixture-calendar",
  revision: 2, title: "Admitted title", description: "Notes", status: "in-process", due: "2026-10-20T14:30:00.123Z",
  start: "2026-10-19T10:00:00.456Z", completedAt: null, priority: 2, percentComplete: 37, sequence: 4, url: "https://example.invalid/task" });
const CAPTURE = { sourceId: "fixture-source", writeGeneration: 1, connectionId: "fixture-physical-account", connectionGeneration: 1, privacyEpoch: "task:0" };
function envelopeFor(action: TaskDeliveryScenario["row"]["action"]) {
  const encoded = encodeTaskV1("google", TASK, undefined, { action, operationId: OPERATION_ID, acceptedAt: "2026-10-20T09:00:00.000Z" });
  return SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action, version: 1 },
  commandId: "fixture-command", operationId: OPERATION_ID, hostObjectId: TASK_ID,
  locator: { provider: "google", connectionId: "fixture-account", collectionId: "musubi-google-task-list:fixture-list", resourceId: action === "create" ? null : "native-task" },
  sourceEpoch: { sourceId: CAPTURE.sourceId, generation: CAPTURE.writeGeneration }, acceptedRevision: 2, privacyEpoch: CAPTURE.privacyEpoch,
  allowedSideEffects: ["provider-content-write"], ...encoded });
}
function fixtureRow(scenario: TaskDeliveryScenario): TaskOutboxRow & { reconciling: boolean } {
  return { id: OPERATION_ID, actorID: "fixture-owner", mutationID: "fixture-command", position: 0, taskID: TASK_ID, revision: 2,
    calendarID: "fixture-calendar", externalCalendarLinkID: CAPTURE.sourceId, provider: "google", userID: "fixture-owner", accountID: "fixture-account",
    externalCalendarID: "musubi-google-task-list:fixture-list", externalTaskID: scenario.row.action === "create" ? null : "native-task", expectedEtag: scenario.row.action === "create" ? null : '"accepted"', icalUid: null,
    providerAccessRevision: 1, retiredGeneration: 0, action: scenario.row.action, predecessorID: null,
    payload: { task: structuredClone(TASK), projectionBaseline: structuredClone(scenario.row.projectionBaseline),
      ...(scenario.row.dispatchProjection ? { dispatchProjection: structuredClone(scenario.row.dispatchProjection) } : {}),
      operationCapture: structuredClone(CAPTURE), operationEnvelope: envelopeFor(scenario.row.action) },
    status: "attempting", attempts: 1, attemptedAt: new Date(0), leaseToken: "fixture-lease", leaseUntil: new Date(120_000),
    nextAttemptAt: new Date(0), uncertain: scenario.row.reconciling, resultRef: scenario.row.action === "create" && scenario.row.reconciling ? { externalTaskId: "native-task", etag: '"written"', icalUid: null } : null, remoteSnapshot: null,
    errorCode: null, createdAt: new Date(0), updatedAt: new Date(0), reconciling: scenario.row.reconciling } as TaskOutboxRow & { reconciling: boolean };
}
interface ActiveFixture {
  scenario: TaskDeliveryScenario; row: ReturnType<typeof fixtureRow>; summary: TaskDeliverySummary;
  steps: TaskDeliveryScenario["adapter"]; signal?: AbortSignal; fatal?: TaskDeliveryScenarioFailure;
  ackSettled?: Promise<void>;
  lateReadSettled?: Promise<void>;
  predecessorRef?: { externalTaskId: string | null; etag: string | null; icalUid: null };
}
let active: ActiveFixture | undefined;
function port(name: string): ActiveFixture {
  if (!active) throw new TaskDeliveryScenarioFailure("unexpected-port", "No task delivery fixture owns this port.");
  active.summary.events.push(name);
  return active;
}
function unexpected(name: string): never {
  const fixture = port(`unexpected:${name}`);
  const error = new TaskDeliveryScenarioFailure("unexpected-port", "An unplanned dependency port was called.");
  fixture.fatal ??= error;
  throw error;
}
const dbExports = {
  claimTaskOutbox(id: string) { const fixture = port("db.claim"); if (id !== OPERATION_ID) return unexpected("claim-identity"); return fixture.row; },
  decodeTaskOutboxOperation(row: TaskOutboxRow) { port("db.decode"); return realDecode(row); },
  assertPinnedOutboxSource(_row: unknown, allowDeleted: boolean) { port(`db.pinned:${allowDeleted}`); return true; },
  getTaskOutbox() { const fixture = port("db.get"); return { id: OPERATION_ID, ...structuredClone(fixture.scenario.returned) }; },
  getTaskOutboxPredecessorEvidence() { const fixture = port("db.predecessor"); fixture.predecessorRef = fixture.scenario.row.predecessorRef ? structuredClone(fixture.scenario.row.predecessorRef) : { externalTaskId: fixture.row.externalTaskID, etag: fixture.row.expectedEtag, icalUid: null };
    return { ref: fixture.predecessorRef, projectionBaseline: structuredClone(fixture.scenario.row.projectionBaseline) }; },
  renewTaskOutboxLease() { port("db.renew"); return true; },
  assertTaskOutboxDeliverySource(_row: unknown, allowDeleted: boolean) { port(`db.source:${allowDeleted}`); return true; },
  setTaskOutboxProjection(_id: string, _lease: string, saved: unknown) { const fixture = port("db.save-projection"); fixture.summary.savedProjection = structuredClone(saved) as TaskDeliverySummary["savedProjection"]; return true; },
  finishTaskOutbox(_id: string, _lease: string, status: string, code: string | null, details: { uncertain: boolean; resultRef?: unknown; remoteSnapshot?: unknown }) {
    const fixture = port("db.finish"); fixture.summary.finishes.push({ status, code, uncertain: details.uncertain });
    fixture.summary.finishRef = structuredClone(details.resultRef ?? null) as TaskDeliverySummary["finishRef"];
    fixture.summary.finishSnapshot = structuredClone(details.remoteSnapshot ?? null) as TaskDeliverySummary["finishSnapshot"];
    return true;
  },
  async acceptTaskOutboxDelivery(_row: unknown, _lease: unknown, evidence: TaskReadEvidence | null, deletionRef: unknown, signal?: AbortSignal, expectedRef?: unknown) {
    const fixture = port("db.ack"), summary = fixture.summary;
    summary.ackCalls++;
    summary.ackProjection = structuredClone(evidence?.projection ?? null) as TaskDeliverySummary["ackProjection"];
    summary.ackRef = structuredClone(evidence?.ref ?? null) as TaskDeliverySummary["ackRef"];
    summary.ackDeletionRef = structuredClone(deletionRef ?? null) as TaskDeliverySummary["ackDeletionRef"];
    if (fixture.scenario.ack.inspectExpectedRef) summary.ackExpectedRef = structuredClone(expectedRef ?? null) as TaskDeliverySummary["ackExpectedRef"];
    if (fixture.scenario.ack.requireSignal) { summary.ackSignalPassed = signal instanceof AbortSignal; summary.ackSignalSame = !!signal && signal === fixture.signal; }
    if (fixture.scenario.ack.waitForAbort) {
      // This is an abort-aware fixture ACK port, not a DB/transaction simulator.
      if (!(signal instanceof AbortSignal)) return false;
      let settled!: () => void;
      fixture.ackSettled = new Promise<void>(resolve => { settled = resolve; });
      try {
        await new Promise<never>((_resolve, reject) => {
          const aborted = () => { summary.ackCancelledWait = true; reject(signal.reason); };
          if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
        });
      } finally { settled(); }
    }
    return fixture.scenario.ack.result;
  },
  getOAuthCredentials: () => unexpected("getOAuthCredentials"),
  hasProviderSyncScopes: () => unexpected("hasProviderSyncScopes"),
};
// Node's module mocking replaces existing exported ports BEFORE either app DB or
// config module can execute. No .env, SQL, auth or network fallback is loaded.
mock.module(new URL("../../../../../packages/db/src/index.ts", import.meta.url), { namedExports: dbExports });
mock.module(new URL("../../../../../packages/config/src/index.ts", import.meta.url), { namedExports: { config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} } } });
const { decodeTaskOutboxOperation: realDecode } = await import("../../../../../packages/db/src/queries/outbox-operation");
const { deliverTaskOutbox } = await import("../task_delivery");
function adapterStep(method: TaskDeliveryScenario["adapter"][number]["method"], signal?: AbortSignal) {
  const fixture = port(`adapter.${method}`);
  fixture.summary.adapterCalls.push(method);
  const step = fixture.steps.shift();
  if (!step || step.method !== method) return unexpected(`adapter-${method}`);
  if (!(signal instanceof AbortSignal) || fixture.signal && fixture.signal !== signal) return unexpected("delivery-signal");
  fixture.signal = signal;
  return { fixture, step };
}
export async function runTaskDeliveryScenario(input: TaskDeliveryScenario): Promise<TaskDeliverySummary> {
  if (active) throw new TaskDeliveryScenarioFailure("concurrent-run", "Task module fixtures must run serially.");
  const scenario = parseTaskDeliverySuite({ schemaVersion: 1, driver: "task-delivery", scenarios: [input] }).scenarios[0]!;
  const summary: TaskDeliverySummary = { boundary: "actual-task-delivery-with-fixture-db-and-adapter-ports", events: [], adapterCalls: [],
    savedProjection: null, updatePatch: null, updatePlanBody: null, updateTaskTitle: null, updateAcceptedEtag: null, createPlanBody: null,
    ackCalls: 0, ackSignalPassed: null, ackSignalSame: null, ackCancelledWait: false, ackProjection: null, ackRef: null, ackDeletionRef: null, ackExpectedRef: null,
    finishRef: null, finishSnapshot: null, finishes: [], returnedStatus: "unavailable" };
  const fixture: ActiveFixture = { scenario, row: fixtureRow(scenario), summary, steps: structuredClone(scenario.adapter) };
  const originalFetch = globalThis.fetch;
  active = fixture;
  globalThis.fetch = async () => unexpected("ambient-network");
  const adapter: Partial<CalendarAdapter> = {
    projectTask: () => unexpected("legacy-mapper"),
    async readTask(_user, _account, _calendar, _ref, signal) {
      const { step } = adapterStep("readTask", signal);
      if (step.method !== "readTask") return unexpected("read-receipt");
      if (step.mutatePredecessorEtag !== undefined && fixture.predecessorRef) fixture.predecessorRef.etag = step.mutatePredecessorEtag;
      if (step.waitForAbort) {
        // A deliberately late adapter receipt ignores cancellation. The real
        // executor must stop it from reaching ACK after its attempt expires.
        let settled!: () => void;
        fixture.lateReadSettled = new Promise<void>(resolve => { settled = resolve; });
        await new Promise<void>(resolve => {
          const reply = () => setImmediate(resolve);
          if (signal!.aborted) reply(); else signal!.addEventListener("abort", reply, { once: true });
        });
        port("fixture.late-read-return"); settled();
      }
      return structuredClone(step.result);
    },
    async assertTaskWrite(_user, _account, _calendar, operation) { adapterStep("assertTaskWrite", operation.signal); },
    async pushTaskUpdate(_user, _account, _calendar, taskId, task, ref, patch, signal, nativePlan) {
      const { step } = adapterStep("pushTaskUpdate", signal);
      if (step.method !== "pushTaskUpdate" || taskId !== "native-task") return unexpected("update-receipt");
      summary.updatePatch = structuredClone(patch ?? null) as TaskDeliverySummary["updatePatch"];
      summary.updatePlanBody = nativePlan?.planKind === "json-body" ? structuredClone(nativePlan.body) as TaskDeliverySummary["updatePlanBody"] : null;
      summary.updateTaskTitle = task.title; summary.updateAcceptedEtag = ref?.etag ?? null;
      // The adapter write port invokes the real host mutation/lease fence.
      await ref?.beforeMutation?.();
      return structuredClone(step.result);
    },
    async pushTaskCreate(_user, _account, _calendar, _task, mark, signal, nativePlan) {
      const { step } = adapterStep("pushTaskCreate", signal);
      if (step.method !== "pushTaskCreate") return unexpected("create-receipt");
      summary.createPlanBody = nativePlan?.planKind === "json-body" ? structuredClone(nativePlan.body) as TaskDeliverySummary["createPlanBody"] : null;
      await mark?.(); return structuredClone(step.result);
    },
    async pushTaskDelete(_user, _account, _calendar, _taskId, ref, signal) { adapterStep("pushTaskDelete", signal); await ref?.beforeMutation?.(); },
  };
  try {
    const result = await deliverTaskOutbox(OPERATION_ID, () => adapter as CalendarAdapter,
      { timeoutMs: scenario.ack.waitForAbort || scenario.adapter.some(step => step.method === "readTask" && step.waitForAbort) ? 30 : 5_000, heartbeatMs: 10_000 });
    await fixture.ackSettled;
    await fixture.lateReadSettled;
    await new Promise<void>(resolve => setImmediate(resolve));
    summary.returnedStatus = result?.status ?? "unavailable";
    if (fixture.fatal) throw fixture.fatal;
    if (fixture.steps.length) throw new TaskDeliveryScenarioFailure("unconsumed-port", "Planned adapter receipts were not consumed.");
    if (!isDeepStrictEqual(summary, scenario.expected)) {
      const differing = Object.keys(summary).filter(key => !isDeepStrictEqual(summary[key as keyof TaskDeliverySummary], scenario.expected[key as keyof TaskDeliverySummary]));
      throw new TaskDeliveryScenarioFailure("expectation-mismatch", `Task delivery evidence differs in: ${differing.join(", ")}.`);
    }
    return summary;
  } finally { globalThis.fetch = originalFetch; active = undefined; }
}
