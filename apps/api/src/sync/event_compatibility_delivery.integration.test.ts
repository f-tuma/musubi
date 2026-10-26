import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { EVENT_COMPATIBILITY_BASELINE, EVENT_COMPATIBILITY_BASELINE_SHA256, EVENT_COMPATIBILITY_FIXTURES, EVENT_COMPATIBILITY_CI_FIXTURES, EVENT_COMPATIBILITY_PROCESS_FIXTURES, EVENT_COMPATIBILITY_PROCESS_PHASES, EVENT_COMPATIBILITY_TABLES,
  eventCompatibilityFixtureSource, eventCompatibilityDataHash, eventCompatibilityNormalizedWitnessInput, eventCompatibilityGeneratedClockResource, eventCompatibilityAlarmWitnessInput, eventCompatibilityNormalizedAlarmWitnessInput, type EventCompatibilityWitness, type EventCompatibilityEchoObservation, type EventCompatibilitySerializerClock, type EventCompatibilityAlarmWitness, type EventFixtureSuite } from "./event_compatibility_fixture_manifest";

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
type RecordRow = { id: string; family: string; fixtureCase?: string; before: Record<string, unknown> | null; returned: unknown; after: Record<string, unknown> | null;
  state: Record<string, Record<string, unknown>[]>; wireStart: number; wireEnd: number;
  cohort?: { id: number; count: number; after: Record<string, unknown> | null; state: Record<string, Record<string, unknown>[]> } };
type FixtureReceipt = { schemaVersion: 1; label: "old" | "new"; sourceSha256: string; records: RecordRow[];
  harnessSha256?: string; harnessStable?: boolean; executorSourceSha256?: string; productionStart?: { sha256: string; files: Record<string, string> }; productionEnd?: { sha256: string; files: Record<string, string> }; sourceStable?: boolean;
  wire: { url: string; method: string; headers: Record<string, string>; body: string | null; redirect: string | null; status?: number; responseHeaders?: Record<string, string>; responseBody?: string }[];
  relayWire?: { method: string; path: string; headers: Record<string, string>; body: string }[];
  processReceipt?: { family: string; phase: string; operationId: string; before: Record<string, unknown>; checkpoint: Record<string, unknown>; afterKill: Record<string, unknown>; afterRestart: Record<string, unknown>;
    checkpointState: Record<string, Record<string, unknown>[]>; afterKillState: Record<string, Record<string, unknown>[]>; finalState: Record<string, Record<string, unknown>[]>; wireStart: number; recoveryWireStart: number; wireEnd: number; killedSignal: string | null };
  origins: { origin: string; alias: string }[]; ownedPoolsClosed: number; passed: boolean };
const volatile = new Set(["created_at", "updated_at", "createdAt", "updatedAt", "attempted_at", "attemptedAt", "lease_until", "leaseUntil", "lease_token", "leaseToken",
  "next_attempt_at", "nextAttemptAt", "observed_at", "observedAt", "provider_state_observed_at", "providerStateObservedAt", "startedAt", "acceptedAt", "completedAt", "deleted_at", "deletedAt"]);

/** Normalize generated fixture addresses and volatile host metadata only.
 * Canonical start/end, milliseconds, original slots, validators, all native
 * content fields and complete DAV resource bytes otherwise remain exact. */
