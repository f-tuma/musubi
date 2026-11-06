import assert from "node:assert/strict";
import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import { getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";

// Fixture env only: the production factory reads `config`, which needs these
// names at import. No `.env` is read in the driver process by design.
process.env.DATABASE_URL ??= "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.ENVIRONMENT ??= "test";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

export class FederationTransportScenarioFailure extends Error {
  constructor(
    readonly code: "invalid-suite" | "invalid-arguments" | "unknown-scenario" | "unexpected-port" | "unconsumed-port" | "expectation-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "FederationTransportScenarioFailure";
  }
}

const identity = { id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().trim().min(1).max(160) };
const address = z.object({ address: z.string().min(1), family: z.union([z.literal(4), z.literal(6)]) }).strict();
const lookupPlan = z.union([
  z.object({ addresses: z.array(address).min(1).max(8) }).strict(),
  z.object({ error: z.string().min(1) }).strict(),
  z.object({ never: z.literal(true) }).strict(),
  z.object({ rejectAfterAbortMs: z.number().int().min(1).max(500) }).strict(),
]);
const leafPlan = z.object({ status: z.number().int().min(200).max(599), headers: z.record(z.string(), z.string()).optional() }).strict();
const signalPlan = z.union([
  z.object({ abortedBefore: z.literal(true) }).strict(),
  z.object({ abortAfterMs: z.number().int().min(1).max(500) }).strict(),
  z.object({ timeoutMs: z.number().int().min(1).max(500) }).strict(),
]);
const expectation = z.object({
  outcome: z.enum(["response", "rejected"]),
  status: z.number().int().min(200).max(599).optional(),
  rejectMessage: z.string().min(1).optional(),
  rejectReason: z.enum(["signal", "timeout", "type-error"]).optional(),
  lookupCalls: z.number().int().min(0).max(8),
  leafCalls: z.number().int().min(0).max(8),
  pin: z.array(address).min(1).max(8).optional(),
  urlUnchanged: z.literal(true).optional(),
  authorizationPreserved: z.literal(true).optional(),
  redirectManual: z.literal(true).optional(),
  noAbortListener: z.literal(true).optional(),
}).strict();
const scenario = z.object({
  ...identity,
  input: z.union([z.string().min(1), z.object({ request: z.string().min(1) }).strict()]),
  headers: z.record(z.string(), z.string()).optional(),
  allowPrivate: z.boolean(),
  lookup: lookupPlan.optional(),
  leaf: leafPlan.optional(),
  signal: signalPlan.optional(),
  expect: expectation,
}).strict();
const suiteSchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.literal("federation-transport"),
  scenarios: z.array(scenario).min(1).max(40),
}).strict();
export type FederationTransportScenario = z.infer<typeof scenario>;

export async function loadFederationTransportSuite() {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(new URL("./federation-transport.json", import.meta.url), "utf8"));
  } catch {
    throw new FederationTransportScenarioFailure("invalid-suite", "The federation-transport manifest is unreadable.");
  }
  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success) throw new FederationTransportScenarioFailure("invalid-suite", "The federation-transport manifest does not match its strict schema.");
  if (new Set(parsed.data.scenarios.map((item) => item.id)).size !== parsed.data.scenarios.length)
    throw new FederationTransportScenarioFailure("invalid-suite", "Scenario ids must be unique.");
  return parsed.data;
}

