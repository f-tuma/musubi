import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createReadAttempt, ReadAttemptInterrupted, type ReadAttemptClock } from "../read_attempt";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const duration = z.number().int().min(0).max(3_600_000);
const interruption = z.enum(["idle", "lease-lost", "cancelled", "finished"]);
const outcome = z.enum(["completed", "idle", "lease-lost", "cancelled", "finished"]);
const kind = z.enum(["pages", "database", "leaf"]);
const step = z.discriminatedUnion("command", [
  z.object({ command: z.literal("pages"), id, count: z.number().int().min(1).max(1000), leafMs: duration }).strict(),
  z.object({ command: z.literal("database-progress"), id, durationMs: duration }).strict(),
  z.object({ command: z.literal("start-blocked"), id, kind: z.enum(["leaf", "database"]) }).strict(),
  z.object({ command: z.literal("immediate-run"), id }).strict(),
  z.object({ command: z.literal("pause"), id }).strict(),
  z.object({ command: z.literal("resume"), id }).strict(),
  z.object({ command: z.literal("advance"), durationMs: duration }).strict(),
  z.object({ command: z.literal("progress") }).strict(),
  z.object({ command: z.literal("guard") }).strict(),
  z.object({ command: z.literal("caller-abort") }).strict(),
  z.object({ command: z.literal("dispose") }).strict(),
]);
const summarySchema = z.object({
  elapsedMs: duration, completedAtMs: duration.nullable(), pages: z.number().int().min(0),
  databaseProgress: z.number().int().min(0), renewals: z.number().int().min(0), resumeCalls: z.number().int().min(0),
  signalReason: z.enum(["live", ...interruption.options]), guards: z.array(z.enum(["live", ...interruption.options])),
  runs: z.array(z.object({ id, kind, outcome, entered: z.boolean() }).strict()),
  callbacksAfterDispose: z.number().int().min(0), pendingTimers: z.number().int().min(0),
}).strict();
const scenarioSchema = z.object({
  id, title: z.string().trim().min(1).max(160),
  options: z.object({ idleTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(), heartbeatMs: z.number().int().positive().max(2_147_483_647).optional() }).strict().optional(),
  renewalResponses: z.array(z.boolean()).max(1000).optional(),
  steps: z.array(step).min(1).max(1000), expected: summarySchema,
}).strict();
const suiteSchema = z.object({ schemaVersion: z.literal(1), suite: z.literal("read-attempt"), driver: z.literal("read-attempt"), scenarios: z.array(scenarioSchema).min(1).max(100) }).strict();
export type ReadAttemptScenario = z.infer<typeof scenarioSchema>;
export type ReadAttemptSummary = z.infer<typeof summarySchema>;
export class ReadAttemptScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "suite-unavailable" | "invalid-arguments" | "unknown-scenario" | "unexpected-port" | "unconsumed-port" | "expectation-mismatch", message: string) { super(message); this.name = "ReadAttemptScenarioFailure"; }
}
export async function loadReadAttemptSuite(input?: unknown) {
  let value = input;
  if (value === undefined) {
    try { value = JSON.parse(await readFile(new URL("./read-attempt.json", import.meta.url), "utf8")); }
    catch { throw new ReadAttemptScenarioFailure("suite-unavailable", "The read attempt suite is unavailable."); }
  }
  const result = suiteSchema.safeParse(value);
  if (!result.success || new Set(result.data.scenarios.map(item => item.id)).size !== result.data.scenarios.length)
    throw new ReadAttemptScenarioFailure("invalid-suite", "Invalid or duplicate read attempt scenarios.");
  return result.data;
}
const settleMicrotasks = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
/** Only the production timer port is replaced. This clock executes scheduled
 * callbacks; it does not implement attempt/lease/idle/cancellation decisions. */