export function normalizeEventCompatibilityReceipt(receipt: FixtureReceipt) {
  const recordRowRoot = "(?:records\\[\\]\\.(?:before|after|returned)|processReceipt\\.(?:before|checkpoint|afterKill|afterRestart))";
  const stateRoot = "(?:records\\[\\]\\.state|processReceipt\\.(?:checkpointState|afterKillState|finalState))";
  const outboxRoot = `(?:${recordRowRoot}|${stateRoot}\\.event_outbox\\[\\])`;
  const outboxPaths = new Map<string, RegExp>(), movePaths = new Map<string, RegExp>();
  const outboxPath = (suffix = "") => { let pattern = outboxPaths.get(suffix); if (!pattern) { pattern = new RegExp(`^${outboxRoot}${suffix ? `\\.${suffix}` : ""}$`); outboxPaths.set(suffix, pattern); } return pattern; };
  const recordRowPath = new RegExp(`^${recordRowRoot}$`);
  const sqlRowPath = new RegExp(`^${stateRoot}\\.(?:${EVENT_COMPATIBILITY_TABLES.join("|")})\\[\\]$`);
  const movePath = (suffix: string) => { let pattern = movePaths.get(suffix); if (!pattern) { pattern = new RegExp(`^${stateRoot}\\.outlook_moves\\[\\]\\.journal\\.${suffix}$`); movePaths.set(suffix, pattern); } return pattern; };
  const alarmWitnesses = new Map<string, EventCompatibilityAlarmWitness>();
  const alarmRows = new WeakMap<object, string>();
  for (const proof of (receipt as FixtureReceipt & { alarmWitnesses?: EventCompatibilityAlarmWitness[] }).alarmWitnesses ?? []) {
    assert.equal(proof.recomputedRawHash, proof.rawHash, "The actual production alarm version must match its raw admission");
    assert.equal(eventCompatibilityDataHash(proof.input), proof.rawHash, "Independently verify the exact raw seven-element alarm tuple");
    assert.equal(eventCompatibilityDataHash(eventCompatibilityNormalizedAlarmWitnessInput(proof.input, receipt.origins)), proof.normalizedHash, "Only the receipt-owned resource origin may derive an alarm comparison version");
    assert(!alarmWitnesses.has(proof.operationId)); alarmWitnesses.set(proof.operationId, proof);
  }
  const registerAlarmRow = (row: Record<string, unknown> | null | undefined) => {
    if (!row || row.provider !== "caldav") return;
    const payload = row.payload as Record<string, unknown> | undefined, intent = payload?.caldavAlarm as { context: Parameters<typeof eventCompatibilityAlarmWitnessInput>[0]; before: string; request: { expectedStateVersion: string } } | undefined;
    if (!intent) return;
    const proof = alarmWitnesses.get(String(row.id)); assert(proof, "A current alarm intent must retain its actual operation-owned raw witness proof");
    assert.deepEqual(eventCompatibilityAlarmWitnessInput(intent.context, intent.before), proof.input); assert.equal(intent.request.expectedStateVersion, proof.rawHash);
    const resolution = payload?.resolution as { expectedReminderStateVersion?: string } | undefined;
    if (resolution?.expectedReminderStateVersion !== undefined) assert.equal(resolution.expectedReminderStateVersion, proof.rawHash, "The copied alarm resolution value must equal this exact current operation's raw witness");
    alarmRows.set(row, proof.operationId);
  };
  const serializerClocks = new Map<string, EventCompatibilitySerializerClock>();
  for (const proof of (receipt as FixtureReceipt & { serializerClocks?: EventCompatibilitySerializerClock[] }).serializerClocks ?? []) {
    assert.equal(proof.serializer, "caldavOrganizerDesired"); assert.equal(proof.verified, true);
    assert.equal(createHash("sha256").update(proof.desiredResource).digest("hex"), proof.resourceSha256, "The exact actual-serializer resource proof must remain intact");
    assert(/^\d{8}T\d{6}Z$/.test(proof.stamp)); assert(!serializerClocks.has(proof.operationId)); serializerClocks.set(proof.operationId, proof);
  }
  const registerSerializerRow = (row: Record<string, unknown> | null | undefined) => {
    if (!row || row.provider !== "caldav") return;
    const intent = (row.payload as Record<string, unknown> | undefined)?.organizer as { request?: { provider?: string; action?: string }; desired?: Record<string, unknown> } | undefined;
    if (intent?.request?.provider !== "caldav" || !intent.desired) return;
    const proof = serializerClocks.get(String(row.id)); assert(proof, "An admitted serializer clock cannot be normalized without its actual production rebuild proof");
    assert.equal(proof.resourceUrl, intent.desired.id); assert.equal(proof.uid, intent.desired.iCalUID); assert.equal(proof.stamp, intent.desired.stamp); assert.equal(proof.desiredResource, intent.desired.data);
    assert.equal(proof.generatedProperty, intent.request.action === "create" || intent.desired.rescheduled === true);
  };
  const wireSerializerClocks = new Map<number, EventCompatibilitySerializerClock[]>();
  const registerWire = (operationId: string, start: number, end: number) => {
    const proof = serializerClocks.get(operationId); if (!proof) return;
    for (let index = start; index < end; index++) if (receipt.wire[index]?.url === proof.resourceUrl) {
      const values = wireSerializerClocks.get(index) ?? []; if (!values.includes(proof)) values.push(proof); wireSerializerClocks.set(index, values);
    }
  };
  for (const record of receipt.records) {
    registerAlarmRow(record.before); registerAlarmRow(record.after); registerAlarmRow(record.returned as Record<string, unknown> | null);
    for (const row of record.state.event_outbox ?? []) registerAlarmRow(row);
    if (record.cohort) { registerAlarmRow(record.cohort.after); for (const row of record.cohort.state.event_outbox ?? []) registerAlarmRow(row); }
    registerSerializerRow(record.before); registerSerializerRow(record.after); registerSerializerRow(record.returned as Record<string, unknown> | null);
    for (const row of record.state.event_outbox ?? []) registerSerializerRow(row); registerWire(record.id, record.wireStart, record.wireEnd);
  }
  if (receipt.processReceipt) { const process = receipt.processReceipt;
    for (const row of [process.before, process.checkpoint, process.afterKill, process.afterRestart]) registerAlarmRow(row);
    for (const state of [process.checkpointState, process.afterKillState, process.finalState]) for (const row of state.event_outbox ?? []) registerAlarmRow(row);
    for (const row of [process.before, process.checkpoint, process.afterKill, process.afterRestart]) registerSerializerRow(row);
    for (const state of [process.checkpointState, process.afterKillState, process.finalState]) for (const row of state.event_outbox ?? []) registerSerializerRow(row);
    registerWire(process.operationId, process.wireStart, process.wireEnd);
  }
  const serializerPut = new Map<string, number>();
  receipt.wire.forEach((request, index) => { if (request.method !== "PUT") return;
    for (const proof of wireSerializerClocks.get(index) ?? []) {
      assert.equal(request.body, proof.desiredResource, "The actual owned PUT must exactly equal the whole recomputed native serializer resource before any generated-clock comparison");
      serializerPut.set(proof.operationId, Math.min(serializerPut.get(proof.operationId) ?? index, index));
    }
  });
  const echoSets = new Map<string, unknown[]>(), lastEcho = new Map<string, Record<string, unknown>>();
  const echoes = (receipt as FixtureReceipt & { echoObservations?: EventCompatibilityEchoObservation[] }).echoObservations ?? [];
  echoes.forEach((observation, index) => assert.equal(observation.sequence, index, "Committed echo sequence cannot be reordered or omitted"));
  for (const record of receipt.records.filter(value => value.fixtureCase === "delete-sweep-echo")) {
    assert(record.before && record.after && record.after.status === "completed" && record.family === "caldavSeriesDeletion");
    const observations = echoes.filter(value => value.operationId === record.id), intent = (record.before.payload as { caldavSeriesDeletion: { context: { mappings: Record<string, unknown>[] } } }).caldavSeriesDeletion;
    assert(intent); assert.equal(observations.length, intent.context.mappings.length, "A sweep echo contract must retain every admitted resource member");
    assert.deepEqual(observations.map(value => value.evidence.externalEventId).sort(), intent.context.mappings.map(value => value.externalEventID).sort(), "No missing, duplicate or foreign echo member");
    const ownership = Object.fromEntries(["actor_id", "provider", "user_id", "account_id", "calendar_id", "external_calendar_link_id", "external_calendar_id"].map(key => [key, record.before![key]]));
    for (const observation of observations) {
      assert.equal(observation.fixtureCase, "delete-sweep-echo"); assert.equal(observation.committed, true); assert.equal(observation.rowCount, 1);
      assert.deepEqual(observation.ownership, ownership);
      const member = intent.context.mappings.find(value => value.externalEventID === observation.evidence.externalEventId); assert(member);
      assert.deepEqual(observation.mapping, member, "Exact identity, UID, mapping and original slot remain bound");
      assert.equal(typeof observation.evidence.observedAt, "string");
      assert.deepEqual({ ...observation.evidence, observedAt: "<host-metadata>" }, { isEcho: true, externalEventId: member.externalEventID, etag: null, icalUid: member.icalUid, deleted: true, observedAt: "<host-metadata>" });
    }
    const final = observations[observations.length - 1]!.evidence;
    assert.deepEqual(record.after.remote_snapshot, final, "The raw settled selected address must equal the actual last committed owned echo byte-for-byte");
    assert.deepEqual((record.returned as { remoteSnapshot: unknown }).remoteSnapshot, final);
    const row = record.state.event_outbox.find(value => value.id === record.id); assert(row); assert.deepEqual(row.remote_snapshot, final);
    lastEcho.set(record.id, final);
    echoSets.set(record.id, observations.map(({ evidence, mapping, ownership }) => ({ evidence: { ...evidence, observedAt: "<host-metadata>" } as Record<string, unknown>, mapping, ownership })).sort((a, b) => String(a.evidence.externalEventId).localeCompare(String(b.evidence.externalEventId))));
  }
  const witnesses = new Map<string, string>();
  for (const proof of (receipt as FixtureReceipt & { witnesses?: EventCompatibilityWitness[] }).witnesses ?? []) {
    assert.equal(proof.recomputedRawHash, proof.rawHash, "Actual production raw Graph witness proof must agree");
    assert.equal(eventCompatibilityDataHash(proof.input), proof.rawHash, "Independently recompute the exact raw witness input before any normalization");
    assert.equal(eventCompatibilityDataHash(eventCompatibilityNormalizedWitnessInput(proof.input)), proof.normalizedHash, "Only the declared host relation clocks can derive a normalized comparison witness");
    witnesses.set(proof.rawHash, proof.normalizedHash);
  }
  const replaceOrigin = (text: string) => receipt.origins.reduce((result, owned) => result.split(owned.origin).join(owned.alias), text);
  const hostClock = (parent: string, key: string) => {
    if (!volatile.has(key) && !["expires_at", "expiresAt"].includes(key)) return false;
    if (recordRowPath.test(parent) || sqlRowPath.test(parent)) return true;
    if (outboxPath("payload\\.event").test(parent)) return ["createdAt", "updatedAt", "deletedAt"].includes(key);
    if (outboxPath("payload\\.(?:graphOccurrenceContent|graphMeetingCancellation|graphSeriesDeletion)\\.context\\.(?:family\\[\\]|mappings\\[\\]|children\\[\\]|memberships\\[\\]|root|grant|link)").test(parent) ||
      movePath("initial\\.(?:context\\.(?:family\\[\\]|mappings\\[\\])|template)").test(parent)) return ["createdAt", "updatedAt", "deletedAt", "providerStateObservedAt"].includes(key);
    if (outboxPath("payload\\.(?:organizer|graphOccurrenceContent|graphMeetingCancellation)\\.dispatch").test(parent)) return ["startedAt", "acceptedAt"].includes(key);
    if (outboxPath("payload\\.rsvp\\.graphDispatch").test(parent)) return ["startedAt", "acceptedAt"].includes(key);
    if (outboxPath("payload\\.rsvp\\.caldavDelivery").test(parent)) return key === "startedAt";
    if (outboxPath("payload\\.organizer\\.dispatch\\.cancellationTombstone").test(parent)) return key === "deletedAt";
    if (outboxPath("(?:remote_snapshot|remoteSnapshot)").test(parent)) return key === "observedAt";
    if (outboxPath("payload\\.operationEnvelope\\.operation").test(parent)) return key === "acceptedAt";
    return false;
  };
  const visit = (input: unknown, path = "", key = "", parent = "", operationId?: string, wireIndex?: number, alarmOperationId?: string): Value => {
    if (input === undefined) return "<undefined>";
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") {
      if (hostClock(parent, key)) return "<host-metadata>";
      if (alarmOperationId && (outboxPath("payload\\.caldavAlarm\\.request\\.expectedStateVersion").test(path) || outboxPath("payload\\.resolution\\.expectedReminderStateVersion").test(path))) {
        const proof = alarmWitnesses.get(alarmOperationId);
        assert(proof && input === proof.rawHash, "Only this operation's proven raw alarm witness may use the derived comparison"); return proof.normalizedHash;
      }
      if (outboxPath("payload\\.(?:graphOccurrenceContent|graphMeetingCancellation)\\.request\\.expectedSeriesVersion").test(path) || movePath("(?:request\\.expectedVersion|initial\\.version)").test(path)) {
        const normalized = witnesses.get(input); assert(normalized, "A raw altered/unproven Graph request witness cannot be removed from parity"); return normalized;
      }
      return replaceOrigin(input);
    }
    if (Array.isArray(input)) return input.map((value, index) => visit(value, `${path}[]`, "", "", operationId, path === "wire" ? index : wireIndex, alarmOperationId));
    assert(input && typeof input === "object");
    const row = input as Record<string, unknown>;
    const owner = outboxPath().test(path) && typeof row.id === "string" ? row.id : operationId;
    const alarmOwner = outboxPath().test(path) ? alarmRows.get(row) : alarmOperationId;
    return Object.fromEntries(Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
        const next = path ? `${path}.${name}` : name;
        const clock = owner ? serializerClocks.get(owner) : undefined;
        if (clock && outboxPath("payload\\.organizer\\.desired").test(path)) {
          if (name === "stamp") { assert.equal(value, clock.stamp); return [name, "<serializer-admission-clock>"]; }
          if (name === "data" && typeof value === "string") { assert.equal(value, clock.desiredResource); return [name, visit(eventCompatibilityGeneratedClockResource(value, clock), next, name, path, owner, wireIndex)]; }
        }
        if (path === "wire[]" && ["body", "responseBody"].includes(name) && typeof value === "string" && wireIndex !== undefined) {
          const normalized = (wireSerializerClocks.get(wireIndex) ?? []).filter(proof => serializerPut.has(proof.operationId) && serializerPut.get(proof.operationId)! <= wireIndex)
            .reduce((data, proof) => eventCompatibilityGeneratedClockResource(data, proof), value);
          return [name, visit(normalized, next, name, path, owner, wireIndex)];
        }
        if (["remote_snapshot", "remoteSnapshot"].includes(name) && typeof row.id === "string" && echoSets.has(row.id) && value !== null &&
          /^(?:records\[\]\.(?:before|after|returned)|records\[\]\.state\.event_outbox\[\])$/.test(path)) {
          assert.deepEqual(value, lastEcho.get(row.id), "Only the proven last committed snapshot may use the scoped-set contract");
          return [name, visit({ scopedCommittedEchoMembers: echoSets.get(row.id) }, next, name, path)];
        }
        if (name === "responseHeaders" && value && /^wire\[\]$/.test(path)) return [name, Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([header]) => !["date", "connection", "keep-alive"].includes(header.toLowerCase())).map(([header, item]) => [header, visit(item, `${next}.${header}`, header, next)]))];
        return [name, visit(value, next, name, path, owner, wireIndex, alarmOwner)];
      }));
  };
  const seen = new Set<number>(), settledRecords: unknown[] = [];
  for (const record of receipt.records) {
    if (!record.cohort) { settledRecords.push(record); continue; }
    if (seen.has(record.cohort.id)) continue; seen.add(record.cohort.id);
    const group = receipt.records.filter(value => value.cohort?.id === record.cohort!.id);
    assert.equal(group.length, record.cohort.count);
    // A skipped locked claim returns an unlocked observational read. Its
    // pending/attempting/completed timing is not stable under concurrency.
    // Keep every raw observation; compare the cohort's exact final durable
    // state and its whole shared native ledger instead of erasing that race.
    settledRecords.push({ id: record.id, family: record.family, before: group[0]!.before,
      returned: { concurrentObservations: group.length }, after: record.cohort.after, state: record.cohort.state,
      wireStart: Math.min(...group.map(value => value.wireStart)), wireEnd: Math.max(...group.map(value => value.wireEnd)) });
  }
  const value = visit({ records: settledRecords, wire: receipt.wire, relayWire: receipt.relayWire ?? [], ...(receipt.processReceipt ? { processReceipt: receipt.processReceipt } : {}) }) as { records: Value[]; wire: Value[]; processReceipt?: { checkpointState: Record<string, Value[]>; afterKillState: Record<string, Value[]>; finalState: Record<string, Value[]> } };
  // Database row order is not a query contract. Preserve delivery and wire
  // ordering, while canonically sorting full table rows inside each snapshot.
  for (const record of value.records as { state: Record<string, Value[]> }[]) for (const rows of Object.values(record.state)) rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value.processReceipt) for (const state of [value.processReceipt.checkpointState, value.processReceipt.afterKillState, value.processReceipt.finalState]) for (const rows of Object.values(state)) rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return value;
}

