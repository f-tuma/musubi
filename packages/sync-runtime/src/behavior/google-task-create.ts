import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { TaskSchema, SyncJsonValueSchema, SyncOperationEnvelopeSchema, SyncErrorSchema, type SyncError } from "@musubi/types";
import { encodeTaskV1 } from "@musubi/sync-codec";
import { parseGoogleTaskPatch, parseGoogleTaskProjection, strongGoogleEtag, type GoogleTaskCreateRequestMetric, type GoogleTaskProjection } from "@musubi/provider-google";
import { runClaimedGoogleTaskCreate, type GoogleTaskCreatePolicy, type RuntimeTaskCreateNativeFacts } from "../index";
import { ScenarioFailure } from "./google-delete";
export { ScenarioFailure } from "./google-delete";

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef", TASK_ID = "abcdef01-abcd-4000-8000-abcdefabcdea";
const TARGET = { connectionId: "physical-account", connectionGeneration: "1", taskListId: "native/list" };
const TASK_INPUT = { id: TASK_ID, creatorID: "fixture-owner", calendarID: "fixture-home", revision: 2, title: "Admitted title", description: "Notes", status: "in-process",
  due: "2026-10-20T14:30:00.123Z", start: "2026-10-19T10:00:00.456Z", priority: 2, percentComplete: 37 };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Projection = { title: string; notes: Json; status: string; due: Json };
type Address = { taskId: string; validator: string | null };
type Exchange = { method: "GET" | "POST"; url: string; status?: number; body?: Json; rawBody?: string; headers?: Record<string, string>;
  error?: "lost-reply"; responseUrl?: "exact" | "other"; redirected?: boolean; abortAfterJson?: boolean };
type EvidenceSummary = { providerKind: string; acceptedStatus: number | null; responseAddress: Address | null;
  writerResult: { taskId: string; etag: string } | null; remoteKind: string; possibleDispatch: boolean };
