import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

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
export function partition(items, total, timings = {}, fallback = 1) {
  if (!Number.isSafeInteger(total) || total < 1 || items.length < total) {
    throw new Error("Every shard must contain at least one test");
  }
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error("Duplicate test identity in the shard inventory");
  }
  const weighted = items.map((item, index) => {
    const duration = timings[item.id] ?? fallback;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid timing for ${item.id}`);
    return { item, index, duration };
  }).sort((a, b) => b.duration - a.duration || a.index - b.index);
  const shards = Array.from({ length: total }, () => ({ duration: 0, entries: [] }));
  for (const entry of weighted) {
    const next = shards.reduce((best, shard) => shard.duration < best.duration ? shard : best);
    next.entries.push(entry);
    next.duration += entry.duration;
  }
  return shards.map(shard => ({
    duration: shard.duration,
    items: shard.entries.sort((a, b) => a.index - b.index).map(entry => entry.item),
  }));
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
export function webTests(report) {
  if (report.errors?.length) throw new Error(`Playwright collection failed: ${JSON.stringify(report.errors)}`);
  function visit(suite, groups = []) {
    const titles = suite.line ? [...groups, suite.title] : groups;
    return [
      ...(suite.specs ?? []).flatMap(spec => spec.tests.map(test => ({
        id: `[${test.projectName}] › ${spec.file} › ${[...titles, spec.title].join(" › ")}`,
      }))),
      ...(suite.suites ?? []).flatMap(child => visit(child, titles)),
    ];
  }
  return report.suites.flatMap(suite => visit(suite));
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

function main() {
  const [kind, shardArg, mode] = process.argv.slice(2);
  if (!["db", "web"].includes(kind) || (mode && mode !== "--list")) {
    throw new Error("Usage: node scripts/ci-shards.mjs db|web current/total [--list]");
  }
  const { current, total } = parseShard(shardArg);
  const webDirectory = join(root, "apps/web");
  // .npmrc uses node-linker=hoisted, so workspace tools live at the root.
  const playwright = join(root, "node_modules/.bin/playwright");
  function collectWeb(extra = []) {
    const result = run(playwright, ["test", "--list", "--reporter=json", ...extra], {
      cwd: webDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: "", PLAYWRIGHT_JSON_OUTPUT_FILE: "" },
    });
    if (result.status !== 0) throw new Error("Playwright test collection failed");
    return webTests(JSON.parse(result.stdout));
  }
  let inventory;
  let timings = {};
  if (kind === "db") {
    inventory = databaseTests();
  } else {
    inventory = collectWeb();
    timings = readJson(join(root, "scripts/ci-web-timings.json")).durationsMs;
  }
  const shards = partition(inventory, total, timings, kind === "web" ? 6000 : 1);
  const selected = shards[current - 1].items;
  console.log(`${kind}: ${inventory.length} total suites/tests; shard ${shardArg}: ${selected.length}`);
  console.log(`Shard weights: ${shards.map(shard => Math.round(shard.duration)).join(", ")}`);
  if (mode === "--list") {
    console.log(selected.map(item => item.id).join("\n"));
    return;
  }
  const output = process.env.CI_SHARD_OUTPUT_DIR ?? join(tmpdir(), `musubi-ci-${kind}-${current}`);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "selected-tests.txt"), selected.map(item => item.id).join("\n") + "\n");
  if (kind === "web") {
    const testList = `--test-list=${join(output, "selected-tests.txt")}`;
    // Playwright accepts an empty --test-list match as success. Verify the
    // selected inventory before execution, so path/title changes cannot hide tests.
    assertSelection(selected, collectWeb([testList]));
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
