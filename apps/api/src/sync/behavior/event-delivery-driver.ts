import { readFile, readdir, stat } from "node:fs/promises";
import { mock } from "node:test";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { EventSchema, SyncJsonValueSchema } from "@musubi/types";
import { copyCompatibilityData } from "@musubi/sync-runtime";
import type { EventOutboxRow } from "@musubi/db";
import type { CalendarAdapter } from "../adapter";

export class EventDeliveryScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "invalid-arguments" | "unknown-scenario" | "unexpected-port" | "unconsumed-port" | "expectation-mismatch" | "suite-unavailable" | "concurrent-run", message: string) { super(message); this.name = "EventDeliveryScenarioFailure"; }
}
const text = z.string().max(512), data = z.record(z.string(), SyncJsonValueSchema);
const nativeNames = ["assertEventWrite", "projectEvent", "pushCreate", "pushUpdate", "pushDelete", "readEvent", "findCreatedEvent", "updateGraphOccurrenceContent", "cancelGraphMeeting", "organizer", "microsoftOrganizer", "caldavOrganizer", "reminderInstance.write", "deleteGraphSeries", "createGraphFamily", "writeCaldavAlarm", "writeCaldavSplitSource", "createCaldavSeries", "deleteCaldavSeries", "writeCaldavSeries", "readOccurrence", "recoverOccurrence", "writeOccurrence", "writeMicrosoftRsvp", "writeCaldavRsvp", "writeRsvp", "readReminderState", "writeReminders"] as const;
const error = z.object({ code: z.enum(["provider-conflict", "provider-version-unavailable", "event-diff-unavailable", "provider-write-failed", "caldav-rsvp-response-unconfirmed"]), outcome: z.enum(["not-written", "unconfirmed"]).optional(), status: z.number().int().min(100).max(599).optional() }).strict();
const httpRequest = z.object({ method: z.enum(["GET", "PATCH"]), url: text.min(1), headers: z.record(z.string(), z.string()), body: SyncJsonValueSchema.optional() }).strict();
const step = z.object({ http: httpRequest.optional(), portFailure: z.literal("marker-ack-lost").optional(), port: text.min(1).refine(value => portNames.has(value)), result: SyncJsonValueSchema.optional(), error: error.optional(), callbacks: z.array(z.union([z.number().int().min(0).max(12), z.enum(["5.beforeWrite", "3.acceptedUpdate.beforeMutation"])] )).max(3).optional(), waitForAbort: z.boolean().optional(), mutateProjectionBeforeCapture: z.object({ title: text.optional(), start: text.optional() }).strict().optional(), mutateClaim: z.object({ reconciling: z.boolean().optional(), title: text.optional(), start: text.optional() }).strict().optional() }).strict();
const summary = z.object({ boundary: z.literal("actual-event-delivery-with-fixture-db-and-native-ports"), events: z.array(text).max(160), returnedStatus: text,
  completions: z.array(data).max(3), finishes: z.array(data).max(3), native: z.array(data).max(20), savedProjection: data.optional() }).strict();
const scenario = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().min(1).max(160),
  row: z.object({ provider: z.enum(["google", "microsoft", "caldav"]), action: z.enum(["create", "update", "delete"]), reconciling: z.boolean().optional(), attempts: z.number().int().min(1).max(12).optional(),
    externalEventID: text.nullable().optional(), externalCalendarID: text.optional(), icalUid: text.nullable().optional(), expectedEtag: text.nullable().optional(), predecessorID: text.nullable().optional(), payload: data.optional() }).strict(),
  actualGoogleRsvp: z.literal(true).optional(), flags: z.record(z.string(), z.boolean()).optional(), inspectNative: z.boolean().optional(), inspectCompletions: z.boolean().optional(), inspectProjection: z.boolean().optional(), adapter: z.array(z.enum(nativeNames)).max(32), steps: z.array(step).max(96), returnedStatus: text, expected: summary }).strict();
