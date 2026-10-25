import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { EventSchema, SyncErrorSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  runClaimedMicrosoftPersonalDelete, type ClaimedMicrosoftPersonalDelete, type MicrosoftPersonalDeleteHostPorts,
  type MicrosoftPersonalDeletePolicy, type MicrosoftRuntimeDeleteCompletionEvidence, type MicrosoftRuntimeDeleteFinishOutcome,
  type MicrosoftRuntimeDeleteNativeFacts, type MicrosoftRuntimeDeleteProviderFact,
} from "../index";
import { ScenarioFailure } from "./google-delete";
export { ScenarioFailure } from "./google-delete";

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef";
const EVENT_PATH = "/v1.0/me/calendars/native%2Fcalendar/events/native%2Fevent";
const ME_PATH = "/v1.0/me?$select=id,mail,userPrincipalName";
const CALENDAR_PATH = "/v1.0/me/calendars/native%2Fcalendar?$select=id,canEdit,owner";
const SMALL_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';
const DELIVERY_PREFER = `${SMALL_PREFER}, odata.maxpagesize=100`;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Exchange = { method: "GET" | "DELETE"; path: string; status?: number; body?: Json; headers?: Record<string, string>;
  error?: "lost-reply"; nativeEtagAtDispatch?: string };
