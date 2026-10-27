import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
const root = process.env.SYNC_CONFORMANCE_SOURCE_ROOT, target = process.env.SYNC_CONFORMANCE_MODULE, id = process.env.SYNC_CONFORMANCE_CASE_ID;
if (!root || !target || !id || !/^[a-z0-9][a-z0-9/_.:-]{0,199}$/.test(id)) throw new Error("Invalid conformance module identity");
const path = resolve(root, target), local = relative(root, path);
if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("Conformance module escapes its source root");
if (process.env.SYNC_CONFORMANCE_DB_JOURNAL) {
  const { installDatabaseJournal } = await import("./db-journal.mjs"); installDatabaseJournal(process.env.SYNC_CONFORMANCE_DB_JOURNAL);
}
const loaded = await import(pathToFileURL(path).href);
if (loaded.conformanceReady ?? loaded.default?.conformanceReady) await (loaded.conformanceReady ?? loaded.default.conformanceReady);
// Assert-only files become a required named module case. Native node:test cases
// remain registered and the reporter rejects their skip/TODO/failure outcomes.
test(`module-loaded:${id}`, () => {});