export class ReadAttemptTestClock implements ReadAttemptClock {
  private now = 0;
  private nextID = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  callbacks = 0;
  nowMs = () => this.now;
  schedule = (run: () => void, delayMs: number) => {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new ReadAttemptScenarioFailure("unexpected-port", "Invalid timer delay.");
    const key = ++this.nextID; this.timers.set(key, { at: this.now + delayMs, run });
    return () => { this.timers.delete(key); };
  };
  get pendingTimers() { return this.timers.size; }
  async advance(durationMs: number) {
    const target = this.now + durationMs;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++this.callbacks > 10_000) throw new ReadAttemptScenarioFailure("unexpected-port", "Timer fixture exceeded its bound.");
      this.now = next[1].at; this.timers.delete(next[0]); next[1].run(); await settleMicrotasks();
    }
    this.now = target; await settleMicrotasks();
  }
}
function reason(error: unknown): z.infer<typeof interruption> {
  if (error instanceof ReadAttemptInterrupted) return error.reason;
  throw new ReadAttemptScenarioFailure("unexpected-port", "Production work returned an unexpected failure.");
}
export async function runReadAttemptScenario(input: unknown): Promise<ReadAttemptSummary> {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) throw new ReadAttemptScenarioFailure("invalid-suite", "Invalid read attempt scenario.");
  const scenario = parsed.data, clock = new ReadAttemptTestClock(), caller = new AbortController();
  let renewals = 0, receipts = 0, pages = 0, databaseProgress = 0, resumeCalls = 0;
  let disposed = false, callbacksAtDispose = 0, completedAtMs: number | null = null;
  const attempt = createReadAttempt(async () => {
    renewals++; return scenario.renewalResponses?.[receipts++] ?? true;
  }, { ...scenario.options, clock, signal: caller.signal });
  const pauses = new Map<string, () => void>(), runIDs = new Set<string>(), runs: Promise<ReadAttemptSummary["runs"][number]>[] = [];
  const guards: ReadAttemptSummary["guards"] = [];
  const run = (runID: string, runKind: z.infer<typeof kind>, work: () => Promise<void>) => {
    if (runIDs.has(runID)) throw new ReadAttemptScenarioFailure("unexpected-port", "Duplicate work fixture.");
    runIDs.add(runID); let entered = false;
    const result = attempt.run(async () => { entered = true; await work(); completedAtMs = clock.nowMs(); }).then(
      () => ({ id: runID, kind: runKind, outcome: "completed" as const, entered }),
      error => ({ id: runID, kind: runKind, outcome: reason(error), entered }),
    );
    runs.push(result); return result;
  };
  try {
    for (const action of scenario.steps) {
      switch (action.command) {
        case "pages": await run(action.id, "pages", async () => {
          for (let page = 0; page < action.count; page++) {
            attempt.guard(); attempt.progress(); await clock.advance(action.leafMs); attempt.guard(); attempt.progress(); pages++;
          }
        }); break;
        case "database-progress": await run(action.id, "database", async () => {
          attempt.guard(); attempt.progress(); await clock.advance(action.durationMs); attempt.guard(); attempt.progress(); databaseProgress++;
        }); break;
        case "start-blocked": void run(action.id, action.kind, () => new Promise<void>(() => {})); await settleMicrotasks(); break;
        case "immediate-run": await run(action.id, "leaf", async () => {}); break;
        case "pause": if (pauses.has(action.id)) throw new ReadAttemptScenarioFailure("unexpected-port", "Duplicate pause fixture."); pauses.set(action.id, attempt.pause()); break;
        case "resume": { const resume = pauses.get(action.id); if (!resume) throw new ReadAttemptScenarioFailure("unexpected-port", "Resume has no matching pause."); resumeCalls++; resume(); break; }
        case "advance": await clock.advance(action.durationMs); break;
        case "progress": attempt.progress(); break;
        case "guard": try { attempt.guard(); guards.push("live"); } catch (error) { guards.push(reason(error)); } break;
        case "caller-abort": caller.abort(); await settleMicrotasks(); break;
        case "dispose": if (!disposed) callbacksAtDispose = clock.callbacks; disposed = true; attempt.dispose(); await settleMicrotasks(); break;
      }
    }
    if (!disposed) throw new ReadAttemptScenarioFailure("unconsumed-port", "The scenario must dispose its production attempt.");
    if (receipts < (scenario.renewalResponses?.length ?? 0)) throw new ReadAttemptScenarioFailure("unconsumed-port", "The scenario left renewal receipts unused.");
    const summary: ReadAttemptSummary = { elapsedMs: clock.nowMs(), completedAtMs, pages, databaseProgress, renewals, resumeCalls,
      signalReason: attempt.signal.aborted ? reason(attempt.signal.reason) : "live", guards, runs: await Promise.all(runs),
      callbacksAfterDispose: clock.callbacks - callbacksAtDispose, pendingTimers: clock.pendingTimers };
    try { assert.deepStrictEqual(summary, scenario.expected); }
    catch { throw new ReadAttemptScenarioFailure("expectation-mismatch", "Read attempt evidence differs from its expected summary."); }
    return summary;
  } finally { attempt.dispose(); }
}
