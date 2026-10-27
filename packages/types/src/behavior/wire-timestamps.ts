import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { AvailabilityIntervalSchema, AvailabilityRequestSchema, AvailabilityResponseSchema } from "../availability";
import { OutlookMoveOptionsSchema, OutlookMoveResultSchema } from "../outlook-move";
import { OrganizerDispatchSchema } from "../provider-organizer";
import { CaldavRsvpDeliverySchema, GoogleRsvpDeliverySchema, GraphRsvpDispatchSchema } from "../provider-rsvp";

const boundaries = {
  "availability-request": AvailabilityRequestSchema,
  "availability-interval": AvailabilityIntervalSchema,
  "availability-response": AvailabilityResponseSchema,
  "outlook-options": OutlookMoveOptionsSchema,
  "outlook-result": OutlookMoveResultSchema,
  "graph-rsvp-dispatch": GraphRsvpDispatchSchema,
  "caldav-rsvp-delivery": CaldavRsvpDeliverySchema,
  "google-rsvp-delivery": GoogleRsvpDeliverySchema,
  "organizer-dispatch": OrganizerDispatchSchema,
};
const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  title: z.string().min(1),
  boundary: z.enum(Object.keys(boundaries) as [keyof typeof boundaries, ...Array<keyof typeof boundaries>]),
  input: z.unknown(),
  expectedSuccess: z.boolean(),
});
const suiteSchema = z.strictObject({
  schemaVersion: z.literal(1), suite: z.literal("wire-timestamps"),
  scenarios: z.array(scenarioSchema).min(1),
}).refine(suite => new Set(suite.scenarios.map(scenario => scenario.id)).size === suite.scenarios.length,
  "Scenario IDs must be unique");

export function loadWireTimestampSuite() {
  return suiteSchema.parse(JSON.parse(readFileSync(new URL("./wire-timestamps.json", import.meta.url), "utf8")));
}

/** The production schema owns all timestamp, ordering and limit validation. */
export function runWireTimestampScenario(scenario: z.infer<typeof scenarioSchema>) {
  const parsed = boundaries[scenario.boundary].safeParse(scenario.input);
  assert.equal(parsed.success, scenario.expectedSuccess, scenario.id);
  if (parsed.success) assert.deepEqual(parsed.data, scenario.input, "Validation preserves the wire value");
}

export function runWireTimestampSuite(filter?: string) {
  const suite = loadWireTimestampSuite();
  const selected = suite.scenarios.filter(scenario => !filter || scenario.id === filter);
  if (!selected.length) throw new Error("unknown-scenario");
  const started = performance.now();
  const results = selected.map(scenario => {
    const start = performance.now();
    try {
      runWireTimestampScenario(scenario);
      return { id: scenario.id, title: scenario.title, status: "passed" as const, durationMs: performance.now() - start };
    } catch {
      return { id: scenario.id, title: scenario.title, status: "failed" as const, durationMs: performance.now() - start };
    }
  });
  return { schemaVersion: 1, suite: suite.suite, durationMs: performance.now() - started, results };
}
