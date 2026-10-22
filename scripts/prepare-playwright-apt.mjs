import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const archive = "https://archive.ubuntu.com/ubuntu";
const runnerArchiveToken = /(^|\s)(?:https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?|mirror\+file:\/etc\/apt\/apt-mirrors\.txt)(?=\s|$)/g;

// Only acquisition limits: no trust, signature, checksum, TLS, suite or package
// selection option is changed. This file lives on an ephemeral browser runner.
export const PLAYWRIGHT_APT_CONFIG = [
  'Acquire::Retries "2";',
  'Acquire::http::Timeout "30";',
  'Acquire::https::Timeout "30";',
  "",
].join("\n");

export function rewriteUbuntuArchive(source, format) {
  if (typeof source !== "string" || !["list", "sources"].includes(format)) {
    throw new Error("Unsupported Ubuntu source format");
  }
  let inUris = false;
  return source.split(/(?<=\n)/).map((raw) => {
    const ending = raw.match(/\r?\n$/)?.[0] ?? "";
    const line = ending ? raw.slice(0, -ending.length) : raw;
    if (format === "list") {
      // Match the URI position of an active deb/deb-src line, never comments,
      // option values, another host, a path suffix, credentials, or query text.
      // The exact runner mirrorlist selects Azure first; replace that URI,
      // without opening or changing any mirror file or unrelated source.
      return line.replace(/^(\s*deb(?:-src)?\s+(?:\[[^\]\r\n]*\]\s+)?)(?:https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?|mirror\+file:\/etc\/apt\/apt-mirrors\.txt)(?=\s|$)/,
        (_match, prefix) => `${prefix}${archive}`) + ending;
    }
    if (/^\s*#/.test(line)) return raw;
    const field = line.match(/^(URIs:[ \t]*)(.*)$/i);
    if (field) {
      inUris = true;
      return field[1] + field[2].replace(runnerArchiveToken, (_match, space) => space + archive) + ending;
    }
    if (/^[ \t]/.test(line) && inUris) {
      return line.replace(runnerArchiveToken, (_match, space) => space + archive) + ending;
    }
    inUris = false;
    return raw;
  }).join("");
}

function readRegular(path) {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Expected a regular APT configuration file");
  return readFileSync(path, "utf8");
}

/** Local file preparation only; no apt, network, cache or browser command. */
export function preparePlaywrightApt({ aptDirectory = "/etc/apt" } = {}) {
  const targets = [["sources.list", "list"], ["sources.list.d/ubuntu.sources", "sources"]];
  let checkedFiles = 0;
  let changedFiles = 0;
  for (const [relative, format] of targets) {
    const path = join(aptDirectory, relative);
    const before = readRegular(path);
    if (before === undefined) continue;
    checkedFiles++;
    const after = rewriteUbuntuArchive(before, format);
    if (after !== before) {
      writeFileSync(path, after);
      changedFiles++;
    }
  }
  if (checkedFiles === 0) throw new Error("No supported Ubuntu APT source file was found");
  const configDirectory = join(aptDirectory, "apt.conf.d");
  mkdirSync(configDirectory, { recursive: true });
  const configPath = join(configDirectory, "99musubi-playwright-network");
  const previous = readRegular(configPath);
  const configChanged = previous !== PLAYWRIGHT_APT_CONFIG;
  if (configChanged) writeFileSync(configPath, PLAYWRIGHT_APT_CONFIG, { mode: 0o644 });
  return { checkedFiles, changedFiles, configChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2 || process.getuid?.() !== 0) {
      throw new Error("Run without arguments as root on the disposable CI runner");
    }
    const result = preparePlaywrightApt();
    console.log(`Playwright APT prepared: ${result.checkedFiles} source files checked, ${result.changedFiles} changed; acquisition retries2/timeouts30s`);
  } catch {
    console.error("Playwright APT preparation failed; package validation must not be bypassed");
    process.exitCode = 1;
  }
}
