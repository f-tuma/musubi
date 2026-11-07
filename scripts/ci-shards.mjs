import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Placement estimates for tests without a recorded duration. They affect only
// which shard runs a test, never whether it runs.
export const FALLBACK_MS = Object.freeze({ db: 15000, web: 6000 });

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  const [current, total] = match ? match.slice(1).map(Number) : [];
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(current) || current < 1 || current > total) {
    throw new Error("Shard must be current/total, for example 1/4");
  }
  return { current, total };
}

// Longest suites go to the least busy runner. Keep original execution order
// within each runner, and use a stable tie-break so every job gets the same plan.
// reservedMs[i] is work shard i+1 does besides its suites (shard 1's frozen
// conformance step); it is the shard's initial load. Missing entries are 0.
export function partition(items, total, timings = {}, fallback = 1, reservedMs = []) {
  if (!Number.isSafeInteger(total) || total < 1 || items.length < total) {
    throw new Error("Every shard must contain at least one test");
  }
  if (!Array.isArray(reservedMs) || reservedMs.length > total ||
      Array.from(reservedMs).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Invalid reserved weight: expected at most one non-negative integer of milliseconds per shard");
  }
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error("Duplicate test identity in the shard inventory");
  }
  const weighted = items.map((item, index) => {
    const duration = timings[item.id] ?? fallback;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid timing for ${item.id}`);
    return { item, index, duration };
  }).sort((a, b) => b.duration - a.duration || a.index - b.index);
  const shards = Array.from({ length: total }, (_, index) => {
    const reserved = reservedMs[index] ?? 0;
    return { duration: reserved, reservedMs: reserved, entries: [] };
  });
  for (const entry of weighted) {
    const next = shards.reduce((best, shard) => shard.duration < best.duration ? shard : best);
    next.entries.push(entry);
    next.duration += entry.duration;
  }
  const empty = shards.findIndex(shard => !shard.entries.length);
  if (empty >= 0) throw new Error(`Reserved weight leaves shard ${empty + 1} without suites`);
  return shards.map(shard => ({
    duration: shard.duration,
    reservedMs: shard.reservedMs,
    items: shard.entries.sort((a, b) => a.index - b.index).map(entry => entry.item),
  }));
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Shape check shared by loadTimingFile (fatal before any resource) and
// reservedWeights. The importer writes { total, reservedMs, basis }.
function validReservations(reservations) {
  if (!isObject(reservations) || Object.keys(reservations).sort().join() !== "basis,reservedMs,total" ||
      !Number.isSafeInteger(reservations.total) || reservations.total < 1 ||
      typeof reservations.basis !== "string" || !reservations.basis ||
      !Array.isArray(reservations.reservedMs) || reservations.reservedMs.length !== reservations.total ||
      Array.from(reservations.reservedMs).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Malformed timing reservations: expected { total, reservedMs, basis } with one non-negative integer per shard");
  }
  return reservations;
}

// Reserved loads recorded for this shard total, or [] when there are none or
// they were recorded for another total. A missing record only degrades placement.
export function reservedWeights(timingFile, total) {
  if (timingFile.reservations === undefined) return [];
  const reservations = validReservations(timingFile.reservations);
  return reservations.total === total ? [...reservations.reservedMs] : [];
}

// Report only: how much of the live inventory has a recorded duration. There
// is no threshold; unmeasured tests use the fallback and are still selected.
export function timingCoverage(inventory, durationsMs) {
  const current = new Set(inventory.map(item => item.id));
  const fallbackIds = inventory.filter(item => !Object.hasOwn(durationsMs, item.id)).map(item => item.id);
  return {
    inventory: inventory.length,
    measured: inventory.length - fallbackIds.length,
    fallbackIds,
    obsolete: Object.keys(durationsMs).filter(id => !current.has(id)).length,
  };
}

// Used for both the db and web timing files, before inventory collection,
// output directories or test processes. Only unreadable, malformed or invalid
// data is fatal; coverage and age never are.
export function loadTimingFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Unreadable timing file ${path}: ${error.message}`);
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid timing file ${path}: ${error.message}`);
  }
  if (!isObject(file) || !isObject(file.durationsMs)) {
    throw new Error(`Invalid timing file ${path}: expected an object with a durationsMs object`);
  }
  for (const [id, duration] of Object.entries(file.durationsMs)) {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid timing for ${id} in ${path}`);
  }
  if (file.reservations !== undefined) validReservations(file.reservations);
  return file;
}

