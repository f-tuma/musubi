import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSelection, collectWebTests, databaseTests, webTestCases } from "./ci-shards.mjs";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Shard 1 of the four database jobs also runs this frozen conformance step.
// Its measured duration becomes that shard's reserved planning load.
export const RESERVATION_JOB = "Database integration (1/4)";
export const RESERVATION_STEP = "Frozen standalone candidate and installed conformance";
const RESERVATION_BASIS = `median duration of the "${RESERVATION_STEP}" step of "${RESERVATION_JOB}", ` +
  "from each source run attempt's jobs.json; reserved on shard 1 of 4";

export function median(values) {
  if (!values.length) throw new Error("Cannot take the median of no samples");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
}

// A flaky retry is not a representative clean run, even if its final attempt
// passed. Conditional skips/expected failures receive the runtime fallback.
export function successfulTimings(kind, report) {
  if (kind === "db") {
    if (!Array.isArray(report)) throw new Error("Expected database result array");
    return report.filter(item => item.exitCode === 0).map(item => ({ id: item.id, durationMs: item.durationMs }));
  }
  if (kind !== "web") throw new Error("Timing kind must be db or web");
  return webTestCases(report).flatMap(({ id, test }) => {
    const [attempt] = test.results ?? [];
    if (test.expectedStatus !== "passed" || test.status !== "expected" || test.results.length !== 1 ||
        attempt.status !== "passed" || attempt.retry !== 0 || attempt.errors?.length) return [];
    return [{ id, durationMs: attempt.duration }];
  });
}

export function medianTimings(inventory, runs) {
  const current = new Set(inventory.map(item => item.id));
  if (!current.size || current.size !== inventory.length) throw new Error("Invalid current timing inventory");
  const samples = new Map();
  for (const run of runs) {
    const observed = new Set();
    for (const { id, durationMs } of run) {
      if (typeof id !== "string" || !id || observed.has(id)) throw new Error("Duplicate or missing timing identity in one run");
      observed.add(id);
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`Invalid timing for ${id}`);
      if (current.has(id)) samples.set(id, [...(samples.get(id) ?? []), durationMs]);
    }
  }
  return Object.fromEntries([...samples].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, values]) => [id, median(values)]));
}

// `jobs.json` is the saved jobs API response for the source run attempt
// (actions/runs/$run/attempts/$attempt/jobs). It must belong to that run.
export function conformanceReservation(run, jobsFile) {
  if (!Array.isArray(jobsFile?.jobs)) throw new Error("Expected jobs.json with a jobs array");
  const jobs = jobsFile.jobs.filter(job => job.name === RESERVATION_JOB);
  if (jobs.length !== 1) throw new Error(`Expected exactly one job named "${RESERVATION_JOB}" in jobs.json; found ${jobs.length}`);
  const [job] = jobs;
  for (const [field, expected] of [["run_id", run.id], ["head_sha", run.head_sha], ["run_attempt", run.run_attempt]]) {
    if (job[field] !== expected) throw new Error(`jobs.json ${field} ${job[field]} does not match run ${field} ${expected}`);
  }
  if (!Number.isSafeInteger(job.id) || job.id < 1) throw new Error("jobs.json job has no valid id");
  if (job.conclusion !== "success") throw new Error(`jobs.json job "${RESERVATION_JOB}" did not succeed`);
  const steps = (job.steps ?? []).filter(step => step.name === RESERVATION_STEP);
  if (steps.length !== 1) throw new Error(`Expected exactly one "${RESERVATION_STEP}" step in "${RESERVATION_JOB}"; found ${steps.length}`);
  const [step] = steps;
  if (step.conclusion !== "success") throw new Error(`Step "${RESERVATION_STEP}" did not succeed`);
  const durationMs = Date.parse(step.completed_at) - Date.parse(step.started_at);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error(`Invalid "${RESERVATION_STEP}" duration from ${step.started_at} to ${step.completed_at}`);
  }
  return { jobId: job.id, job: job.name, step: step.name, stepNumber: step.number,
    startedAt: step.started_at, completedAt: step.completed_at, durationMs };
}

// Each source is an unchanged `gh run download` directory plus saved GitHub
// run/artifact API metadata. Report hashes make this refresh reproducible.
export function importTimings(kind, recordedAt, directories, inventory) {
  if (!["db", "web"].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(recordedAt) ||
      !Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString().slice(0, 10) !== recordedAt) {
    throw new Error("Expected db|web and a valid YYYY-MM-DD recording date");
  }
  if (!directories.length) throw new Error("At least one source run is required");
  const seenRuns = new Set();
  const sources = [];
  const runs = [];
  for (const directory of directories) {
    const run = readJson(join(directory, "run.json"));
    if (run.status !== "completed" || run.conclusion !== "success" || !Number.isSafeInteger(run.id) ||
        run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
        !/^[a-f0-9]{40}$/.test(run.head_sha) || seenRuns.has(run.id)) {
      throw new Error("Expected a distinct completed successful GitHub run with source identity");
    }
    seenRuns.add(run.id);
    const reservation = kind === "db" ? conformanceReservation(run, readJson(join(directory, "jobs.json"))) : null;
    const metadata = readJson(join(directory, "artifacts.json")).artifacts;
    const source = { runId: run.id, runAttempt: run.run_attempt, headSha: run.head_sha,
      url: run.html_url, artifacts: [] };
    if (reservation) source.reservation = reservation;
    const samples = [];
    const selectedInRun = [];
    for (let shard = 1; shard <= 4; shard++) {
      const name = `${kind === "db" ? "database" : "web"}-timings-${shard}`;
      const matches = metadata.filter(item => item.name === name);
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) {
        throw new Error(`Missing or ambiguous artifact metadata: ${name}`);
      }
      const reportBytes = readFileSync(join(directory, name, `${kind}-results.json`));
      const selectedBytes = readFileSync(join(directory, name, "selected-tests.txt"));
      const selectedLines = selectedBytes.toString("utf8").split(/\r?\n/);
      if (selectedLines.at(-1) === "") selectedLines.pop();
      const selected = selectedLines.map(id => ({ id }));
      const report = JSON.parse(reportBytes);
      const actual = kind === "db" ? report : webTestCases(report);
      assertSelection(selected, actual);
      if (new Set(selected.map(item => item.id)).size !== selected.length ||
          selected.some(item => !item.id || selectedInRun.includes(item.id))) throw new Error("Duplicate or empty selection across shards");
      selectedInRun.push(...selected.map(item => item.id));
      samples.push(...successfulTimings(kind, report));
      source.artifacts.push({ id: matches[0].id, name, reportSha256: sha256(reportBytes), selectedSha256: sha256(selectedBytes) });
    }
    sources.push(source);
    runs.push(samples);
  }
  const aggregation = "median of clean successful first attempts; obsolete identities omitted";
  sources.sort((a, b) => a.runId - b.runId);
  const durationsMs = medianTimings(inventory, runs);
  if (kind !== "db") return { schemaVersion: 1, recordedAt, aggregation, sources, durationsMs };
  // Step timestamps have whole-second resolution; rounding only guards a .5 median.
  const reserved = Math.round(median(sources.map(source => source.reservation.durationMs)));
  return { schemaVersion: 2, recordedAt, aggregation, sources,
    reservations: { total: 4, reservedMs: [reserved, 0, 0, 0], basis: RESERVATION_BASIS }, durationsMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [kind, recordedAt, ...directories] = process.argv.slice(2);
    const inventory = kind === "db" ? databaseTests() : kind === "web" ? collectWebTests() : [];
    console.log(JSON.stringify(importTimings(kind, recordedAt, directories, inventory), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
