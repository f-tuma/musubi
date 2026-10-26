import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
    const candidates = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));
    const licensePaths = [];
    for (const name of candidates) { const file = join(directory, name); if ((await lstat(file)).isFile()) licensePaths.push(file); }
    packages.push({ name: value.name, version: value.version ?? null, private: value.private === true, path: entry.path,
      manifestSha256: entry.sha256, declaredLicense: value.license ?? null, licenseReview: "pending-owner-review", licensePaths, directory });
  }
  for (const value of packages) {
    if (!value.licensePaths.length && OWNED_NAMES.has(value.name)) value.licensePaths.push(join(root, "LICENSE"));
    // esbuild's platform binary packages omit the text but ship the same pinned MIT project.
    if (!value.licensePaths.length && value.name.startsWith("@esbuild/") && value.declaredLicense === "MIT") {
      const parent = packages.find(item => item.name === "esbuild" && item.version === value.version && item.declaredLicense === "MIT" && item.licensePaths.length);
      if (parent) value.licensePaths.push(...parent.licensePaths);
    }
    requireThat(value.licensePaths.length > 0, `Installed package has no collected license text: ${value.name}.`);
    value.licenses = [];
    for (const path of value.licensePaths) {
      const bytes = await readFile(path), digest = sha256(bytes); requireThat(bytes.length > 0 && bytes.length <= 2_000_000, "Invalid license text size.");
      const target = join(licenseOutput, `${digest}.txt`); await mkdir(licenseOutput, { recursive: true });
      await copyFile(path, target); value.licenses.push({ source: relative(root, path).split(sep).join("/"), sha256: digest, text: `licenses/${digest}.txt` });
    }
    delete value.licensePaths; delete value.directory;
  }
  requireThat(packages.some(value => value.name === "@musubi/sync-runtime"), "Installed runtime package is missing.");
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}
export function loadTool(root, specifier) { return createRequire(join(root, "package.json")).resolve(specifier); }
export async function auditOwnedImports(roots, toolingRoot, { runtimeRoot, mirrorsRoot }) {
  const ts = createRequire(join(toolingRoot, "package.json"))(loadTool(toolingRoot, "typescript"));
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]); let checked = 0;
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
        if (!builtins.has(name)) imports.push({ name, owned: OWNED_NAMES.has(packageName) });
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
