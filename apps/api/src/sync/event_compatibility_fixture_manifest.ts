import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ICAL from "ical.js";

export const EVENT_COMPATIBILITY_BASELINE = "8ea0d3bfe193abd701e06c15d19b5d312bdd2290";
export const EVENT_COMPATIBILITY_BASELINE_SHA256 = "63f478c91e36db4913717db759e773d260e928cc530dd0c8696112b5e39ae8b0";
export type EventFixtureSuite = { id: string; source: string; families: readonly string[]; native: boolean; retainedGate?: boolean };
/** These are existing native fixture programs, with their independent expected
 * wire, resource and DB assertions retained. No provider or lifecycle algorithm
 * is reproduced by the replay harness. */
export const EVENT_COMPATIBILITY_FIXTURES: readonly EventFixtureSuite[] = [
  { id: "generic", source: "event_delivery.integration.test.ts", families: ["generic"], native: false },
  { id: "generic-native", source: "event_compatibility_generic_native.fixture.ts", families: ["generic"], native: true, retainedGate: false },
  { id: "google-reminders", source: "google_reminders.integration.test.ts", families: ["reminderEdit"], native: true },
  { id: "google-instance-reminders", source: "provider_reminder_instance_delivery.integration.test.ts", families: ["reminderInstance"], native: true },
  { id: "google-occurrence", source: "google_scope.integration.test.ts", families: ["googleOccurrence"], native: true },
  { id: "dav-resource", source: "caldav_scope.integration.test.ts", families: ["caldavSeries", "caldavSplit", "caldavSeriesDeletion"], native: true },
  { id: "dav-alarms", source: "caldav_alarms.integration.test.ts", families: ["caldavAlarm"], native: true },
  { id: "graph-create", source: "graph_series_create_worker.integration.test.ts", families: ["graphSeriesCreate"], native: true },
  { id: "graph-delete", source: "graph_series_delete.integration.test.ts", families: ["graphSeriesDeletion"], native: true },
  { id: "graph-content", source: "microsoft_occurrence_content.integration.test.ts", families: ["graphOccurrenceContent"], native: true },
  { id: "graph-series-content", source: "microsoft_series_content.integration.test.ts", families: ["graphOccurrenceContent"], native: true },
  { id: "graph-meeting-cancel", source: "microsoft_series_cancel.integration.test.ts", families: ["graphMeetingCancellation"], native: true },
  { id: "google-organizer", source: "provider_organizer.integration.test.ts", families: ["organizer:google"], native: true },
  { id: "graph-organizer", source: "microsoft_organizer.integration.test.ts", families: ["organizer:microsoft"], native: true },
  { id: "dav-organizer", source: "caldav_organizer.integration.test.ts", families: ["organizer:caldav"], native: true },
  { id: "google-rsvp", source: "provider_rsvp.integration.test.ts", families: ["rsvp:google"], native: true },
  { id: "google-rsvp-recovery", source: "event_compatibility_google_rsvp.fixture.ts", families: ["rsvp:google"], native: true, retainedGate: false },
  { id: "graph-rsvp", source: "microsoft_rsvp.integration.test.ts", families: ["rsvp:microsoft"], native: true },
  { id: "dav-rsvp", source: "caldav_rsvp.integration.test.ts", families: ["rsvp:caldav"], native: true },
  { id: "graph-move", source: "outlook_moves.integration.test.ts", families: ["graphOccurrenceContent"], native: true },
];
export const EVENT_COMPATIBILITY_CI_FIXTURES = ["generic", "generic-native", "google-instance-reminders", "graph-content", "google-organizer"] as const;
export const EVENT_COMPATIBILITY_PROCESS_FIXTURES: Record<string, string> = {
  "google-organizer": "organizer:google", "graph-content": "graphOccurrenceContent", "dav-organizer": "organizer:caldav", "dav-resource": "caldavSplit",
};
export const EVENT_COMPATIBILITY_PROCESS_PHASES = ["before-native-send", "raw-native-response", "before-ack", "ack-committed"] as const;
export type EventCompatibilityWitness = { kind: "graph-content" | "graph-cancellation" | "graph-move"; rawHash: string; recomputedRawHash: string; normalizedHash: string; input: unknown };
export type EventCompatibilityEchoObservation = { sequence: number; operationId: string; fixtureCase: "delete-sweep-echo"; evidence: Record<string, unknown>; ownership: Record<string, unknown>; mapping: Record<string, unknown>; updateSql: string; rowCount: number; committed: true };
export type EventCompatibilitySerializerClock = { operationId: string; resourceUrl: string; uid: string; stamp: string; desiredResource: string; resourceSha256: string; serializer: "caldavOrganizerDesired"; verified: true; generatedProperty: boolean };
export type EventCompatibilityAlarmWitness = { operationId: string; rawHash: string; recomputedRawHash: string; normalizedHash: string; input: [string, string, string, string, string, number, string] };
/** The alarm producer hashes this exact tuple. Only its owned fixture origin
 * varies between independently provisioned old/new fixture servers. */
