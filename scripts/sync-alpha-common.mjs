import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const PINS = Object.freeze({ nodeMajor: 22, pnpm: "11.8.0", tsx: "4.23.12", typescript: "6.0.3" });
export const WORKSPACES = Object.freeze(["types", "sync-codec", "provider-google", "provider-microsoft", "provider-caldav", "sync-runtime"]);
export const OWNED_NAMES = new Set(["@musubi/sync-reference", ...WORKSPACES.map(name => `@musubi/${name}`)]);
export const DOCUMENT_PATHS = Object.freeze(["docs/protocol/sync-operation-v1.md", "docs/protocol/sync-profile-v1.md",
  "docs/research/nylas/10-source-inventory.md", "docs/research/nylas/references/source-manifest.json",
  "docs/research/nylas/references/nylas-sitemap-2026-10-12.xml", "docs/research/nylas/references/link-check-2026-10-12.json"]);
export const ARCHIVE_PATHS = Object.freeze(["LICENSE", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "patches",
  "apps/sync-reference", ...WORKSPACES.map(name => `packages/${name}`), "scripts/sync-alpha-common.mjs", "scripts/package-sync-alpha.mjs",
  "scripts/verify-sync-alpha.mjs", "scripts/sync-alpha.test.mjs", "scripts/sync-conformance.mjs", "docs/sync-alpha", ...DOCUMENT_PATHS]);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function inside(root, target) { const path = relative(root, target); return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`); }
export function parseArguments(args, names) {
  const values = Object.create(null);
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; requireThat(names.includes(key) && values[key] === undefined, "Unknown or repeated option.");
    const value = args[++index]; requireThat(typeof value === "string" && value && !value.startsWith("--"), "Option requires a value.");
    values[key] = value;
  }
  return values;
}
export async function readJson(path) {
  const bytes = await readFile(path); requireThat(bytes.length <= 8_000_000, "JSON exceeds bounded size.");
  return JSON.parse(bytes.toString("utf8"));
}
export async function requireArchivedPackageManager(source, run) {
  requireThat((await readJson(join(source, "package.json"))).packageManager === `pnpm@${PINS.pnpm}`, "Source package manager pin changed.");
  const result = await run("pnpm-version", "pnpm", ["--version"], { cwd: source });
  requireThat(result.stdout.toString("utf8").trim() === PINS.pnpm, "Exact pinned pnpm is required.");
}
const DEPENDENCY_TABLES = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
function permitsInstalledVersion(specifier, version) {
  const pattern = /^(\^|~)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const source = pattern.exec(specifier), installed = pattern.exec(version);
  if (!source || !installed || installed[1]) return false;
  const before = source.slice(2).map(Number), after = installed.slice(2).map(Number);
  if (![...before, ...after].every(Number.isSafeInteger)) return false;
  const atLeast = after[0] > before[0] || after[0] === before[0] && (after[1] > before[1] || after[1] === before[1] && after[2] >= before[2]);
  if (!source[1]) return isDeepStrictEqual(before, after);
  if (source[1] === "~") return after[0] === before[0] && after[1] === before[1] && atLeast;
  return atLeast && after[0] === before[0] && (before[0] > 0 || after[1] === before[1] && (before[1] > 0 || after[2] === before[2]));
}
async function resolveInstalledPackage(importer, name, boundary, metadataOnly) {
  requireThat(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name), "Invalid declared package identity.");
  const physicalBoundary = await realpath(boundary), physicalImporter = await realpath(importer);
  requireThat(inside(physicalBoundary, physicalImporter), "Importing package is outside its declared closure.");
  const require = createRequire(join(physicalImporter, "package.json"));
  if (metadataOnly) {
    for (const location of require.resolve.paths(name) ?? []) {
      const path = join(location, name, "package.json"); if (!inside(physicalBoundary, path)) continue;
      let actual; try { actual = await realpath(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      requireThat(inside(physicalBoundary, actual), "Development metadata resolves outside corresponding tooling closure.");
      const manifest = await readJson(actual); requireThat(manifest.name === name, "Installed dependency name differs from its edge.");
      return { directory: dirname(actual), manifest };
    }
    throw new Error("Development dependency metadata is missing from corresponding tooling importer.");
  }
  const entry = await realpath(require.resolve(name)); requireThat(inside(physicalBoundary, entry), "Production dependency resolves outside actual installed closure.");
  let directory = dirname(entry);
  while (inside(physicalBoundary, directory)) {
    let manifest; try { manifest = await readJson(join(directory, "package.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (manifest?.name !== undefined) {
      requireThat(manifest.name === name, "Installed dependency name differs from its edge.");
      return { directory, manifest };
    }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  throw new Error("Installed dependency manifest is missing.");
}
/** Plan only. Caller preserves raw bytes and validates every owner before applying metadata writes. */
export async function planDeployedManifest({ original, deployed, sourceRoot, closureRoot, closureKind, toolingRoot, toolingImporter, workspaceLocations }) {
  requireThat(["runtime", "tooling"].includes(closureKind), "Unknown installed closure kind.");
  const physicalSource = await realpath(sourceRoot), physicalClosure = await realpath(closureRoot), physicalDeployed = await realpath(deployed);
  requireThat(inside(physicalSource, await realpath(original)) && inside(physicalClosure, physicalDeployed), "Owned manifest is outside its declared source/closure.");
  const sourceLeaf = await lstat(join(original, "package.json")), rawLeaf = await lstat(join(physicalDeployed, "package.json"));
  requireThat(sourceLeaf.isFile() && !sourceLeaf.isSymbolicLink() && rawLeaf.isFile() && !rawLeaf.isSymbolicLink(), "Owned manifest leaves must be regular non-symlink files.");
  const sourceBytes = await readFile(join(original, "package.json")), rawBytes = await readFile(join(physicalDeployed, "package.json"));
  const source = JSON.parse(sourceBytes), raw = JSON.parse(rawBytes), normalized = structuredClone(raw), edges = [];
  requireThat(OWNED_NAMES.has(source.name) && raw.name === source.name, "Only matching owned manifests may normalize.");
  const nonDependencies = value => Object.fromEntries(Object.entries(value).filter(([key]) => !DEPENDENCY_TABLES.includes(key)));
  requireThat(isDeepStrictEqual(nonDependencies(source), nonDependencies(raw)), "Deployment changed non-dependency workspace manifest fields.");
  requireThat(inside(await realpath(toolingRoot), await realpath(toolingImporter)), "Development metadata importer is outside tooling closure.");
  const toolingLeaf = await lstat(join(toolingImporter, "package.json"));
  requireThat(toolingLeaf.isFile() && !toolingLeaf.isSymbolicLink() && (await readJson(join(toolingImporter, "package.json"))).name === source.name,
    "Development metadata importer is not the corresponding owned tooling package.");
  for (const table of DEPENDENCY_TABLES) {
    const before = source[table] ?? {}, after = raw[table] ?? {};
    requireThat(before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after), "Invalid dependency table.");
    requireThat(Object.keys(after).every(name => Object.hasOwn(before, name)), "Deployment added an undeclared dependency.");
    for (const [name, sourceSpecifier] of Object.entries(before)) {
      if (table === "devDependencies" && !Object.hasOwn(after, name)) { edges.push({ table, name, sourceSpecifier, rawSpecifier: null, normalizedSpecifier: null, rationale: "development-edge-omitted" }); continue; }
      requireThat(typeof sourceSpecifier === "string" && typeof after[name] === "string", "Deployment omitted or changed a declared dependency.");
      const development = table === "devDependencies", importer = development ? toolingImporter : deployed;
      const boundary = development ? toolingRoot : closureRoot;
      const target = await resolveInstalledPackage(importer, name, boundary, development);
      const resolution = { closure: development ? "tooling" : closureKind, importer: relative(await realpath(boundary), await realpath(importer)),
        target: relative(await realpath(boundary), target.directory), version: target.manifest.version ?? null };
      let specifier, rationale;
      if (sourceSpecifier === "workspace:*") {
        requireThat(!development || closureKind === "tooling", "Runtime development workspace edges require an explicit supported policy.");
        const expected = workspaceLocations.get(name);
        requireThat(OWNED_NAMES.has(name) && expected, "Unknown declared workspace edge.");
        const sourcePath = join(sourceRoot, name === "@musubi/sync-reference" ? "apps/sync-reference" : `packages/${name.slice("@musubi/".length)}`);
        requireThat(await realpath(expected.original) === await realpath(sourcePath) && inside(physicalSource, await realpath(sourcePath)), "Workspace edge is outside exact archived owned source.");
        requireThat((await readJson(join(sourcePath, "package.json"))).name === name, "Archived workspace identity differs from edge.");
        requireThat(after[name] === "workspace:*" || after[name] === `${name}@${pathToFileURL(sourcePath).href}`, "Raw workspace reference differs from exact archived path/name.");
        const installedTarget = await realpath(expected.deployed);
        requireThat(inside(physicalClosure, installedTarget) && installedTarget === target.directory, "Workspace edge resolves to a wrong installed target.");
        const path = relative(physicalDeployed, installedTarget).split(sep).join("/");
        requireThat(path && !isAbsolute(path), "Invalid installed relative workspace edge.");
        specifier = `file:${path.startsWith(".") ? path : `./${path}`}`;
        requireThat(await realpath(resolve(physicalDeployed, specifier.slice(5))) === installedTarget, "Normalized workspace edge is not relocatable within its closure.");
        rationale = "exact-archived-workspace-to-actual-installed-relative-target";
      } else {
        const version = target.manifest.version;
        requireThat(typeof version === "string" && permitsInstalledVersion(sourceSpecifier, version), "Installed version violates supported original dependency pin/range.");
        requireThat(after[name] === sourceSpecifier || after[name] === version, "Raw external dependency differs from source or exact installed version.");
        specifier = version; rationale = "importer-resolved-installed-version-within-original-pin";
      }
      normalized[table][name] = specifier;
      edges.push({ table, name, sourceSpecifier, rawSpecifier: after[name], normalizedSpecifier: specifier, resolution, rationale });
    }
  }
  requireThat(isDeepStrictEqual(nonDependencies(raw), nonDependencies(normalized)), "Normalization changed non-dependency fields.");
  const normalizedBytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
  return { path: join(physicalDeployed, "package.json"), rawBytes, normalizedBytes, record: { name: source.name, closure: closureKind,
    sourceManifest: relative(physicalSource, join(await realpath(original), "package.json")).split(sep).join("/"),
    manifest: `${closureKind}/${relative(physicalClosure, join(physicalDeployed, "package.json")).split(sep).join("/")}`,
    sourceSha256: sha256(sourceBytes), rawDeploySha256: sha256(rawBytes), normalizedSha256: sha256(normalizedBytes), rawMode: rawLeaf.mode & 0o777, edges } };
}
export const GENERATED_MANAGER_PATHS = Object.freeze(["pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]);
export async function planGeneratedManagerMetadata(root, closureKind) {
  requireThat(["runtime", "tooling"].includes(closureKind), "Unknown installed closure kind.");
  const physicalRoot = await realpath(root), result = [];
  for (const relativePath of GENERATED_MANAGER_PATHS) {
    const path = join(physicalRoot, relativePath), info = await lstat(path);
    requireThat(info.isFile() && !info.isSymbolicLink() && await realpath(path) === path, "Generated manager metadata must be an exact regular closure-owned file.");
    const rawBytes = await readFile(path), from = `${closureKind}/${relativePath}`, to = `provenance/generated-manager/${from}`;
    result.push({ path, rawBytes, record: { from, to, sha256: sha256(rawBytes), bytes: rawBytes.length, mode: info.mode & 0o777 } });
  }
  return result;
}
export async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
export function requiredCases(manifest, mode) {
  requireThat(manifest?.schemaVersion === 1 && Array.isArray(manifest.entries), "Unsupported conformance manifest.");
  const entries = manifest.entries.filter(entry => entry.mode === mode), ids = [];
  requireThat(entries.length > 0, "Required conformance mode is empty.");
  for (const entry of entries) {
    requireThat(entry.required === true && typeof entry.id === "string" && /^[a-z0-9][a-z0-9/_.:-]{0,199}$/.test(entry.id) && ["json", "module"].includes(entry.kind), "Invalid required conformance entry.");
    if (entry.kind === "module") ids.push(entry.id);
    else { requireThat(Array.isArray(entry.scenarios) && entry.scenarios.length > 0 && entry.scenarios.every(id => typeof id === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(id)), "Invalid conformance JSON inventory.");
      ids.push(...entry.scenarios.map(id => `${entry.id}/${id}`)); }
  }
  requireThat(ids.every(id => /^[a-z0-9][a-z0-9/_.:-]{0,199}$/.test(id)) && new Set(ids).size === ids.length && Array.isArray(manifest.modes?.[mode]?.requiredCaseIDs) &&
    JSON.stringify([...ids].sort()) === JSON.stringify([...manifest.modes[mode].requiredCaseIDs].sort()), "Conformance manifest inventories disagree.");
  return ids;
}
export async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Output must not already exist.");
}
/** Existing parents may be aliases; return the physical new leaf before writes. */
export async function canonicalNewPath(path, forbiddenRoots) {
  requireThat(typeof path === "string" && isAbsolute(path), "Output path must be absolute.");
  const requested = resolve(path), parent = await realpath(dirname(requested)), canonical = join(parent, basename(requested));
  for (const root of forbiddenRoots) requireThat(!inside(await realpath(root), canonical), "Output resolves inside an immutable source/candidate root.");
  // lstat rejects an existing dangling leaf symlink as well as files/directories.
  await absent(requested); if (canonical !== requested) await absent(canonical);
  return canonical;
}
export async function cleanEnvironment(root, extra = {}) {
  for (const name of ["home", "cache", "config", "data", "tmp"]) await mkdir(join(root, name), { recursive: true });
  return { PATH: process.env.PATH ?? "", HOME: join(root, "home"), XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), TMPDIR: join(root, "tmp"), LANG: "C.UTF-8", TZ: "UTC", CI: "true", ...extra };
}
export async function execute(id, command, args, { cwd, env, input, expectedCode = 0, timeoutMs = 120_000, maximumOutput = 8_000_000,
  terminationGraceMs = 1000, reapTimeoutMs = 2000 } = {}) {
  requireThat(/^[a-z][a-z0-9-]{0,79}$/.test(id), "Invalid command identifier.");
  requireThat(process.platform === "linux" && [timeoutMs, maximumOutput, terminationGraceMs, reapTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0), "Owned process execution requires bounded Linux settings.");
  const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [], stderr = []; let bytes = 0, failure, cleanupFailed = false, signalStopped;
  const interrupted = new Promise(resolveInterrupted => { signalStopped = resolveInterrupted; });
  const ownedPID = () => Number.isSafeInteger(child.pid) && child.pid > 1 ? child.pid : undefined;
  function groupAlive() {
    const pid = ownedPID(); if (!pid) return false;
    try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; cleanupFailed = true; return true; }
  }
  function signalGroup(signal) {
    const pid = ownedPID(); if (!pid) return;
    try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") cleanupFailed = true; }
  }
  function stop(reason) { if (!failure) { failure = reason; signalGroup("SIGTERM"); signalStopped({ interrupted: true }); } }
  const terminate = () => stop("interrupted"), deadline = setTimeout(() => stop("timeout"), timeoutMs);
  process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
  const collect = list => chunk => { if (failure) return; bytes += chunk.length; if (bytes > maximumOutput) stop("output-overflow"); else list.push(chunk); };
  child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
  const closed = new Promise(resolveClosed => {
    child.once("error", () => resolveClosed({ code: null, signal: null, error: true }));
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  child.stdin.on("error", () => {}); child.stdin.end(input);
  async function waitForGroup(milliseconds) {
    const end = performance.now() + milliseconds;
    while (groupAlive() && performance.now() < end) await new Promise(done => setTimeout(done, Math.min(25, Math.max(1, end - performance.now()))));
    return !groupAlive();
  }
  try {
    let result = await Promise.race([closed, interrupted]);
    if (!result.interrupted && (result.error || result.signal || result.code !== expectedCode)) failure ??= "child-failed";
    // A successful loader may briefly outlive its parent while shutting down.
    if (!failure && groupAlive() && !await waitForGroup(reapTimeoutMs)) failure = "descendants-survived";
    if (failure) {
      signalGroup("SIGTERM");
      if (!await waitForGroup(terminationGraceMs)) { signalGroup("SIGKILL"); if (!await waitForGroup(reapTimeoutMs)) cleanupFailed = true; }
      // Closing pipes cannot leave this waiter unbounded if a failed descendant retained one.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      let timer; const reaped = await Promise.race([closed.then(value => { result = value; return true; }), new Promise(done => { timer = setTimeout(() => done(false), reapTimeoutMs); })]);
      clearTimeout(timer); if (!reaped) cleanupFailed = true;
    }
    requireThat(!cleanupFailed, `${id}: owned process group cleanup incomplete.`);
    requireThat(!failure && !result.interrupted && result.code === expectedCode, `${id}: required process did not complete successfully.`);
    return { id, code: result.code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally { clearTimeout(deadline); process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate); }
}
export async function files(root) {
  const result = []; const physicalRoot = await realpath(root);
  async function visit(directory) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = join(directory, name), item = await lstat(path), entry = relative(root, path).split(sep).join("/");
      requireThat(result.length < 300_000, "Artifact file inventory exceeds bound.");
      requireThat(name !== ".env" && !name.startsWith(".env.") && ![".npmrc", ".git", ".netrc"].includes(name), "Artifact contains ambient configuration.");
      if (item.isSymbolicLink()) {
        requireThat(inside(physicalRoot, await realpath(path)), "Artifact symlink escapes candidate.");
        const target = await readlink(path); result.push({ path: entry, kind: "symlink", target, sha256: sha256(target) });
      } else if (item.isDirectory()) await visit(path);
      else { requireThat(item.isFile(), "Unsupported artifact filesystem entry.");
        result.push({ path: entry, kind: "file", size: item.size, mode: item.mode & 0o777, sha256: sha256(await readFile(path)) }); }
    }
  }
  await visit(root); return result;
}
export function isRuntimeTest(path) {
  return /(?:^|\/)(?:src\/)?behavior\//.test(path) || /(?:\.test\.[cm]?[jt]s|(?:process[_-]fixture|process-fixture)[^/]*\.child\.ts)$/.test(path);
}
/** This reference-host directory is test support, not a production CLI entry. */
export async function stripReferenceTestSupport(runtimeRoot) {
  const path = join(runtimeRoot, "conformance"); let item;
  try { item = await lstat(path); } catch (error) { if (error.code === "ENOENT") return { directory: "conformance", present: false, files: [] }; throw error; }
  requireThat(item.isDirectory() && !item.isSymbolicLink(), "Runtime reference test-support directory has an unexpected shape.");
  const excluded = await files(path); await rm(path, { recursive: true }); await absent(path);
  return { directory: "conformance", present: true, files: excluded };
}
const MIT_NOTICE_PARAGRAPHS = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
];
function hasCompleteEmbeddedMitNotice(text) {
  const heading = /^#{1,6}[ \t]+licen[cs]e[ \t]*\r?$/im.exec(text); if (!heading) return false;
  const rest = text.slice(heading.index + heading[0].length), next = /^#{1,6}[ \t]+/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const normalized = section.replace(/\s+/g, " ").toLowerCase();
  return /copyright\s*(?:\(c\)|©)?\s*\d{4}(?:-\d{4})?\s+\S+/i.test(section) &&
    MIT_NOTICE_PARAGRAPHS.every(paragraph => normalized.includes(paragraph.toLowerCase()));
}
const primaryLicense = source => !["notice-file", "third-party-notice"].includes(source.sourceKind);
export async function inventoryPackages(root, licenseOutput) {
  const paths = await files(root), packages = [];
  for (const entry of paths) {
    if (entry.kind !== "file" || !entry.path.endsWith("/package.json") && entry.path !== "package.json") continue;
    if (entry.path !== "runtime/package.json" && !entry.path.startsWith("runtime/node_modules/") && !entry.path.startsWith("tooling/node_modules/") &&
      !/^conformance\/(?:packages\/[^/]+|apps\/sync-reference)\/package.json$/.test(entry.path)) continue;
    const path = join(root, entry.path), value = await readJson(path);
    if (typeof value.name !== "string") continue;
    requireThat(value.name.length <= 256 && (OWNED_NAMES.has(value.name) || typeof value.version === "string" && value.version.length <= 128), "Invalid installed package identity.");
    requireThat(!value.name.startsWith("@musubi/") || OWNED_NAMES.has(value.name), "Forbidden Musubi host package in installed closure.");
    requireThat(value.name !== "dotenv" && value.name !== "dotenv-expand", "Dotenv is forbidden in standalone installed closure.");
    for (const name of Object.keys(value.dependencies ?? {})) requireThat(!name.startsWith("@musubi/") || OWNED_NAMES.has(name), "Forbidden declared Musubi dependency.");
    const directory = dirname(path);
    const candidates = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name) || name === "ThirdPartyNoticeText.txt");
    const licensePaths = [];
    for (const name of candidates) {
      const file = join(directory, name); if (!(await lstat(file)).isFile()) continue;
      const sourceKind = name === "ThirdPartyNoticeText.txt" ? "third-party-notice" : /^notice(?:[._-]|$)/i.test(name) ? "notice-file" : "package-license-file";
      licensePaths.push({ path: file, sourceKind, rationale: "included same-package license/notice file; no compatibility conclusion" });
    }
    packages.push({ name: value.name, version: value.version ?? null, private: value.private === true, path: entry.path,
      manifestSha256: entry.sha256, declaredLicense: value.license ?? null, licenseReview: "pending-owner-review", licensePaths, directory });
  }
  for (const value of packages) {
    if (!value.licensePaths.some(primaryLicense) && OWNED_NAMES.has(value.name)) value.licensePaths.push({ path: join(root, "LICENSE"), sourceKind: "repository-original-license", rationale: "original license for repository-owned code" });
    // esbuild's platform binary packages omit the text but ship the same pinned MIT project.
    if (!value.licensePaths.some(primaryLicense) && value.name.startsWith("@esbuild/") && value.declaredLicense === "MIT") {
      const parent = packages.find(item => item.name === "esbuild" && item.version === value.version && item.declaredLicense === "MIT" && item.licensePaths.some(primaryLicense));
      if (parent) value.licensePaths.push(...parent.licensePaths.filter(primaryLicense).map(source => ({ ...source, sourceKind: "matching-version-project-license", rationale: "esbuild platform binary uses matching installed esbuild version/license text" })));
    }
    if (!value.licensePaths.some(primaryLicense) && value.declaredLicense === "MIT") {
      for (const name of ["README.md", "readme.md", "README"]) {
        const path = join(value.directory, name); let bytes;
        try { if (!(await lstat(path)).isFile()) continue; bytes = await readFile(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (bytes.length <= 2_000_000 && hasCompleteEmbeddedMitNotice(bytes.toString("utf8"))) {
          value.licensePaths.push({ path, sourceKind: "embedded-license-readme", rationale: "same-package declared MIT with explicit heading, copyright and complete grant/condition/warranty/liability; entire README retained" }); break;
        }
      }
    }
    requireThat(value.licensePaths.some(primaryLicense), `Installed package has no collected license text: ${value.name}.`);
    value.licenses = [];
    for (const { path, sourceKind, rationale } of value.licensePaths) {
      const bytes = await readFile(path), digest = sha256(bytes); requireThat(bytes.length > 0 && bytes.length <= 2_000_000, "Invalid license text size.");
      const target = join(licenseOutput, `${digest}.txt`); await mkdir(licenseOutput, { recursive: true });
      await copyFile(path, target); value.licenses.push({ source: relative(root, path).split(sep).join("/"), sourceKind, rationale, sha256: digest, text: `licenses/${digest}.txt` });
    }
  }
  for (const value of packages) { delete value.licensePaths; delete value.directory; }
  requireThat(packages.some(value => value.name === "@musubi/sync-runtime"), "Installed runtime package is missing.");
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}
export function loadTool(root, specifier) { return createRequire(join(root, "package.json")).resolve(specifier); }
export async function auditOwnedImports(roots, toolingRoot, { runtimeRoot, mirrorsRoot }) {
  const ts = createRequire(join(toolingRoot, "package.json"))(loadTool(toolingRoot, "typescript"));
  let checked = 0;
  for (const root of roots) for (const entry of await files(root)) {
    if (entry.kind !== "file" || !/\.[cm]?[jt]s$/.test(entry.path)) continue;
    const filename = join(root, entry.path), text = await readFile(filename, "utf8"), source = ts.createSourceFile(entry.path, text, ts.ScriptTarget.Latest, true), imports = []; checked++;
    function visit(node) {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const name = specifier.text;
        const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
        requireThat(!name.startsWith("@musubi/") || OWNED_NAMES.has(packageName), "Portable source imports a Musubi host package.");
        requireThat(!/^(?:dotenv|dotenv-expand)(?:\/|$)/.test(name) && !/(?:^|\/)(?:apps\/api|packages\/(?:db|auth|config))(?:\/|$)/.test(name), "Portable source imports host configuration.");
        requireThat(!isAbsolute(name) && !name.startsWith("file:") && !name.startsWith("/tmp/"), "Portable source imports an external source path.");
        if (!isBuiltin(name)) imports.push({ name, owned: OWNED_NAMES.has(packageName) });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const { name, owned } of imports) {
      let resolved;
      if (name.startsWith(".")) resolved = ts.resolveModuleName(name, filename, { moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext, allowJs: true }, ts.sys).resolvedModule?.resolvedFileName;
      else resolved = createRequire(filename).resolve(name);
      requireThat(typeof resolved === "string", "Portable import cannot resolve from installed closure.");
      const target = await realpath(resolved);
      requireThat(inside(runtimeRoot, target) || (owned || name.startsWith(".")) && inside(mirrorsRoot, target), "Portable import resolves through tooling or external fallback.");
    }
  }
  return checked;
}