const suite = z.object({ schemaVersion: z.literal(1), driver: z.literal("event-delivery"), scenarios: z.array(scenario).min(1).max(160) }).strict();
export type EventDeliveryScenario = z.infer<typeof scenario>;
export type EventDeliverySummary = z.infer<typeof summary>;
export function parseEventDeliverySuite(value: unknown) {
  // Preserve descriptor-safe JSON validation while bounding each independent
  // case. The manifest's existing byte/case limits bound the aggregate corpus.
  let owned: unknown;
  try { owned = copyCompatibilityData(value); } catch { throw new EventDeliveryScenarioFailure("invalid-suite", "Expected plain JSON data."); }
  const parsed = suite.safeParse(owned);
  if (!parsed.success || parsed.data.scenarios.some(item => !SyncJsonValueSchema.safeParse(item).success) || new Set(parsed.data.scenarios.map(item => item.id)).size !== parsed.data.scenarios.length) throw new EventDeliveryScenarioFailure("invalid-suite", "Event delivery suite does not match schema version 1.");
  if (parsed.data.scenarios.some(scenario => scenario.steps.some(step => step.result === "<current-destination>" && step.port !== "db.getExternalLinkForCalendar"))) throw new EventDeliveryScenarioFailure("invalid-suite", "Destination receipts belong to the destination query only.");
  if (parsed.data.scenarios.some(scenario => scenario.steps.some(step => step.mutateProjectionBeforeCapture && step.port !== "db.setEventOutboxProjection"))) throw new EventDeliveryScenarioFailure("invalid-suite", "Projection mutation belongs to its existing storage port only.");
  if (parsed.data.scenarios.some(scenario => scenario.actualGoogleRsvp && !scenario.adapter.includes("writeRsvp") || scenario.steps.some(step => step.http && (step.port !== "http.googleRsvp" || !scenario.actualGoogleRsvp) || step.portFailure && step.port !== "db.markGoogleRsvpDispatched"))) throw new EventDeliveryScenarioFailure("invalid-suite", "Google native HTTP/marker receipts must use their exact existing ports.");
  return structuredClone(parsed.data);
}
export async function loadEventDeliverySuite() {
  const path = new URL("./event-delivery.json", import.meta.url);
  if ((await stat(path)).size > 1_500_000) throw new EventDeliveryScenarioFailure("invalid-suite", "Event delivery suite exceeds its size bound.");
  return parseEventDeliverySuite(JSON.parse(await readFile(path, "utf8")));
}
const OPERATION = "abcdef01-abcd-4000-8000-abcdefabcdef", EVENT = "abcdef01-abcd-4000-8000-abcdefabcdea";
const EVENT_DATA = EventSchema.parse({ id: EVENT, creatorID: "fixture-owner", calendars: ["fixture-calendar"], title: "Accepted title", organizer: "fixture-owner", color: "#112233",
  description: "Keep description", location: "Keep location", start: "2026-10-26T10:11:12.123Z", end: "2026-10-26T11:12:13.456Z", isAllDay: false, isCanceled: false });
