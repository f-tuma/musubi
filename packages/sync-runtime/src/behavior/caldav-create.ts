import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EventSchema, SyncErrorSchema, SyncJsonValueSchema, SyncOperationEnvelopeSchema, type SyncOperationEnvelope } from "@musubi/types";
import { encodeEventV1 } from "@musubi/sync-codec";
import {
  projectCaldavCreatedEvent, caldavPersonalCreateIdentityV1, runClaimedCaldavPersonalCreate, type ClaimedCaldavPersonalCreate, type CaldavPersonalCreateHostPorts, type CaldavPersonalCreatePolicy,
  type CaldavTimedProjection, type CaldavRuntimeCreateCompletionEvidence, type CaldavRuntimeCreateFinishOutcome, type CaldavRuntimeCreateNativeFacts, type CaldavRuntimeCreateProviderFact,
} from "../index";
import { ScenarioFailure } from "./google-delete";
export { ScenarioFailure } from "./google-delete";

const OPERATION_ID = "abcdef01-abcd-4000-8000-abcdefabcdef", UID = `musubi-${OPERATION_ID}`;
const COLLECTIONS = { default: "https://dav.example.test/cal/", "no-slash": "https://dav.example.test/cal",
  long: `https://dav.example.test/${"a".repeat(2023)}`, query: "https://dav.example.test/cal/?opaque=1", hash: "https://dav.example.test/cal/#opaque" };
const RESOURCES = Object.fromEntries(Object.entries(COLLECTIONS).map(([key, calendar]) => [key, caldavPersonalCreateIdentityV1(calendar, OPERATION_ID)!.resourceUrl]));
const URLS = [...Object.values(COLLECTIONS), ...Object.values(RESOURCES), "https://dav.example.test/alias/event.ics", "https://other.example.test/alias.ics"];
const propfindBody = (name: string) => `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><${name}/></d:prop></d:propfind>`;
const PROPFIND = { privileges: propfindBody("d:current-user-privilege-set") };
type Exchange = { method: "GET" | "PROPFIND" | "PUT"; url: string; status?: number; body?: string | null; headers?: Record<string, string>; error?: "lost-reply" };
type ProviderSummary = { kind: string; status: number | null; etag: string | null; errorCode: string | null; retry: string | null; retryAfterMs: number | null };
type FactSummary = { provider: ProviderSummary; remoteKind: string; remoteEtag: string | null; remoteUid: string | null; remoteUrl: string | null; remoteDataHash: string | null;
  remoteStatus: 404 | null; possibleDispatch: boolean };
