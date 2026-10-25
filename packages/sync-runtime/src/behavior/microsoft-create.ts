import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EventSchema, SyncErrorSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  projectMicrosoftCreatedEvent, runClaimedMicrosoftPersonalCreate,
  type ClaimedMicrosoftPersonalCreate, type MicrosoftPersonalCreateHostPorts, type MicrosoftPersonalCreatePolicy,
  type MicrosoftRuntimeCreateCompletionEvidence, type MicrosoftRuntimeCreateFinishOutcome,
  type MicrosoftRuntimeCreateNativeFacts, type MicrosoftRuntimeCreateProviderFact,
} from "../index";
import { ScenarioFailure } from "./google-delete";
export { ScenarioFailure } from "./google-delete";

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef";
const COLLECTION = "/v1.0/me/calendars/native%2Fcalendar/events";
const LEGACY_SELECT = "id,transactionId,subject,start,end,isAllDay,isCancelled,body,location,organizer,recurrence,onlineMeeting,onlineMeetingUrl";
const LISTING = `${COLLECTION}?$select=${LEGACY_SELECT}&$top=100`;
const STRICT_LISTING = `${COLLECTION}?$select=${LEGACY_SELECT},type,isOrganizer,isDraft,seriesMasterId,attendees,isOnlineMeeting&$top=100`;
const LEGACY_PREFER = 'outlook.timezone="UTC"';
const STRICT_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';
const PAGE2 = `${COLLECTION}?$skiptoken=owned`;
const CALENDAR = "/v1.0/me/calendars/native%2Fcalendar?$select=canEdit";
const STRICT_CALENDAR = "/v1.0/me/calendars/native%2Fcalendar?$select=id,canEdit,owner";
const ME = "/v1.0/me?$select=id,mail,userPrincipalName";
const PATHS = [COLLECTION, LISTING, STRICT_LISTING, PAGE2, CALENDAR, STRICT_CALENDAR, ME];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Exchange = { method: "GET" | "POST"; path: string; status?: number; body?: Json; headers?: Record<string, string>;
  error?: "lost-reply"; malformedJson?: true; responseURL?: "https://other.example.test/moved"; redirected?: true };
type ProviderSummary = { kind: string; status: number | null; eventId: string | null; etag: string | null;
  errorCode: string | null; retry: string | null; retryAfterMs: number | null };
type FactSummary = { provider: ProviderSummary; remoteKind: string; remoteId: string | null; remoteEtag: string | null;
  remoteHash: string | null; possibleDispatch: boolean };