export interface GoogleTaskCreateSummary extends EvidenceSummary {
  status: string; urls: string[]; methods: string[]; redirects: (string | null)[]; bodies: (Json | null)[]; contentTypes: (string | null)[];
  ifMatch: (string | null)[]; tokens: string[]; sessions: number; recoveries: number; mutationMarks: number;
  metrics: { method: string; status: number | string; durationMs: number }[]; preparedPatch: Json | null; evidence: EvidenceSummary[];
  ackKinds: string[]; ackTaskIds: string[]; ackProjection: Json | null; ackValidators: string[]; finishStatuses: string[];
  validator: string | null; providerErrorCode: string | null; providerRetry: string | null; providerRetryAfterMs: number | null;
  errorCode: string | null; errorOutcome: string | null; providerStatus: number | null; retryAfterMs: number | null;
}
export interface GoogleTaskCreateScenario {
  id: string; title: string; policy: "musubi" | "reference"; recovery: boolean; priorProvider: "not-dispatched" | "uncertain" | "accepted" | "rejected";
  possibleDispatch?: boolean; priorAcceptedStatus?: 200 | 201 | 204; priorResponseAddress?: Address; priorError?: SyncError;
  saved?: { baseline: Projection | null; patch: Record<string, Json> }; readRecovery?: boolean; dispatchAllowed?: boolean; ackAllowed?: boolean;
  taskOverrides?: Record<string, Json>; collectionIdentity?: "native" | "musubi-google-task-list"; collectionId?: string; taskListId?: string;
  tamper?: "extra-body-field" | "projection-disagrees" | "unknown-serializer" | "resource-id";
  cancelAt?: "afterCredentials" | "beforeDispatch" | "afterAcceptance" | "afterReadback";
  exchanges: Exchange[]; expected: GoogleTaskCreateSummary;
}
export interface GoogleTaskCreateSuite { schemaVersion: 1; driver: "google-task-create"; scenarios: GoogleTaskCreateScenario[] }
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Google task CREATE suite does not match schema version 1."); };
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key) ||
      !Object.getOwnPropertyDescriptor(item, key)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(item, key)!)) ||
      required.some(key => !Object.prototype.hasOwnProperty.call(item, key))) invalid();
  return item;
}
function choice(value: unknown, values: readonly unknown[]) { if (!values.includes(value)) invalid(); }
const boundedText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);
function projection(value: unknown) { const item = object(value, ["title", "notes", "status", "due"]); if (typeof item.title !== "string" || !["needsAction", "completed"].includes(item.status as string)) invalid(); }
function address(value: unknown, writer = false) {
  const item = object(value, writer ? ["taskId", "etag"] : ["taskId", "validator"]), tag = writer ? item.etag : item.validator;
  if (!boundedText(item.taskId) || tag !== null && strongGoogleEtag(tag) === null || writer && tag === null) invalid();
}
function evidence(value: unknown) {
  const item = object(value, ["providerKind", "acceptedStatus", "responseAddress", "writerResult", "remoteKind", "possibleDispatch"]);
  choice(item.providerKind, ["not-dispatched", "uncertain", "accepted", "rejected"]); choice(item.remoteKind, ["unobserved", "confirmed", "conflict"]);
  choice(item.acceptedStatus, [null, 200, 201, 204]); if (typeof item.possibleDispatch !== "boolean") invalid();
  if (item.responseAddress !== null) address(item.responseAddress); if (item.writerResult !== null) address(item.writerResult, true);
  if (item.acceptedStatus !== null && item.providerKind !== "accepted" || item.writerResult !== null && item.providerKind !== "accepted") invalid();
}
const EVIDENCE_KEYS = ["providerKind", "acceptedStatus", "responseAddress", "writerResult", "remoteKind", "possibleDispatch"];
function summary(value: unknown) {
  const item = object(value, [...EVIDENCE_KEYS, "status", "urls", "methods", "redirects", "bodies", "contentTypes", "ifMatch", "tokens", "sessions", "recoveries", "mutationMarks", "metrics", "preparedPatch", "evidence",
    "ackKinds", "ackTaskIds", "ackProjection", "ackValidators", "finishStatuses", "validator", "providerErrorCode", "providerRetry", "providerRetryAfterMs", "errorCode", "errorOutcome", "providerStatus", "retryAfterMs"]);
  evidence(Object.fromEntries(EVIDENCE_KEYS.map(key => [key, item[key]])));
  choice(item.status, ["acked", "hold", "conflict"]); choice(item.errorOutcome, [null, "not-written", "unconfirmed"]); choice(item.providerRetry, [null, "never", "after-delay", "after-reconnect"]);
  for (const key of ["urls", "methods", "redirects", "bodies", "contentTypes", "ifMatch", "tokens", "metrics", "evidence", "ackKinds", "ackTaskIds", "ackValidators", "finishStatuses"])
    if (!Array.isArray(item[key]) || (item[key] as unknown[]).length > (key === "evidence" ? 24 : 16)) invalid();
  for (const key of ["urls", "redirects", "bodies", "contentTypes", "ifMatch", "tokens", "metrics"]) if ((item[key] as unknown[]).length !== (item.methods as unknown[]).length) invalid();
  for (const url of item.urls as unknown[]) if (!boundedText(url) || !url.startsWith("https://tasks.googleapis.com/tasks/v1/")) invalid();
  for (const method of item.methods as unknown[]) choice(method, ["GET", "POST"]);
  for (const redirect of item.redirects as unknown[]) choice(redirect, [null, "error"]);
  for (const type of item.contentTypes as unknown[]) choice(type, [null, "application/json"]);
  for (const token of item.tokens as unknown[]) choice(token, ["initial", "recovered"]);
  for (const tag of item.ifMatch as unknown[]) if (tag !== null) invalid();
  for (const body of item.bodies as unknown[]) if (body !== null && !parseGoogleTaskProjection(body)) invalid();
  for (const metric of item.metrics as unknown[]) {
    const fields = object(metric, ["method", "status", "durationMs"]); choice(fields.method, ["GET", "POST"]);
    if (typeof fields.status === "number" ? !Number.isInteger(fields.status) || fields.status < 100 || fields.status > 599 : !["network-error", "aborted"].includes(fields.status as string)) invalid();
    if (typeof fields.durationMs !== "number" || !Number.isFinite(fields.durationMs) || fields.durationMs < 0) invalid();
  }
  for (const value of item.evidence as unknown[]) evidence(value);
  for (const kind of item.ackKinds as unknown[]) choice(kind, ["exact-readback"]); for (const status of item.finishStatuses as unknown[]) choice(status, ["hold", "conflict"]);
  if ((item.ackKinds as unknown[]).length > 1 || (item.finishStatuses as unknown[]).length > 1 || ["ackTaskIds", "ackValidators"].some(key => (item[key] as unknown[]).length !== (item.ackKinds as unknown[]).length)) invalid();
  for (const id of item.ackTaskIds as unknown[]) if (!boundedText(id)) invalid(); for (const tag of item.ackValidators as unknown[]) if (strongGoogleEtag(tag) === null) invalid();
  if (item.preparedPatch !== null && !parseGoogleTaskPatch(item.preparedPatch)) invalid(); if (item.ackProjection !== null) projection(item.ackProjection);
  for (const key of ["sessions", "recoveries", "mutationMarks"]) if (typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || (item[key] as number) < 0 || (item[key] as number) > 16) invalid();
  if (item.validator !== null && strongGoogleEtag(item.validator) === null) invalid();
  for (const key of ["errorCode", "providerErrorCode"]) if (item[key] !== null && (typeof item[key] !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(item[key] as string))) invalid();
  if (item.providerStatus !== null && (typeof item.providerStatus !== "number" || !Number.isInteger(item.providerStatus) || item.providerStatus < 100 || item.providerStatus > 599)) invalid();
  for (const key of ["retryAfterMs", "providerRetryAfterMs"]) if (item[key] !== null && (typeof item[key] !== "number" || !Number.isFinite(item[key]) || (item[key] as number) < 0)) invalid();
}
export function parseGoogleTaskCreateSuite(value: unknown): GoogleTaskCreateSuite {
  if (!SyncJsonValueSchema.safeParse(value).success) invalid();
  const suite = object(value, ["schemaVersion", "driver", "scenarios"]);
  if (suite.schemaVersion !== 1 || suite.driver !== "google-task-create" || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 80) invalid();
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const item = object(raw, ["id", "title", "policy", "recovery", "priorProvider", "exchanges", "expected"], ["possibleDispatch", "priorAcceptedStatus", "priorResponseAddress", "priorError", "saved", "readRecovery", "dispatchAllowed", "ackAllowed", "taskOverrides", "collectionIdentity", "collectionId", "taskListId", "tamper", "cancelAt"]);
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id) || ids.has(item.id)) invalid(); ids.add(item.id as string);
    if (typeof item.title !== "string" || !item.title.length || item.title.length > 160 || /[\u0000-\u001f\u007f]/.test(item.title)) invalid();
    choice(item.policy, ["musubi", "reference"]); choice(item.priorProvider, ["not-dispatched", "uncertain", "accepted", "rejected"]);
    if (typeof item.recovery !== "boolean") invalid(); for (const key of ["possibleDispatch", "readRecovery", "dispatchAllowed", "ackAllowed"]) if (item[key] !== undefined && typeof item[key] !== "boolean") invalid();
    const dispatched = item.possibleDispatch ?? item.recovery;
    if (item.recovery && !dispatched || item.priorProvider !== "not-dispatched" && !dispatched) invalid();
    if (item.priorAcceptedStatus !== undefined) { choice(item.priorAcceptedStatus, [200, 201, 204]); if (item.priorProvider !== "accepted") invalid(); }
    if (item.priorResponseAddress !== undefined) { address(item.priorResponseAddress); if (!dispatched) invalid(); }
    if (item.priorProvider === "rejected" ? !SyncErrorSchema.safeParse(item.priorError).success : item.priorError !== undefined) invalid();
    if (item.saved !== undefined) { const saved = object(item.saved, ["baseline", "patch"]); if (saved.baseline !== null) projection(saved.baseline); if (!parseGoogleTaskPatch(saved.patch)) invalid(); }
    if (item.taskOverrides !== undefined) object(item.taskOverrides, [], ["title", "description", "status", "start", "due", "isAllDay", "completedAt", "percentComplete", "priority"]);
    if (!TaskSchema.safeParse({ ...TASK_INPUT, ...item.taskOverrides as object | undefined }).success) invalid();
    if (item.collectionIdentity !== undefined) choice(item.collectionIdentity, ["native", "musubi-google-task-list"]);
    for (const key of ["collectionId", "taskListId"]) if (item[key] !== undefined && !boundedText(item[key])) invalid();
    if (item.tamper !== undefined) choice(item.tamper, ["extra-body-field", "projection-disagrees", "unknown-serializer", "resource-id"]);
    if (item.cancelAt !== undefined) choice(item.cancelAt, ["afterCredentials", "beforeDispatch", "afterAcceptance", "afterReadback"]);
    if (!Array.isArray(item.exchanges) || item.exchanges.length > 16) invalid();
    for (const rawExchange of item.exchanges as unknown[]) {
      const exchange = object(rawExchange, ["method", "url"], ["status", "body", "rawBody", "headers", "error", "responseUrl", "redirected", "abortAfterJson"]);
      choice(exchange.method, ["GET", "POST"]); if (!boundedText(exchange.url) || !exchange.url.startsWith("https://tasks.googleapis.com/tasks/v1/")) invalid();
      if (exchange.error !== undefined) { choice(exchange.error, ["lost-reply"]); if (Object.keys(exchange).some(key => !["method", "url", "error"].includes(key))) invalid(); }
      else {
        if (typeof exchange.status !== "number" || !Number.isInteger(exchange.status) || exchange.status < 200 || exchange.status > 599) invalid();
        if (Object.prototype.hasOwnProperty.call(exchange, "body") === Object.prototype.hasOwnProperty.call(exchange, "rawBody")) invalid();
        if (exchange.rawBody !== undefined && (typeof exchange.rawBody !== "string" || exchange.rawBody.length > 512)) invalid();
        if ([204, 205, 304].includes(exchange.status as number) && exchange.body !== null) invalid();
        if (exchange.headers !== undefined) { const headers = object(exchange.headers, [], ["retry-after", "content-range"]); if (Object.values(headers).some(value => typeof value !== "string" || value.length > 128 || /[\r\n\0]/.test(value))) invalid(); }
        if (exchange.responseUrl !== undefined) choice(exchange.responseUrl, ["exact", "other"]);
        for (const key of ["redirected", "abortAfterJson"]) if (exchange[key] !== undefined && typeof exchange[key] !== "boolean") invalid();
      }
    }
    summary(item.expected);
  }
  return structuredClone(value) as GoogleTaskCreateSuite;
}
export async function loadGoogleTaskCreateSuite(): Promise<GoogleTaskCreateSuite> {
  const file = new URL("./google-task-create.json", import.meta.url); if ((await stat(file)).size > 1_000_000) invalid();
  return parseGoogleTaskCreateSuite(JSON.parse(await readFile(file, "utf8")));
}
const factsSummary = (facts: RuntimeTaskCreateNativeFacts): EvidenceSummary => ({ providerKind: facts.provider.kind, acceptedStatus: facts.acceptedStatus ?? null,
  responseAddress: facts.responseAddress ? structuredClone(facts.responseAddress) : null, writerResult: facts.writerResult ? structuredClone(facts.writerResult) : null,
  remoteKind: facts.remote.kind, possibleDispatch: facts.possibleDispatch });