export type CaldavCreateSummary = FactSummary & {
  status: "acked" | "hold" | "conflict"; methods: string[]; urls: string[]; ifNoneMatch: (string | null)[]; bodyHashes: (string | null)[]; authorized: boolean[]; propfindKinds: (string | null)[];
  metrics: { method: string; status: number | "network-error" | "aborted" }[]; dnsLookups: number; ackKinds: string[]; finishStatuses: string[]; evidence: FactSummary[];
  mutationMarks: number; normalizations: number; preparations: number; sessions: number; projectionPort: "portable" | "fixture" | "throw"; retryAfterMs: number | null; errorCode: string | null; errorOutcome: "not-written" | "unconfirmed" | null;
};
export type CaldavCreateScenario = {
  id: string; title: string; policy: "musubi" | "reference"; collection: keyof typeof COLLECTIONS; normalize: "project" | "throw"; hostProjection?: CaldavTimedProjection; binding?: "known"; dns: "public" | "mixed-private";
  recovery: { required: boolean; possibleDispatch: boolean }; priorProvider: CaldavRuntimeCreateProviderFact;
  exchanges: Exchange[]; expected: CaldavCreateSummary;
};
export type CaldavCreateSuite = { schemaVersion: 1; scenarios: CaldavCreateScenario[] };
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Scenario suite does not match schema version 1."); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key) ||
      !Object.getOwnPropertyDescriptor(item, key)?.enumerable || !("value" in Object.getOwnPropertyDescriptor(item, key)!)) || required.some(key => !Object.hasOwn(item, key))) invalid();
  return item;
}
function oneOf(value: unknown, choices: readonly unknown[]) { if (!choices.includes(value)) invalid(); }
function integer(value: unknown, max: number, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) invalid();
}
function list(value: unknown, choices: readonly unknown[], max = 32): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(); for (const item of value as unknown[]) oneOf(item, choices);
}
function code(value: unknown) { if (value !== null && (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(value))) invalid(); }
function tag(value: unknown) { if (value !== null && (typeof value !== "string" || !/^"[a-zA-Z0-9,-]{0,64}"$/.test(value))) invalid(); }
const FACT_KEYS = ["provider", "remoteKind", "remoteEtag", "remoteUid", "remoteUrl", "remoteDataHash", "remoteStatus", "possibleDispatch"];
function validateProjection(value: unknown) {
  const projection = object(value, ["title", "description", "location", "start", "end", "isAllDay", "recurrence"]);
  if (typeof projection.title !== "string" || projection.description !== null && typeof projection.description !== "string" || projection.location !== null && typeof projection.location !== "string" || projection.isAllDay !== false || projection.recurrence !== null) invalid();
  for (const key of ["start", "end"]) { const value = projection[key]; if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); }
  if ((projection.start as string) > (projection.end as string)) invalid();
}
function validateFact(value: unknown) {
  const fact = object(value, FACT_KEYS), provider = object(fact.provider, ["kind", "status", "etag", "errorCode", "retry", "retryAfterMs"]);
  oneOf(provider.kind, ["not-dispatched", "accepted", "uncertain", "rejected"]); oneOf(provider.status, [null, 200, 201, 204]);
  tag(provider.etag); code(provider.errorCode); oneOf(provider.retry, [null, "never", "after-delay", "after-reconnect", "observe-only"]); integer(provider.retryAfterMs, Number.MAX_SAFE_INTEGER, true);
  oneOf(fact.remoteKind, ["unobserved", "absent", "confirmed", "conflict"]); tag(fact.remoteEtag); oneOf(fact.remoteUid, [null, UID]); oneOf(fact.remoteUrl, [null, ...Object.values(RESOURCES)]);
  if (fact.remoteDataHash !== null && (typeof fact.remoteDataHash !== "string" || !/^[a-f0-9]{64}$/.test(fact.remoteDataHash))) invalid();
  oneOf(fact.remoteStatus, [null, 404]); if (typeof fact.possibleDispatch !== "boolean") invalid();
}
function validateSummary(value: unknown) {
  const summary = object(value, ["status", "methods", "urls", "ifNoneMatch", "bodyHashes", "authorized", "propfindKinds", "metrics", "dnsLookups", "ackKinds", "finishStatuses", "evidence",
    ...FACT_KEYS, "mutationMarks", "normalizations", "preparations", "sessions", "projectionPort", "retryAfterMs", "errorCode", "errorOutcome"]);
  oneOf(summary.status, ["acked", "hold", "conflict"]); list(summary.methods, ["GET", "PROPFIND", "PUT"]); list(summary.urls, URLS);
  list(summary.authorized, [true, false]); list(summary.propfindKinds, [null, "privileges"]);
  if (!Array.isArray(summary.ifNoneMatch) || summary.ifNoneMatch.length > 32) invalid(); for (const value of summary.ifNoneMatch as unknown[]) oneOf(value, [null, "*"]);
  if (!Array.isArray(summary.bodyHashes) || summary.bodyHashes.length > 32) invalid();
  for (const value of summary.bodyHashes as unknown[]) if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) invalid();
  for (const key of ["urls", "ifNoneMatch", "bodyHashes", "authorized", "propfindKinds"]) if ((summary[key] as unknown[]).length !== summary.methods.length) invalid();
  if (!Array.isArray(summary.metrics) || summary.metrics.length > 32) invalid();
  for (const item of summary.metrics as unknown[]) { const metric = object(item, ["method", "status"]); oneOf(metric.method, ["GET", "PROPFIND", "PUT"]);
    if (typeof metric.status === "number") { integer(metric.status, 599); if (metric.status < 100) invalid(); } else oneOf(metric.status, ["network-error", "aborted"]); }
  integer(summary.dnsLookups, 32); list(summary.ackKinds, ["provider-response", "exact-readback"], 1); list(summary.finishStatuses, ["hold", "conflict"], 1);
  validateFact(Object.fromEntries(FACT_KEYS.map(key => [key, summary[key]])));
  if (!Array.isArray(summary.evidence) || summary.evidence.length > 8) invalid(); for (const fact of summary.evidence as unknown[]) validateFact(fact);
  integer(summary.mutationMarks, 1); integer(summary.normalizations, 1); integer(summary.preparations, 1); integer(summary.sessions, 32);
  oneOf(summary.projectionPort, ["portable", "fixture", "throw"]); integer(summary.retryAfterMs, Number.MAX_SAFE_INTEGER, true); code(summary.errorCode); oneOf(summary.errorOutcome, [null, "not-written", "unconfirmed"]);
}
export function parseCaldavCreateSuite(value: unknown): CaldavCreateSuite {
  const suite = object(value, ["schemaVersion", "scenarios"]);
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length || suite.scenarios.length > 64) invalid();
  const scenarios = suite.scenarios as unknown[];
  if (Object.getPrototypeOf(scenarios) !== Array.prototype || Reflect.ownKeys(scenarios).length !== scenarios.length + 1) invalid();
  for (let index = 0; index < scenarios.length; index++) {
    const field = Object.getOwnPropertyDescriptor(scenarios, String(index));
    if (!field?.enumerable || !("value" in field) || !SyncJsonValueSchema.safeParse(field.value).success) invalid();
  }
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const scenario = object(raw, ["id", "title", "policy", "collection", "normalize", "dns", "recovery", "priorProvider", "exchanges", "expected"], ["hostProjection", "binding"]);
    if (typeof scenario.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(scenario.id) || ids.has(scenario.id)) invalid(); ids.add(scenario.id as string);
    if (typeof scenario.title !== "string" || !scenario.title.length || scenario.title.length > 160 || /[\u0000-\u001f\u007f]/.test(scenario.title)) invalid();
    oneOf(scenario.policy, ["musubi", "reference"]); oneOf(scenario.collection, Object.keys(COLLECTIONS)); oneOf(scenario.normalize, ["project", "throw"]);
    if (scenario.binding !== undefined) oneOf(scenario.binding, ["known"]);
    if (scenario.hostProjection !== undefined) { if (scenario.policy !== "musubi" || scenario.normalize !== "project") invalid(); validateProjection(scenario.hostProjection); } oneOf(scenario.dns, ["public", "mixed-private"]);
    const recovery = object(scenario.recovery, ["required", "possibleDispatch"]);
    if (typeof recovery.required !== "boolean" || typeof recovery.possibleDispatch !== "boolean" || recovery.required !== recovery.possibleDispatch) invalid();
    const prior = object(scenario.priorProvider, ["kind"], ["status", "validator", "error"]);
    if (prior.kind === "accepted") { object(prior, ["kind", "status", "validator"]); oneOf(prior.status, [200, 201, 204]); tag(prior.validator); }
    else if (prior.kind === "rejected") { object(prior, ["kind", "error"]); if (!SyncErrorSchema.safeParse(prior.error).success) invalid(); }
    else { object(prior, ["kind"]); oneOf(prior.kind, ["not-dispatched", "uncertain"]); }
    if (prior.kind !== "not-dispatched" && !recovery.possibleDispatch) invalid();
    if (!Array.isArray(scenario.exchanges) || scenario.exchanges.length > 32) invalid();
    for (const raw of scenario.exchanges as unknown[]) {
      const exchange = object(raw, ["method", "url"], ["status", "body", "headers", "error"]);
      oneOf(exchange.method, ["GET", "PROPFIND", "PUT"]); oneOf(exchange.url, URLS);
      if (exchange.error !== undefined) { oneOf(exchange.error, ["lost-reply"]); if (["status", "body", "headers"].some(key => Object.hasOwn(exchange, key))) invalid(); }
      else {
        if (!Object.hasOwn(exchange, "status") || !Object.hasOwn(exchange, "body")) invalid(); integer(exchange.status, 599); if ((exchange.status as number) < 200) invalid();
        if (exchange.body !== null && (typeof exchange.body !== "string" || exchange.body.length > 16_384)) invalid();
        if ([204, 205, 304].includes(exchange.status as number) && exchange.body !== null) invalid();
        if (exchange.headers !== undefined) { const headers = object(exchange.headers, [], ["etag", "retry-after", "location", "content-range"]);
          for (const value of Object.values(headers)) if (typeof value !== "string" || value.length > 2048 || /[\r\n]/.test(value)) invalid(); }
      }
    }
    validateSummary(scenario.expected);
  }
  return structuredClone(value) as CaldavCreateSuite;
}
export async function loadCaldavCreateSuite(): Promise<CaldavCreateSuite> {
  try {
    const url = new URL("./caldav-create.json", import.meta.url); if ((await stat(url)).size > 512_000) invalid();
    const source = await readFile(url, "utf8"); if (Buffer.byteLength(source) > 512_000) invalid(); return parseCaldavCreateSuite(JSON.parse(source));
  } catch (error) { if (error instanceof ScenarioFailure) throw error; throw new ScenarioFailure("suite-unavailable", "The bundled scenario suite could not be loaded."); }
}
const policies: Record<CaldavCreateScenario["policy"], CaldavPersonalCreatePolicy> = {
  musubi: { completion: "provider-response", ambiguousRecovery: "deferred", nativeProfile: "existing-caldav", requireStrongReadback: false },
  reference: { completion: "exact-readback", ambiguousRecovery: "within-attempt", nativeProfile: "strict-reference", requireStrongReadback: true },
};
export function claimedCaldavCreateInput(scenario: Pick<CaldavCreateScenario, "recovery" | "priorProvider" | "collection" | "binding">): ClaimedCaldavPersonalCreate {
  const CALENDAR = COLLECTIONS[scenario.collection], RESOURCE = RESOURCES[scenario.collection]!;
  const event = EventSchema.parse({ id: "object:scenario", creatorID: "synthetic:user", organizer: "synthetic:user", calendars: ["calendar:scenario"],
    color: "#112233", title: "Synthetic event", description: null, location: null, start: "2026-10-13T08:00:00.000Z", end: "2026-10-13T09:00:00.000Z", isAllDay: false, isCanceled: false });
  const encoded = encodeEventV1("caldav", event, undefined, { action: "create", uid: UID, operationId: OPERATION_ID, acceptedAt: "2026-10-13T07:00:00.000Z" });
  const rawEnvelope = { schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "create", version: 1 },
    ...encoded, commandId: "command:scenario", operationId: OPERATION_ID, hostObjectId: event.id,
    locator: { provider: "caldav", connectionId: "logical:account", collectionId: CALENDAR, resourceId: RESOURCE }, sourceEpoch: { sourceId: "source:scenario", generation: 1 },
    acceptedRevision: 2, privacyEpoch: "private:scenario", allowedSideEffects: ["provider-content-write"] };
  // One declared native-address fixture exercises the existing v1 decode limit,
  // rather than failing in this builder before the actual runtime sees the JSON.
  const envelope = scenario.collection === "long" ? rawEnvelope as unknown as SyncOperationEnvelope : SyncOperationEnvelopeSchema.parse(rawEnvelope);
  return { operationId: OPERATION_ID, attemptId: "attempt:scenario", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "create", operationId: OPERATION_ID, commandId: envelope.commandId, hostObjectId: event.id, provider: "caldav", connectionId: envelope.locator.connectionId,
      collectionId: CALENDAR, resourceId: scenario.binding === "known" ? RESOURCE : null, acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:account", connectionGeneration: "1760000000000", calendarUrl: CALENDAR, resourceUrl: RESOURCE, uid: UID },
    recovery: scenario.recovery, priorProvider: scenario.priorProvider };
}
function factSummary(facts: CaldavRuntimeCreateNativeFacts): FactSummary {
  const fact = facts.provider, remote = facts.remote;
  return { provider: { kind: fact.kind, status: fact.kind === "accepted" ? fact.status : null, etag: fact.kind === "accepted" ? fact.validator : null, errorCode: fact.kind === "rejected" ? fact.error.code : null,
    retry: fact.kind === "rejected" ? fact.error.retry : null, retryAfterMs: fact.kind === "rejected" ? fact.error.retryAfterMs ?? null : null }, remoteKind: remote.kind,
    remoteEtag: (remote.kind === "confirmed" || remote.kind === "conflict") ? remote.read.etag : null, remoteUid: (remote.kind === "confirmed" || remote.kind === "conflict") ? remote.read.resource.uid : null,
    remoteUrl: (remote.kind === "confirmed" || remote.kind === "conflict") ? remote.read.resource.resourceUrl : null,
    remoteDataHash: (remote.kind === "confirmed" || remote.kind === "conflict") ? createHash("sha256").update(remote.read.resource.data).digest("hex") : null,
    remoteStatus: remote.kind === "absent" ? 404 : null, possibleDispatch: facts.possibleDispatch };
}
/** Optional claims test malformed immutable admission, never executable JSON. */
export async function runCaldavCreateScenario(raw: CaldavCreateScenario, suppliedClaim?: ClaimedCaldavPersonalCreate): Promise<CaldavCreateSummary> {
  const scenario = parseCaldavCreateSuite({ schemaVersion: 1, scenarios: [raw] }).scenarios[0]!;
  let next = 0, failedExchange = 0, mutationMarks = 0, normalizations = 0, preparations = 0, sessions = 0, observations = 0, dnsLookups = 0;
  const methods: string[] = [], urls: string[] = [], bodyHashes: (string | null)[] = [], ifNoneMatch: (string | null)[] = [], authorized: boolean[] = [], propfindKinds: (string | null)[] = [];
  const acks: CaldavRuntimeCreateCompletionEvidence[] = [], finishes: CaldavRuntimeCreateFinishOutcome[] = [], evidence: FactSummary[] = [], metrics: CaldavCreateSummary["metrics"] = [];
  const claim = suppliedClaim ?? claimedCaldavCreateInput(scenario);
  const acceptedBody = (claim.payload as { operationEnvelope: { nativePlan: { data: { createResource: string } } } }).operationEnvelope.nativePlan.data.createResource;
  const host: CaldavPersonalCreateHostPorts = {
    async renew() { return true; }, async prepare() { preparations++; },
    accountSession: { async open(scope) { sessions++; return { ...scope, authorization: "Basic SYNTHETIC_FIXTURE" }; } },
    async beforeMutation() { mutationMarks++; }, normalizeObservation(read) {
      normalizations++; if (scenario.normalize === "throw") throw new TypeError("Synthetic host normalization failure.");
      return scenario.hostProjection ? structuredClone(scenario.hostProjection) : projectCaldavCreatedEvent(read.resource);
    }, async recordEvidence(facts) { evidence.push(factSummary(facts)); },
    async ack(item) { acks.push(item); return { kind: "acknowledged" }; }, async finish(item) { finishes.push(item); }, observationId() { return `observation:${++observations}`; },
  };
  const result = await runClaimedCaldavPersonalCreate(claim, host, {
    network: { allowPrivate: false, async lookupImpl() { dnsLookups++; return scenario.dns === "mixed-private" ? [{ address: "203.0.113.10", family: 4 }, { address: "127.0.0.1", family: 4 }] : [{ address: "203.0.113.10", family: 4 }]; } },
    http: { async fetchPinned(url, init, address) {
      const exchange = scenario.exchanges[next++], method = init.method ?? "GET", headers = new Headers(init.headers);
      const property = Object.entries(PROPFIND).find(([, body]) => body === init.body)?.[0] ?? null;
      methods.push(method); urls.push(url.href); ifNoneMatch.push(headers.get("if-none-match")); authorized.push(headers.has("authorization")); propfindKinds.push(property); bodyHashes.push(method === "PUT" && typeof init.body === "string" ? createHash("sha256").update(init.body).digest("hex") : null);
      if (!exchange || url.href !== exchange.url || method !== exchange.method || init.redirect !== "manual" || address.address !== "203.0.113.10" ||
          !(init.signal instanceof AbortSignal) || (url.origin === "https://dav.example.test" ? headers.get("authorization") !== "Basic SYNTHETIC_FIXTURE" : headers.has("authorization")) ||
          headers.has("if-match") ||
          (method === "PUT" ? init.body !== acceptedBody || headers.get("if-none-match") !== "*" || headers.get("content-type") !== "text/calendar; charset=utf-8" : headers.has("if-none-match") || headers.get("cache-control") !== "no-cache") ||
          (method === "PROPFIND" ? property !== "privileges" || headers.get("depth") !== "0" || headers.get("content-type") !== "application/xml" : method !== "PUT" && (init.body !== undefined || headers.get("accept") !== "text/calendar"))) {
        failedExchange ||= Math.min(next, 33); throw new Error("Synthetic exchange mismatch.");
      }
      if (exchange.error) throw new TypeError("Synthetic lost response.");
      return new Response(exchange.body, { status: exchange.status, headers: exchange.headers });
    } },
    clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record(metric) { metrics.push({ method: metric.method, status: metric.status }); } },
  }, policies[scenario.policy]);
  if (failedExchange) throw new ScenarioFailure("exchange-mismatch", `The runtime issued an unplanned provider request at exchange ${failedExchange}.`);
  if (next !== scenario.exchanges.length) throw new ScenarioFailure("unconsumed-exchange", "The runtime did not consume every planned provider response.");
  const summary: CaldavCreateSummary = { status: result.status, methods, urls, ifNoneMatch, bodyHashes, authorized, propfindKinds, metrics, dnsLookups,
    ackKinds: acks.map(item => item.kind), finishStatuses: finishes.map(item => item.status), evidence, ...factSummary(result.facts), mutationMarks, normalizations, preparations, sessions, projectionPort: scenario.normalize === "throw" ? "throw" : scenario.hostProjection ? "fixture" : "portable",
    retryAfterMs: finishes.at(-1)?.retryAfterMs ?? null, errorCode: result.error?.code ?? null, errorOutcome: result.error?.outcome ?? null };
  if (!isDeepStrictEqual(summary, scenario.expected)) throw new ScenarioFailure("expectation-mismatch", "The observed runtime summary differs from the complete expected summary.");
  return summary;
}