// Expand the existing test:db script instead of maintaining a second file list.
// Reject unknown shell syntax: a newly added command must never silently vanish.
export function databaseTests(loadPackage = directory => readJson(join(root, directory, "package.json"))) {
  const packages = { "@musubi/api": "apps/api", "@musubi/db": "packages/db", "@musubi/sync-reference": "apps/sync-reference" };
  function expand(directory, script, ancestors = []) {
    const identity = `${directory}:${script}`;
    if (ancestors.includes(identity)) throw new Error(`Recursive script: ${identity}`);
    const command = loadPackage(directory).scripts?.[script];
    if (!command) throw new Error(`Missing script: ${identity}`);
    return command.split(/\s*&&\s*/).flatMap(part => {
      let match = /^pnpm (?:run )?(test:[\w:-]+)$/.exec(part);
      if (match) return expand(directory, match[1], [...ancestors, identity]);
      match = /^pnpm --filter (@musubi\/(?:api|db|sync-reference)) (.+)$/.exec(part);
      let target = directory;
      let leaf = part;
      if (match) {
        target = packages[match[1]];
        leaf = match[2];
        const nested = /^run (test:[\w:-]+)$/.exec(leaf);
        if (nested) return expand(target, nested[1], [...ancestors, identity]);
      }
      const source = /^(?:exec )?tsx (src\/[\w./-]+\.test\.ts)$/.exec(leaf)?.[1];
      if (!source || !Object.values(packages).includes(target)) {
        throw new Error(`Unsupported database test command: ${part}`);
      }
      return [{ id: `${target}/${source}`, directory: target, source }];
    });
  }
  return expand("", "test:db");
}

// Playwright's JSON inventory includes generated tests and describe groups.
// Qualified test-list entries distinguish cases sharing the same source line.
export function webTestCases(report) {
  if (report.errors?.length) throw new Error(`Playwright collection failed: ${JSON.stringify(report.errors)}`);
  function visit(suite, groups = []) {
    const titles = suite.line ? [...groups, suite.title] : groups;
    return [
      ...(suite.specs ?? []).flatMap(spec => spec.tests.map(test => ({
        id: `[${test.projectName}] › ${spec.file} › ${[...titles, spec.title].join(" › ")}`,
        test,
      }))),
      ...(suite.suites ?? []).flatMap(child => visit(child, titles)),
    ];
  }
  return report.suites.flatMap(suite => visit(suite));
}

export function webTests(report) {
  return webTestCases(report).map(({ id }) => ({ id }));
}

