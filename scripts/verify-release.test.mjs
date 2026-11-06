import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const requiredFiles = [
  "package.json", "pnpm-workspace.yaml", "scripts/verify-release.mjs",
  "apps/client/app.config.ts", "apps/client/components/UpdateRequiredModal.tsx", "apps/client/eas.json",
  "packages/types/src/version.ts", "packages/types/contracts/wire.json",
  "apps/api/Dockerfile", "apps/web/Dockerfile", "packages/docs/Dockerfile", "apps/sync-reference/Dockerfile",
  ".nvmrc", "scripts/sync-alpha-common.mjs",
  "README.md",
  "packages/docs/src/content/docs/guides/running-locally.mdx",
  "packages/docs/src/content/docs/guides/troubleshooting.mdx",
];
// Every live workflow is copied, so the validator's directory scan sees the
// same inventory in the fixture as in the repository.
const requiredDirectories = [".github/workflows"];

function verify({ storedListing, environmentListing, betaListing, edit = {}, write = {}, remove = [] } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "musubi-release-metadata-"));
  try {
    for (const relative of requiredFiles) {
      const target = join(fixture, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(sourceRoot, relative), target);
    }
    for (const relative of requiredDirectories) {
      cpSync(join(sourceRoot, relative), join(fixture, relative), { recursive: true });
    }
    const manifestPath = join(fixture, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const versionsPath = join(fixture, "packages/types/src/version.ts");
    writeFileSync(versionsPath, readFileSync(versionsPath, "utf8")
      .replace(/PRODUCT_VERSION = "[^"]+"/, `PRODUCT_VERSION = "${manifest.version}"`));
    const easPath = join(fixture, "apps/client/eas.json");
    const eas = JSON.parse(readFileSync(easPath, "utf8"));
    delete eas.build.production.env.EXPO_PUBLIC_IOS_APP_STORE_URL;
    if (storedListing !== undefined) eas.build.production.env.EXPO_PUBLIC_IOS_APP_STORE_URL = storedListing;
    if (betaListing !== undefined) eas.build.production.env.EXPO_PUBLIC_IOS_TESTFLIGHT_URL = betaListing;
    writeFileSync(easPath, JSON.stringify(eas));
    // Mutations apply to the fixture copy only; the validator under test reads
    // every path relative to its own location, so the real checkout is never
    // what gets exercised.
    for (const relative of remove) rmSync(join(fixture, relative), { force: true });
    for (const [relative, content] of Object.entries(write)) {
      mkdirSync(dirname(join(fixture, relative)), { recursive: true });
      writeFileSync(join(fixture, relative), content);
    }
    for (const [relative, transform] of Object.entries(edit)) {
      const path = join(fixture, relative);
      writeFileSync(path, transform(readFileSync(path, "utf8")));
    }
    const env = { ...process.env };
    delete env.EXPO_PUBLIC_IOS_APP_STORE_URL;
    delete env.EXPO_PUBLIC_IOS_TESTFLIGHT_URL;
    if (environmentListing !== undefined) env.EXPO_PUBLIC_IOS_APP_STORE_URL = environmentListing;
    return spawnSync(process.execPath, [join(fixture, "scripts/verify-release.mjs"), manifest.version], {
      env, encoding: "utf8",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("API/web metadata does not require a native App Store listing", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release metadata verified: Musubi \d+\.\d+\.\d+/);
});

test("real validator accepts a direct listing from EAS configuration or build environment", () => {
  for (const location of ["storedListing", "environmentListing"]) {
    const result = verify({ [location]: "https://apps.apple.com/app/musubi/id1234567890" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("real validator rejects an all-zero distribution override and environment value", () => {
  for (const location of ["storedListing", "environmentListing"]) {
    const result = verify({ [location]: "https://apps.apple.com/app/id0000000000" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nonzero numeric app id/);
  }
});

test("real validator rejects a supplied URL outside the direct HTTPS listing", () => {
  for (const value of ["http://apps.apple.com/app/id1234567890", "https://example.test/app/id1234567890"]) {
    const result = verify({ storedListing: value });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /direct apps\.apple\.com listing/);
  }
});

test("real validator accepts the beta update channel and rejects a malformed one", () => {
  const valid = verify({ betaListing: "https://testflight.apple.com/join/EqzdPVfC" });
  assert.equal(valid.status, 0, valid.stderr);
  const invalid = verify({ betaListing: "https://example.test/join/EqzdPVfC" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /direct HTTPS TestFlight join URL/);
});


// --- Node toolchain coherence -------------------------------------------------
// Facts below are read from the real checkout, never hard-coded, so the
// assertions describe the repository as it is rather than a remembered state.

const sourceOf = (relative) => readFileSync(join(sourceRoot, relative), "utf8");
const lineNumberOf = (relative, pattern) =>
  sourceOf(relative).split("\n").findIndex((line) => pattern.test(line)) + 1;
const replaceLine = (pattern, replacement) => (source) => {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  assert.notEqual(index, -1, `no line matches ${pattern}`);
  lines[index] = replacement;
  return lines.join("\n");
};
const dropLines = (pattern) => (source) =>
  source.split("\n").filter((line) => !pattern.test(line)).join("\n");

const nodeVersion = sourceOf(".nvmrc").replace(/\r?\n$/, "");
const nodeMajor = nodeVersion.split(".")[0];
const [major, minor, patch] = nodeVersion.split(".").map(Number);
const bumpedPatch = `${major}.${minor}.${patch + 1}`;
const digest = sourceOf("apps/api/Dockerfile").match(/@sha256:([a-f0-9]{64})/)[1];
const dockerfiles = ["apps/api/Dockerfile", "apps/web/Dockerfile", "packages/docs/Dockerfile", "apps/sync-reference/Dockerfile"];
const runnerPattern = /^FROM node:\S+ AS runner$/;
const apiRunnerLine = lineNumberOf("apps/api/Dockerfile", runnerPattern);
const webRunnerLine = lineNumberOf("apps/web/Dockerfile", runnerPattern);
const pinnedFromLines = dockerfiles
  .flatMap((relative) => sourceOf(relative).split("\n"))
  .filter((line) => /^FROM node:/.test(line)).length;
const workflowDirectory = ".github/workflows";
const qualityWorkflow = `${workflowDirectory}/quality.yml`;
const assetsWorkflow = `${workflowDirectory}/vardum-assets.yml`;
const nodeVersionPattern = /^\s*node-version:/;
const qualityNodeVersionLine = lineNumberOf(qualityWorkflow, nodeVersionPattern);
const countLines = (relative, pattern) =>
  sourceOf(relative).split("\n").filter((line) => !/^\s*#/.test(line) && pattern.test(line)).length;
const qualitySetupNodeCount = countLines(qualityWorkflow, /actions\/setup-node@/);
const assetsSetupNodeCount = countLines(assetsWorkflow, /actions\/setup-node@/);
const guides = [
  "README.md",
  "packages/docs/src/content/docs/guides/running-locally.mdx",
  "packages/docs/src/content/docs/guides/troubleshooting.mdx",
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const assertRejected = (result, ...patterns) => {
  assert.equal(result.status, 1, `expected a toolchain failure, got exit ${result.status}\n${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stdout, /Release metadata verified/);
  for (const pattern of patterns) assert.match(result.stderr, pattern);
};

test("toolchain: the real copy agrees with .nvmrc, with or without a trailing newline", () => {
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(sourceOf("apps/sync-reference/Dockerfile"), /^HEALTHCHECK /m);
  for (const content of [`${nodeVersion}\n`, `${nodeVersion}\r\n`, nodeVersion]) {
    const result = verify({ write: { ".nvmrc": content } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release metadata verified/);
  }
});

test("toolchain: unrelated changes stay out of scope", () => {
  const result = verify({
    edit: {
      [qualityWorkflow]: (source) => source
        .replace(/^(\s*)node-version: 22$/m, "$1node-version: '22'")
        .replace(/^(\s*)node-version: 22$/m, `$1node-version: "22"`)
        .replace("runs-on: ubuntu-latest", "runs-on: macos-26")
        .replace("postgres:17-alpine", "postgres:18-alpine"),
      "scripts/sync-alpha-common.mjs": (source) => source.replace(/tsx: "[^"]+"/, 'tsx: "9.9.9"'),
      "packages/docs/Dockerfile": (source) => source.replace(new RegExp(digest, "g"), "a".repeat(64)),
    },
    write: { [`${workflowDirectory}/synthetic-no-node.yml`]: "name: synthetic\non: workflow_dispatch\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo noop\n" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release metadata verified/);
});

test("toolchain: a drifted .nvmrc is reported against every pinned declaration", () => {
  const result = verify({ write: { ".nvmrc": "24.15.0\n" } });
  assertRejected(result,
    new RegExp(`apps/api/Dockerfile:1 pins Node ${escape(nodeVersion)}, but \\.nvmrc declares 24\\.15\\.0`),
    new RegExp(`${escape(qualityWorkflow)}:${qualityNodeVersionLine} node-version ${nodeMajor} does not match \\.nvmrc major 24`),
    new RegExp(`scripts/sync-alpha-common\\.mjs declares PINS\\.nodeMajor ${nodeMajor}, but \\.nvmrc declares 24\\.15\\.0`));
  assert.equal(result.stderr.match(/ pins Node /g).length, pinnedFromLines);
});

test("toolchain: .nvmrc must be an exact X.Y.Z", () => {
  for (const content of [`v${nodeVersion}\n`, "lts/*\n", `${nodeMajor}\n`, "", ` ${nodeVersion}\n`, `${nodeVersion}\n\n`]) {
    assertRejected(verify({ write: { ".nvmrc": content } }),
      new RegExp(`\\.nvmrc must contain an exact Node version X\\.Y\\.Z, received ${escape(JSON.stringify(content))}`));
  }
  assertRejected(verify({ remove: [".nvmrc"] }), /\.nvmrc is missing/);
});

test("toolchain: unknown FROM shapes fail closed at the exact Dockerfile line", () => {
  for (const line of [
    "FROM node:24-alpine AS runner",
    `FROM --platform=linux/amd64 node:${nodeVersion}-alpine@sha256:${digest} AS runner`,
    "FROM node:${NODE_VERSION}-alpine AS runner",
    `FROM node:${nodeVersion}-alpine AS runner`,
    `FROM node@sha256:${digest} AS runner`,
    "FROM alpine:3.21 AS runner",
    `FROM node:${nodeVersion}-alpine@sha256:${digest}`,
    `from node:${nodeVersion}-alpine@sha256:${digest} as runner`,
  ]) {
    const result = verify({ edit: { "apps/api/Dockerfile": replaceLine(runnerPattern, line) } });
    assertRejected(result,
      new RegExp(`apps/api/Dockerfile:${apiRunnerLine} must be "FROM node:${escape(nodeVersion)}-alpine@sha256:<digest> AS <stage>".*received: ${escape(line)}`));
    assert.doesNotMatch(result.stderr, /apps\/api\/Dockerfile:1 /);
  }
});

test("toolchain: a stage alias must name an earlier stage of the same file", () => {
  const result = verify({ edit: { "apps/web/Dockerfile": replaceLine(runnerPattern, "FROM deploy AS runner") } });
  assertRejected(result, new RegExp(`apps/web/Dockerfile:${webRunnerLine} builds on undeclared stage "deploy"`));
  const valid = verify({ edit: { "apps/web/Dockerfile": replaceLine(runnerPattern, "FROM build AS runner") } });
  assert.equal(valid.status, 0, valid.stderr);
});

test("toolchain: a pinned patch that differs from .nvmrc is reported", () => {
  const result = verify({ edit: {
    "apps/web/Dockerfile": replaceLine(runnerPattern, `FROM node:${bumpedPatch}-alpine@sha256:${digest} AS runner`),
  } });
  assertRejected(result,
    new RegExp(`apps/web/Dockerfile:${webRunnerLine} pins Node ${escape(bumpedPatch)}, but \\.nvmrc declares ${escape(nodeVersion)}`));
  assert.doesNotMatch(result.stderr, /apps\/web\/Dockerfile:1 /);
});

test("toolchain: every Dockerfile needs at least one pinned Node stage", () => {
  const result = verify({ edit: { "apps/sync-reference/Dockerfile": dropLines(/^FROM /) } });
  assertRejected(result,
    new RegExp(`apps/sync-reference/Dockerfile must declare at least one digest-pinned node:${escape(nodeVersion)}-alpine stage`));
});

test("toolchain: a CI node-version major that drifts from .nvmrc is reported", () => {
  const result = verify({ edit: { [qualityWorkflow]: replaceLine(nodeVersionPattern, "          node-version: 24") } });
  assertRejected(result,
    new RegExp(`${escape(qualityWorkflow)}:${qualityNodeVersionLine} node-version 24 does not match \\.nvmrc major ${nodeMajor}`));
});

test("toolchain: non-bare CI node-version shapes fail closed", () => {
  for (const value of [nodeVersion, `${nodeMajor}.x`, "lts/*", "${{ matrix.node }}", ""]) {
    const result = verify({ edit: { [qualityWorkflow]: replaceLine(nodeVersionPattern, `          node-version: ${value}`) } });
    assertRejected(result,
      new RegExp(`${escape(qualityWorkflow)}:${qualityNodeVersionLine} node-version must be the bare major of \\.nvmrc \\(${nodeMajor}\\), received: ${escape(value || "nothing")}`));
  }
  const folded = verify({ edit: { [qualityWorkflow]: replaceLine(nodeVersionPattern, `          node-version: >-\n            ${nodeMajor}`) } });
  assertRejected(folded,
    new RegExp(`${escape(qualityWorkflow)}:${qualityNodeVersionLine} node-version must be the bare major of \\.nvmrc \\(${nodeMajor}\\), received: >-`));
});

test("toolchain: setup-node steps and node-version lines are counted per workflow", () => {
  const file = verify({ edit: { [qualityWorkflow]: replaceLine(nodeVersionPattern, "          node-version-file: .nvmrc") } });
  assertRejected(file,
    new RegExp(`${escape(qualityWorkflow)} declares actions/setup-node ${qualitySetupNodeCount} time\\(s\\) but node-version ${qualitySetupNodeCount - 1} time\\(s\\)`));
  const dropped = verify({ edit: { [assetsWorkflow]: dropLines(nodeVersionPattern) } });
  assertRejected(dropped,
    new RegExp(`${escape(assetsWorkflow)} declares actions/setup-node ${assetsSetupNodeCount} time\\(s\\) but node-version 0 time\\(s\\)`));
  assert.doesNotMatch(dropped.stderr, /quality\.yml/);
});

test("toolchain: a new workflow with setup-node is covered by the directory scan", () => {
  const workflow = "name: synthetic\non: workflow_dispatch\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@0000000000000000000000000000000000000000\n        with:\n          node-version: 24\n";
  const result = verify({ write: { [`${workflowDirectory}/synthetic.yaml`]: workflow } });
  assertRejected(result,
    new RegExp(`${escape(workflowDirectory)}/synthetic\\.yaml:9 node-version 24 does not match \\.nvmrc major ${nodeMajor}`));
});

test("toolchain: the alpha packaging pin must match the .nvmrc major", () => {
  const drifted = verify({ edit: { "scripts/sync-alpha-common.mjs": (source) => source.replace(/nodeMajor:\s*\d+/, "nodeMajor: 24") } });
  assertRejected(drifted,
    new RegExp(`scripts/sync-alpha-common\\.mjs declares PINS\\.nodeMajor 24, but \\.nvmrc declares ${escape(nodeVersion)}`));
  const missing = verify({ edit: { "scripts/sync-alpha-common.mjs": (source) => source.replace(/nodeMajor:\s*\d+,\s*/, "") } });
  assertRejected(missing, /scripts\/sync-alpha-common\.mjs must declare PINS\.nodeMajor/);
});

test("toolchain: each guide points at .nvmrc and drops the stale 22.12 floor", () => {
  for (const guide of guides) {
    const pointer = verify({ edit: { [guide]: (source) => source.replaceAll(".nvmrc", "the Node version") } });
    assertRejected(pointer, new RegExp(`${escape(guide)} must point contributors at \\.nvmrc`));
    const stale = verify({ edit: { [guide]: (source) => `${source}\nUse Node 22.12+.\n` } });
    const staleLine = sourceOf(guide).split("\n").length + 1;
    assertRejected(stale, new RegExp(`${escape(guide)}:${staleLine} still names the stale Node floor 22\\.12`));
  }
});