export type MicrosoftCreateSummary = FactSummary & {
  status: "acked" | "hold" | "conflict"; methods: string[]; paths: string[]; redirects: (string | null)[];
  prefer: (string | null)[]; bodyHashes: (string | null)[]; markers: (string | null)[];
  metrics: { method: string; status: number | string }[]; ackKinds: string[]; finishStatuses: string[]; evidence: FactSummary[];
  mutationMarks: number; normalizations: number; retryAfterMs: number | null; errorCode: string | null; errorOutcome: string | null;
};
export type MicrosoftCreateScenario = {
  id: string; title: string; policy: "musubi" | "reference"; normalize: "project" | "throw";
  recovery: { required: boolean; possibleDispatch: boolean }; priorProvider: MicrosoftRuntimeCreateProviderFact;
  priorCandidateEventId?: string | null;
  exchanges: Exchange[]; expected: MicrosoftCreateSummary;
};
export type MicrosoftCreateSuite = { schemaVersion: 1; scenarios: MicrosoftCreateScenario[] };
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Scenario suite does not match schema version 1."); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key) ||
      !Object.getOwnPropertyDescriptor(item, key)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(item, key)!)) || required.some(key => !Object.hasOwn(item, key))) invalid();
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
function text(value: unknown, nullable = true) { if (!(nullable && value === null) && (typeof value !== "string" || value.length > 256)) invalid(); }
function code(value: unknown) { if (value !== null && (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(value))) invalid(); }
function hash(value: unknown) { if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) invalid(); }
function validJson(value: unknown, depth = 0, budget = { remaining: 100_000 }): void {
  if (--budget.remaining < 0 || depth > 16) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (value.length > 8192) invalid(); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid(); validJson(descriptor!.value, depth + 1, budget);
    }
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Reflect.ownKeys(value); if (keys.length > 64) invalid();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || key.length > 128 || !descriptor.enumerable || !("value" in descriptor)) invalid();
      validJson(descriptor.value, depth + 1, budget);
    }
    return;
  }
  invalid();
}
function validateFact(value: unknown): void {
  const fact = object(value, ["provider", "remoteKind", "remoteId", "remoteEtag", "remoteHash", "possibleDispatch"]);
  const provider = object(fact.provider, ["kind", "status", "eventId", "etag", "errorCode", "retry", "retryAfterMs"]);
  oneOf(provider.kind, ["not-dispatched", "accepted", "uncertain", "rejected"]); oneOf(provider.status, [null, 200, 201, 204]);
  text(provider.eventId); text(provider.etag); code(provider.errorCode); oneOf(provider.retry, [null, "never", "after-delay", "after-reconnect"]);
  integer(provider.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, true);
  oneOf(fact.remoteKind, ["unobserved", "missing", "confirmed", "conflict"]); text(fact.remoteId); text(fact.remoteEtag); hash(fact.remoteHash);
  if (typeof fact.possibleDispatch !== "boolean") invalid();
}
function validateSummary(value: unknown): void {
  const summary = object(value, ["status", "methods", "paths", "redirects", "prefer", "bodyHashes", "markers", "metrics", "ackKinds", "finishStatuses", "evidence",
    "provider", "remoteKind", "remoteId", "remoteEtag", "remoteHash", "possibleDispatch", "mutationMarks", "normalizations", "retryAfterMs", "errorCode", "errorOutcome"]);
  oneOf(summary.status, ["acked", "hold", "conflict"]); list(summary.methods, ["GET", "POST"]); list(summary.paths, PATHS);
  list(summary.redirects, [null, "error"]); list(summary.prefer, [null, LEGACY_PREFER, STRICT_PREFER]); list(summary.markers, [null, OPERATION_ID]);
  if (!Array.isArray(summary.bodyHashes) || summary.bodyHashes.length > 32) invalid();
  for (const item of summary.bodyHashes as unknown[]) hash(item);
  for (const key of ["paths", "redirects", "prefer", "bodyHashes", "markers"]) if ((summary[key] as unknown[]).length !== summary.methods.length) invalid();
  list(summary.ackKinds, ["provider-response", "correlated-readback"], 1); list(summary.finishStatuses, ["hold", "conflict"], 1);
  validateFact(Object.fromEntries(["provider", "remoteKind", "remoteId", "remoteEtag", "remoteHash", "possibleDispatch"].map(key => [key, summary[key]])));
  if (!Array.isArray(summary.evidence) || summary.evidence.length > 8 || !Array.isArray(summary.metrics) || summary.metrics.length > 32) invalid();
  for (const fact of summary.evidence as unknown[]) validateFact(fact);
  for (const value of summary.metrics as unknown[]) {
    const metric = object(value, ["method", "status"]); oneOf(metric.method, ["GET", "POST"]);
    if (metric.status !== "network-error" && metric.status !== "aborted") integer(metric.status, 200, 599);
  }
  integer(summary.mutationMarks, 0, 1); integer(summary.normalizations, 0, 1); integer(summary.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, true);
  code(summary.errorCode); oneOf(summary.errorOutcome, [null, "not-written", "unconfirmed"]);
}
export function parseMicrosoftCreateSuite(value: unknown): MicrosoftCreateSuite {
  validJson(value);
  const suite = object(value, ["schemaVersion", "scenarios"]);
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 64) invalid();
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const scenario = object(raw, ["id", "title", "policy", "normalize", "recovery", "priorProvider", "exchanges", "expected"], ["priorCandidateEventId"]);
    if (typeof scenario.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(scenario.id) || ids.has(scenario.id)) invalid(); ids.add(scenario.id as string);
    if (typeof scenario.title !== "string" || !scenario.title.length || scenario.title.length > 160 || /[\u0000-\u001f\u007f]/.test(scenario.title)) invalid();
    oneOf(scenario.policy, ["musubi", "reference"]); oneOf(scenario.normalize, ["project", "throw"]);
    const recovery = object(scenario.recovery, ["required", "possibleDispatch"]);
    if (typeof recovery.required !== "boolean" || typeof recovery.possibleDispatch !== "boolean" || recovery.required !== recovery.possibleDispatch) invalid();
    const prior = object(scenario.priorProvider, ["kind"], ["status", "eventId", "validator", "error"]);
    if (prior.kind === "accepted") { object(prior, ["kind", "status", "eventId", "validator"]); oneOf(prior.status, [200, 201, 204]); text(prior.eventId, false); if (!prior.eventId) invalid(); text(prior.validator); }
    else if (prior.kind === "rejected") { object(prior, ["kind", "error"]); if (!SyncErrorSchema.safeParse(prior.error).success) invalid(); }
    else { object(prior, ["kind"]); oneOf(prior.kind, ["not-dispatched", "uncertain"]); }
    if (prior.kind !== "not-dispatched" && !recovery.possibleDispatch) invalid();
    if (Object.hasOwn(scenario, "priorCandidateEventId")) {
      text(scenario.priorCandidateEventId);
      if (scenario.priorCandidateEventId !== null && (!scenario.priorCandidateEventId || !recovery.possibleDispatch ||
          prior.kind === "accepted" && prior.eventId !== scenario.priorCandidateEventId)) invalid();
    }
    if (!Array.isArray(scenario.exchanges) || scenario.exchanges.length > 32) invalid();
    for (const rawExchange of scenario.exchanges as unknown[]) {
      const exchange = object(rawExchange, ["method", "path"], ["status", "body", "headers", "error", "malformedJson", "responseURL", "redirected"]);
      oneOf(exchange.method, ["GET", "POST"]); oneOf(exchange.path, PATHS);
      if (exchange.error !== undefined) {
        oneOf(exchange.error, ["lost-reply"]);
        if (["status", "body", "headers", "malformedJson", "responseURL", "redirected"].some(key => Object.hasOwn(exchange, key))) invalid();
      } else {
        if (!Object.hasOwn(exchange, "status") || !Object.hasOwn(exchange, "body")) invalid(); integer(exchange.status, 200, 599);
        if ([204, 205, 304].includes(exchange.status as number) && exchange.body !== null) invalid();
        if (exchange.malformedJson !== undefined) { if (exchange.malformedJson !== true || exchange.body !== null || [204, 205, 304].includes(exchange.status as number)) invalid(); }
        if (exchange.responseURL !== undefined) oneOf(exchange.responseURL, ["https://other.example.test/moved"]);
        if (exchange.redirected !== undefined && exchange.redirected !== true) invalid();
        if (exchange.headers !== undefined) {
          const headers = object(exchange.headers, [], ["retry-after", "content-range"]);
          for (const value of Object.values(headers)) if (typeof value !== "string" || !value || value.length > 64 || /[\r\n]/.test(value)) invalid();
        }
      }
    }
    validateSummary(scenario.expected);
  }
  return structuredClone(value) as MicrosoftCreateSuite;
}
export async function loadMicrosoftCreateSuite(): Promise<MicrosoftCreateSuite> {
  try {
    const url = new URL("./microsoft-create.json", import.meta.url);
    if ((await stat(url)).size > 512_000) invalid();
    const source = await readFile(url, "utf8"); if (Buffer.byteLength(source) > 512_000) invalid();
    return parseMicrosoftCreateSuite(JSON.parse(source));
  } catch (error) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("suite-unavailable", "The bundled scenario suite could not be loaded.");
  }
}
const policies: Record<MicrosoftCreateScenario["policy"], MicrosoftPersonalCreatePolicy> = {
  musubi: { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-microsoft" },
  reference: { completion: "correlated-readback", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference" },
};
export function claimedMicrosoftCreateInput(scenario: Pick<MicrosoftCreateScenario, "recovery" | "priorProvider" | "priorCandidateEventId">): ClaimedMicrosoftPersonalCreate {
  const event = EventSchema.parse({ id: "object:scenario", creatorID: "synthetic:user", organizer: "synthetic:user", calendars: ["calendar:scenario"],
    color: "#112233", title: "Synthetic event", description: null, location: null, start: "2026-10-13T08:00:00.000Z",
    end: "2026-10-13T09:00:00.000Z", isAllDay: false, isCanceled: false });
  const encoded = encodeEventV1("microsoft", event, undefined, { action: "create", operationId: OPERATION_ID, acceptedAt: "2026-10-13T07:00:00.000Z" });
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    ...encoded, commandId: "command:scenario", operationId: OPERATION_ID, hostObjectId: event.id,
    locator: { provider: "microsoft", connectionId: "logical:account", collectionId: "native/calendar", resourceId: null },
    sourceEpoch: { sourceId: "source:scenario", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:scenario", allowedSideEffects: ["provider-content-write"] });
  return { operationId: OPERATION_ID, attemptId: "attempt:scenario", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "create", operationId: OPERATION_ID, commandId: envelope.commandId, hostObjectId: event.id,
      provider: "microsoft", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: null,
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account", connectionGeneration: "1", calendarId: "native/calendar" },
    recovery: scenario.recovery, priorProvider: scenario.priorProvider,
    ...(scenario.priorCandidateEventId === undefined ? {} : { priorCandidateEventId: scenario.priorCandidateEventId }) };
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function factSummary(facts: MicrosoftRuntimeCreateNativeFacts): FactSummary {
  const provider = facts.provider, remote = facts.remote;
  return { provider: { kind: provider.kind, status: provider.kind === "accepted" ? provider.status : null,
    eventId: provider.kind === "accepted" ? provider.eventId : null, etag: provider.kind === "accepted" ? provider.validator : null,
    errorCode: provider.kind === "rejected" ? provider.error.code : null, retry: provider.kind === "rejected" ? provider.error.retry : null,
    retryAfterMs: provider.kind === "rejected" ? provider.error.retryAfterMs ?? null : null },
    remoteKind: remote.kind, remoteId: remote.kind === "confirmed" || remote.kind === "conflict" ? remote.read.event.id : null,
    remoteEtag: remote.kind === "confirmed" || remote.kind === "conflict" ? remote.read.etag : null,
    remoteHash: remote.kind === "confirmed" || remote.kind === "conflict" ? sha(JSON.stringify(remote.read.event)) : null,
    possibleDispatch: facts.possibleDispatch };
}
/** Optional malformed claim is a test seam, never executable JSON configuration. */
export async function runMicrosoftCreateScenario(raw: MicrosoftCreateScenario, suppliedClaim?: ClaimedMicrosoftPersonalCreate): Promise<MicrosoftCreateSummary> {
  const scenario = parseMicrosoftCreateSuite({ schemaVersion: 1, scenarios: [raw] }).scenarios[0]!, claim = suppliedClaim ?? claimedMicrosoftCreateInput(scenario);
  const envelope = (claim.payload as { operationEnvelope: { nativePlan: { data: { body: unknown } } } }).operationEnvelope;
  const acceptedBody = JSON.stringify(envelope.nativePlan.data.body);
  let next = 0, mutationMarks = 0, normalizations = 0, observations = 0, exchangeFailed = false;
  const methods: string[] = [], paths: string[] = [], redirects: (string | null)[] = [], prefer: (string | null)[] = [], bodyHashes: (string | null)[] = [], markers: (string | null)[] = [];
  const metrics: MicrosoftCreateSummary["metrics"] = [], acks: MicrosoftRuntimeCreateCompletionEvidence[] = [], finishes: MicrosoftRuntimeCreateFinishOutcome[] = [], evidence: FactSummary[] = [];
  const host: MicrosoftPersonalCreateHostPorts = {
    async renew() { return true; }, accountSession: { async open(scope) { return { ...scope, accessToken: "synthetic-test-credential", eventWriteAllowed: true }; } },
    async beforeMutation() { mutationMarks++; }, normalizeObservation(read) {
      normalizations++; if (scenario.normalize === "throw") throw new TypeError("Synthetic host normalization failure.");
      return projectMicrosoftCreatedEvent(read.event);
    }, async recordEvidence(facts) { evidence.push(factSummary(facts)); },
    async ack(value) { acks.push(value); return { kind: "acknowledged" }; }, async finish(value) { finishes.push(value); },
    observationId() { return `observation:${++observations}`; },
  };
  const result = await runClaimedMicrosoftPersonalCreate(claim, host, {
    http: { async fetch(url, init) {
      const exchange = scenario.exchanges[next++], method = init.method ?? "GET", headers = new Headers(init.headers);
      let path: string;
      try { const address = new URL(url); path = `${address.pathname}${address.search}`; }
      catch { exchangeFailed = true; throw new Error("Synthetic exchange mismatch."); }
      let marker: unknown = null;
      try { if (init.body !== undefined) marker = JSON.parse(String(init.body)).transactionId; } catch { exchangeFailed = true; }
      methods.push(method); paths.push(path); redirects.push(init.redirect ?? null); prefer.push(headers.get("prefer"));
      bodyHashes.push(typeof init.body === "string" ? sha(init.body) : null); markers.push(typeof marker === "string" ? marker : null);
      const isLegacyPreflight = scenario.policy === "musubi" && path === CALENDAR;
      const isListing = [LISTING, STRICT_LISTING, PAGE2].includes(path);
      if (!exchange || url !== `https://graph.microsoft.com${exchange.path}` || method !== exchange.method ||
          init.redirect !== (isLegacyPreflight ? undefined : "error") || headers.has("if-match") ||
          headers.get("authorization") !== "Bearer synthetic-test-credential" ||
          headers.get("prefer") !== (isListing ? scenario.policy === "reference" ? STRICT_PREFER : LEGACY_PREFER : null) ||
          headers.get("cache-control") !== (isListing || scenario.policy === "reference" && method === "GET" ? "no-cache" : null) ||
          (method === "POST" ? path !== COLLECTION || init.body !== acceptedBody || headers.get("content-type") !== "application/json" : init.body !== undefined || headers.has("content-type"))) {
        exchangeFailed = true; throw new Error("Synthetic exchange mismatch.");
      }
      if (exchange.error) throw new Error("Synthetic lost response.");
      const response = new Response(exchange.malformedJson ? "synthetic-invalid-json" : exchange.body === null ? null : JSON.stringify(exchange.body), { status: exchange.status, headers: exchange.headers });
      if (exchange.responseURL) Object.defineProperty(response, "url", { value: exchange.responseURL });
      if (exchange.redirected) Object.defineProperty(response, "redirected", { value: true });
      return response;
    } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record(metric) { metrics.push({ method: metric.method, status: metric.status }); } },
  }, policies[scenario.policy]);
  if (exchangeFailed) throw new ScenarioFailure("exchange-mismatch", "The runtime issued an unplanned provider request.");
  if (next !== scenario.exchanges.length) throw new ScenarioFailure("unconsumed-exchange", "The runtime did not consume every planned provider response.");
  const summary: MicrosoftCreateSummary = { status: result.status, methods, paths, redirects, prefer, bodyHashes, markers, metrics,
    ackKinds: acks.map(value => value.kind), finishStatuses: finishes.map(value => value.status), evidence, ...factSummary(result.facts),
    mutationMarks, normalizations, retryAfterMs: finishes.at(-1)?.retryAfterMs ?? null, errorCode: result.error?.code ?? null, errorOutcome: result.error?.outcome ?? null };
  if (!isDeepStrictEqual(summary, scenario.expected)) throw new ScenarioFailure("expectation-mismatch", "The observed runtime summary differs from the complete expected summary.");
  return summary;
}