function assertIndependentNativeEvidence(spec: EventFixtureSuite, receipt: FixtureReceipt) {
  assert.equal(receipt.passed, true, "Every existing expected fixture assertion must pass");
  if (process.env.MUSUBI_EVENT_COMPATIBILITY_ALLOW_INTERMEDIATE !== "1") { assert.equal(receipt.sourceStable, true, "Final evidence requires one stable exact production source manifest"); assert.equal(receipt.harnessStable, true, "Final evidence also requires stable fixture/helper/harness bytes"); }
  assert(receipt.ownedPoolsClosed > 0); assert(receipt.records.length > 0, "A fixture must call actual production delivery");
  for (const family of spec.families) assert(receipt.records.some(record => record.family === family), `${spec.id}: missing actual ${family} delivery`);
  if (spec.native) assert(receipt.wire.length > 0, `${spec.id}: native fixture must observe actual HTTP`);
  if (spec.native && receipt.wire.some(request => /^https:\/\/(?:www\.googleapis\.com|graph\.microsoft\.com)\//.test(request.url)))
    assert((receipt.relayWire?.length ?? 0) > 0, `${spec.id}: provider response fixtures must cross the actual closed HTTP relay`);
  for (const record of receipt.records) {
    assert(record.state.events && record.state.external_events && record.state.event_outbox, "Complete canonical/mapping/outbox state must be retained");
    if (!record.before || !record.after) continue;
    assert.deepEqual(record.after.payload && (record.after.payload as Record<string, unknown>).operationEnvelope,
      record.before.payload && (record.before.payload as Record<string, unknown>).operationEnvelope, "The immutable admission envelope must not be rewritten by delivery");
    for (const field of ["provider", "action", "event_id", "calendar_id", "external_calendar_link_id", "external_event_id", "expected_etag", "ical_uid"]) {
      if (field === "external_event_id" && spec.id === "graph-organizer" && record.before.action === "create" && record.before.external_event_id === null && record.after.status === "completed") {
        const ref = record.after.result_ref as { externalEventId: string }; assert.equal(record.after.external_event_id, ref.externalEventId);
        assert(record.state.external_events.some(mapping => mapping.event_id === record.before!.event_id && mapping.external_event_id === ref.externalEventId && mapping.provider === "microsoft"), "Existing Graph CREATE completion atomically binds its generated ID and mapping");
      } else assert.deepEqual(record.after[field], record.before[field], `Immutable admitted ${field} must remain unchanged`);
    }
    assert(["pending", "attempting", "completed", "not-needed", "conflict", "not-written", "unconfirmed", "retry", "blocked", "cancelled"].includes(String(record.after.status)));
  }
  const mutations = receipt.wire.filter(request => ["POST", "PATCH", "PUT", "DELETE"].includes(request.method));
  if (spec.id === "google-reminders" || spec.id === "google-instance-reminders") {
    assert(mutations.some(request => request.method === "PATCH" && request.body && Object.keys(JSON.parse(request.body)).join(",") === "reminders" && request.headers["if-match"]));
  }
  if (spec.id === "google-rsvp") assert(mutations.some(request => request.method === "PATCH" && request.url.includes("sendUpdates=all") && request.url.includes("conferenceDataVersion=1") && request.headers["if-match"] && request.body?.includes("attendeesOmitted")));
  if (spec.id === "graph-create") assert(mutations.some(request => request.method === "POST" && request.body?.includes("transactionId")));
  if (spec.id.startsWith("dav-")) assert(receipt.wire.some(request => request.method === "PROPFIND" || request.method === "REPORT"), "DAV privilege/resource reads must stay real");
  if (spec.id === "dav-resource" || spec.id === "dav-alarms") assert(mutations.some(request => request.method === "PUT" && request.body?.includes("BEGIN:VCALENDAR") && request.headers["if-match"]));
  if (spec.id.endsWith("organizer")) {
    assert(receipt.records.some(record => (record.after?.payload as { organizer?: { dispatch?: { startedAt?: string } } } | undefined)?.organizer?.dispatch?.startedAt), "Organizer possible-notification marker must persist independently");
  }
}

async function command(args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, timeoutMs = 300_000, supervised = false) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: supervised ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] }); let output = "", expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout!.on("data", value => { output += String(value); }); child.stderr!.on("data", value => { output += String(value); });
    child.once("error", reject); child.once("close", async (code, signal) => { clearTimeout(timer); await writeFile(log, output);
      code === 0 && !expired ? resolve() : reject(new Error(`Event fixture exited ${code}/${signal}${expired ? " (timeout)" : ""}; inspect ${log}`)); });
  });
}

