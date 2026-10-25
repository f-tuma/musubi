import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { SyncErrorSchema, SyncJsonValueSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import {
  runClaimedGooglePersonalDelete,
  type ClaimedGooglePersonalDelete,
  type GooglePersonalDeleteHostPorts,
  type GooglePersonalDeletePolicy,
  type RuntimeDeleteCompletionEvidence,
  type RuntimeDeleteFinishOutcome,
  type RuntimeDeleteRunResult,
  type RuntimeDeleteProviderFact,
} from "../index";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Exchange = {
  method: "GET" | "DELETE";
  path: string;
  status?: number;
  body?: Json;
  headers?: Record<string, string>;
  error?: "lost-reply";
};
export type DeleteSummary = {
  status: "acked" | "hold" | "conflict";
  methods: string[];
  ifMatch: (string | null)[];
  ackKinds: string[];
  finishStatuses: string[];
  provider: { kind: string; status: number | null; errorCode: string | null; retry: string | null; retryAfterMs: number | null };
  remoteKind: string;
  possibleDispatch: boolean;
  mutationMarks: number;
  retryAfterMs: number | null;
  errorOutcome: "not-written" | "unconfirmed" | null;
  providerStatus: number | null;
};
export type DeleteScenario = {
  id: string;
  title: string;
  policy: "musubi" | "reference";
  recovery?: { required: boolean; possibleDispatch: boolean };
  priorProvider?: RuntimeDeleteProviderFact;
  exchanges: Exchange[];
  expected: DeleteSummary;
};
export type DeleteSuite = { schemaVersion: 1; scenarios: DeleteScenario[] };

export class ScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "exchange-mismatch" | "unconsumed-exchange" | "expectation-mismatch" | "invalid-arguments" | "unknown-scenario" | "suite-unavailable", message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Scenario suite does not match schema version 1."); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return record;
}
function oneOf(value: unknown, choices: readonly unknown[]): void { if (!choices.includes(value)) invalid(); }
function list(value: unknown, choices: readonly unknown[], maximum = 32): void {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (const item of value as unknown[]) oneOf(item, choices);
}
function nullableInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)) invalid();
}
function validJson(value: unknown, depth = 0): void {
  if (depth > 12) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > 4096) invalid(); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (Array.isArray(value)) { if (value.length > 64) invalid(); value.forEach(item => validJson(item, depth + 1)); return; }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.keys(value).length > 64) invalid();
    for (const [key, item] of Object.entries(value)) { if (key.length > 128) invalid(); validJson(item, depth + 1); }
    return;
  }
  invalid();
}
function validateSummary(value: unknown): void {
  const s = object(value, ["status", "methods", "ifMatch", "ackKinds", "finishStatuses", "provider", "remoteKind", "possibleDispatch", "mutationMarks", "retryAfterMs", "errorOutcome", "providerStatus"]);
  oneOf(s.status, ["acked", "hold", "conflict"]);
  list(s.methods, ["GET", "DELETE"]);
  if (!Array.isArray(s.ifMatch) || s.ifMatch.length !== (s.methods as unknown[]).length) invalid();
  for (const tag of s.ifMatch as unknown[]) if (tag !== null && (typeof tag !== "string" || !/^"[a-zA-Z0-9-]{1,64}"$/.test(tag))) invalid();
  list(s.ackKinds, ["provider-response", "exact-absence"], 1);
  list(s.finishStatuses, ["hold", "conflict"], 1);
  const provider = object(s.provider, ["kind", "status", "errorCode", "retry", "retryAfterMs"]);
  oneOf(provider.kind, ["not-dispatched", "accepted", "uncertain", "rejected"]);
  nullableInteger(provider.status, 100, 599);
  if (provider.errorCode !== null && (typeof provider.errorCode !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(provider.errorCode))) invalid();
  oneOf(provider.retry, [null, "never", "after-delay", "after-reconnect"]);
  nullableInteger(provider.retryAfterMs);
  oneOf(s.remoteKind, ["unobserved", "absent", "conflict"]);
  if (typeof s.possibleDispatch !== "boolean") invalid();
  nullableInteger(s.mutationMarks, 0, 1);
  if (s.mutationMarks === null) invalid();
  nullableInteger(s.retryAfterMs);
  oneOf(s.errorOutcome, [null, "not-written", "unconfirmed"]); nullableInteger(s.providerStatus, 100, 599);
}
export function parseDeleteSuite(value: unknown): DeleteSuite {
  if (!SyncJsonValueSchema.safeParse(value).success) invalid();
  const suite = object(value, ["schemaVersion", "scenarios"]);
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 100) invalid();
  const ids = new Set<string>();
  for (const item of suite.scenarios as unknown[]) {
    const scenario = object(item, ["id", "title", "policy", "exchanges", "expected"], ["recovery", "priorProvider"]);
    if (typeof scenario.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(scenario.id) || ids.has(scenario.id)) invalid();
    ids.add(scenario.id as string);
    if (typeof scenario.title !== "string" || !scenario.title.length || scenario.title.length > 160 || /[\u0000-\u001f\u007f]/.test(scenario.title)) invalid();
    oneOf(scenario.policy, ["musubi", "reference"]);
    if (Object.hasOwn(scenario, "recovery") !== Object.hasOwn(scenario, "priorProvider")) invalid();
    if (scenario.recovery !== undefined) {
      const recovery = object(scenario.recovery, ["required", "possibleDispatch"]), prior = object(scenario.priorProvider, ["kind"], ["status", "error"]);
      if (typeof recovery.required !== "boolean" || typeof recovery.possibleDispatch !== "boolean" || recovery.required !== recovery.possibleDispatch) invalid();
      if (prior.kind === "accepted") { object(prior, ["kind", "status"]); oneOf(prior.status, [200, 201, 204, 404, 410]); }
      else if (prior.kind === "rejected") { object(prior, ["kind", "error"]); if (!SyncErrorSchema.safeParse(prior.error).success) invalid(); }
      else { object(prior, ["kind"]); oneOf(prior.kind, ["not-dispatched", "uncertain"]); }
      if (prior.kind !== "not-dispatched" && !recovery.possibleDispatch) invalid();
    }
    if (!Array.isArray(scenario.exchanges) || scenario.exchanges.length > 32) invalid();
    for (const raw of scenario.exchanges as unknown[]) {
      const exchange = object(raw, ["method", "path"], ["status", "body", "headers", "error"]);
      oneOf(exchange.method, ["GET", "DELETE"]);
      if (typeof exchange.path !== "string" || !/^\/calendar\/v3\/(?:calendars\/native%2Fcalendar\/events\/native%2Fevent|users\/me\/calendarList\/native%2Fcalendar)$/.test(exchange.path)) invalid();
      if (exchange.error !== undefined) {
        oneOf(exchange.error, ["lost-reply"]);
        if (Object.hasOwn(exchange, "status") || Object.hasOwn(exchange, "body") || Object.hasOwn(exchange, "headers")) invalid();
      } else {
        if (!Object.hasOwn(exchange, "status") || !Object.hasOwn(exchange, "body")) invalid();
        nullableInteger(exchange.status, 200, 599);
        if (exchange.status === null) invalid();
        validJson(exchange.body);
        if ((exchange.status === 204 || exchange.status === 205 || exchange.status === 304) && exchange.body !== null) invalid();
        if (exchange.headers !== undefined) {
          const headers = object(exchange.headers, [], ["retry-after"]);
          if (headers["retry-after"] !== undefined && (typeof headers["retry-after"] !== "string" || !/^\d{1,6}$/.test(headers["retry-after"]))) invalid();
        }
      }
    }
    validateSummary(scenario.expected);
  }
  return structuredClone(value) as DeleteSuite;
}