// ── Process isolation (active for every state: stub, red, green, mutant) ─────
// Public and mixed addresses exist only behind the injected ports below. Any
// ambient fetch or system DNS lookup that reaches this process is a failure,
// never a socket.
const unhandled: unknown[] = [];
let systemLookups = 0;
let isolated = false;
export function installFederationTransportIsolation() {
  if (isolated) return;
  isolated = true;
  globalThis.fetch = (() => {
    throw new FederationTransportScenarioFailure("unexpected-port", "Ambient fetch reached the driver process.");
  }) as typeof fetch;
  const refuse = () => {
    systemLookups++;
    return new FederationTransportScenarioFailure("unexpected-port", "System DNS lookup reached the driver process.");
  };
  const dnsModule = dns as unknown as { lookup: unknown; promises: { lookup: unknown } };
  dnsModule.lookup = (...args: unknown[]) => {
    const callback = args[args.length - 1];
    const error = refuse();
    if (typeof callback === "function") queueMicrotask(() => callback(error));
    else throw error;
  };
  dnsModule.promises.lookup = async () => {
    throw refuse();
  };
  syncBuiltinESMExports();
  process.on("unhandledRejection", (reason) => {
    unhandled.push(reason);
  });
}
export function federationTransportUnhandledRejections() {
  return unhandled.length;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runFederationTransportScenario(value: FederationTransportScenario) {
  installFederationTransportIsolation();
  const { createFederationFetch } = await import("../federation_origin");
  const unhandledBefore = unhandled.length;
  const systemLookupsBefore = systemLookups;
  let lookupCalls = 0;
  let leafCalls = 0;
  const leafRecords: { url: string; redirect: RequestInit["redirect"]; headers: Headers; signal: AbortSignal | null | undefined; pin: readonly LookupAddress[] }[] = [];

  const controller = new AbortController();
  const reason = new Error(`fixture abort for ${value.id}`);
  let signal: AbortSignal | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  if (value.signal && "abortedBefore" in value.signal) {
    controller.abort(reason);
    signal = controller.signal;
  } else if (value.signal && "abortAfterMs" in value.signal) {
    signal = controller.signal;
    abortTimer = setTimeout(() => controller.abort(reason), value.signal.abortAfterMs);
  } else if (value.signal && "timeoutMs" in value.signal) {
    signal = AbortSignal.timeout(value.signal.timeoutMs);
  }
  if (value.lookup && "rejectAfterAbortMs" in value.lookup && !signal)
    throw new FederationTransportScenarioFailure("invalid-suite", `${value.id}: rejectAfterAbortMs needs a signal.`);

  const lookupImpl = async (hostname: string): Promise<LookupAddress[]> => {
    lookupCalls++;
    const plan = value.lookup;
    if (!plan) throw new FederationTransportScenarioFailure("unexpected-port", `Unplanned lookup for ${hostname}.`);
    if ("addresses" in plan) return plan.addresses.map((item) => ({ ...item }));
    if ("error" in plan) throw new Error(plan.error);
    if ("rejectAfterAbortMs" in plan) {
      return new Promise<LookupAddress[]>((_, reject) => {
        signal!.addEventListener("abort", () => {
          setTimeout(() => reject(new Error("late lookup failure after abort")), plan.rejectAfterAbortMs);
        }, { once: true });
      });
    }
    return new Promise<LookupAddress[]>(() => {});
  };
  const fetchPinnedImpl = async (url: URL, init: RequestInit, pin: readonly LookupAddress[]) => {
    leafCalls++;
    const plan = value.leaf;
    if (!plan) throw new FederationTransportScenarioFailure("unexpected-port", "Unplanned leaf dispatch.");
    leafRecords.push({ url: url.href, redirect: init.redirect, headers: new Headers(init.headers), signal: init.signal, pin });
    return new Response(null, { status: plan.status, headers: plan.headers });
  };

  const federationFetch = createFederationFetch({ allowPrivate: value.allowPrivate, lookupImpl, fetchPinnedImpl });
  const input = typeof value.input === "string" ? value.input : new Request(value.input.request);
  let settled: { kind: "response"; response: Response } | { kind: "rejected"; error: unknown };
  let watchdog: NodeJS.Timeout | undefined;
  const watchdogPromise = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new FederationTransportScenarioFailure("expectation-mismatch", `${value.id} did not settle within 1000 ms.`)), 1000);
  });
  try {
    const response = await Promise.race([
      federationFetch(input as string | URL, { headers: value.headers, signal }),
      watchdogPromise,
    ]);
    settled = { kind: "response", response };
  } catch (error) {
    if (error instanceof FederationTransportScenarioFailure) throw error;
    settled = { kind: "rejected", error };
  } finally {
    clearTimeout(watchdog);
    clearTimeout(abortTimer);
  }
  // Let a late lookup rejection or a same-tick unhandled rejection surface.
  await sleep(value.lookup && "rejectAfterAbortMs" in value.lookup ? value.lookup.rejectAfterAbortMs + 30 : 5);

  if (value.lookup && lookupCalls === 0)
    throw new FederationTransportScenarioFailure("unconsumed-port", `${value.id}: the planned lookup was never consumed.`);
  if (value.leaf && leafCalls === 0)
    throw new FederationTransportScenarioFailure("unconsumed-port", `${value.id}: the planned leaf response was never consumed.`);

  const expect = value.expect;
  if (expect.outcome === "response") {
    assert.equal(settled.kind, "response", settled.kind === "rejected" ? `rejected: ${String((settled.error as Error)?.message ?? settled.error)}` : "");
    if (settled.kind === "response") assert.equal(settled.response.status, expect.status);
  } else {
    assert.equal(settled.kind, "rejected", "expected a rejection");
    if (settled.kind === "rejected") {
      const error = settled.error;
      const message = error instanceof Error ? error.message : String(error);
      if (expect.rejectMessage) assert.match(message, new RegExp(expect.rejectMessage));
      if (expect.rejectReason === "signal") assert.equal(error, reason, `rejected with a different reason: ${message}`);
      if (expect.rejectReason === "timeout") assert.ok(error instanceof DOMException && error.name === "TimeoutError", `not a TimeoutError: ${message}`);
      if (expect.rejectReason === "type-error") assert.ok(error instanceof TypeError, `not a TypeError: ${message}`);
    }
  }
  assert.equal(lookupCalls, expect.lookupCalls, "lookup calls");
  assert.equal(leafCalls, expect.leafCalls, "leaf calls");
  const first = leafRecords[0];
  if (expect.pin) assert.deepEqual(first?.pin.map(({ address, family }) => ({ address, family })), expect.pin);
  if (expect.urlUnchanged) assert.equal(first?.url, typeof value.input === "string" ? new URL(value.input).href : undefined);
  if (expect.authorizationPreserved) assert.equal(first?.headers.get("authorization"), value.headers?.authorization ?? null);
  if (expect.redirectManual) assert.equal(first?.redirect, "manual");
  if (first) assert.equal(first.signal, signal, "the leaf receives the caller's signal");
  const abortListeners = signal ? getEventListeners(signal, "abort").length : 0;
  if (expect.noAbortListener) assert.equal(abortListeners, 0, "abort listener was not removed");
  assert.equal(unhandled.length, unhandledBefore, "unhandledRejection observed");
  assert.equal(systemLookups, systemLookupsBefore, "system DNS reached");
  return {
    outcome: settled.kind,
    status: settled.kind === "response" ? settled.response.status : undefined,
    lookupCalls,
    leafCalls,
    pin: first?.pin.map(({ address, family }) => `${address}/${family}`),
    redirect: first?.redirect,
    abortListenersAfter: abortListeners,
    productionFactory: true,
  };
}