export function eventDeliveryFixtureRow(input: EventDeliveryScenario) {
  return { id: OPERATION, actorID: "fixture-owner", mutationID: "fixture-command", position: 0, eventID: EVENT, revision: 2, predecessorID: input.row.predecessorID ?? null,
    calendarID: "fixture-calendar", externalCalendarLinkID: "fixture-source", provider: input.row.provider, userID: "fixture-owner", accountID: "fixture-account", externalCalendarID: input.row.externalCalendarID ?? "fixture-collection",
    externalEventID: input.row.externalEventID ?? null, expectedEtag: input.row.expectedEtag ?? null, icalUid: input.row.icalUid ?? null, personalReadRecovery: null,
    action: input.row.action, payload: { event: structuredClone(EVENT_DATA), ...structuredClone(input.row.payload ?? {}) }, status: "attempting", attempts: input.row.attempts ?? 1,
    attemptedAt: new Date(0), leaseToken: "fixture-lease", leaseUntil: new Date(120_000), nextAttemptAt: new Date(0), uncertain: input.row.reconciling ?? false,
    resultRef: null, remoteSnapshot: null, errorCode: null, createdAt: new Date(0), updatedAt: new Date(0), reconciling: input.row.reconciling ?? false } as EventOutboxRow & { reconciling: boolean };
}
interface Active { input: EventDeliveryScenario; row: ReturnType<typeof eventDeliveryFixtureRow>; steps: EventDeliveryScenario["steps"]; summary: EventDeliverySummary; fatal?: EventDeliveryScenarioFailure; signal?: AbortSignal; late?: Promise<void>; rawProjection?: unknown }
let active: Active | undefined;
function current() { if (!active) throw new EventDeliveryScenarioFailure("unexpected-port", "No event fixture owns this port."); return active; }
function unexpected(name: string): never { const f = current(); const failure = new EventDeliveryScenarioFailure("unexpected-port", `Unplanned dependency port: ${name}.`); f.fatal ??= failure; throw f.fatal; }
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => ["observedAt", "nextAttemptAt"].includes(key) ? "<time>" : typeof item === "function" ? "<callback>" : item instanceof AbortSignal ? "<signal>" : item));
}
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ["start", "end"].includes(key) && typeof item === "string" && /^\d{4}-\d\d-\d\dT/.test(item) ? new Date(item) : revive(item)]));
  return value;
}
async function receipt(name: string, args: unknown[]) {
  const f = current(); f.summary.events.push(name);
  const planned = f.steps.shift(); if (!planned || planned.port !== name) return unexpected(name);
  const discover = (value: unknown) => { if (value instanceof AbortSignal) f.signal = value; else if (value && typeof value === "object" && !(value instanceof Date)) for (const child of Object.values(value)) discover(child); };
  discover(args);
  if (planned.mutateClaim) {
    if (planned.mutateClaim.reconciling !== undefined) f.row.reconciling = planned.mutateClaim.reconciling;
    if (planned.mutateClaim.title !== undefined) f.row.payload.event.title = planned.mutateClaim.title;
    if (planned.mutateClaim.start !== undefined) f.row.payload.event.start = new Date(planned.mutateClaim.start);
  }
  for (const index of planned.callbacks ?? []) {
    const callback = typeof index === "number" ? args[index] : index.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, args);
    if (typeof callback !== "function") return unexpected(`${name}:callback-${index}`);
    await callback();
  }
  if (planned.waitForAbort) {
    const signal = f.signal; if (!signal) return unexpected(`${name}:signal`);
    let done!: () => void; f.late = new Promise<void>(resolve => { done = resolve; });
    await new Promise<void>(resolve => { const reply = () => setImmediate(resolve); if (signal.aborted) reply(); else signal.addEventListener("abort", reply, { once: true }); });
    done();
  }
  if (planned.portFailure === "marker-ack-lost") throw new Error("Synthetic lost marker COMMIT acknowledgement");
  if (planned.error) throw new ProviderEventWriteError(planned.error.code, planned.error.outcome, planned.error.status);
  return planned.result === "<current-destination>" ? { id: f.row.externalCalendarLinkID, calendarID: f.row.calendarID, userID: f.row.userID, accountID: f.row.accountID, provider: f.row.provider,
    externalCalendarID: f.row.externalCalendarID, disabled: false, supportsEvents: true } : revive(structuredClone(planned.result));
}
// Export names are discovered only to install the existing dependency seam.
// Every invocation still needs its exact data-only receipt; no query or native
// business behavior is implemented by this driver.
const dbNames = new Set<string>();
for (const entry of await readdir(new URL("../", import.meta.url), { withFileTypes: true, recursive: true })) if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
  const source = await readFile(`${entry.parentPath}/${entry.name}`, "utf8");
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@musubi\/db["']/g)) for (const item of match[1]!.split(",")) {
    const name = item.trim(); if (name && !name.startsWith("type ") && /^[A-Za-z_$][\w$]*$/.test(name)) dbNames.add(name);
  }
  for (const match of source.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s*import\(["']@musubi\/db["']\)/g)) for (const item of match[1]!.split(",")) if (/^[A-Za-z_$][\w$]*$/.test(item.trim())) dbNames.add(item.trim());
}
const dbExports: Record<string, unknown> = Object.fromEntries([...dbNames].map(name => [name, (...args: unknown[]) => receipt(`db.${name}`, args)]));
const portNames = new Set([...dbNames].map(name => `db.${name}`).concat(nativeNames.map(name => `native.${name}`), ["native.organizer.deliver", "native.microsoftOrganizer.deliver", "native.caldavOrganizer.deliver", "credentials.googleRsvp", "http.googleRsvp"]));
for (const name of dbNames) if (/^(?:complete|confirmCaldav)/.test(name)) dbExports[name] = async (...args: unknown[]) => {
  const f = current(); if (f.input.inspectCompletions) f.summary.completions.push(plain({ port: name, args }) as Record<string, never>); return receipt(`db.${name}`, args);
};
Object.assign(dbExports, {
  claimEventOutbox(id: string) { const f = current(); if (id !== OPERATION) return unexpected("claim-identity"); f.summary.events.push("db.claim"); return f.row; },
  decodeEventOutboxOperation(row: EventOutboxRow) { current().summary.events.push("db.decode"); return realDecode(row); },
  getEventOutboxRow() { const f = current(); f.summary.events.push("db.get"); return { id: OPERATION, status: f.input.returnedStatus }; },
  async setEventOutboxProjection(...args: unknown[]) {
    const f = current(), mutation = f.steps[0]?.mutateProjectionBeforeCapture;
    if (mutation) {
      if (!f.rawProjection || typeof f.rawProjection !== "object") return unexpected("missing-projector-result");
      if (mutation.title !== undefined) (f.rawProjection as { title: string }).title = mutation.title;
      if (mutation.start !== undefined) ((f.rawProjection as { start: Date }).start).setTime(new Date(mutation.start).getTime());
    }
    if (f.input.inspectProjection) f.summary.savedProjection = plain(args[2]) as Record<string, never>;
    return receipt("db.setEventOutboxProjection", args);
  },
  async finishEventOutbox(...args: unknown[]) { const f = current(); f.summary.finishes.push(plain({ status: args[2], code: args[3] ?? null, details: args[4] ?? {} }) as Record<string, never>); return receipt("db.finishEventOutbox", args); },
});
// Projection/evidence comparisons are production functions, not replaceable
// fixture authority. Only their existing storage ports are scripted above.
Object.assign(dbExports, await import("../../../../../packages/db/src/queries/event-outbox-projection"));
let realInstanceMatch: typeof import("../../../../../packages/db/src/queries/provider-reminder-instance")["matchesProviderReminderInstanceState"];
let realRsvpVersion: typeof import("../../../../../packages/db/src/queries/provider-rsvp")["providerRsvpBaselineVersion"];
dbExports.matchesProviderReminderInstanceState = (...args: Parameters<typeof realInstanceMatch>) => realInstanceMatch(...args);
dbExports.providerRsvpBaselineVersion = (...args: Parameters<typeof realRsvpVersion>) => realRsvpVersion(...args);
const flags: Record<string, boolean> = { providerOrganizerEditsEnabled: true, caldavOrganizerEditsEnabled: true, providerReminderEditsEnabled: true, eventTimeEditsEnabled: true, caldavAlarmEditsEnabled: true, providerRsvpEditsEnabled: true };
mock.module(new URL("../../../../../packages/db/src/index.ts", import.meta.url), { namedExports: dbExports });
mock.module(new URL("../../../../../packages/config/src/index.ts", import.meta.url), { namedExports: { config: { api: flags }, logger: { info() {}, warn() {}, error() {}, debug() {} } } });
mock.module(new URL("../../../../../packages/auth/src/index.ts", import.meta.url), { namedExports: { auth: {} } });
// Node's module-mock ESM mode does not discover rrule's CommonJS names. Use
// the installed library's actual exports, without substituting its algorithms.
mock.module("rrule", { namedExports: createRequire(import.meta.url)("rrule") });
realInstanceMatch = (await import("../../../../../packages/db/src/queries/provider-reminder-instance")).matchesProviderReminderInstanceState;
realRsvpVersion = (await import("../../../../../packages/db/src/queries/provider-rsvp")).providerRsvpBaselineVersion;
const { decodeEventOutboxOperation: realDecode } = await import("../../../../../packages/db/src/queries/outbox-operation");
const { ProviderEventWriteError } = await import("../event_write");
// The application registers the Google adapter before event delivery. Retain
// that entry order for its existing reminder/adapter circular module graph.
await import("../adapters/google");
const { deliverEventOutbox } = await import("../event_delivery");
const { googleRsvpMethods } = await import("../adapters/google_rsvp_delivery");

export async function runEventDeliveryScenario(input: EventDeliveryScenario, diagnostic?: (summary: EventDeliverySummary) => void): Promise<EventDeliverySummary> {
  if (active) throw new EventDeliveryScenarioFailure("concurrent-run", "Event delivery fixtures run sequentially.");
  const selected = parseEventDeliverySuite({ schemaVersion: 1, driver: "event-delivery", scenarios: [input] }).scenarios[0]!;
  const summary: EventDeliverySummary = { boundary: "actual-event-delivery-with-fixture-db-and-native-ports", events: [], returnedStatus: "unavailable", completions: [], finishes: [], native: [] };
  const f: Active = { input: selected, row: eventDeliveryFixtureRow(selected), steps: structuredClone(selected.steps), summary };
  const originalFetch = globalThis.fetch, originalFlags = { ...flags }; active = f;
  globalThis.fetch = async (request, init) => {
    if (!selected.actualGoogleRsvp) return unexpected("ambient-network");
    init?.signal?.throwIfAborted();
    const planned = f.steps[0], actual = { method: init?.method ?? "GET", url: String(request), headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) };
    if (!planned?.http || !isDeepStrictEqual(actual, planned.http) || init?.redirect !== "error") return unexpected("http.googleRsvp:request-mismatch");
    const response = await receipt("http.googleRsvp", [request, init]) as { status: number; body?: unknown };
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status, headers: { "content-type": "application/json" } });
  }; Object.assign(flags, selected.flags);
  const adapter: Record<string, unknown> = { provider: selected.row.provider };
  const method = (name: string) => async (...args: unknown[]) => {
    if (selected.inspectNative) summary.native.push(plain({ method: name, args }) as Record<string, never>);
    if (["organizer", "microsoftOrganizer", "caldavOrganizer"].includes(name)) { await receipt(`native.${name}`, args); return { deliver: method(`${name}.deliver`) }; }
    return receipt(`native.${name}`, args);
  };
  for (const name of selected.adapter) {
    if (name === "projectEvent") { adapter[name] = (...args: unknown[]) => {
      summary.events.push("native.projectEvent"); const planned = f.steps.shift();
      if (!planned || planned.port !== "native.projectEvent" || planned.callbacks || planned.waitForAbort || planned.error) return unexpected("native.projectEvent");
      if (selected.inspectNative) summary.native.push(plain({ method: name, args }) as Record<string, never>);
      f.rawProjection = revive(structuredClone(planned.result)); return f.rawProjection;
    }; } else if (name === "reminderInstance.write") adapter.reminderInstance = { write: method(name) };
    else adapter[name] = method(name);
  }
  if (selected.actualGoogleRsvp) {
    const methods = googleRsvpMethods(async (...args) => await receipt("credentials.googleRsvp", args) as string);
    adapter.writeRsvp = async (...args: Parameters<NonNullable<CalendarAdapter["writeRsvp"]>>) => {
      if (selected.inspectNative) summary.native.push(plain({ method: "writeRsvp", args }) as Record<string, never>);
      await receipt("native.writeRsvp", args);
      return methods.writeRsvp!(...args);
    };
  }
  try {
    const result = await deliverEventOutbox(OPERATION, () => adapter as CalendarAdapter, { timeoutMs: selected.steps.some(value => value.waitForAbort) ? 30 : 5_000 });
    await f.late; await new Promise<void>(resolve => setImmediate(resolve));
    summary.returnedStatus = result?.status ?? "unavailable";
    if (f.fatal) throw f.fatal;
    if (f.steps.length) throw new EventDeliveryScenarioFailure("unconsumed-port", "Planned dependency receipts were not consumed.");
    diagnostic?.(structuredClone(summary));
    if (!isDeepStrictEqual(summary, selected.expected)) throw new EventDeliveryScenarioFailure("expectation-mismatch", "Event delivery evidence differs from its reviewed expectation.");
    return summary;
  } finally { globalThis.fetch = originalFetch; for (const key of Object.keys(flags)) delete flags[key]; Object.assign(flags, originalFlags); active = undefined; }
}
