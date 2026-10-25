import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { EventSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  runClaimedGooglePersonalCreate, type ClaimedGooglePersonalCreate, type GooglePersonalCreateHostPorts,
  type GooglePersonalCreatePolicy, type RuntimeCreateCompletionEvidence, type RuntimeCreateFinishOutcome,
} from "../index";
import { ScenarioFailure } from "./google-delete";
export { ScenarioFailure } from "./google-delete";

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef";
const EVENT_ID = `musubi${OPERATION_ID.replace(/-/g, "")}`;
const COLLECTION_PATH = "/calendar/v3/calendars/native%2Fcalendar/events";
const EVENT_PATH = `${COLLECTION_PATH}/${EVENT_ID}`;
const CALENDAR_PATH = "/calendar/v3/users/me/calendarList/native%2Fcalendar";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Exchange = { method: "GET" | "POST"; path: string; status?: number; body?: Json; headers?: Record<string, string>; error?: "lost-reply" };
export type CreateSummary = {
  status: "acked" | "hold" | "conflict"; methods: string[]; bodyIds: (string | null)[]; markers: (string | null)[];
  ackKinds: string[]; finishStatuses: string[];
  provider: { kind: string; validator: string | null; errorCode: string | null; retry: string | null; retryAfterMs: number | null };
  remoteKind: string; possibleDispatch: boolean; mutationMarks: number; retryAfterMs: number | null; errorCode: string | null;
  errorOutcome: "not-written" | "unconfirmed" | null; providerStatus: number | null;
};
export type CreateScenario = {
  id: string; title: string; policy: "musubi" | "reference";
  recovery: { required: boolean; possibleDispatch: boolean }; priorProvider: "not-dispatched" | "uncertain";
  exchanges: Exchange[]; expected: CreateSummary;
};
export type CreateSuite = { schemaVersion: 1; scenarios: CreateScenario[] };
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Scenario suite does not match schema version 1."); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key) ||
      !Object.getOwnPropertyDescriptor(item, key)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(item, key)!)) ||
      required.some(key => !Object.hasOwn(item, key))) invalid();
  return item;
}
function oneOf(value: unknown, choices: readonly unknown[]) { if (!choices.includes(value)) invalid(); }
function integer(value: unknown, minimum: number, maximum: number, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
}
function list(value: unknown, choices: readonly unknown[], maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (const item of value as unknown[]) oneOf(item, choices);
}
function validJson(value: unknown, depth = 0): void {
  if (depth > 12) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > 4096) invalid(); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (Array.isArray(value)) {
    if (value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      validJson(descriptor!.value, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) invalid();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || key.length > 128 || !descriptor.enumerable || !("value" in descriptor)) invalid();
      validJson(descriptor.value, depth + 1);
    }
    return;
  }
  invalid();
}
function validateSummary(value: unknown) {
  const summary = object(value, ["status", "methods", "bodyIds", "markers", "ackKinds", "finishStatuses", "provider", "remoteKind", "possibleDispatch", "mutationMarks", "retryAfterMs", "errorCode", "errorOutcome", "providerStatus"]);
  oneOf(summary.status, ["acked", "hold", "conflict"]); list(summary.methods, ["GET", "POST"]);
  for (const [key, expected] of [["bodyIds", EVENT_ID], ["markers", OPERATION_ID]] as const) {
    list(summary[key], [null, expected]);
    if ((summary[key] as unknown[]).length !== (summary.methods as unknown[]).length) invalid();
  }
  list(summary.ackKinds, ["provider-response", "exact-readback"], 1); list(summary.finishStatuses, ["hold", "conflict"], 1);
  const provider = object(summary.provider, ["kind", "validator", "errorCode", "retry", "retryAfterMs"]);
  oneOf(provider.kind, ["not-dispatched", "accepted", "uncertain", "rejected"]);
  if (provider.validator !== null && (typeof provider.validator !== "string" || !/^"[a-zA-Z0-9-]{1,64}"$/.test(provider.validator))) invalid();
  for (const code of [summary.errorCode, provider.errorCode])
    if (code !== null && (typeof code !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(code))) invalid();
  oneOf(provider.retry, [null, "never", "after-delay", "after-reconnect"]);
  integer(provider.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, true);
  oneOf(summary.remoteKind, ["unobserved", "confirmed", "conflict"]);
  if (typeof summary.possibleDispatch !== "boolean") invalid();
  integer(summary.mutationMarks, 0, 1); integer(summary.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, true);
  oneOf(summary.errorOutcome, [null, "not-written", "unconfirmed"]); integer(summary.providerStatus, 100, 599, true);
}
export function parseCreateSuite(value: unknown): CreateSuite {
  const suite = object(value, ["schemaVersion", "scenarios"]);
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 100) invalid();
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const scenario = object(raw, ["id", "title", "policy", "recovery", "priorProvider", "exchanges", "expected"]);
    if (typeof scenario.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(scenario.id) || ids.has(scenario.id)) invalid();
    ids.add(scenario.id as string);
    if (typeof scenario.title !== "string" || !scenario.title.length || scenario.title.length > 160 || /[\u0000-\u001f\u007f]/.test(scenario.title)) invalid();
    oneOf(scenario.policy, ["musubi", "reference"]); oneOf(scenario.priorProvider, ["not-dispatched", "uncertain"]);
    const recovery = object(scenario.recovery, ["required", "possibleDispatch"]);
    if (typeof recovery.required !== "boolean" || typeof recovery.possibleDispatch !== "boolean" ||
        recovery.required && !recovery.possibleDispatch || scenario.priorProvider === "uncertain" && !recovery.possibleDispatch) invalid();
    if (!Array.isArray(scenario.exchanges) || scenario.exchanges.length > 32) invalid();
    for (const rawExchange of scenario.exchanges as unknown[]) {
      const exchange = object(rawExchange, ["method", "path"], ["status", "body", "headers", "error"]);
      oneOf(exchange.method, ["GET", "POST"]);
      if (typeof exchange.path !== "string" || ![COLLECTION_PATH, EVENT_PATH, CALENDAR_PATH].includes(exchange.path)) invalid();
      if (exchange.error !== undefined) {
        oneOf(exchange.error, ["lost-reply"]);
        if (["status", "body", "headers"].some(key => Object.hasOwn(exchange, key))) invalid();
      } else {
        if (!Object.hasOwn(exchange, "status") || !Object.hasOwn(exchange, "body")) invalid();
        integer(exchange.status, 200, 599); validJson(exchange.body);
        if ([204, 205, 304].includes(exchange.status as number) && exchange.body !== null) invalid();
        if (exchange.headers !== undefined) {
          const headers = object(exchange.headers, [], ["retry-after"]);
          if (headers["retry-after"] !== undefined && (typeof headers["retry-after"] !== "string" || !/^\d{1,6}$/.test(headers["retry-after"]))) invalid();
        }
      }
    }
    validateSummary(scenario.expected);
  }
  return structuredClone(value) as CreateSuite;
}
export async function loadCreateSuite(): Promise<CreateSuite> {
  try {
    const url = new URL("./google-create.json", import.meta.url);
    if ((await stat(url)).size > 512_000) invalid();
    const source = await readFile(url, "utf8");
    if (Buffer.byteLength(source) > 512_000) invalid();
    return parseCreateSuite(JSON.parse(source));
  } catch (error) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("suite-unavailable", "The bundled scenario suite could not be loaded.");
  }
}
const policies: Record<CreateScenario["policy"], GooglePersonalCreatePolicy> = {
  musubi: { completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty", nativeProfile: "existing-google", requireStrongReadback: false },
  reference: { completion: "exact-readback", ambiguousRecovery: "within-attempt", compareContent: "literal", nativeProfile: "strict-reference", requireStrongReadback: true },
};
export function claimedCreateInput(scenario: Pick<CreateScenario, "recovery" | "priorProvider">): ClaimedGooglePersonalCreate {
  const event = EventSchema.parse({ id: "object:scenario", creatorID: "synthetic:user", organizer: "synthetic:user", calendars: ["calendar:scenario"],
    color: "#112233", title: "Synthetic event", description: null, location: null, start: "2026-10-13T08:00:00.000Z",
    end: "2026-10-13T09:00:00.000Z", isAllDay: false, isCanceled: false });
  const encoded = encodeEventV1("google", event, undefined, { action: "create", operationId: OPERATION_ID, acceptedAt: "2026-10-13T07:00:00.000Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    ...encoded, commandId: "command:scenario", operationId: OPERATION_ID, hostObjectId: event.id,
    locator: { provider: "google", connectionId: "logical:account", collectionId: "native/calendar", resourceId: EVENT_ID },
    sourceEpoch: { sourceId: "source:scenario", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:scenario", allowedSideEffects: ["provider-content-write"] });
  return { operationId: OPERATION_ID, attemptId: "attempt:scenario", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "create", operationId: OPERATION_ID, commandId: envelope.commandId, hostObjectId: event.id,
      provider: "google", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: null,
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account", connectionGeneration: "1", calendarId: "native/calendar", eventId: EVENT_ID },
    recovery: scenario.recovery, priorProvider: { kind: scenario.priorProvider } };
}
/** The optional claim is a test seam for malformed-admission regressions, never JSON executable code. */
export async function runCreateScenario(raw: CreateScenario, suppliedClaim?: ClaimedGooglePersonalCreate): Promise<CreateSummary> {
  const scenario = parseCreateSuite({ schemaVersion: 1, scenarios: [raw] }).scenarios[0]!;
  const claim = suppliedClaim ?? claimedCreateInput(scenario);
  const envelope = (claim.payload as { operationEnvelope: { nativePlan: { data: { body: unknown } } } }).operationEnvelope;
  const acceptedBody = JSON.stringify(envelope.nativePlan.data.body);
  let next = 0, mutationMarks = 0, observations = 0, exchangeFailed = false;
  const methods: string[] = [], bodyIds: (string | null)[] = [], markers: (string | null)[] = [];
  const acks: RuntimeCreateCompletionEvidence[] = [], finishes: RuntimeCreateFinishOutcome[] = [];
  const host: GooglePersonalCreateHostPorts = {
    async renew() { return true; },
    accountSession: { async open(scope) { return { ...scope, accessToken: "synthetic-test-credential", eventWriteAllowed: true }; } },
    async beforeMutation() { mutationMarks++; }, async recordEvidence() {},
    async ack(evidence) { acks.push(evidence); return { kind: "acknowledged" }; },
    async finish(outcome) { finishes.push(outcome); }, observationId() { return `observation:${++observations}`; },
  };
  const result = await runClaimedGooglePersonalCreate(claim, host, {
    http: { async fetch(url, init) {
      const exchange = scenario.exchanges[next++], method = init.method ?? "GET";
      let body: { id?: unknown; extendedProperties?: { private?: { musubiOperationID?: unknown } } } | null = null;
      try { if (init.body !== undefined) body = JSON.parse(String(init.body)); } catch { exchangeFailed = true; }
      methods.push(method); bodyIds.push(typeof body?.id === "string" ? body.id : null);
      const marker = body?.extendedProperties?.private?.musubiOperationID; markers.push(typeof marker === "string" ? marker : null);
      const headers = new Headers(init.headers);
      if (!exchange || url !== `https://www.googleapis.com${exchange.path}` || method !== exchange.method || init.redirect !== "error" ||
          headers.has("if-match") || (method === "POST" ? init.body !== acceptedBody || exchange.path !== COLLECTION_PATH : init.body !== undefined || headers.get("cache-control") !== "no-cache")) {
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
  const summary: CreateSummary = { status: result.status, methods, bodyIds, markers,
    ackKinds: acks.map(item => item.kind), finishStatuses: finishes.map(item => item.status),
    provider: { kind: fact.kind, validator: fact.kind === "accepted" ? fact.validator : null,
      errorCode: fact.kind === "rejected" ? fact.error.code : null, retry: fact.kind === "rejected" ? fact.error.retry : null,
      retryAfterMs: fact.kind === "rejected" ? fact.error.retryAfterMs ?? null : null },
    remoteKind: result.facts.remote.kind, possibleDispatch: result.facts.possibleDispatch, mutationMarks,
    retryAfterMs: finishes.at(-1)?.retryAfterMs ?? null, errorCode: result.error?.code ?? null,
    errorOutcome: result.error?.outcome ?? null, providerStatus: result.error?.providerStatus ?? null };
  if (!isDeepStrictEqual(summary, scenario.expected)) throw new ScenarioFailure("expectation-mismatch", "The observed runtime summary differs from the complete expected summary.");
  return summary;
}