export function assertSelection(planned, actual) {
  const ids = items => items.map(item => item.id).sort();
  if (!planned.length || JSON.stringify(ids(planned)) !== JSON.stringify(ids(actual))) {
    throw new Error(`Playwright selected ${actual.length} tests instead of the exact ${planned.length} planned tests`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result;
}

export function collectWebTests(extra = []) {
  const webDirectory = join(root, "apps/web");
  // .npmrc uses node-linker=hoisted, so workspace tools live at the root.
  const playwright = join(root, "node_modules/.bin/playwright");
  const result = run(playwright, ["test", "--list", "--reporter=json", ...extra], {
    cwd: webDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: "", PLAYWRIGHT_JSON_OUTPUT_FILE: "" },
  });
  if (result.status !== 0) throw new Error("Playwright test collection failed");
  return webTests(JSON.parse(result.stdout));
}

// Estimates, never measurements: db-results.json records what actually ran.
function databasePlanReport(file, inventory, shards, total) {
  const coverage = timingCoverage(inventory, file.durationsMs);
  const recordedFor = file.reservations?.total;
  const lines = [
    `Timing coverage: ${coverage.measured}/${coverage.inventory} measured, ${coverage.fallbackIds.length} fallback at ` +
      `${FALLBACK_MS.db} ms, ${coverage.obsolete} obsolete; recorded ${file.recordedAt ?? "unknown"} (${file.sources?.length ?? 0} runs)`,
    "Estimated load ms per shard (suites + reserved): " + shards.map(shard => {
      const combined = Math.round(shard.duration);
      return shard.reservedMs ? `${combined} (${combined - shard.reservedMs} + ${shard.reservedMs} reserved)` : `${combined}`;
    }).join(", "),
  ];
  const notices = [];
  if (coverage.fallbackIds.length) {
    lines.push(`Unmeasured suites (${FALLBACK_MS.db} ms estimate): ${coverage.fallbackIds.join(", ")}`);
    notices.push(`${coverage.fallbackIds.length} database suites have no recorded duration and use the ${FALLBACK_MS.db} ms placement estimate; all are still selected`);
  }
  if (recordedFor === undefined) {
    lines.push("No reserved weights recorded");
    notices.push("No reserved weights recorded in scripts/ci-db-timings.json; shard 1 conformance work is not counted in placement");
  } else if (recordedFor !== total) {
    lines.push(`reserved weights: none for ${total} shard(s) (recorded for ${recordedFor})`);
  }
  const plan = {
    estimate: true,
    kind: "db",
    total,
    fallbackMs: FALLBACK_MS.db,
    recordedAt: file.recordedAt ?? null,
    coverage: { inventory: coverage.inventory, measured: coverage.measured, fallbackIds: coverage.fallbackIds, obsolete: coverage.obsolete },
    reservations: { recordedFor: recordedFor ?? null, applied: shards.some(shard => shard.reservedMs > 0) },
    shards: shards.map((shard, index) => ({
      shard: index + 1, count: shard.items.length,
      suitesMs: shard.duration - shard.reservedMs, reservedMs: shard.reservedMs, combinedMs: shard.duration,
    })),
  };
  return { lines, notices, plan };
}

function main() {
  const [kind, shardArg, mode] = process.argv.slice(2);
  if (!["db", "web"].includes(kind) || (mode && mode !== "--list")) {
    throw new Error("Usage: node scripts/ci-shards.mjs db|web current/total [--list]");
  }
  const { current, total } = parseShard(shardArg);
  const webDirectory = join(root, "apps/web");
  const playwright = join(root, "node_modules/.bin/playwright");
  // Validate the timing file before collecting tests or creating output.
  const file = loadTimingFile(join(root, `scripts/ci-${kind}-timings.json`));
  const reservedMs = kind === "db" ? reservedWeights(file, total) : [];
  let inventory;
  if (kind === "db") {
    inventory = databaseTests();
  } else {
    inventory = collectWebTests();
  }
  const shards = partition(inventory, total, file.durationsMs, FALLBACK_MS[kind], reservedMs);
  const selected = shards[current - 1].items;
  console.log(`${kind}: ${inventory.length} total suites/tests; shard ${shardArg}: ${selected.length}`);
  const report = kind === "db" ? databasePlanReport(file, inventory, shards, total) : null;
  if (report) {
    for (const line of report.lines) console.log(line);
    if (process.env.GITHUB_ACTIONS === "true") for (const notice of report.notices) console.log(`::notice title=Database shard plan::${notice}`);
  } else {
    console.log(`Shard weights: ${shards.map(shard => Math.round(shard.duration)).join(", ")}`);
  }
  if (mode === "--list") {
    console.log(selected.map(item => item.id).join("\n"));
    return;
  }
  const output = process.env.CI_SHARD_OUTPUT_DIR ?? join(tmpdir(), `musubi-ci-${kind}-${current}`);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "selected-tests.txt"), selected.map(item => item.id).join("\n") + "\n");
  if (report) writeFileSync(join(output, "shard-plan.json"), JSON.stringify({ ...report.plan, shard: current }, null, 2) + "\n");
  if (kind === "web") {
    const testList = `--test-list=${join(output, "selected-tests.txt")}`;
    // Playwright accepts an empty --test-list match as success. Verify the
    // selected inventory before execution, so path/title changes cannot hide tests.
    assertSelection(selected, collectWebTests([testList]));
    const result = run(playwright, ["test", testList, "--reporter=list,json"], {
      cwd: webDirectory,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: join(output, "web-results.json") },
    });
    process.exitCode = result.status ?? 1;
    return;
  }
  const results = [];
  // A shard has one isolated Postgres. Suites within it must stay sequential.
  for (const item of selected) {
    console.log(`::group::${item.id}`);
    const start = performance.now();
    const result = run(join(root, "node_modules/.bin/tsx"), [item.source], {
      cwd: join(root, item.directory),
    });
    results.push({ id: item.id, durationMs: Math.round(performance.now() - start), exitCode: result.status ?? 1 });
    writeFileSync(join(output, "db-results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log("::endgroup::");
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
