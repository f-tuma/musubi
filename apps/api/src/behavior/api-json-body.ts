import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  title: z.string().trim().min(1).max(160),
  encoding: z.enum(["identity", "gzip", "deflate"]),
  input: z.enum(["small-json", "oversized-json", "invalid-json"]),
  trailingBytes: z.number().int().min(0).max(102400),
  expectedStatus: z.array(z.union([z.literal(200), z.literal(400), z.literal(413)])).min(1).max(2),
}).strict().superRefine((value, ctx) => {
  if (value.trailingBytes && (value.encoding !== "gzip" || value.input !== "small-json"))
    ctx.addIssue({ code: "custom", message: "Trailing-byte cases require a small gzip frame." });
});
const suiteSchema = z.object({ schemaVersion: z.literal(1), suite: z.literal("api-json-body"),
  driver: z.literal("api-json-body"), scenarios: z.array(scenarioSchema).min(1).max(20) }).strict();

export class ApiJsonBodyScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "suite-unavailable" | "invalid-arguments" | "unknown-scenario" | "expectation-mismatch", message: string) {
    super(message); this.name = "ApiJsonBodyScenarioFailure";
  }
}

export async function loadApiJsonBodySuite(input?: unknown) {
  let value = input;
  if (value === undefined) {
    try { value = JSON.parse(await readFile(new URL("./api-json-body.json", import.meta.url), "utf8")); }
    catch { throw new ApiJsonBodyScenarioFailure("suite-unavailable", "The API JSON body suite is unavailable."); }
  }
  const result = suiteSchema.safeParse(value);
  if (!result.success || new Set(result.data.scenarios.map(item => item.id)).size !== result.data.scenarios.length)
    throw new ApiJsonBodyScenarioFailure("invalid-suite", "Invalid, empty or duplicate API JSON body scenarios.");
  return result.data;
}

/** Real HTTP middleware runs in an isolated child. Only its downstream/error
 * ports are observers; DB, auth, provider and production network are absent. */
export async function runApiJsonBodyScenario(input: unknown) {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) throw new ApiJsonBodyScenarioFailure("invalid-suite", "Invalid API JSON body scenario.");
  const childPath = fileURLToPath(new URL("./api-json-body-child.ts", import.meta.url));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", childPath], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT },
      shell: false, timeout: 8000, killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", overflow = false;
    const append = (target: "stdout" | "stderr") => (chunk: Buffer) => {
      if (overflow) return;
      if (stdout.length + stderr.length + chunk.length > 65536) { overflow = true; child.kill("SIGKILL"); return; }
      if (target === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.on("data", append("stdout")); child.stderr.on("data", append("stderr"));
    child.on("error", () => resolve({ code: null, signal: null, stdout, stderr }));
    child.on("close", (code, signal) => resolve({ code: overflow ? null : code, signal, stdout, stderr }));
    child.stdin.on("error", () => { /* Exit status remains authoritative on early child failure. */ });
    child.stdin.end(JSON.stringify(parsed.data));
  });
  if (result.code !== 0 || result.signal || result.stderr.trim())
    throw new ApiJsonBodyScenarioFailure("expectation-mismatch", "The isolated parser process crashed, timed out or logged an unexpected error.");
  try {
    const summary = z.object({ status: z.number().int(), downstreamCalls: z.number().int(), parserErrors: z.number().int(), healthStatus: z.literal(200) }).strict().parse(JSON.parse(result.stdout));
    assert.ok(parsed.data.expectedStatus.includes(summary.status as 200 | 400 | 413));
    assert.equal(summary.downstreamCalls, summary.status === 200 ? 1 : 0);
    assert.equal(summary.parserErrors, summary.status === 200 ? 0 : 1);
    return summary;
  } catch { throw new ApiJsonBodyScenarioFailure("expectation-mismatch", "The isolated parser process returned an invalid result."); }
}
