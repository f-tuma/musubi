import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SyncJsonValueSchema } from "@musubi/types";
const config = { api: { providerRsvpEditsEnabled: false } };
import { mock } from "node:test";
// The native port does not use DB credentials: its existing authorized-token
// callback is supplied below. Refuse any unexpected DB fallback.
const unexpectedDb = () => { throw new Error("Unexpected DB port in native RSVP scenario"); };
mock.module(new URL("../../../../../packages/db/src/index.ts", import.meta.url), { namedExports: { getOAuthCredentials: unexpectedDb, hasProviderSyncScopes: unexpectedDb } });
mock.module(new URL("../../../../../packages/config/src/index.ts", import.meta.url), { namedExports: { config } });
const { googleRsvpMethods } = await import("../adapters/google_rsvp_delivery");
const { googleRsvpEvidence } = await import("../adapters/google_rsvp");

const jsonObject = z.record(z.string(), SyncJsonValueSchema);
const exchange = z.object({ method: z.enum(["GET", "PATCH"]), url: z.string(), status: z.number().int().min(200).max(599), body: SyncJsonValueSchema.optional(), requestBody: jsonObject.optional(), ifMatch: z.string().optional(), networkError: z.boolean().optional(), bodyError: z.boolean().optional() }).strict();
const result = z.object({ outcome: z.enum(["confirmed", "unconfirmed", "not-written"]), recovered: z.boolean().optional(), status: z.number().optional() }).strict();
const step = z.object({ observeOnly: z.boolean(), beforeWrite: z.enum(["grant", "reject", "absent"]), credentialMutation: z.enum(["policy", "evidence", "nested-baseline", "original-slot"]).optional(), policyFault: z.enum(["getter", "prototype"]).optional(), evidenceFault: z.enum(["getter", "id-getter", "etag-getter", "nested-getter", "response-getter", "patch-getter", "occurrence-getter", "slot-getter", "prototype", "baseline-prototype", "slot-prototype", "function", "cycle"]).optional(), expected: result }).strict();
export const GoogleRsvpScenarioSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().min(1), baseline: jsonObject, occurrence: z.object({ externalSeriesID: z.string(), originalStart: z.object({ kind: z.literal("date"), value: z.string() }).strict() }).strict().optional(), steps: z.array(step).min(1), exchanges: z.array(exchange), expected: z.object({ patches: z.number().int().nonnegative(), grants: z.number().int().nonnegative(), credentials: z.number().int().nonnegative() }).strict() }).strict();
const suiteSchema = z.object({ schemaVersion: z.literal(1), scenarios: z.array(GoogleRsvpScenarioSchema).min(1) }).strict();
export class GoogleRsvpScenarioFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
export async function loadGoogleRsvpSuite(value?: unknown) {
  const input = value ?? JSON.parse(await readFile(new URL("./google-rsvp-delivery.json", import.meta.url), "utf8"));
  const suite = suiteSchema.safeParse(input);
  if (!suite.success || new Set(suite.data.scenarios.map(item => item.id)).size !== suite.data.scenarios.length) throw new GoogleRsvpScenarioFailure("invalid-suite", "Invalid or duplicate Google RSVP scenarios.");
  return suite.data;
}
let running = false;
/** Data-only HTTP receipts replace the existing fetch leaf. All RSVP decisions,
 * payload construction, identity and result validation remain production code. */