export function eventCompatibilityAlarmWitnessInput(context: { link: { id: string }; mapping: { id: string; ref: { externalEventId: string; etag: string; icalUid: string } }; event: { revision: number } }, before: string): EventCompatibilityAlarmWitness["input"] {
  return [context.link.id, context.mapping.id, context.mapping.ref.externalEventId, context.mapping.ref.etag, context.mapping.ref.icalUid, context.event.revision, before];
}
export function eventCompatibilityNormalizedAlarmWitnessInput(input: EventCompatibilityAlarmWitness["input"], origins: { origin: string; alias: string }[]): EventCompatibilityAlarmWitness["input"] {
  assert.equal(input.length, 7); assert(input.slice(0, 5).every(value => typeof value === "string")); assert.equal(typeof input[5], "number"); assert.equal(typeof input[6], "string");
  const resource = new URL(input[2]), owned = origins.find(value => value.origin === resource.origin);
  assert(owned && input[2].startsWith(owned.origin) && !resource.username && !resource.password, "An alarm witness cannot alias an unowned resource origin");
  const suffix = input[2].slice(owned.origin.length); assert(!suffix || /^[/?#]/.test(suffix), "The owned origin must end at the resource authority boundary");
  return [input[0], input[1], owned.alias + suffix, input[3], input[4], input[5], input[6]];
}
/** A comparison-only resource copy. Ownership comes from an actual serializer
 * proof plus the operation/resource wire binding, never VCALENDAR enclosure. */
export function eventCompatibilityGeneratedClockResource(resource: string, proof: EventCompatibilitySerializerClock): string {
  if (!proof.generatedProperty || !resource.startsWith("BEGIN:VCALENDAR\r\n")) return resource;
  try {
    const root = new ICAL.Component(ICAL.parse(resource)), events = root.getAllSubcomponents("vevent");
    if (root.name !== "vcalendar" || events.length !== 1) return resource;
    const event = events[0]!;
    if (event.getFirstPropertyValue("uid") !== proof.uid || event.hasProperty("recurrence-id") || event.getAllProperties("dtstamp").length !== 1 ||
      String((event.getFirstPropertyValue("dtstamp") as ICAL.Time).toICALString()) !== proof.stamp) return resource;
    const stack: string[] = [];
    return (resource.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(line => {
      const value = line.replace(/\r?\n$/, ""), begin = /^BEGIN:([A-Z0-9-]+)$/.exec(value), end = /^END:([A-Z0-9-]+)$/.exec(value);
      if (begin) stack.push(begin[1]!);
      const output = stack.join("/") === "VCALENDAR/VEVENT" && value === `DTSTAMP:${proof.stamp}` ? line.replace(proof.stamp, "<serializer-generated-clock>") : line;
      if (end) stack.pop(); return output;
    }).join("");
  } catch { return resource; }
}
/** A generic cryptographic assertion helper, independent of provider delivery.
 * The worker separately calls the actual production graphMeetingVersion. */
export function eventCompatibilityDataHash(value: unknown): string {
  const canonical = (item: unknown): unknown => item instanceof Date ? item.toISOString() : Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ?
    Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function eventCompatibilityNormalizedWitnessInput(input: unknown): unknown {
  const visit = (value: unknown, path: string): unknown => {
    if (value instanceof Date) return visit(value.toISOString(), path);
    if (Array.isArray(value)) return value.map(item => visit(item, `${path}[]`));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" &&
      /^(?:context\.(?:family\[\]|mappings\[\])|template)$/.test(path) && ["createdAt", "updatedAt", "deletedAt", "providerStateObservedAt"].includes(key)
      ? "<host-metadata>" : visit(item, path ? `${path}.${key}` : key)]));
  };
  const normalized = visit(input, "") as Record<string, unknown>;
  if (input && typeof input === "object") {
    const source = input as Record<string, unknown>;
    if (typeof source.version === "string" && source.context && source.baseline && source.identity && source.native) {
      const content = { context: source.context, baseline: source.baseline, identity: source.identity, native: source.native, ...(source.nativeExceptions ? { nativeExceptions: source.nativeExceptions } : {}) };
      assert.equal(source.version, eventCompatibilityDataHash(content), "A move's nested raw content witness must also remain proven");
      normalized.version = eventCompatibilityDataHash(eventCompatibilityNormalizedWitnessInput(content));
    }
  }
  return normalized;
}
export async function eventCompatibilityHarnessFingerprint(root: string) {
  const files: Record<string, string> = {};
  const directory = join(root, "apps/api/src/sync");
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || !/\.test\.|\.fixture\.|_fixture/.test(entry.name) || /^event_compatibility_fixture_[0-9a-f]{32}\.ts$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name); files[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  return { sha256: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"), files: sorted };
}
export async function eventCompatibilityProductionFingerprint(root: string) {
  const files: Record<string, string> = {};
  for (const directory of ["apps/api/src", "packages/db/src", "packages/sync-runtime/src", "packages/types/src", "packages/calendar/src", "packages/sync-codec/src",
    "packages/provider-google/src", "packages/provider-microsoft/src", "packages/provider-caldav/src", "packages/auth/src", "packages/config/src"]) {
    for (const entry of await readdir(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || /\.test\.|\.fixture\.|_fixture_|_compatibility_old_|_compatibility_delivery\.integration/.test(entry.name) || entry.parentPath.includes("/behavior")) continue;
      const path = join(entry.parentPath, entry.name); files[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  return { sha256: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"), files: sorted };
}

export const EVENT_COMPATIBILITY_TABLES = ["calendars", "calendar_members", "calendar_events", "events", "event_users", "event_reminders",
  "external_calendars", "external_events", "external_event_tombstones", "event_outbox", "event_scope_operations", "outlook_moves"] as const;
export const EVENT_COMPATIBILITY_PRIORITY = ["graphOccurrenceContent", "graphMeetingCancellation", "organizer", "reminderInstance", "graphSeriesDeletion",
  "graphSeriesCreate", "caldavAlarm", "caldavSplit", "caldavSeriesDeletion", "caldavSeries", "googleOccurrence", "rsvp", "reminderEdit"] as const;
export function eventCompatibilityFamily(row: { provider: string; payload: Record<string, unknown> }) {
  const family = EVENT_COMPATIBILITY_PRIORITY.find(key => row.payload[key]);
  return family === "organizer" || family === "rsvp" ? `${family}:${row.provider}` : family ?? "generic";
}

/** Change terminal/exit control and route dynamic executor imports through the
 * same observation hook as static imports. Fixture setup, native adapters and
 * every independent expected assertion remain verbatim. */
export function eventCompatibilityFixtureSource(source: string, filename: string) {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = [...file.statements].reverse().find(value => ts.isExpressionStatement(value));
  assert(statement && ts.isExpressionStatement(statement), "A fixture must expose its existing final promise invocation");
  let expression = statement.expression.getText(file).replace(/^void\s+/, "");
  assert(/(?:main|runMicrosoftRsvpIntegration|Promise\.resolve)\s*\(/.test(expression), "Refuse an unknown fixture terminal expression");
  expression = expression.replace(/process\.exit\(([^)]*)\)/g, (_match, code: string) => `(process.exitCode = ${code.trim() || "process.exitCode ?? 0"})`);
  let adapted = source.slice(0, statement.getStart(file)) + `export const eventCompatibilityFixtureDone = (${expression});` + source.slice(statement.end);
  // tsx's native dynamic import path does not necessarily consult CJS _load.
  // Only the delivery module import changes; the hook still loads the exact
  // old/new production module, with no lifecycle or provider implementation.
  adapted = adapted.replace(/import\((["'])\.\/event_delivery\1\)/g, "Promise.resolve((globalThis as any).__musubiEventCompatibilityExecutor())");
  // This existing suite exposes a scenario selector. Add observation metadata
  // at that selector so a raw race receipt names its original fixture case.
  adapted = adapted.replace("if (process.env.CALDAV_SCOPE_SCENARIOS", "(globalThis as any).__musubiEventCompatibilityFixtureCase = scenario;\n      if (process.env.CALDAV_SCOPE_SCENARIOS");
  if (filename.endsWith("caldav_scope.integration.test.ts")) adapted = adapted.replace("} finally { await db.delete(user).where(eq(user.id, owner)); }",
    "} finally { await (globalThis as any).__musubiEventCompatibilityDrain(); await db.delete(user).where(eq(user.id, owner)); }");
  return adapted;
}
