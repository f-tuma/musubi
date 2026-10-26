import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { SyncJsonValueSchema, SyncOperationEnvelopeSchema } from "@musubi/types";
import { runClaimedGooglePersonalUpdate, type ClaimedGooglePersonalUpdate, type GooglePersonalUpdateHostPorts,
  type GooglePersonalUpdatePolicy, type RuntimeCompletionEvidence, type RuntimeFinishOutcome } from "../index";

type Exchange = { method: "GET" | "PATCH"; path: string; status?: number; body?: unknown; error?: "lost-reply" };
export type GoogleUpdateSummary = { status: string; methods: string[]; ifMatch: (string | null)[]; bodies: unknown[];
  sessions: number; mutationMarks: number; ackKinds: string[]; finishStatuses: string[];
  providerKind: string; validator: string | null; remoteKind: string; possibleDispatch: boolean; metrics: number };
export type GoogleUpdateScenario = { id: string; title: string; policy: "reference" | "musubi";
  fault?: "wrong-session" | "unknown-version" | "reject-ack"; exchanges: Exchange[]; expected: GoogleUpdateSummary };
export type GoogleUpdateSuite = { schemaVersion: 1; scenarios: GoogleUpdateScenario[] };
export class ScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "exchange-mismatch" | "unconsumed-exchange" | "expectation-mismatch" | "invalid-arguments" | "unknown-scenario" | "suite-unavailable", message: string) { super(message); }
}
const invalid = (): never => { throw new ScenarioFailure("invalid-suite", "Invalid Google UPDATE scenario schema."); };
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return record;
}
const paths = ["/calendar/v3/users/me/calendarList/native%2Fcalendar", "/calendar/v3/calendars/native%2Fcalendar/events/native%2Fevent"];
export function parseGoogleUpdateSuite(value: unknown): GoogleUpdateSuite {
  if (!SyncJsonValueSchema.safeParse(value).success) invalid();
  const suite = object(value, ["schemaVersion", "scenarios"]);
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || suite.scenarios.length < 1 || suite.scenarios.length > 64) invalid();
  const ids = new Set<string>();
  for (const raw of suite.scenarios as unknown[]) {
    const s = object(raw, ["id", "title", "policy", "exchanges", "expected"], ["fault"]);
    if (typeof s.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(s.id) || ids.has(s.id)) invalid(); ids.add(s.id as string);
    if (typeof s.title !== "string" || !s.title || s.title.length > 160 || /[\u0000-\u001f\u007f]/.test(s.title)) invalid();
    if (!["reference", "musubi"].includes(s.policy as string) || s.fault !== undefined && !["wrong-session", "unknown-version", "reject-ack"].includes(s.fault as string)) invalid();
    if (!Array.isArray(s.exchanges) || s.exchanges.length > 16) invalid();
    for (const rawExchange of s.exchanges as unknown[]) {
      const e = object(rawExchange, ["method", "path"], ["status", "body", "error"]);
      if (!["GET", "PATCH"].includes(e.method as string) || !paths.includes(e.path as string)) invalid();
      if (e.error !== undefined) { if (e.error !== "lost-reply" || Object.hasOwn(e, "status") || Object.hasOwn(e, "body")) invalid(); }
      else if (!Number.isInteger(e.status) || (e.status as number) < 200 || (e.status as number) > 599 || !Object.hasOwn(e, "body") ||
        [204, 205, 304].includes(e.status as number) && e.body !== null) invalid();
    }
    const expected = object(s.expected, ["status", "methods", "ifMatch", "bodies", "sessions", "mutationMarks", "ackKinds", "finishStatuses", "providerKind", "validator", "remoteKind", "possibleDispatch", "metrics"]);
    if (!["acked", "hold", "conflict"].includes(expected.status as string) || !["not-dispatched", "accepted", "uncertain", "rejected"].includes(expected.providerKind as string) ||
      !["unobserved", "confirmed", "conflict"].includes(expected.remoteKind as string) || typeof expected.possibleDispatch !== "boolean" ||
      expected.validator !== null && typeof expected.validator !== "string") invalid();
    for (const key of ["methods", "ifMatch", "bodies", "ackKinds", "finishStatuses"]) if (!Array.isArray(expected[key]) || (expected[key] as unknown[]).length > 16) invalid();
    if ((expected.methods as unknown[]).some(v => !["GET", "PATCH"].includes(v as string)) ||
      (expected.ackKinds as unknown[]).some(v => !["provider-response", "exact-readback"].includes(v as string)) ||
      (expected.finishStatuses as unknown[]).some(v => !["hold", "conflict"].includes(v as string)) ||
      (expected.ifMatch as unknown[]).some(v => v !== null && typeof v !== "string")) invalid();
    if ((expected.methods as unknown[]).length !== (expected.ifMatch as unknown[]).length || (expected.methods as unknown[]).length !== (expected.bodies as unknown[]).length) invalid();
    for (const key of ["sessions", "mutationMarks", "metrics"]) if (!Number.isInteger(expected[key]) || (expected[key] as number) < 0 || (expected[key] as number) > 32) invalid();
  }
  return structuredClone(value) as GoogleUpdateSuite;
}
export async function loadGoogleUpdateSuite(): Promise<GoogleUpdateSuite> {
  try { return parseGoogleUpdateSuite(JSON.parse(await readFile(new URL("./google-update.json", import.meta.url), "utf8"))); }
  catch (error) { if (error instanceof ScenarioFailure) throw error; throw new ScenarioFailure("suite-unavailable", "Google UPDATE scenarios cannot be loaded."); }
}
const policies: Record<GoogleUpdateScenario["policy"], GooglePersonalUpdatePolicy> = {
  reference: { completion: "exact-readback", ambiguousRecovery: "within-attempt", compareContent: "literal", untouchedPreflight: true, nativeProfile: "strict-reference", observeConflict: false },
  musubi: { completion: "provider-response", ambiguousRecovery: "deferred", compareContent: "nullable-empty", untouchedPreflight: false, nativeProfile: "existing-google", observeConflict: true },
};
function claim(): ClaimedGooglePersonalUpdate {
  const envelope = SyncOperationEnvelopeSchema.parse({ schemaVersion: 1, profileVersion: "sync-profile-v1", operation: { kind: "event", action: "update", version: 1 },
    serializer: { id: "google-personal-event", version: 1 }, commandId: "command:scenario", operationId: "operation:scenario", hostObjectId: "object:scenario",
    locator: { provider: "google", connectionId: "logical:scenario", collectionId: "native/calendar", resourceId: "native/event" },
    sourceEpoch: { sourceId: "source:scenario", generation: 1 }, acceptedRevision: 2, privacyEpoch: "private:scenario", allowedSideEffects: ["provider-content-write"],
    admittedProjection: { data: { title: "New", description: null, location: "Room", start: "2026-10-13T08:00:00.000Z", end: "2026-10-13T09:00:00.000Z", isAllDay: false, recurrence: null } },
    nativePlan: { kind: "codec-data", data: { planKind: "json-body", body: { summary: "New" } } } });
  return { operationId: envelope.operationId, attemptId: "attempt:scenario", payload: { operationEnvelope: envelope },
    binding: { kind: "event", action: "update", operationId: envelope.operationId, commandId: envelope.commandId, hostObjectId: envelope.hostObjectId,
      provider: "google", connectionId: envelope.locator.connectionId, collectionId: envelope.locator.collectionId, resourceId: envelope.locator.resourceId,
      acceptedRevision: envelope.acceptedRevision, sourceEpoch: envelope.sourceEpoch, privacyEpoch: envelope.privacyEpoch },
    nativeTarget: { connectionId: "physical:scenario", connectionGeneration: "1", calendarId: "native/calendar", eventId: "native/event" },
    acceptedEtag: '"before"', recovery: { required: false, possibleDispatch: false }, priorProvider: { kind: "not-dispatched" } };
}
export async function runGoogleUpdateScenario(raw: GoogleUpdateScenario): Promise<GoogleUpdateSummary> {
  const s = parseGoogleUpdateSuite({ schemaVersion: 1, scenarios: [raw] }).scenarios[0]!;
  const input = claim(); if (s.fault === "unknown-version") (input.payload as { operationEnvelope: { schemaVersion: number } }).operationEnvelope.schemaVersion = 2;
  let next = 0, mismatch = false, sessions = 0, mutationMarks = 0, metrics = 0, observations = 0;
  const methods: string[] = [], ifMatch: (string | null)[] = [], bodies: unknown[] = [];
  const acks: RuntimeCompletionEvidence[] = [], finishes: RuntimeFinishOutcome[] = [];
  const host: GooglePersonalUpdateHostPorts = { async renew() { return true; }, accountSession: { async open(connection) {
    sessions++; return { ...connection, ...(s.fault === "wrong-session" ? { connectionId: "foreign:connection" } : {}), accessToken: "synthetic-update-token", eventWriteAllowed: true };
  } }, async beforeMutation() { mutationMarks++; }, async recordEvidence() {}, async ack(evidence) {
    acks.push(evidence); return { kind: s.fault === "reject-ack" ? "authority-rejected" : "acknowledged" };
  }, async finish(outcome) { finishes.push(outcome); }, observationId() { return `observation:${++observations}`; } };
  const result = await runClaimedGooglePersonalUpdate(input, host, { http: { async fetch(url, init) {
    const e = s.exchanges[next++]; methods.push(init.method ?? "GET"); ifMatch.push(new Headers(init.headers).get("if-match"));
    let body: unknown = null; try { if (init.body !== undefined) body = JSON.parse(String(init.body)); } catch { mismatch = true; }
    bodies.push(body);
    if (!e || String(url) !== `https://www.googleapis.com${e.path}` || init.method !== e.method || init.redirect !== "error" ||
      new Headers(init.headers).get("authorization") !== "Bearer synthetic-update-token" ||
      (init.method === "PATCH" ? !isDeepStrictEqual(body, { summary: "New" }) || new Headers(init.headers).get("if-match") !== '"before"' : init.body !== undefined)) {
      mismatch = true; throw new Error("Owned exchange mismatch.");
    }
    if (e.error) throw new Error("Owned lost response.");
    return new Response(e.body === null ? null : JSON.stringify(e.body), { status: e.status, headers: { "content-type": "application/json" } });
  } }, clock: { nowEpochMs: () => 0, nowMonotonicMs: () => 0 }, telemetry: { record() { metrics++; } } }, policies[s.policy]);
  if (mismatch) throw new ScenarioFailure("exchange-mismatch", "An actual native request differed from the scenario.");
  if (next !== s.exchanges.length) throw new ScenarioFailure("unconsumed-exchange", "Not every planned exchange was consumed.");
  const summary: GoogleUpdateSummary = { status: result.status, methods, ifMatch, bodies, sessions, mutationMarks, ackKinds: acks.map(v => v.kind),
    finishStatuses: finishes.map(v => v.status), providerKind: result.facts.provider.kind,
    validator: result.facts.provider.kind === "accepted" ? result.facts.provider.validator : null, remoteKind: result.facts.remote.kind,
    possibleDispatch: result.facts.possibleDispatch, metrics };
  if (!isDeepStrictEqual(summary, s.expected)) throw new ScenarioFailure("expectation-mismatch", "The complete observed production summary differs from the expected summary.");
  return summary;
}