export async function loadDeleteSuite(): Promise<DeleteSuite> {
  try {
    const url = new URL("./google-delete.json", import.meta.url);
    if ((await stat(url)).size > 512_000) invalid();
    const source = await readFile(url, "utf8");
    if (Buffer.byteLength(source) > 512_000) invalid();
    return parseDeleteSuite(JSON.parse(source));
  } catch (error) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("suite-unavailable", "The bundled scenario suite could not be loaded.");
  }
}
const policies: Record<DeleteScenario["policy"], GooglePersonalDeletePolicy> = {
  musubi: { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-google", observeConflict: true },
  reference: { completion: "exact-absence", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", observeConflict: false },
};
function claimedInput(): ClaimedGooglePersonalDelete {
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "delete", version: 1 },
    serializer: { id: "google-personal-event", version: 1 }, commandId: "command:scenario", operationId: "operation:scenario", hostObjectId: "object:scenario",
    locator: { provider: "google", connectionId: "logical:account", collectionId: "native/calendar", resourceId: "native/event" },
    sourceEpoch: { sourceId: "source:scenario", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:scenario", allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: { title: "Synthetic event", description: null, location: null, start: "2026-10-13T08:00:00.000Z", end: "2026-10-13T09:00:00.000Z", isAllDay: false, recurrence: null } },
    nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: null } } });
  return { operationId: envelope.operationId, attemptId: "attempt:scenario", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "delete", operationId: envelope.operationId, commandId: envelope.commandId, hostObjectId: envelope.hostObjectId,
      provider: "google", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: envelope.locator.resourceId,
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account", connectionGeneration: "1", calendarId: "native/calendar", eventId: "native/event" },
    acceptedEtag: '"before"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
}
export async function runDeleteScenario(raw: DeleteScenario): Promise<DeleteSummary> {
  const scenario = parseDeleteSuite({ schemaVersion: 1, scenarios: [raw] }).scenarios[0]!;
  let next = 0, mutationMarks = 0, observations = 0;
  let exchangeFailed = false;
  const methods: string[] = [], ifMatch: (string | null)[] = [];
  const acks: RuntimeDeleteCompletionEvidence[] = [], finishes: RuntimeDeleteFinishOutcome[] = [];
  const host: GooglePersonalDeleteHostPorts = {
    async renew() { return true; },
    accountSession: { async open(scope) { return { ...scope, accessToken: "synthetic-test-credential", eventWriteAllowed: true }; } },
    async beforeMutation() { mutationMarks++; }, async recordEvidence() {},
    async ack(evidence) { acks.push(evidence); return { kind: "acknowledged" }; },
    async finish(outcome) { finishes.push(outcome); }, observationId() { return `observation:${++observations}`; },
  };
  let result: RuntimeDeleteRunResult;
  const claim = claimedInput();
  result = await runClaimedGooglePersonalDelete({ ...claim,
    ...(scenario.recovery ? { recovery: scenario.recovery, priorProvider: scenario.priorProvider! } : {}) }, host, {
    http: { async fetch(url, init) {
      const exchange = scenario.exchanges[next++];
      methods.push(init.method ?? "GET"); ifMatch.push(new Headers(init.headers).get("if-match"));
      if (!exchange || url !== `https://www.googleapis.com${exchange.path}` || init.method !== exchange.method || init.body !== undefined || init.redirect !== "error") {
        // The production runtime intentionally catches transport errors. Retain
        // an independent test failure so a permissive HOLD expectation cannot hide it.
        exchangeFailed = true;
        throw new Error("Synthetic exchange mismatch.");
      }
      if (exchange.error) throw new Error("Synthetic lost response.");
      return new Response(exchange.body === null ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: exchange.headers });
    } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  }, policies[scenario.policy]);
  if (exchangeFailed) throw new ScenarioFailure("exchange-mismatch", "The runtime issued an unplanned provider request.");
  if (next !== scenario.exchanges.length) throw new ScenarioFailure("unconsumed-exchange", "The runtime did not consume every planned provider response.");
  const fact = result.facts.provider;
  const summary: DeleteSummary = { status: result.status, methods, ifMatch,
    ackKinds: acks.map(value => value.kind), finishStatuses: finishes.map(value => value.status),
    provider: { kind: fact.kind, status: fact.kind === "accepted" ? fact.status : null,
      errorCode: fact.kind === "rejected" ? fact.error.code : null, retry: fact.kind === "rejected" ? fact.error.retry : null,
      retryAfterMs: fact.kind === "rejected" ? fact.error.retryAfterMs ?? null : null },
    remoteKind: result.facts.remote.kind, possibleDispatch: result.facts.possibleDispatch, mutationMarks,
    retryAfterMs: finishes.at(-1)?.retryAfterMs ?? null,
    errorOutcome: result.error?.outcome ?? null, providerStatus: result.error?.providerStatus ?? null };
  if (!isDeepStrictEqual(summary, scenario.expected)) throw new ScenarioFailure("expectation-mismatch", "The observed runtime summary differs from the complete expected summary.");
  return summary;
}
