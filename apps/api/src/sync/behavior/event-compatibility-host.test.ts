import assert from "node:assert/strict";
import { loadEventDeliverySuite, eventDeliveryFixtureRow } from "./event-delivery-driver";
import type { CalendarAdapter } from "../adapter";
import type { EventCompatibilityDelivery, EventCompatibilityRead } from "@musubi/sync-runtime";
import type { NativeWritePlanV1 } from "@musubi/sync-codec";
import type { SyncOperationEnvelope } from "@musubi/types";

// The existing JSON driver installs the actual application's dependency ports
// and module entry order. These probes call the actual API host, without a
// second executor or alternate native response translator.
const { eventCompatibilityPorts } = await import("../event_compatibility_host");
const suite = await loadEventDeliverySuite(), signal = new AbortController().signal;
const selected = (id: string) => { const value = suite.scenarios.find(scenario => scenario.id === id); assert(value, id); return value; };
const ref = { externalEventId: "native-event", etag: '"v1"', icalUid: "native-uid" };
let checks = 0;
const ingresses = [
  ["google-generic-update", "pushUpdate", "etag", "generic", "update"],
  ["google-generic-create", "pushCreate", "externalEventId", "generic", "create"],
  ["google-generic-update", "readEvent", "ref", "generic", "read"],
  ["google-generic-create", "findCreatedEvent", "event", "find-created", "read"],
  ["google-occurrence-achieved-read-only", "writeOccurrence", "ref", "googleOccurrence", "update"],
  ["google-reminder-instance-original-slot", "reminderInstance.write", "state", "reminderInstance", "update"],
  ["google-reminder-off-write", "writeReminders", "state", "reminderEdit", "update"],
  ["dav-split-source", "writeCaldavSplitSource", "ref", "caldavSplit", "update"],
  ["dav-series-following-resource-write", "writeCaldavSeries", "ref", "caldavSeries", "update"],
  ["dav-series-whole-delete", "deleteCaldavSeries", "etag", "caldavSeriesDeletion", "delete"],
  ["google-rsvp-reconciling-baseline", "writeRsvp", "etag", "googleRsvp", "update"],
  ["graph-rsvp-fresh-marker", "writeMicrosoftRsvp", "kind", "microsoftRsvp", "update"],
  ["dav-rsvp-fresh", "writeCaldavRsvp", "etag", "caldavRsvp", "update"],
  ["dav-alarm-resource-proof", "writeCaldavAlarm", "ref", "caldavAlarm", "update"],
  ["graph-content-mark-accept-ack", "updateGraphOccurrenceContent", "kind", "graphOccurrenceContent", "update"],
  ["graph-meeting-cancellation-mark-accept", "cancelGraphMeeting", "native", "graphMeetingCancellation", "delete"],
  ["graph-series-deletion-complete-proof", "deleteGraphSeries", "native", "graphSeriesDeletion", "delete"],
  ["graph-series-create-whole-family-ack", "createGraphFamily", "master", "graphSeriesCreate", "create"],
  ["google-organizer-distinct-marker-acceptance", "organizer", "kind", "organizer", "update"],
] as const;
for (const [id, method, field, family, action] of ingresses) {
  const input = selected(id), row = eventDeliveryFixtureRow(input); let getters = 0, invocations = 0;
  const raw = {}; Object.defineProperty(raw, field, { enumerable: true, get() { getters++; return "forged"; } });
  const reply = async () => { invocations++; return raw; };
  const adapter: Record<string, unknown> = { assertEventWrite: async () => {}, readReminderState: async () => undefined };
  if (method === "reminderInstance.write") adapter.reminderInstance = { write: reply };
  else if (method === "organizer") adapter.organizer = async () => ({ deliver: reply });
  else adapter[method] = reply;
  const { host, native } = eventCompatibilityPorts(row, adapter as unknown as CalendarAdapter, undefined, undefined);
  if (family === "reminderEdit" || family === "caldavRsvp") await host.prepare(signal);
  if (family === "caldavRsvp") await host.prepareNative(family, () => {}, signal);
  const request = { family, action, event: row.payload.event, ref, identity: { operationID: row.id, signal }, mark: async () => {}, accepted: async () => {} };
  await assert.rejects(() => action === "read" ? native.read(request as EventCompatibilityRead, signal) : native.deliver(request as EventCompatibilityDelivery, signal), /Invalid task preparation descriptor/, `${method} owns its full native return before translation`);
  assert.equal(invocations, 1, `${method} actual native return boundary was reached`); assert.equal(getters, 0, method); checks++;
}

