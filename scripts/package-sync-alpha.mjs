import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARCHIVE_PATHS, DOCUMENT_PATHS, OWNED_NAMES, PINS, WORKSPACES, auditOwnedImports, canonicalNewPath, cleanEnvironment, execute, files, inside,
  inventoryPackages, isRuntimeTest, loadTool, parseArguments, readJson, requiredCases, requireThat, sha256, stripReferenceTestSupport, writeJson } from "./sync-alpha-common.mjs";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
async function packageRoot(runtime, name) {
  let directory = dirname(loadTool(runtime, name));
  for (;;) {
    try { if ((await readJson(join(directory, "package.json"))).name === name) return directory; } catch {}
    const parent = dirname(directory); requireThat(parent !== directory, "Installed workspace package root is missing."); directory = parent;
  }
}
async function stripRuntimeTests(root) {
  for (const entry of await files(root)) if (entry.kind === "file" && isRuntimeTest(entry.path)) await rm(join(root, entry.path));
}
async function verifySourceParity(original, deployed) {
  const expected = (await files(join(original, "src"))).filter(entry => !isRuntimeTest(entry.path));
  const actual = await files(join(deployed, "src"));
  requireThat(JSON.stringify(actual) === JSON.stringify(expected), "Deployed first-party source or SQL differs from exact archive.");
  return expected.length;
}
async function manifestParity(original, deployed) {
  const sourceBytes = await readFile(join(original, "package.json")), installedBytes = await readFile(join(deployed, "package.json"));
  const source = JSON.parse(sourceBytes), installed = JSON.parse(installedBytes), tables = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"], normalized = [];
  const main = value => Object.fromEntries(Object.entries(value).filter(([key]) => !tables.includes(key)));
  requireThat(JSON.stringify(main(source)) === JSON.stringify(main(installed)), "Deployment changed non-dependency workspace manifest fields.");
  for (const table of tables) {
    const before = source[table] ?? {}, after = installed[table] ?? {};
    requireThat(Object.keys(after).every(name => Object.hasOwn(before, name)), "Deployment added an undeclared workspace dependency.");
    for (const [name, specifier] of Object.entries(before)) {
      if (table === "devDependencies" && !Object.hasOwn(after, name)) { normalized.push({ table, name, change: "development-edge-omitted" }); continue; }
      requireThat(Object.hasOwn(after, name), "Deployment omitted a declared production dependency.");
      if (after[name] !== specifier) {
        requireThat(specifier === "workspace:*" && OWNED_NAMES.has(name) && typeof after[name] === "string", "Deployment changed a non-workspace dependency pin.");
        normalized.push({ table, name, from: specifier, to: after[name] });
      }
    }
  }
  return { name: source.name, sourceSha256: sha256(sourceBytes), installedSha256: sha256(installedBytes), normalized };
}
async function makeTestMirror(original, deployed, mirror, archiveOnlyDirectories = []) {
  await mkdir(dirname(mirror), { recursive: true });
  await cp(deployed, mirror, { recursive: true, filter: path => !relative(deployed, path).split("/").includes("node_modules") });
  for (const entry of await files(original)) if (entry.kind === "file" && isRuntimeTest(entry.path)) {
    await mkdir(dirname(join(mirror, entry.path)), { recursive: true }); await cp(join(original, entry.path), join(mirror, entry.path));
  }
  const support = [];
  for (const directory of archiveOnlyDirectories) {
    await cp(join(original, directory), join(mirror, directory), { recursive: true });
    const expected = await files(join(original, directory));
    requireThat(JSON.stringify(await files(join(mirror, directory))) === JSON.stringify(expected), "Archive-only test support changed during copy.");
    support.push({ directory, files: expected });
  }
  const mirroredProduction = (await files(join(mirror, "src"))).filter(entry => !isRuntimeTest(entry.path));
  requireThat(JSON.stringify(mirroredProduction) === JSON.stringify(await files(join(deployed, "src"))), "Conformance production mirror differs from actual runtime.");
  requireThat(sha256(await readFile(join(mirror, "package.json"))) === sha256(await readFile(join(deployed, "package.json"))), "Conformance manifest differs from actual runtime.");
  return support;
}
async function aliasProductionDependencies(runtime, conformance) {
  const targetRoot = join(conformance, "node_modules"); await mkdir(targetRoot);
  for (const name of (await readdir(join(runtime, "node_modules"))).sort()) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      await mkdir(join(targetRoot, name));
      for (const child of (await readdir(join(runtime, "node_modules", name))).sort()) {
        const alias = join(targetRoot, name, child); await symlink(relative(dirname(alias), join(runtime, "node_modules", name, child)), alias, "dir");
      }
    } else { const alias = join(targetRoot, name); await symlink(relative(dirname(alias), join(runtime, "node_modules", name)), alias, "dir"); }
  }
}
async function documentationLayout(bundle, source, sourceFiles, ref, allSourcePaths) {
  const aliases = [];
  for (const [path, target] of [["apps/sync-reference", "conformance/apps/sync-reference"],
    ...WORKSPACES.map(name => [`packages/${name}`, `conformance/packages/${name}`]), ["conformance/docs", "docs"], ["conformance/LICENSE", "LICENSE"]]) {
    const alias = join(bundle, path); await mkdir(dirname(alias), { recursive: true });
    await symlink(relative(dirname(alias), join(bundle, target)), alias, "dir"); aliases.push({ path, target });
  }
  const originals = sourceFiles.filter(entry => entry.kind === "file" && (entry.path.startsWith("docs/sync-alpha/") || DOCUMENT_PATHS.includes(entry.path) ||
    entry.path === "apps/sync-reference/README.md" || WORKSPACES.some(name => entry.path === `packages/${name}/README.md`)));
  const external = new Map();
  for (const entry of originals) {
    requireThat(sha256(await readFile(join(bundle, entry.path))) === entry.sha256, "Embedded review document differs from exact source.");
    if (!entry.path.endsWith(".md")) continue;
    const markdown = await readFile(join(source, entry.path), "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const link = match[1]; if (link.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const target = resolve(source, dirname(entry.path), decodeURIComponent(link.split(/[?#]/)[0]));
      requireThat(inside(source, target), "Review document link escapes source root.");
      const path = relative(source, target).split("\\").join("/");
      try { await stat(join(bundle, path)); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        requireThat(allSourcePaths.has(path), "Review document link has no exact source target.");
        external.set(path, { path, url: `https://github.com/f-tuma/musubi/blob/${ref}/${path.split("/").map(encodeURIComponent).join("/")}` });
      }
    }
  }
  const record = { schemaVersion: 1, kind: "sync-alpha-documentation-layout", sourceCommit: ref, aliases,
    originalDocuments: originals.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    generated: ["ARTIFACT-NAVIGATION.md", "provenance/documentation.json"], externalSourceReferences: [...external.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  const navigation = ["# Candidate review navigation", "", "Generated packaging navigation; original embedded documents are unchanged and hashed in provenance/documentation.json.", "",
    "- [Alpha candidate guide](docs/sync-alpha/README.md)", "- [Reference host guide](apps/sync-reference/README.md)",
    "- [Operation envelope](docs/protocol/sync-operation-v1.md)", "- [Sync profile](docs/protocol/sync-profile-v1.md)",
    "- [Research provenance inventory](docs/research/nylas/10-source-inventory.md)", "- [Original license](LICENSE)", "",
    "The repository-relative core links resolve through bounded aliases to the included byte-equal test mirrors. No alias points to host application source or the checkout.", "",
    "The research inventory's three snapshot/manifest records are embedded. Its research chapter context and other host-only context below are intentionally not embedded. Original relative links to that context are retained; use these exact-commit source references instead. They require repository access and publication of the selected commit; availability is not verified by packaging.", "",
    ...record.externalSourceReferences.map(item => `- [${item.path}](${item.url})`), ""];
  await writeFile(join(bundle, "ARTIFACT-NAVIGATION.md"), navigation.join("\n"), { flag: "wx" });
  await writeJson(join(bundle, "provenance/documentation.json"), record); return record;
}
export async function packageSyncAlpha(args) {
  const options = parseArguments(args, ["--ref", "--output"]), ref = options["--ref"];
  requireThat(typeof ref === "string" && /^[a-f0-9]{40}$/.test(ref), "Use an exact 40-character source commit.");
  requireThat(process.versions.node.split(".")[0] === String(PINS.nodeMajor) && process.platform === "linux", "Candidate build requires Node 22 on Linux.");
  const output = await canonicalNewPath(options["--output"], [REPOSITORY]); await mkdir(output);
  const work = await mkdtemp(join(tmpdir(), "sync-alpha-build-")), bundle = join(output, "candidate"), commands = [];
  const env = await cleanEnvironment(join(work, "environment"));
  const run = async (id, command, argv, settings = {}) => { const result = await execute(id, command, argv, { cwd: work, env, ...settings });
    commands.push({ id, executable: command, args: argv.map(value => value.replaceAll(work, "$WORK").replaceAll(REPOSITORY, "$REPOSITORY").replaceAll(output, "$OUTPUT")), code: result.code }); return result; };
  try {
    const git = async (id, argv) => (await run(id, "git", ["-C", REPOSITORY, ...argv])).stdout.toString("utf8").trim();
    requireThat(await git("source-type", ["cat-file", "-t", ref]) === "commit", "Source must identify a commit.");
    const tree = await git("source-tree", ["rev-parse", `${ref}^{tree}`]), timestamp = await git("source-time", ["show", "-s", "--format=%ct", ref]);
    requireThat(/^[a-f0-9]{40}$/.test(tree) && /^\d+$/.test(timestamp), "Invalid source provenance.");
    requireThat((await run("pnpm-version", "pnpm", ["--version"])).stdout.toString("utf8").trim() === PINS.pnpm, "Exact pinned pnpm is required.");
    requireThat((await run("tar-version", "tar", ["--version"])).stdout.toString("utf8").startsWith("tar (GNU tar)"), "Deterministic packaging requires GNU tar.");
    const sourceTar = join(work, "source.tar"), source = join(work, "source"); await mkdir(source);
    await git("source-archive", ["archive", "--format=tar", `--output=${sourceTar}`, ref, "--", ...ARCHIVE_PATHS]);
    await run("extract-source", "tar", ["--extract", "--file", sourceTar, "--directory", source, "--no-same-owner"]);
    const sourceFiles = await files(source);
    for (const name of ["package-sync-alpha.mjs", "verify-sync-alpha.mjs", "sync-alpha-common.mjs"]) {
      requireThat(sha256(await readFile(new URL(name, import.meta.url))) === sha256(await readFile(join(source, "scripts", name))), "Packaging tooling differs from exact archived source.");
    }
    requireThat((await readJson(join(source, "package.json"))).packageManager === `pnpm@${PINS.pnpm}`, "Source package manager pin changed.");
    const reference = await readJson(join(source, "apps/sync-reference/package.json"));
    requireThat(reference.private === true && reference.type === "module", "Reference candidate must remain private ESM.");
    for (const name of WORKSPACES) requireThat((await readJson(join(source, "packages", name, "package.json"))).private === true, "Workspace candidate must remain private.");
    await mkdir(bundle); const runtime = join(bundle, "runtime"), tooling = join(bundle, "tooling");
    const common = ["--config.inject-workspace-packages=true", "--filter", "@musubi/sync-reference", "deploy", "--frozen-lockfile", "--store-dir", join(work, "store")];
    await run("frozen-production-deploy", "pnpm", [...common, "--prod", runtime], { cwd: source, timeoutMs: 900_000, maximumOutput: 8_000_000 });
    await run("frozen-conformance-tool-deploy", "pnpm", [...common, tooling], { cwd: source, timeoutMs: 900_000, maximumOutput: 8_000_000 });
    for (const entry of sourceFiles) requireThat(sha256(entry.kind === "file" ? await readFile(join(source, entry.path)) : await readlink(join(source, entry.path))) === entry.sha256,
      "Frozen deploy changed archived source inputs.");
    requireThat((await readJson(join(runtime, "node_modules/tsx/package.json"))).version === PINS.tsx, "Installed TSX pin differs.");
    requireThat((await readJson(join(tooling, "node_modules/typescript/package.json"))).version === PINS.typescript, "Installed TypeScript pin differs.");
    // Preserve original production bytes, excluding test-only entry points from the runnable closure.
    await stripRuntimeTests(join(runtime, "src"));
    for (const name of WORKSPACES) await stripRuntimeTests(join(await packageRoot(runtime, `@musubi/${name}`), "src"));
    const excludedReferenceSupport = await stripReferenceTestSupport(runtime);
    for (const entry of excludedReferenceSupport.files) requireThat(sourceFiles.some(sourceFile => sourceFile.path === `apps/sync-reference/conformance/${entry.path}` && sourceFile.sha256 === entry.sha256),
      "Excluded deployed test support differs from exact archive.");
    let deployedSourceFiles = await verifySourceParity(join(source, "apps/sync-reference"), runtime);
    const manifests = [await manifestParity(join(source, "apps/sync-reference"), runtime)];
    for (const name of WORKSPACES) deployedSourceFiles += await verifySourceParity(join(source, "packages", name), await packageRoot(runtime, `@musubi/${name}`));
    for (const name of WORKSPACES) manifests.push(await manifestParity(join(source, "packages", name), await packageRoot(runtime, `@musubi/${name}`)));
    const conformance = join(bundle, "conformance"); await mkdir(conformance);
    await aliasProductionDependencies(runtime, conformance);
    await writeJson(join(conformance, "package.json"), { name: "musubi-sync-alpha-conformance", private: true, type: "module", packageManager: `pnpm@${PINS.pnpm}`,
      engines: { node: ">=22 <23" }, description: "Private installed conformance material; no public package contract." });
    const mirroredReferenceSupport = await makeTestMirror(join(source, "apps/sync-reference"), runtime, join(conformance, "apps/sync-reference"), ["conformance"]);
    for (const name of WORKSPACES) {
      await makeTestMirror(join(source, "packages", name), await packageRoot(runtime, `@musubi/${name}`), join(conformance, "packages", name));
      const alias = join(conformance, "node_modules/@musubi", name); await rm(alias, { recursive: true, force: true });
      await symlink(relative(dirname(alias), join(conformance, "packages", name)), alias, "dir");
    }
    await mkdir(join(conformance, "scripts")); await cp(join(source, "scripts/sync-conformance.mjs"), join(conformance, "scripts/sync-conformance.mjs"));
    for (const name of ["sync-alpha-common.mjs", "verify-sync-alpha.mjs", "sync-alpha.test.mjs"]) {
      await mkdir(join(bundle, "scripts"), { recursive: true }); await cp(join(source, "scripts", name), join(bundle, "scripts", name));
      await cp(join(source, "scripts", name), join(conformance, "scripts", name));
    }
    await cp(join(source, "LICENSE"), join(bundle, "LICENSE")); await cp(join(source, "docs/sync-alpha"), join(bundle, "docs/sync-alpha"), { recursive: true });
    for (const name of DOCUMENT_PATHS) {
      await mkdir(dirname(join(bundle, name)), { recursive: true }); await cp(join(source, name), join(bundle, name));
    }
    const provenance = join(bundle, "provenance"); await mkdir(provenance);
    for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"]) await cp(join(source, name), join(provenance, name));
    await cp(join(source, "patches"), join(provenance, "patches"), { recursive: true });
    await cp(sourceTar, join(provenance, "source.tar")); await writeJson(join(provenance, "source-files.json"), sourceFiles);
    await writeJson(join(provenance, "workspace-manifest-parity.json"), manifests);
    await writeJson(join(provenance, "test-support.json"), { schemaVersion: 1, runtimeExclusions: [excludedReferenceSupport],
      archiveOnlyMirrors: mirroredReferenceSupport, productionCodeExceptionAllowed: false });
    await cp(join(source, "docs/research/nylas/10-source-inventory.md"), join(provenance, "research-source-inventory.md"));
    const allSourcePaths = new Set((await git("documentation-source-paths", ["ls-tree", "-r", "--name-only", ref])).split("\n"));
    const documentation = await documentationLayout(bundle, source, sourceFiles, ref, allSourcePaths);
    const ownedRoots = [join(runtime, "src"), ...await Promise.all(WORKSPACES.map(async name => join(await packageRoot(runtime, `@musubi/${name}`), "src"))),
      join(conformance, "apps/sync-reference/src"), join(conformance, "apps/sync-reference/conformance"), join(conformance, "scripts"), ...WORKSPACES.map(name => join(conformance, "packages", name))];
    const importedFiles = await auditOwnedImports(ownedRoots, tooling, { runtimeRoot: runtime, mirrorsRoot: conformance });
    const corpusPath = join(conformance, "apps/sync-reference/conformance/manifest.v1.json"), corpus = await readJson(corpusPath);
    for (const mode of ["deterministic", "reference-db"]) {
      requiredCases(corpus, mode);
      for (const entry of corpus.entries.filter(entry => entry.mode === mode)) {
        requireThat(typeof entry.file === "string" && !isAbsolute(entry.file) && inside(conformance, resolve(conformance, entry.file)), "Conformance entry escapes installed source.");
        requireThat((await stat(join(conformance, entry.file))).isFile(), "Required installed conformance executable is missing.");
        if (entry.kind === "json") {
          requireThat(typeof entry.corpus === "string" && !isAbsolute(entry.corpus) && inside(conformance, resolve(conformance, entry.corpus)), "Conformance corpus escapes installed source.");
          const json = await readJson(join(conformance, entry.corpus));
          requireThat(json.schemaVersion === 1 && Array.isArray(json.scenarios) && JSON.stringify(json.scenarios.map(value => value.id)) === JSON.stringify(entry.scenarios), "Installed JSON inventory differs from conformance manifest.");
        }
      }
    }
    const packages = await inventoryPackages(bundle, join(provenance, "licenses"));
    await writeJson(join(provenance, "installed-packages.json"), packages);
    const payload = await files(bundle); await writeJson(join(provenance, "files.json"), payload);
    const payloadDigest = sha256(Buffer.from(JSON.stringify(payload)));
    const manifest = { schemaVersion: 1, kind: "musubi-sync-private-alpha", distribution: "private-local-review-candidate", publicReleaseApproved: false,
      source: { commit: ref, head: ref, tree, archiveSha256: sha256(await readFile(sourceTar)) }, payloadDigest, fileInventory: "provenance/files.json",
      packageInventory: "provenance/installed-packages.json", runtime: { nodeMajor: PINS.nodeMajor, node: process.version, platform: process.platform, architecture: process.arch,
        pnpm: PINS.pnpm, tsx: PINS.tsx, typescript: PINS.typescript, entry: "runtime/src/cli.ts", sourceEsmWithTsx: true, plainNodeEsmCertified: false },
      conformance: { root: "conformance", entry: "scripts/sync-conformance.mjs", manifest: "apps/sync-reference/conformance/manifest.v1.json",
        manifestSha256: sha256(await readFile(corpusPath)), contract: "sync-conformance-report/v1" },
      tooling: { root: "tooling", runtimeImportFallbackAllowed: false, compiler: "node_modules/typescript/bin/tsc", typeRoots: "node_modules/@types" },
      documentation: { entry: "ARTIFACT-NAVIGATION.md", record: "provenance/documentation.json", embeddedOriginals: documentation.originalDocuments.length,
        unembeddedSourceReferences: documentation.externalSourceReferences.length },
      checks: { ownedImportFiles: importedFiles, deployedSourceFiles, frozenDeploys: 2, runtimeReferenceTestSupportExcluded: true, ambientMusubiEnvironment: false, externalSymlinks: false },
      buildEnvironment: { kind: "host-node22-linux", nodeBinarySha256: sha256(await readFile(process.execPath)), baseImage: null },
      license: { original: "LICENSE", newLicenseChosen: false }, liveProvider: "not-run", deployed: "not-established" };
    await writeJson(join(bundle, "candidate.json"), manifest);
    const archive = join(output, "candidate.tar.gz");
    await run("candidate-archive", "tar", ["--sort=name", `--mtime=@${timestamp}`, "--owner=0", "--group=0", "--numeric-owner", "--create", "--gzip", "--file", archive, "--directory", output, "candidate"], { timeoutMs: 120_000 });
    const receipt = { schemaVersion: 1, kind: "sync-alpha-package-receipt", status: "built-not-verified", source: manifest.source, payloadDigest,
      archive: { name: "candidate.tar.gz", bytes: (await stat(archive)).size, sha256: sha256(await readFile(archive)) }, candidateManifestSha256: sha256(await readFile(join(bundle, "candidate.json"))),
      tools: { node: process.version, pnpm: PINS.pnpm, tsx: PINS.tsx, typescript: PINS.typescript }, commands, verification: "not-run", publicPublication: "not-performed", deployment: "not-performed" };
    await writeJson(join(output, "package-receipt.json"), receipt); return receipt;
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) packageSyncAlpha(process.argv.slice(2)).then(
  receipt => process.stdout.write(`${JSON.stringify(receipt)}\n`), () => { process.stderr.write('{"schemaVersion":1,"kind":"sync-alpha-package-error","status":"failed"}\n'); process.exitCode = 1; });
