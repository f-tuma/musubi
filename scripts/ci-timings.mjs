import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSelection, collectWebTests, databaseTests, webTestCases } from "./ci-shards.mjs";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

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
  return Object.fromEntries([...samples].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, values]) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return [id, (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2];
  }));
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
    const metadata = readJson(join(directory, "artifacts.json")).artifacts;
    const source = { runId: run.id, runAttempt: run.run_attempt, headSha: run.head_sha,
      url: run.html_url, artifacts: [] };
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
  return { schemaVersion: 1, recordedAt, aggregation: "median of clean successful first attempts; obsolete identities omitted",
    sources: sources.sort((a, b) => a.runId - b.runId), durationsMs: medianTimings(inventory, runs) };
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