type ProviderSummary = { kind: string; status: number | null; errorCode: string | null; retry: string | null; retryAfterMs: number | null };
type FactSummary = { provider: ProviderSummary; remoteKind: string; remoteEtag: string | null; remoteStatus: 404 | null; possibleDispatch: boolean };
export type MicrosoftDeleteSummary = FactSummary & {
  status: "acked" | "hold" | "conflict"; methods: string[]; paths: string[]; ifMatch: (string | null)[]; prefer: (string | null)[];
  dispatchVersions: (string | null)[]; ackKinds: string[]; finishStatuses: string[]; evidence: FactSummary[];
  mutationMarks: number; retryAfterMs: number | null; errorCode: string | null; errorOutcome: "not-written" | "unconfirmed" | null;
};
export type MicrosoftDeleteScenario = {
  id: string; title: string; policy: "musubi" | "reference"; attemptNumber: number;
  recovery: { required: boolean; possibleDispatch: boolean }; priorProvider: MicrosoftRuntimeDeleteProviderFact;
  resolution: { expectedRemoteExists: true; expectedRemoteEtag: string } | null;
  exchanges: Exchange[]; expected: MicrosoftDeleteSummary;
};
export type MicrosoftDeleteSuite = { schemaVersion: 1; scenarios: MicrosoftDeleteScenario[] };
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
function list(value: unknown, choices: readonly unknown[], maximum = 32): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (const item of value as unknown[]) oneOf(item, choices);
}
function etag(value: unknown, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^W\/"[a-zA-Z0-9-]{1,64}"$/.test(value)) invalid();
}
function code(value: unknown) {
  if (value !== null && (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(value))) invalid();
}
function validJson(value: unknown, depth = 0): void {
  if (depth > 12) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > 4096) invalid(); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
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
function validateFact(value: unknown) {
  const fact = object(value, ["provider", "remoteKind", "remoteEtag", "remoteStatus", "possibleDispatch"]);
  const provider = object(fact.provider, ["kind", "status", "errorCode", "retry", "retryAfterMs"]);
  oneOf(provider.kind, ["not-dispatched", "accepted", "uncertain", "rejected"]);
  oneOf(provider.status, [null, 204, 404]); code(provider.errorCode);
  oneOf(provider.retry, [null, "never", "after-delay", "after-reconnect", "observe-only"]);
  integer(provider.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, true);
  oneOf(fact.remoteKind, ["unobserved", "absent", "present"]); etag(fact.remoteEtag, true); oneOf(fact.remoteStatus, [null, 404]);
  if (typeof fact.possibleDispatch !== "boolean") invalid();
}
function validateSummary(value: unknown) {
  const summary = object(value, ["status", "methods", "paths", "ifMatch", "prefer", "dispatchVersions", "ackKinds", "finishStatuses", "evidence",
    "provider", "remoteKind", "remoteEtag", "remoteStatus", "possibleDispatch", "mutationMarks", "retryAfterMs", "errorCode", "errorOutcome"]);
  oneOf(summary.status, ["acked", "hold", "conflict"]); list(summary.methods, ["GET", "DELETE"]);
  list(summary.paths, [EVENT_PATH, ME_PATH, CALENDAR_PATH]); list(summary.prefer, [null, SMALL_PREFER, DELIVERY_PREFER]);
  for (const key of ["ifMatch", "dispatchVersions"]) {
    if (!Array.isArray(summary[key]) || summary[key].length > 32) invalid();
    for (const value of summary[key] as unknown[]) etag(value, true);
  }
  for (const key of ["paths", "prefer", "ifMatch", "dispatchVersions"]) if ((summary[key] as unknown[]).length !== summary.methods.length) invalid();
  list(summary.ackKinds, ["exact-absence"], 1); list(summary.finishStatuses, ["hold", "conflict"], 1);
  validateFact(Object.fromEntries(["provider", "remoteKind", "remoteEtag", "remoteStatus", "possibleDispatch"].map(key => [key, summary[key]])));
  if (!Array.isArray(summary.evidence) || summary.evidence.length > 8) invalid();
  for (const fact of summary.evidence as unknown[]) validateFact(fact);
  integer(summary.mutationMarks, 0, 1); integer(summary.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, true); code(summary.errorCode);
  oneOf(summary.errorOutcome, [null, "not-written", "unconfirmed"]);
}
export function parseMicrosoftDeleteSuite(value: unknown): MicrosoftDeleteSuite {
  validJson(value);
  const suite = object(value, ["schemaVersion", "scenarios"]);
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 64) invalid();
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const scenario = object(raw, ["id", "title", "policy", "attemptNumber", "recovery", "priorProvider", "resolution", "exchanges", "expected"]);
    if (typeof scenario.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(scenario.id) || ids.has(scenario.id)) invalid();
    ids.add(scenario.id as string);
    if (typeof scenario.title !== "string" || !scenario.title.length || scenario.title.length > 160 || /[\u0000-\u001f\u007f]/.test(scenario.title)) invalid();
    oneOf(scenario.policy, ["musubi", "reference"]); integer(scenario.attemptNumber, 1, 100);
    const recovery = object(scenario.recovery, ["required", "possibleDispatch"]);
    if (typeof recovery.required !== "boolean" || typeof recovery.possibleDispatch !== "boolean" || recovery.required !== recovery.possibleDispatch) invalid();
    const prior = object(scenario.priorProvider, ["kind"], ["status", "error"]);
    if (prior.kind === "accepted") { object(prior, ["kind", "status"]); oneOf(prior.status, [204, 404]); }
    else if (prior.kind === "rejected") { object(prior, ["kind", "error"]); if (!SyncErrorSchema.safeParse(prior.error).success) invalid(); }
    else { object(prior, ["kind"]); oneOf(prior.kind, ["not-dispatched", "uncertain"]); }
    if (prior.kind !== "not-dispatched" && !recovery.possibleDispatch) invalid();
    if (scenario.resolution !== null) {
      const resolution = object(scenario.resolution, ["expectedRemoteExists", "expectedRemoteEtag"]);
      if (resolution.expectedRemoteExists !== true) invalid(); etag(resolution.expectedRemoteEtag);
    }
    if (!Array.isArray(scenario.exchanges) || scenario.exchanges.length > 32) invalid();
    for (const rawExchange of scenario.exchanges as unknown[]) {
      const exchange = object(rawExchange, ["method", "path"], ["status", "body", "headers", "error", "nativeEtagAtDispatch"]);
      oneOf(exchange.method, ["GET", "DELETE"]); oneOf(exchange.path, [EVENT_PATH, ME_PATH, CALENDAR_PATH]);
      if (exchange.nativeEtagAtDispatch !== undefined) { if (exchange.method !== "DELETE") invalid(); etag(exchange.nativeEtagAtDispatch); }
      if (exchange.error !== undefined) {
        oneOf(exchange.error, ["lost-reply"]); if (["status", "body", "headers"].some(key => Object.hasOwn(exchange, key))) invalid();
      } else {
        if (!Object.hasOwn(exchange, "status") || !Object.hasOwn(exchange, "body")) invalid(); integer(exchange.status, 200, 599);
        if ([204, 205, 304].includes(exchange.status as number) && exchange.body !== null) invalid();
        if (exchange.headers !== undefined) {
          const headers = object(exchange.headers, [], ["retry-after"]);
          if (headers["retry-after"] !== undefined && (typeof headers["retry-after"] !== "string" || !/^\d{1,6}$/.test(headers["retry-after"]))) invalid();
        }
      }
    }
    validateSummary(scenario.expected);
  }
  return structuredClone(value) as MicrosoftDeleteSuite;
}
export async function loadMicrosoftDeleteSuite(): Promise<MicrosoftDeleteSuite> {
  try {
    const url = new URL("./microsoft-delete.json", import.meta.url);
    if ((await stat(url)).size > 512_000) invalid();
    const source = await readFile(url, "utf8"); if (Buffer.byteLength(source) > 512_000) invalid();
    return parseMicrosoftDeleteSuite(JSON.parse(source));
  } catch (error) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("suite-unavailable", "The bundled scenario suite could not be loaded.");
  }
}
const policies: Record<MicrosoftDeleteScenario["policy"], MicrosoftPersonalDeletePolicy> = {
  musubi: { preflightPasses: 2, ambiguousRecovery: "deferred" }, reference: { preflightPasses: 1, ambiguousRecovery: "within-attempt" },
};
export function claimedMicrosoftDeleteInput(scenario: Pick<MicrosoftDeleteScenario, "recovery" | "priorProvider" | "attemptNumber" | "resolution">): ClaimedMicrosoftPersonalDelete {
  const event = EventSchema.parse({ id: "object:scenario", creatorID: "synthetic:user", organizer: "synthetic:user", calendars: ["calendar:scenario"],
    color: "#112233", title: "Synthetic event", description: null, location: null, start: "2026-10-13T08:00:00.000Z",
    end: "2026-10-13T09:00:00.000Z", isAllDay: false, isCanceled: false });
  const encoded = encodeEventV1("microsoft", event, undefined, { action: "delete", operationId: OPERATION_ID, acceptedAt: "2026-10-13T07:00:00.000Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "delete", version: 1 },
    ...encoded, commandId: "command:scenario", operationId: OPERATION_ID, hostObjectId: event.id,
    locator: { provider: "microsoft", connectionId: "logical:account", collectionId: "native/calendar", resourceId: "native/event" },
    sourceEpoch: { sourceId: "source:scenario", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:scenario", allowedSideEffects: ["provider-content-write"] });
  return { operationId: OPERATION_ID, attemptId: "attempt:scenario", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "delete", operationId: OPERATION_ID, commandId: envelope.commandId, hostObjectId: event.id,
      provider: "microsoft", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: "native/event",
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account", connectionGeneration: "1", calendarId: "native/calendar", eventId: "native/event" },
    acceptedEtag: 'W/"before"', attemptNumber: scenario.attemptNumber, recovery: scenario.recovery, priorProvider: scenario.priorProvider,
    ...(scenario.resolution ? { resolution: scenario.resolution } : {}) };
}
function factSummary(facts: MicrosoftRuntimeDeleteNativeFacts): FactSummary {
  const fact = facts.provider;
  return { provider: { kind: fact.kind, status: fact.kind === "accepted" ? fact.status : null, errorCode: fact.kind === "rejected" ? fact.error.code : null,
    retry: fact.kind === "rejected" ? fact.error.retry : null, retryAfterMs: fact.kind === "rejected" ? fact.error.retryAfterMs ?? null : null },
    remoteKind: facts.remote.kind, remoteEtag: facts.remote.kind === "present" ? facts.remote.read.etag : null,
    remoteStatus: facts.remote.kind === "absent" ? facts.remote.read.status : null, possibleDispatch: facts.possibleDispatch };
}
/** Optional claims are a malformed-admission test seam, never executable fixture data. */
export async function runMicrosoftDeleteScenario(raw: MicrosoftDeleteScenario, suppliedClaim?: ClaimedMicrosoftPersonalDelete): Promise<MicrosoftDeleteSummary> {
  const scenario = parseMicrosoftDeleteSuite({ schemaVersion: 1, scenarios: [raw] }).scenarios[0]!;
  let next = 0, mutationMarks = 0, observations = 0, exchangeFailed = false, failedExchange = 0;
  const methods: string[] = [], paths: string[] = [], ifMatch: (string | null)[] = [], prefer: (string | null)[] = [], dispatchVersions: (string | null)[] = [];
  const acks: MicrosoftRuntimeDeleteCompletionEvidence[] = [], finishes: MicrosoftRuntimeDeleteFinishOutcome[] = [], evidence: FactSummary[] = [];
  const host: MicrosoftPersonalDeleteHostPorts = {
    async renew() { return true; },
    accountSession: { async open(scope) { return { ...scope, accessToken: "synthetic-test-credential", eventWriteAllowed: true }; } },
    async beforeMutation() { mutationMarks++; }, async recordEvidence(facts) { evidence.push(factSummary(facts)); },
    async ack(item) { acks.push(item); return { kind: "acknowledged" }; }, async finish(item) { finishes.push(item); },
    observationId() { return `observation:${++observations}`; },
  };
  const result = await runClaimedMicrosoftPersonalDelete(suppliedClaim ?? claimedMicrosoftDeleteInput(scenario), host, {
    http: { async fetch(url, init) {
      const exchange = scenario.exchanges[next++], method = init.method ?? "GET", headers = new Headers(init.headers);
      methods.push(method); paths.push(url.startsWith("https://graph.microsoft.com") ? url.slice("https://graph.microsoft.com".length) : "unexpected-origin");
      ifMatch.push(headers.get("if-match")); prefer.push(headers.get("prefer")); dispatchVersions.push(exchange?.nativeEtagAtDispatch ?? null);
      if (!exchange || url !== `https://graph.microsoft.com${exchange.path}` || method !== exchange.method || init.body !== undefined || init.redirect !== "error" ||
          headers.get("authorization") !== "Bearer synthetic-test-credential" || !(init.signal instanceof AbortSignal) ||
          (method === "GET" ? headers.has("if-match") || headers.get("cache-control") !== "no-cache" : headers.has("cache-control") || headers.has("prefer") || headers.get("if-match") !== 'W/"before"')) {
        // The production runtime catches transport failures. Keep harness failure
        // independent so a permissive HOLD expectation cannot hide an unplanned call.
        exchangeFailed = true; failedExchange ||= next; throw new Error("Synthetic exchange mismatch.");
      }
      if (exchange.error) throw new Error("Synthetic lost response.");
      return new Response(exchange.body === null ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: exchange.headers });
    } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() {} },
  }, policies[scenario.policy]);
  if (exchangeFailed) throw new ScenarioFailure("exchange-mismatch", `The runtime issued an unplanned provider request at exchange ${Math.min(failedExchange, 33)}.`);
  if (next !== scenario.exchanges.length) throw new ScenarioFailure("unconsumed-exchange", "The runtime did not consume every planned provider response.");
  const summary: MicrosoftDeleteSummary = { status: result.status, methods, paths, ifMatch, prefer, dispatchVersions,
    ackKinds: acks.map(item => item.kind), finishStatuses: finishes.map(item => item.status), evidence, ...factSummary(result.facts),
    mutationMarks, retryAfterMs: finishes.at(-1)?.retryAfterMs ?? null, errorCode: result.error?.code ?? null, errorOutcome: result.error?.outcome ?? null };
  if (!isDeepStrictEqual(summary, scenario.expected)) throw new ScenarioFailure("expectation-mismatch", "The observed runtime summary differs from the complete expected summary.");
  return summary;
}