export async function runGoogleRsvpScenario(input: z.infer<typeof GoogleRsvpScenarioSchema>) {
  if (running) throw new GoogleRsvpScenarioFailure("concurrent-run", "Fetch fixtures require sequential execution.");
  const scenario = GoogleRsvpScenarioSchema.parse(input);
  running = true;
  const savedFetch = globalThis.fetch, flag = config.api.providerRsvpEditsEnabled;
  let index = 0, patches = 0, grants = 0, credentials = 0;
  let fixtureFailure: GoogleRsvpScenarioFailure | undefined;
  let policyGetterCalls = 0, evidenceGetterCalls = 0;
  const methods: string[] = [];
  try {
    config.api.providerRsvpEditsEnabled = true;
    globalThis.fetch = async (request, init) => {
      const receipt = scenario.exchanges[index++];
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PATCH") patches++;
      if (!receipt) { fixtureFailure = new GoogleRsvpScenarioFailure("exchange-mismatch", "Unexpected HTTP request."); throw fixtureFailure; }
      try {
        assert.equal(method, receipt.method); assert.equal(String(request), receipt.url);
        assert.equal(init?.redirect, "error");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer synthetic-google-rsvp-token");
        assert.equal(headers.get("cache-control"), "no-cache");
        assert.equal(headers.get("if-match"), receipt.ifMatch ?? null);
        assert.equal(headers.get("content-type"), receipt.method === "PATCH" ? "application/json" : null);
        assert.deepEqual(init?.body === undefined ? undefined : JSON.parse(String(init.body)), receipt.requestBody);
      } catch { fixtureFailure = new GoogleRsvpScenarioFailure("exchange-mismatch", "Request differed from its exact receipt."); throw fixtureFailure; }
      if (receipt.networkError) throw new TypeError("Synthetic transport loss");
      if (receipt.bodyError) return new Response(new ReadableStream({ start(controller) { controller.error(new Error("Synthetic body loss")); } }), { status: receipt.status });
      return new Response(JSON.stringify(receipt.body ?? {}), { status: receipt.status, headers: { "content-type": "application/json" } });
    };
    let active: { command: z.infer<typeof step>; policy: { sendUpdates: "all"; observeOnly: boolean } } | undefined;
    const adapter = googleRsvpMethods(async (user, account) => {
      assert.equal(user, "user"); assert.equal(account, "account"); credentials++;
      if (active?.command.credentialMutation === "policy") active.policy.observeOnly = false;
      if (active?.command.credentialMutation === "evidence") { evidence.baseline.id = "substituted"; evidence.baseline.etag = '\"substituted\"'; evidence.response = "declined"; if (evidence.occurrence) evidence.occurrence.externalSeriesID = "substituted"; }
      if (active?.command.credentialMutation === "nested-baseline") { evidence.baseline.attendees[0]!.email = "substituted@example.test"; evidence.baseline.attendees[0]!.comment = "Changed during credential refresh"; }
      if (active?.command.credentialMutation === "original-slot") evidence.occurrence!.originalStart.value = "2026-09-06";
      return "synthetic-google-rsvp-token";
    });
    const evidence = googleRsvpEvidence(scenario.baseline, { eventId: String(scenario.baseline.id), etag: String(scenario.baseline.etag), authenticatedCopyEmail: "guest@example.test", occurrence: scenario.occurrence }, "accepted");
    const outcomes = [];
    for (const command of scenario.steps) {
      let observed;
      const policy = { sendUpdates: "all" as const, observeOnly: command.observeOnly };
      if (command.policyFault === "getter") Object.defineProperty(policy, "observeOnly", { get() { policyGetterCalls++; return false; }, enumerable: true });
      if (command.policyFault === "prototype") Object.setPrototypeOf(policy, { observeOnly: false });
      const rejectGetter = () => { evidenceGetterCalls++; throw new Error("Native evidence accessor executed"); };
      const accessor = (target: object, key: string) => Object.defineProperty(target, key, { get: rejectGetter, enumerable: true });
      if (command.evidenceFault === "getter") accessor(evidence, "baseline");
      if (command.evidenceFault === "id-getter") accessor(evidence.baseline, "id");
      if (command.evidenceFault === "etag-getter") accessor(evidence.baseline, "etag");
      if (command.evidenceFault === "nested-getter") accessor(evidence.baseline.attendees[0]!, "comment");
      if (command.evidenceFault === "response-getter") accessor(evidence, "response");
      if (command.evidenceFault === "patch-getter") accessor(evidence, "patch");
      if (command.evidenceFault === "occurrence-getter") accessor(evidence, "occurrence");
      if (command.evidenceFault === "slot-getter") accessor(evidence.occurrence!.originalStart, "value");
      if (command.evidenceFault === "prototype") Object.setPrototypeOf(evidence, { inherited: true });
      if (command.evidenceFault === "baseline-prototype") Object.setPrototypeOf(evidence.baseline, { inherited: true });
      if (command.evidenceFault === "slot-prototype") Object.setPrototypeOf(evidence.occurrence!.originalStart, { inherited: true });
      if (command.evidenceFault === "function") evidence.baseline.callback = () => undefined;
      if (command.evidenceFault === "cycle") evidence.baseline.circular = evidence.baseline;
      active = { command, policy };
      try {
        const native = await adapter.writeRsvp!("user", "account", "guest@example.test", evidence, policy, undefined, command.beforeWrite === "absent" ? undefined : async () => {
          if (command.beforeWrite === "reject") throw new Error("Synthetic marker commit failure");
          grants++;
        });
        observed = { outcome: "confirmed", recovered: native.recovered };
        assert.equal(native.notificationDelivery, "unknown");
      } catch (error) {
        if (error instanceof GoogleRsvpScenarioFailure) throw error;
        const failure = error as { outcome?: string; providerStatus?: number };
        observed = { outcome: failure.outcome ?? "not-written", ...(failure.providerStatus === undefined ? {} : { status: failure.providerStatus }) };
      }
      if (evidenceGetterCalls) throw new GoogleRsvpScenarioFailure("expectation-mismatch", `Native evidence evaluated ${evidenceGetterCalls} accessor(s) before credentials.`);
      if (fixtureFailure) throw fixtureFailure;
      outcomes.push(observed);
      if (!isEqual(observed, command.expected)) throw new GoogleRsvpScenarioFailure("expectation-mismatch", `Result mismatch: ${JSON.stringify(observed)}.`);
    }
    if (policyGetterCalls) throw new GoogleRsvpScenarioFailure("expectation-mismatch", "Native policy evaluated an accessor.");
    if (index !== scenario.exchanges.length) throw new GoogleRsvpScenarioFailure("unconsumed-exchange", `Not all HTTP receipts were consumed: ${index}/${scenario.exchanges.length}, methods=${JSON.stringify(methods)}, outcomes=${JSON.stringify(outcomes)}.`);
    if (!isEqual({ patches, grants, credentials }, scenario.expected)) throw new GoogleRsvpScenarioFailure("expectation-mismatch", `Summary mismatch: ${JSON.stringify({ patches, grants, credentials })}.`);
    return { methods, patches, grants, credentials, outcomes };
  } finally { globalThis.fetch = savedFetch; config.api.providerRsvpEditsEnabled = flag; running = false; }
}
function isEqual(actual: unknown, expected: unknown) { try { assert.deepEqual(actual, expected); return true; } catch { return false; } }