export async function runGoogleTaskCreateScenario(input: GoogleTaskCreateScenario): Promise<GoogleTaskCreateSummary> {
  const scenario = parseGoogleTaskCreateSuite({ schemaVersion: 1, driver: "google-task-create", scenarios: [input] }).scenarios[0]!;
  const task = TaskSchema.parse({ ...TASK_INPUT, ...scenario.taskOverrides }), target = { ...TARGET, taskListId: scenario.taskListId ?? TARGET.taskListId };
  const encoded = encodeTaskV1("google", task, undefined, { action: "create", operationId: OPERATION_ID, acceptedAt: "2026-10-25T12:00:00.000Z" });
  const admitted = encoded.admittedProjection.data as GoogleTaskProjection, collectionId = scenario.collectionId ?? target.taskListId;
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "task", action: "create", version: 1 }, commandId: "fixture-command", operationId: OPERATION_ID, hostObjectId: TASK_ID,
    locator: { provider: "google", connectionId: "logical-account", collectionId, resourceId: null }, sourceEpoch: { sourceId: "fixture-source", generation: 1 }, acceptedRevision: 2, privacyEpoch: "task:0", allowedSideEffects: ["provider-content-write"], ...encoded });
  if (scenario.tamper === "extra-body-field") (envelope.nativePlan.data.body as Record<string, unknown>).id = "client-generated-task";
  if (scenario.tamper === "projection-disagrees") envelope.admittedProjection.data.title = "Different from saved body";
  if (scenario.tamper === "unknown-serializer") envelope.serializer.version = 999;
  if (scenario.tamper === "resource-id") envelope.locator.resourceId = "invented-address";
  const saved = scenario.saved ? { projection: admitted, baseline: scenario.saved.baseline, patch: scenario.saved.patch } : undefined;
  const controller = new AbortController(), queue = structuredClone(scenario.exchanges), urls: string[] = [], methods: string[] = [], redirects: (string | null)[] = [], bodies: (Json | null)[] = [], contentTypes: (string | null)[] = [], ifMatch: (string | null)[] = [], tokens: string[] = [], metrics: GoogleTaskCreateRequestMetric[] = [];
  const acks: { kind: string; taskId: string; projection: Json; validator: string }[] = [], finishStatuses: string[] = [], evidence: EvidenceSummary[] = [];
  let sessions = 0, recoveries = 0, mutationMarks = 0, time = 0, preparedPatch: Json | null = null, fatal: ScenarioFailure | undefined;
  const session = (connection: { connectionId: string; connectionGeneration: string }, token = "fixture-initial-token") => ({ ...connection, accessToken: token, taskWriteAllowed: true });
  const policy: GoogleTaskCreatePolicy = { nativeProfile: scenario.policy === "musubi" ? "existing-google" : "strict-reference", readback: scenario.policy === "musubi" ? "saved-patch" : "full-target", ambiguousRecovery: scenario.policy === "musubi" ? "deferred" : "within-attempt" };
  const result = await runClaimedGoogleTaskCreate({ operationId: OPERATION_ID, attemptId: "fixture-attempt", payload: { operationEnvelope: envelope },
    binding: { kind: "task", action: "create", operationId: OPERATION_ID, commandId: "fixture-command", hostObjectId: TASK_ID, provider: "google", connectionId: "logical-account", collectionId, resourceId: null, acceptedRevision: 2, predecessorOperationId: null },
    nativeTarget: target, collectionIdentity: scenario.collectionIdentity ?? "native", recovery: { required: scenario.recovery, possibleDispatch: scenario.possibleDispatch ?? scenario.recovery },
    priorProvider: scenario.priorProvider === "accepted" ? { kind: "accepted", validator: null } : scenario.priorProvider === "rejected" ? { kind: "rejected", error: scenario.priorError! } : { kind: scenario.priorProvider },
    ...(scenario.priorAcceptedStatus === undefined ? {} : { priorAcceptedStatus: scenario.priorAcceptedStatus }), ...(scenario.priorResponseAddress ? { priorResponseAddress: scenario.priorResponseAddress } : {}),
  }, {
    async prepare(signal) { signal.throwIfAborted(); return { ...(saved ? { saved } : {}), ...(scenario.dispatchAllowed === undefined ? {} : { dispatchAllowed: scenario.dispatchAllowed }) }; },
    async prepareProjection(input, signal) { signal.throwIfAborted(); const resolved = input.saved ?? { projection: input.target, baseline: null, patch: input.target }; preparedPatch = structuredClone(resolved.patch) as Json; return resolved; },
    renew: async signal => { signal.throwIfAborted(); return true; }, accountSession: { open: async connection => { sessions++; return session(connection); },
      ...(scenario.readRecovery ? { recoverRejectedRead: async (connection: { connectionId: string; connectionGeneration: string }) => { recoveries++; return session(connection, "fixture-recovered-token"); }, onReadAuthenticationRejected: async () => { throw new Error("fixture-resource-401"); } } : {}) },
    async beforeMutation(_request, signal) { signal.throwIfAborted(); mutationMarks++; }, async recordEvidence(facts, signal) { signal.throwIfAborted(); evidence.push(factsSummary(facts)); },
    async ack(item, signal) { signal.throwIfAborted(); acks.push({ kind: item.kind, taskId: item.taskId, projection: structuredClone(item.projection) as Json, validator: item.validator }); return { kind: scenario.ackAllowed === false ? "authority-rejected" : "acknowledged" }; },
    async finish(outcome) { finishStatuses.push(outcome.status); }, observationId: () => "fixture-observation", checkpoint(phase) { if (phase === scenario.cancelAt) controller.abort(new Error("Fixture cancellation")); },
  }, { http: { async fetch(url, init) {
    const headers = new Headers(init.headers), method = init.method ?? "GET", exchange = queue.shift(), auth = headers.get("Authorization");
    urls.push(url); methods.push(method); redirects.push(init.redirect ?? null); bodies.push(init.body === undefined ? null : JSON.parse(String(init.body))); contentTypes.push(headers.get("Content-Type")); ifMatch.push(headers.get("If-Match")); tokens.push(auth === "Bearer fixture-initial-token" ? "initial" : auth === "Bearer fixture-recovered-token" ? "recovered" : "unexpected");
    if (!exchange || exchange.method !== method || exchange.url !== url) { fatal ??= new ScenarioFailure("exchange-mismatch", "An unplanned native task CREATE request was dispatched."); throw fatal; }
    if (exchange.error) throw new TypeError("fixture lost reply");
    const response = new Response(exchange.rawBody !== undefined ? exchange.rawBody : exchange.body === null && [204, 205, 304].includes(exchange.status!) ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: exchange.headers });
    if (exchange.responseUrl) Object.defineProperty(response, "url", { value: exchange.responseUrl === "exact" ? url : "https://example.invalid/unexpected" });
    if (exchange.redirected !== undefined) Object.defineProperty(response, "redirected", { value: exchange.redirected });
    if (exchange.abortAfterJson) { const json = response.json.bind(response); response.json = async () => { const value = await json(); controller.abort(new Error("Fixture cancellation after JSON")); return value; }; }
    return response;
  } }, clock: { nowEpochMs: () => Date.parse("2026-10-25T12:00:00.000Z"), nowMonotonicMs: () => ++time }, telemetry: { record(metric) { metrics.push(metric); } } }, policy, { signal: controller.signal });
  if (fatal) throw fatal; if (queue.length) throw new ScenarioFailure("unconsumed-exchange", "Planned native task CREATE responses were not consumed.");
  const observed: GoogleTaskCreateSummary = { ...factsSummary(result.facts), status: result.status, urls, methods, redirects, bodies, contentTypes, ifMatch, tokens, sessions, recoveries, mutationMarks,
    metrics: metrics.map(({ method, status, durationMs }) => ({ method, status, durationMs })), preparedPatch, evidence,
    ackKinds: acks.map(item => item.kind), ackTaskIds: acks.map(item => item.taskId), ackProjection: acks[0]?.projection ?? null, ackValidators: acks.map(item => item.validator), finishStatuses,
    validator: result.facts.provider.kind === "accepted" ? result.facts.provider.validator : null,
    providerErrorCode: result.facts.provider.kind === "rejected" ? result.facts.provider.error.code : null, providerRetry: result.facts.provider.kind === "rejected" ? result.facts.provider.error.retry : null,
    providerRetryAfterMs: result.facts.provider.kind === "rejected" ? result.facts.provider.error.retryAfterMs ?? null : null,
    errorCode: result.error?.code ?? null, errorOutcome: result.error?.outcome ?? null, providerStatus: result.error?.providerStatus ?? null, retryAfterMs: result.error?.retryAfterMs ?? null };
  if (!isDeepStrictEqual(observed, scenario.expected)) {
    const differing = Object.keys(observed).filter(key => !isDeepStrictEqual(observed[key as keyof GoogleTaskCreateSummary], scenario.expected[key as keyof GoogleTaskCreateSummary]));
    throw new ScenarioFailure("expectation-mismatch", `Google task CREATE evidence differs in: ${differing.join(", ")}.`);
  }
  return observed;
}