async function main() {
  assert.equal(process.env.ENVIRONMENT, "test", "Use an explicitly disposable PostgreSQL environment");
  const mode = process.env.MUSUBI_EVENT_COMPATIBILITY_MODE ?? "new-only"; assert(["new-only", "differential"].includes(mode));
  const differential = mode === "differential";
  const processAcceptance = process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS === "1";
  if (processAcceptance && process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS_PHASE) assert((EVENT_COMPATIBILITY_PROCESS_PHASES as readonly string[]).includes(process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS_PHASE), "Requested process checkpoint is unknown");
  if (differential || processAcceptance) assert.equal(process.env.MUSUBI_EVENT_COMPATIBILITY_QA, "1", "Historical source/process acceptance is explicitly opt-in");
  const root = fileURLToPath(new URL("../../../../", import.meta.url)), adminUrl = process.env.DATABASE_URL; assert(adminUrl);
  const selected = process.env.MUSUBI_EVENT_COMPATIBILITY_SUITE;
  const fullCorpus = differential || process.env.MUSUBI_EVENT_COMPATIBILITY_CORPUS === "full";
  const specs = EVENT_COMPATIBILITY_FIXTURES.filter(value => (!processAcceptance || EVENT_COMPATIBILITY_PROCESS_FIXTURES[value.id]) && (selected ? value.id === selected : processAcceptance || fullCorpus || (EVENT_COMPATIBILITY_CI_FIXTURES as readonly string[]).includes(value.id)));
  assert(specs.length, "Requested fixture suite is unknown");
  const output = process.env.MUSUBI_EVENT_COMPATIBILITY_OUTPUT ?? await mkdtemp(join(tmpdir(), "musubi-event-compatibility-"));
  await mkdir(output, { recursive: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const oldPath = fileURLToPath(new URL(`./event_compatibility_old_${randomUUID().replace(/-/g, "")}.ts`, import.meta.url));
  let oldCreated = false, baseline: { commit: string; sourceSha256: string } | undefined;
  const summaries: { suite: string; mode: string; deliveries: number; nativeRequests: number; families: string[]; fixtureSha256: string; normalizedSha256: string;
    productionSha256?: string; harnessSha256?: string; sourceStable?: boolean; executorSourceSha256?: string }[] = [];
  let expectedProductionSha256: string | undefined, expectedHarnessSha256: string | undefined;
  try {
    if (differential) {
      const oldSource = execFileSync("git", ["show", `${EVENT_COMPATIBILITY_BASELINE}:apps/api/src/sync/event_delivery.ts`], { cwd: root, encoding: "utf8" });
      assert.equal(createHash("sha256").update(oldSource).digest("hex"), EVENT_COMPATIBILITY_BASELINE_SHA256, "Requested immutable production baseline must match exactly");
      await writeFile(oldPath, oldSource, { flag: "wx" }); oldCreated = true; baseline = { commit: EVENT_COMPATIBILITY_BASELINE, sourceSha256: EVENT_COMPATIBILITY_BASELINE_SHA256 };
    }
    for (const spec of specs) for (const phase of processAcceptance ? EVENT_COMPATIBILITY_PROCESS_PHASES.filter(phase => !process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS_PHASE || phase === process.env.MUSUBI_EVENT_COMPATIBILITY_PROCESS_PHASE) : [undefined]) {
      const sourcePath = fileURLToPath(new URL(`./${spec.source}`, import.meta.url)), source = await readFile(sourcePath, "utf8"), fixtureSha256 = createHash("sha256").update(source).digest("hex");
      const fixturePath = fileURLToPath(new URL(`./event_compatibility_fixture_${randomUUID().replace(/-/g, "")}.ts`, import.meta.url));
      await writeFile(fixturePath, eventCompatibilityFixtureSource(source, sourcePath), { flag: "wx" });
      let previous: unknown;
      try {
        for (const label of differential ? ["old", "new"] as const : ["new"] as const) {
          const database = `event_compat_${randomUUID().replace(/-/g, "")}`, url = new URL(adminUrl); url.pathname = `/${database}`;
          const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url.href, ENVIRONMENT: "test", BETTER_AUTH_URL: "http://127.0.0.1:7531",
            BETTER_AUTH_SECRET: "event-compatibility-owned-fixture-secret", GOOGLE_WEB_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture-secret", MICROSOFT_CLIENT_ID: "fixture-client", MICROSOFT_CLIENT_SECRET: "fixture-secret",
            CALDAV_ENC_KEY: "11".repeat(32), FEDERATION_ALLOW_PRIVATE_HOSTS: "true", SYNC_OPERATION_V1_ENCODER_ENABLED: "true",
            MUSUBI_EVENT_COMPATIBILITY_UUID_SEED: `event-compatibility:${spec.id}`, ...(differential ? { MUSUBI_EVENT_COMPATIBILITY_OLD_PATH: oldPath } : {}) };
          if (processAcceptance) Object.assign(env, { MUSUBI_EVENT_COMPATIBILITY_PROCESS_FAMILY: EVENT_COMPATIBILITY_PROCESS_FIXTURES[spec.id], MUSUBI_EVENT_COMPATIBILITY_PROCESS_PHASE: phase });
          await admin.query(`CREATE DATABASE "${database}"`);
          try {
            const stem = join(output, `${spec.id}${phase ? `-${phase}` : ""}-${label}`);
            await command(["--import", "tsx", "packages/db/src/migrate.ts"], root, env, `${stem}-migrate.log`);
            const provision = new Pool({ connectionString: url.href, max: 1 });
            try {
              // Only fixture-generated opaque host identities are seeded.
              // All real SQL authority, clocks, locks and transaction logic stay
              // production code on PostgreSQL; no query is simulated.
              await provision.query("CREATE SEQUENCE event_compatibility_fixture_identity");
              await provision.query(`CREATE FUNCTION event_compatibility_fixture_uuid() RETURNS uuid LANGUAGE SQL VOLATILE AS $$ WITH raw AS (SELECT md5('${spec.id}:' || nextval('event_compatibility_fixture_identity')::text) AS value) SELECT (substr(value,1,12) || '4' || substr(value,14,3) || '8' || substr(value,18))::uuid FROM raw $$`);
              const defaults = await provision.query("SELECT c.relname AS table_name, a.attname AS column_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' AND pg_get_expr(d.adbin,d.adrelid) LIKE '%gen_random_uuid%'");
              for (const item of defaults.rows) { assert(/^[a-z_]+$/.test(item.table_name) && /^[a-z_]+$/.test(item.column_name)); await provision.query(`ALTER TABLE "${item.table_name}" ALTER COLUMN "${item.column_name}" SET DEFAULT event_compatibility_fixture_uuid()`); }
            } finally { await provision.end(); }
            await command(["--import", "tsx", "apps/api/src/sync/event_compatibility_fixture_worker.ts", fixturePath, `${stem}.json`, label], root, env, `${stem}.log`, 300_000, processAcceptance);
            const receipt = JSON.parse(await readFile(`${stem}.json`, "utf8")) as FixtureReceipt;
            if (processAcceptance) {
              assert.equal(receipt.passed, true); assert.equal(receipt.sourceStable, true); assert(receipt.ownedPoolsClosed > 0);
              assert.equal(receipt.processReceipt?.killedSignal, "SIGKILL"); assert.equal(receipt.processReceipt.family, EVENT_COMPATIBILITY_PROCESS_FIXTURES[spec.id]); assert.equal(receipt.processReceipt.phase, phase);
            } else assertIndependentNativeEvidence(spec, receipt);
            if (process.env.MUSUBI_EVENT_COMPATIBILITY_ALLOW_INTERMEDIATE !== "1") {
              expectedProductionSha256 ??= receipt.productionStart?.sha256;
              expectedHarnessSha256 ??= receipt.harnessSha256;
              assert.equal(receipt.productionStart?.sha256, expectedProductionSha256, "The final corpus must run one exact stable production tree");
              assert.equal(receipt.harnessSha256, expectedHarnessSha256, "The final corpus must run one exact fixture/helper/harness tree");
            }
            const normalized = normalizeEventCompatibilityReceipt(receipt);
            await writeFile(`${stem}-normalized.json`, JSON.stringify(normalized, null, 2));
            if (label === "old") previous = normalized;
            else {
              if (differential) assert.deepEqual(normalized, previous, `${spec.id}: immutable old/new native and full stored-state parity`);
              summaries.push({ suite: `${spec.id}${phase ? `/${phase}` : ""}`, mode, deliveries: receipt.records.length + (receipt.processReceipt ? 2 : 0), nativeRequests: receipt.wire.length, families: [...new Set([...receipt.records.map(record => record.family), ...(receipt.processReceipt ? [receipt.processReceipt.family] : [])])].sort(), fixtureSha256,
                normalizedSha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"), productionSha256: receipt.productionStart?.sha256,
                harnessSha256: receipt.harnessSha256, sourceStable: receipt.sourceStable, executorSourceSha256: receipt.executorSourceSha256 });
              console.log(`Event compatibility ${mode}: ${spec.id}${phase ? `/${phase}: actual SIGKILL and restart` : `: independent fixture assertions and ${receipt.records.length} delivery snapshots`}: PASS`);
            }
          } finally {
            const sessions = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1", [database]);
            assert.equal(sessions.rows[0].count, 0, "Every owned process and pool must close before removing its nonce database");
            await admin.query(`DROP DATABASE "${database}"`);
            console.log(`Event compatibility cleanup: ${spec.id}/${label}: zero sessions, nonce DB dropped without FORCE: PASS`);
          }
        }
      } finally { await unlink(fixturePath); }
    }
    const report = { schemaVersion: 1, suite: "event-compatibility-pg-native", mode, processAcceptance, ...(baseline ? { baseline } : {}), suites: summaries, output };
    await writeFile(join(output, "summary.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await admin.end(); if (oldCreated) await unlink(oldPath); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error); process.exitCode = 1; });