{
  const row = eventDeliveryFixtureRow(selected("google-generic-update")); let getters = 0;
  const raw = {}; Object.defineProperty(raw, "title", { enumerable: true, get() { getters++; return "forged"; } });
  const { host } = eventCompatibilityPorts(row, { assertEventWrite: async () => {}, projectEvent: () => raw } as unknown as CalendarAdapter, undefined, undefined);
  await assert.rejects(() => host.prepare(signal), /Invalid task preparation descriptor/); assert.equal(getters, 0); checks++;
}
for (const parameter of ["pinned", "nativePlan"] as const) {
  const row = eventDeliveryFixtureRow(selected("google-generic-update")); let getters = 0;
  const raw = {}; Object.defineProperty(raw, parameter === "pinned" ? "serializer" : "body", { enumerable: true, get() { getters++; return {}; } });
  assert.throws(() => eventCompatibilityPorts(row, null, parameter === "pinned" ? raw as SyncOperationEnvelope : undefined, parameter === "nativePlan" ? raw as NativeWritePlanV1 : undefined), /Invalid task preparation descriptor/);
  assert.equal(getters, 0); checks++;
}
{
  const row = eventDeliveryFixtureRow(selected("google-generic-update"));
  const plan: NativeWritePlanV1 = { planKind: "json-body", body: { summary: "Accepted title", location: "Keep location" } };
  const adapter = {
    async assertEventWrite(_user: string, _account: string, _calendar: string, input: { nativePlan: NativeWritePlanV1; event: typeof row.payload.event }) {
      assert.equal(input.event.start.toISOString(), "2026-10-26T10:11:12.123Z");
      if (input.nativePlan.planKind !== "json-body") throw new Error("Expected JSON plan");
      assert.equal(input.nativePlan.body!.summary, "Accepted title"); input.nativePlan.body!.summary = "Injected by preflight"; input.event.start.setTime(0);
    },
    async pushUpdate(_user: string, _account: string, _calendar: string, _id: string, event: typeof row.payload.event, _ref: unknown, _patch: unknown, _signal: AbortSignal, nativePlan: NativeWritePlanV1) {
      assert.equal(event.start.toISOString(), "2026-10-26T10:11:12.123Z"); assert.equal(event.title, "Accepted title");
      assert.equal(nativePlan.planKind, "json-body"); if (nativePlan.planKind === "json-body") assert.equal(nativePlan.body!.summary, "Accepted title");
      return { etag: '"v2"' };
    },
  } as unknown as CalendarAdapter;
  const { native } = eventCompatibilityPorts(row, adapter, undefined, plan);
  plan.body!.summary = "Injected by original caller";
  await native.preflight(row.payload.event, ref, undefined, undefined, signal);
  const outcome = await native.deliver({ family: "generic", action: "update", event: row.payload.event, ref }, signal);
  assert.equal(outcome.kind, "observed"); assert.equal(row.payload.event.start.toISOString(), "2026-10-26T10:11:12.123Z"); checks++;
}
{
  const row = eventDeliveryFixtureRow(selected("google-occurrence-achieved-read-only"));
  const adapter = {
    async readOccurrence(_user: string, _account: string, _calendar: string, context: NonNullable<typeof row.payload.googleOccurrence>) {
      assert.equal(context.baseline.start.toISOString(), "2026-10-26T00:00:00.000Z");
      context.baseline.start.setTime(0); context.master.start.setTime(0); context.originalStart = { kind: "date", value: "1900-01-01" }; return null;
    },
    async writeOccurrence(_user: string, _account: string, _calendar: string, context: NonNullable<typeof row.payload.googleOccurrence>) {
      assert.equal(context.baseline.start.toISOString(), "2026-10-26T00:00:00.000Z");
      assert.equal(context.master.start.toISOString(), "2026-10-26T10:11:12.123Z");
      assert.deepEqual(context.originalStart, { kind: "date", value: "2026-10-25" }); return { ref };
    },
  } as unknown as CalendarAdapter;
  const { host, native } = eventCompatibilityPorts(row, adapter, undefined, undefined);
  await host.prepare(signal); await host.prepareNative("googleOccurrence", () => {}, signal);
  row.payload.googleOccurrence!.originalStart = { kind: "date", value: "1900-01-02" };
  await native.read({ family: "googleOccurrence", ref, recover: false }, signal);
  assert.equal((await native.deliver({ family: "googleOccurrence", ref, event: row.payload.event }, signal)).kind, "observed"); checks++;
}
console.log(`Event compatibility actual API host: ${checks} native ingress and ownership regressions passed.`);
