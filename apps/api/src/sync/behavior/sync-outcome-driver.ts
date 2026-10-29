import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ProviderDispatchDeferred } from "@musubi/sync-runtime";
import { ProviderAuthError } from "../errors";
import { observeSyncRun, observeSyncFailure, SyncWorkDeferred, type SyncRunOutcome } from "../sync_outcome";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const kind = z.enum(["success", "queued-read", "credit", "cooldown", "budget-persistence-pending", "work-capacity",
  "provider-503", "network", "auth", "source-changed", "unknown", "fake-budget", "fake-queue", "plain-object"]);
const expected = z.object({ outcome: z.enum(["success", "failed", "deferred"]), seconds: z.number().nonnegative(),
  failureCount: z.number().int().nonnegative(), deferredReasons: z.array(z.string()),
  level: z.enum(["info", "warn", "error"]).nullable(), event: z.string().nullable(),
  originalResult: z.boolean(), originalError: z.boolean(), deferralFieldsBounded: z.boolean(),
}).strict();
const scenario = z.object({ id, title: z.string().trim().min(1).max(160), input: z.object({ kind,
  stage: z.enum(["account", "discovery"]), provider: z.enum(["google", "microsoft", "caldav"]),
}).strict(), expected }).strict();
const suiteSchema = z.object({ schemaVersion: z.literal(1), suite: z.literal("sync-outcome"),
  driver: z.literal("sync-outcome"), scenarios: z.array(scenario).min(1).max(100) }).strict();
export class SyncOutcomeScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "suite-unavailable" | "invalid-arguments" | "unknown-scenario" | "expectation-mismatch", message: string) { super(message); }
}
export async function loadSyncOutcomeSuite(input?: unknown) {
  let value = input;
  if (value === undefined) {
    try { value = JSON.parse(await readFile(new URL("./sync-outcome.json", import.meta.url), "utf8")); }
    catch { throw new SyncOutcomeScenarioFailure("suite-unavailable", "The sync outcome suite is unavailable."); }
  }
  const result = suiteSchema.safeParse(value);
  if (!result.success || new Set(result.data.scenarios.map(item => item.id)).size !== result.data.scenarios.length)
    throw new SyncOutcomeScenarioFailure("invalid-suite", "Invalid or duplicate sync outcome scenarios.");
  return result.data;
}
function failure(errorKind: z.infer<typeof kind>): unknown {
  if (errorKind === "queued-read") return new SyncWorkDeferred(12345);
  if (["credit", "cooldown", "budget-persistence-pending", "work-capacity"].includes(errorKind))
    return new ProviderDispatchDeferred({ retryAtMs: 12345, reason: errorKind as "credit", blockedDimensions: [] });
  if (errorKind === "provider-503") return new Error("Outlook 503: Service Unavailable");
  if (errorKind === "network") return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("fixture socket"), { code: "ECONNRESET" }) });
  if (errorKind === "auth") return new ProviderAuthError("google", "invalid_grant", undefined, true);
  if (errorKind === "fake-budget") return Object.assign(new Error("Provider dispatch deferred."), { name: "ProviderDispatchDeferred" });
  if (errorKind === "fake-queue") return Object.assign(new Error("Synchronization is pending a later opportunity."), { name: "SyncWorkDeferred", retryAtMs: 12345 });
  if (errorKind === "plain-object") return { name: "SyncWorkDeferred", retryAtMs: 12345 };
  if (errorKind === "source-changed") return Object.assign(new Error("Sync read work source or claim changed."), { name: "SyncReadWorkChanged" });
  return new Error("Private fixture detail https://private.example.test/token/secret-value");
}
/** Runs the actual production run/failure observers. Only their existing
 * persistence/provider callback, clock and telemetry sinks are supplied here. */
export async function runSyncOutcomeScenario(input: unknown) {
  const parsed = scenario.safeParse(input);
  if (!parsed.success) throw new SyncOutcomeScenarioFailure("invalid-suite", "Invalid sync outcome scenario.");
  const value = parsed.data, error = failure(value.input.kind), result = Object.freeze({ fixture: "native-result" });
  let clock = 1000, failureCount = 0, observed: unknown, caught: unknown;
  const runs: { outcome: SyncRunOutcome; seconds: number }[] = [], deferredReasons: string[] = [];
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  try {
    observed = await observeSyncRun(value.input.provider, async () => {
      clock = 1250;
      if (value.input.kind === "success") return result;
      throw error;
    }, (provider, outcome, seconds) => { assert.equal(provider, value.input.provider); runs.push({ outcome, seconds }); }, () => clock);
  } catch (caughtError) {
    caught = caughtError;
    observeSyncFailure({ ...value.input, error: caughtError, accountId: "private-fixture-account" }, "private-fixture-user", {
      failure(stage, provider) { assert.equal(stage, value.input.stage); assert.equal(provider, value.input.provider); failureCount++; },
      deferred(stage, provider, reason) { assert.equal(stage, value.input.stage); assert.equal(provider, value.input.provider); deferredReasons.push(reason); },
      log(level, event, fields) { logs.push({ level, event, fields }); },
    });
  }
  assert.equal(runs.length, 1); assert(logs.length <= 1);
  const log = logs[0];
  const summary = { ...runs[0]!, failureCount, deferredReasons, level: (log?.level ?? null) as z.infer<typeof expected>["level"],
    event: log?.event ?? null, originalResult: observed === result, originalError: caught === error,
    deferralFieldsBounded: !deferredReasons.length || !!log && Object.keys(log.fields).sort().join(",") === "provider,reason,retryAtMs" &&
      log.fields.provider === value.input.provider && log.fields.retryAtMs === 12345 && !JSON.stringify(log.fields).includes("private-") };
  try { assert.deepStrictEqual(summary, value.expected); }
  catch { throw new SyncOutcomeScenarioFailure("expectation-mismatch", "Sync outcome evidence differs from its expected summary."); }
  return summary;
}
