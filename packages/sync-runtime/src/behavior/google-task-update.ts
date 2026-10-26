import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { TaskSchema, SyncJsonValueSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { diffGoogleTaskProjection, parseGoogleTaskPatch, type GoogleTaskRequestMetric, type GoogleTaskProjection } from "@musubi/provider-google";
import { runClaimedGoogleTaskUpdate, type GoogleTaskUpdatePolicy, type RuntimeTaskNativeFacts } from "../index";
import { ScenarioFailure } from "./google-delete";
export { ScenarioFailure } from "./google-delete";

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef";
const TASK_ID = "abcdef01-abcd-4000-8000-abcdefabcdea";
const TARGET = { connectionId: "physical-account", connectionGeneration: "1", taskListId: "native/list", taskId: "native/task" };
const TASK_INPUT = { id: TASK_ID, creatorID: "fixture-owner", calendarID: "fixture-home", revision: 2, title: "Admitted title", description: "Notes", status: "in-process",
  due: "2026-10-20T14:30:00.123Z", start: "2026-10-19T10:00:00.456Z", priority: 2, percentComplete: 37 };
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Projection = { title: string; notes: Json; status: string; due: Json };
type Exchange = { method: "GET" | "PATCH"; status?: number; body?: Json; rawBody?: string; headers?: Record<string, string>;
  error?: "lost-reply"; responseUrl?: "exact" | "other"; redirected?: boolean };
export interface GoogleTaskUpdateSummary {
  status: string; methods: string[]; redirects: (string | null)[]; bodies: (Json | null)[]; ifMatch: (string | null)[]; tokens: string[];
  sessions: number; recoveries: number; mutationMarks: number; metrics: (number | string)[]; preparedPatch: Json | null;
  ackKinds: string[]; ackProjection: Json | null; ackValidators: string[]; finishStatuses: string[];
  providerKind: string; validator: string | null; acceptedStatus: number | null; remoteKind: string; possibleDispatch: boolean;
  errorCode: string | null; errorOutcome: string | null; providerStatus: number | null; retryAfterMs: number | null;
}
export interface GoogleTaskUpdateScenario {
  id: string; title: string; policy: "musubi" | "reference"; recovery: boolean; priorProvider: "not-dispatched" | "uncertain" | "accepted";
  acceptedEtag: string | null; priorAcceptedStatus?: 200 | 201 | 204; baseline: Projection | null;
  savedPatch?: Record<string, Json>; taskOverrides?: Record<string, Json>; readRecovery?: boolean; deferred?: boolean;
  predecessorProof?: Record<string, Json> | null; nativeTaskId?: string;
  exchanges: Exchange[]; expected: GoogleTaskUpdateSummary;
}
export interface GoogleTaskUpdateSuite { schemaVersion: 1; driver: "google-task-update"; scenarios: GoogleTaskUpdateScenario[] }
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Google task update suite does not match schema version 1."); };
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key) ||
      !Object.getOwnPropertyDescriptor(item, key)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(item, key)!)) ||
      required.some(key => !Object.prototype.hasOwnProperty.call(item, key))) invalid();
  return item;
}
function choice(value: unknown, values: readonly unknown[]) { if (!values.includes(value)) invalid(); }
function projection(value: unknown) { const item = object(value, ["title", "notes", "status", "due"]); if (typeof item.title !== "string" || typeof item.status !== "string") invalid(); }
function summary(value: unknown) {
  const item = object(value, ["status", "methods", "redirects", "bodies", "ifMatch", "tokens", "sessions", "recoveries", "mutationMarks", "metrics", "preparedPatch", "ackKinds", "ackProjection", "ackValidators", "finishStatuses", "providerKind", "validator", "acceptedStatus", "remoteKind", "possibleDispatch", "errorCode", "errorOutcome", "providerStatus", "retryAfterMs"]);
  choice(item.status, ["acked", "hold", "conflict"]); choice(item.providerKind, ["not-dispatched", "accepted", "uncertain", "rejected"]);
  choice(item.remoteKind, ["unobserved", "confirmed", "conflict"]); choice(item.errorOutcome, [null, "not-written", "unconfirmed"]);
  if (typeof item.possibleDispatch !== "boolean") invalid();
  for (const key of ["methods", "redirects", "bodies", "ifMatch", "tokens", "metrics", "ackKinds", "ackValidators", "finishStatuses"])
    if (!Array.isArray(item[key]) || (item[key] as unknown[]).length > 16) invalid();
  for (const method of item.methods as unknown[]) choice(method, ["GET", "PATCH"]);
  for (const redirect of item.redirects as unknown[]) choice(redirect, [null, "error"]);
  for (const token of item.tokens as unknown[]) choice(token, ["initial", "recovered"]);
  for (const kind of item.ackKinds as unknown[]) choice(kind, ["exact-readback"]);
  for (const status of item.finishStatuses as unknown[]) choice(status, ["hold", "conflict"]);
  for (const body of item.bodies as unknown[]) if (body !== null && !parseGoogleTaskPatch(body)) invalid();
  for (const key of ["redirects", "bodies", "ifMatch", "tokens", "metrics"]) if ((item[key] as unknown[]).length !== (item.methods as unknown[]).length) invalid();
  for (const tag of [...item.ifMatch as unknown[], ...item.ackValidators as unknown[]]) if (tag !== null && (typeof tag !== "string" || tag.length > 128)) invalid();
  for (const metric of item.metrics as unknown[]) if (typeof metric === "number" ? !Number.isInteger(metric) || metric < 100 || metric > 599 : !["network-error", "aborted"].includes(metric as string)) invalid();
  if ((item.ackKinds as unknown[]).length > 1 || (item.finishStatuses as unknown[]).length > 1 || (item.ackValidators as unknown[]).length !== (item.ackKinds as unknown[]).length) invalid();
  if (item.preparedPatch !== null && !parseGoogleTaskPatch(item.preparedPatch)) invalid();
  if (item.ackProjection !== null) projection(item.ackProjection);
  for (const key of ["sessions", "recoveries", "mutationMarks"])
    if (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || (item[key] as number) < 0 || (item[key] as number) > 16) invalid();
  for (const key of ["validator", "errorCode"]) if (item[key] !== null && (typeof item[key] !== "string" || (item[key] as string).length > 128)) invalid();
  if (item.errorCode !== null && !/^[a-z][a-z0-9-]{0,127}$/.test(item.errorCode as string)) invalid();
  choice(item.acceptedStatus, [null, 200, 201, 204]);
  for (const key of ["acceptedStatus", "providerStatus", "retryAfterMs"]) if (item[key] !== null && (typeof item[key] !== "number" || !Number.isFinite(item[key]) || (item[key] as number) < 0)) invalid();
}
export function parseGoogleTaskUpdateSuite(value: unknown): GoogleTaskUpdateSuite {
  if (!SyncJsonValueSchema.safeParse(value).success) invalid();
  const suite = object(value, ["schemaVersion", "driver", "scenarios"]);
  if (suite.schemaVersion !== 1 || suite.driver !== "google-task-update" || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 128) invalid();
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const item = object(raw, ["id", "title", "policy", "recovery", "priorProvider", "acceptedEtag", "baseline", "exchanges", "expected"], ["priorAcceptedStatus", "savedPatch", "taskOverrides", "readRecovery", "deferred", "predecessorProof", "nativeTaskId"]);
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id) || ids.has(item.id)) invalid(); ids.add(item.id as string);
    if (typeof item.title !== "string" || !item.title.length || item.title.length > 160 || /[\u0000-\u001f\u007f]/.test(item.title)) invalid();
    choice(item.policy, ["musubi", "reference"]); choice(item.priorProvider, ["not-dispatched", "uncertain", "accepted"]);
    if (typeof item.recovery !== "boolean" || item.readRecovery !== undefined && typeof item.readRecovery !== "boolean" || item.deferred !== undefined && typeof item.deferred !== "boolean" || !item.recovery && item.priorProvider !== "not-dispatched") invalid();
    if (item.predecessorProof !== undefined && !item.deferred || item.nativeTaskId !== undefined && (!item.deferred || typeof item.nativeTaskId !== "string" || !item.nativeTaskId || item.nativeTaskId.length > 8192)) invalid();
    if (item.predecessorProof != null && (typeof item.predecessorProof !== "object" || Array.isArray(item.predecessorProof))) invalid();
    if (item.acceptedEtag !== null && (typeof item.acceptedEtag !== "string" || item.acceptedEtag.length > 128)) invalid();
    if (item.priorAcceptedStatus !== undefined) { choice(item.priorAcceptedStatus, [200, 201, 204]); if (item.priorProvider !== "accepted") invalid(); }
    if (item.baseline !== null) projection(item.baseline);
    if (item.savedPatch !== undefined && (!parseGoogleTaskPatch(item.savedPatch) || item.baseline === null)) invalid();
    if (item.taskOverrides !== undefined) object(item.taskOverrides, [], ["title", "description", "status", "start", "due", "isAllDay", "completedAt", "percentComplete", "priority"]);
    if (!TaskSchema.safeParse({ ...TASK_INPUT, ...item.taskOverrides as object | undefined }).success) invalid();
    if (!Array.isArray(item.exchanges) || item.exchanges.length > 16) invalid();
    for (const rawExchange of item.exchanges as unknown[]) {
      const exchange = object(rawExchange, ["method"], ["status", "body", "rawBody", "headers", "error", "responseUrl", "redirected"]);
      choice(exchange.method, ["GET", "PATCH"]);
      if (exchange.error !== undefined) { choice(exchange.error, ["lost-reply"]); if (Object.keys(exchange).some(key => !["method", "error"].includes(key))) invalid(); }
      else {
        if (typeof exchange.status !== "number" || !Number.isInteger(exchange.status) || exchange.status < 200 || exchange.status > 599) invalid();
        if (Object.prototype.hasOwnProperty.call(exchange, "body") === Object.prototype.hasOwnProperty.call(exchange, "rawBody")) invalid();
        if (exchange.rawBody !== undefined && (typeof exchange.rawBody !== "string" || exchange.rawBody.length > 512)) invalid();
        if ([204, 205, 304].includes(exchange.status as number) && exchange.body !== null) invalid();
        if (exchange.headers !== undefined) { const headers = object(exchange.headers, [], ["retry-after", "content-range"]); if (Object.values(headers).some(value => typeof value !== "string" || value.length > 128 || /[\r\n\0]/.test(value))) invalid(); }
        if (exchange.responseUrl !== undefined) choice(exchange.responseUrl, ["exact", "other"]);
        if (exchange.redirected !== undefined && typeof exchange.redirected !== "boolean") invalid();
      }
    }
    summary(item.expected);
  }
  return structuredClone(value) as GoogleTaskUpdateSuite;
}
export async function loadGoogleTaskUpdateSuite(): Promise<GoogleTaskUpdateSuite> {
  const file = new URL("./google-task-update.json", import.meta.url);
  if ((await stat(file)).size > 1_000_000) invalid();
  return parseGoogleTaskUpdateSuite(JSON.parse(await readFile(file, "utf8")));
}
export async function runGoogleTaskUpdateScenario(input: GoogleTaskUpdateScenario): Promise<GoogleTaskUpdateSummary> {
  const scenario = parseGoogleTaskUpdateSuite({ schemaVersion: 1, driver: "google-task-update", scenarios: [input] }).scenarios[0]!;
  const task = TaskSchema.parse({ ...TASK_INPUT, ...scenario.taskOverrides });
  const encoded = encodeTaskV1("google", task, undefined, { action: "update", operationId: OPERATION_ID, acceptedAt: "2026-10-25T12:00:00.000Z" });
  const admitted = encoded.admittedProjection.data as GoogleTaskProjection;
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "update", version: 1 }, commandId: "fixture-command", operationId: OPERATION_ID, hostObjectId: TASK_ID,
    locator: { provider: "google", connectionId: "logical-account", collectionId: TARGET.taskListId, resourceId: scenario.deferred ? null : TARGET.taskId },
    ...(scenario.deferred ? { predecessorOperationId: "fixture-create" } : {}),
    sourceEpoch: { sourceId: "fixture-source", generation: 1 }, acceptedRevision: 2, privacyEpoch: "task:0", allowedSideEffects: ["provider-content-write"], ...encoded });
  const saved = scenario.savedPatch === undefined ? undefined : { projection: admitted, baseline: scenario.baseline!, patch: scenario.savedPatch };
  const originalEnvelope = JSON.stringify(envelope);
  const nativeTaskId = scenario.nativeTaskId ?? TARGET.taskId;
  const predecessorProof = scenario.predecessorProof === undefined ? { kind: "predecessor-task-reference", operationId: OPERATION_ID, attemptId: "fixture-attempt",
    predecessorOperationId: "fixture-create", evidenceOperationId: "fixture-create", taskId: nativeTaskId, validator: scenario.acceptedEtag,
    projectionBaseline: scenario.baseline, witness: "fixture-complete-scoped-lineage" } : scenario.predecessorProof;
  const queue = structuredClone(scenario.exchanges), methods: string[] = [], redirects: (string | null)[] = [], bodies: (Json | null)[] = [], ifMatch: (string | null)[] = [], tokens: string[] = [], metrics: GoogleTaskRequestMetric[] = [];
  const acks: { kind: string; projection: Json; validator: string }[] = [], finishes: string[] = [];
  let sessions = 0, recoveries = 0, mutationMarks = 0, time = 0, preparedPatch: Json | null = null, fatal: ScenarioFailure | undefined;
  const session = (connection: { connectionId: string; connectionGeneration: string }, token = "fixture-initial-token") => ({ ...connection, accessToken: token, taskWriteAllowed: true });
  const policy: GoogleTaskUpdatePolicy = { nativeProfile: scenario.policy === "musubi" ? "existing-google" : "strict-reference", readback: scenario.policy === "musubi" ? "saved-patch" : "full-target", ambiguousRecovery: scenario.policy === "musubi" ? "deferred" : "within-attempt" };
  const result = await runClaimedGoogleTaskUpdate({ operationId: OPERATION_ID, attemptId: "fixture-attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "task", action: "update", operationId: OPERATION_ID, commandId: "fixture-command", hostObjectId: TASK_ID, provider: "google", connectionId: "logical-account", collectionId: TARGET.taskListId, resourceId: scenario.deferred ? null : TARGET.taskId, acceptedRevision: 2, predecessorOperationId: scenario.deferred ? "fixture-create" : null },
    collectionIdentity: "native", nativeTarget: { ...TARGET, taskId: scenario.deferred ? null : TARGET.taskId }, acceptedEtag: scenario.acceptedEtag,
    recovery: { required: scenario.recovery, possibleDispatch: scenario.recovery }, priorProvider: scenario.priorProvider === "accepted" ? { kind: "accepted", validator: null } : { kind: scenario.priorProvider },
    ...(scenario.priorAcceptedStatus === undefined ? {} : { priorAcceptedStatus: scenario.priorAcceptedStatus }),
  }, {
    async prepare() { return { acceptedEtag: scenario.acceptedEtag, baseline: scenario.baseline, ...(saved ? { saved } : {}),
      ...(scenario.deferred && predecessorProof !== null ? { predecessorAddress: predecessorProof as unknown as import("../google-task-address-ports").GoogleTaskPredecessorResolution } : {}) }; },
    async prepareProjection(input) { const resolved = input.saved ?? { projection: input.target, baseline: input.baseline, patch: diffGoogleTaskProjection(input.baseline, input.target) }; preparedPatch = structuredClone(resolved.patch) as Json; return resolved; },
    renew: async () => true,
    accountSession: { open: async connection => { sessions++; return session(connection); },
      ...(scenario.readRecovery ? { recoverRejectedRead: async (connection: { connectionId: string; connectionGeneration: string }) => { recoveries++; return session(connection, "fixture-recovered-token"); },
        onReadAuthenticationRejected: async () => { throw new Error("fixture-resource-401"); } } : {}) },
    async beforeMutation() { mutationMarks++; }, recordEvidence: async (_facts: RuntimeTaskNativeFacts) => {},
    async ack(evidence) { acks.push({ kind: evidence.kind, projection: structuredClone(evidence.projection) as Json, validator: evidence.validator }); return { kind: "acknowledged" }; },
    async finish(outcome) { finishes.push(outcome.status); }, observationId: () => "fixture-observation",
  }, {
    http: { async fetch(url, init) {
      const headers = new Headers(init.headers), method = init.method ?? "GET", exchange = queue.shift();
      methods.push(method); redirects.push(init.redirect ?? null); bodies.push(init.body === undefined ? null : JSON.parse(String(init.body))); ifMatch.push(headers.get("If-Match")); tokens.push(headers.get("Authorization") === "Bearer fixture-recovered-token" ? "recovered" : "initial");
      if (url !== `https://tasks.googleapis.com/tasks/v1/lists/native%2Flist/tasks/${encodeURIComponent(nativeTaskId)}` || !exchange || exchange.method !== method) { fatal ??= new ScenarioFailure("exchange-mismatch", "An unplanned native task request was dispatched."); throw fatal; }
      if (exchange.error) throw new TypeError("fixture lost reply");
      const response = new Response(exchange.rawBody !== undefined ? exchange.rawBody : exchange.body === null && [204, 205, 304].includes(exchange.status!) ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: exchange.headers });
      if (exchange.responseUrl) Object.defineProperty(response, "url", { value: exchange.responseUrl === "exact" ? url : "https://example.invalid/unexpected" });
      if (exchange.redirected !== undefined) Object.defineProperty(response, "redirected", { value: exchange.redirected });
      return response;
    } }, clock: { nowEpochMs: () => Date.parse("2026-10-25T12:00:00.000Z"), nowMonotonicMs: () => ++time }, telemetry: { record(metric) { metrics.push(metric); } },
  }, policy);
  if (fatal) throw fatal;
  if (JSON.stringify(envelope) !== originalEnvelope) throw new ScenarioFailure("expectation-mismatch", "The original task envelope was rewritten during delivery.");
  if (queue.length) throw new ScenarioFailure("unconsumed-exchange", "Planned native task responses were not consumed.");
  const observed: GoogleTaskUpdateSummary = { status: result.status, methods, redirects, bodies, ifMatch, tokens, sessions, recoveries, mutationMarks, metrics: metrics.map(item => item.status), preparedPatch,
    ackKinds: acks.map(item => item.kind), ackProjection: acks[0]?.projection ?? null, ackValidators: acks.map(item => item.validator), finishStatuses: finishes,
    providerKind: result.facts.provider.kind, validator: result.facts.provider.kind === "accepted" ? result.facts.provider.validator : null,
    acceptedStatus: result.facts.acceptedStatus ?? null, remoteKind: result.facts.remote.kind, possibleDispatch: result.facts.possibleDispatch,
    errorCode: result.error?.code ?? null, errorOutcome: result.error?.outcome ?? null, providerStatus: result.error?.providerStatus ?? null, retryAfterMs: result.error?.retryAfterMs ?? null };
  if (!isDeepStrictEqual(observed, scenario.expected)) {
    const differing = Object.keys(observed).filter(key => !isDeepStrictEqual(observed[key as keyof GoogleTaskUpdateSummary], scenario.expected[key as keyof GoogleTaskUpdateSummary]));
    throw new ScenarioFailure("expectation-mismatch", `Google task update evidence differs in: ${differing.join(", ")}.`);
  }
  return observed;
}
