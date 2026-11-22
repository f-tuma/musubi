#!/usr/bin/env node
// Fails if anything that belongs on the server made it into the browser bundle.
//
// The web client is built to need no configuration at all — it calls /api on its
// own origin — so nothing in `apps/web/src` reads an environment variable. That
// is a property worth keeping rather than rediscovering: the moment someone
// reaches for `import.meta.env.VITE_…` to "just pass the value through", Vite
// inlines it into a file the whole internet can read, and no test notices.
//
// How it knows: it builds the client with a canary in every server-only variable
// and then looks for those canaries. A grep for variable *names* cannot do this
// job — Vite replaces `import.meta.env.X` with the value, so a leak carries no
// name, while libraries that read env at runtime mention plenty of names and leak
// nothing (better-auth ships exactly such a shim). Values are the evidence.
//
// It also checks the shapes that are secrets wherever they came from, and — when
// run on a machine that has a real `.env` — the actual values in it.
//
// Usage:
//   node scripts/scan-client-bundle.mjs              build with canaries, then scan
//   node scripts/scan-client-bundle.mjs --no-build   scan whatever is already built
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundleDir = resolve(root, "apps/web/.output/public");
const build = !process.argv.includes("--no-build");

// Every variable the API reads that must never reach a browser. Adding one here
// is free; leaving one out means it is not covered.
const SERVER_ONLY = [
  "BETTER_AUTH_SECRET",
  "CALDAV_ENC_KEY",
  "DATABASE_URL",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "POSTGRES_PASSWORD",
  "SENTRY_AUTH_TOKEN",
  "SMTP_PASS",
  "SMTP_USER",
];

// Distinctive enough that a match cannot be a coincidence, and shaped like a real
// value so nothing rejects it as malformed on the way through.
const canary = (name) => `mUsUbICaNaRy-${name}-9c1f4e7a2b`;

// Files a browser can fetch and read. A font or an image cannot hide a string
// that matters without also being unreadable here.
const SCANNED = /\.(css|html|js|json|map|mjs|txt|xml)$/;

const SHAPES = [
  { label: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: "database URL with credentials",
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/,
  },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack bot token", pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

/** Secret-looking values from a local `.env`. CI has none; a developer does. */
function secretsFromEnv() {
  let raw;
  try {
    raw = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return [];
  }

  const secrets = [];

  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rest] = match;
    const value = rest.trim().replace(/^["']|["']$/g, "");

    if (!/(SECRET|PASS|PASSWORD|TOKEN|KEY|DATABASE_URL)/.test(name)) continue;
    if (/CLIENT_ID$/.test(name)) continue; // public by design
    // A short value is a word in a minified bundle; a placeholder is not a secret.
    if (value.length < 12) continue;
    if (/^(change|your|placeholder|example)/i.test(value)) continue;
    if (value.includes("${")) continue; // unexpanded reference, not a value

    secrets.push({ label: `value of ${name} from .env`, value });
  }

  return secrets;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (SCANNED.test(entry)) yield path;
  }
}

if (build) {
  const result = spawnSync("pnpm", ["--filter", "@musubi/web", "build"], {
    cwd: root,
    env: {
      ...process.env,
      ...Object.fromEntries(SERVER_ONLY.map((name) => [name, canary(name)])),
      // Vite only exposes prefixed variables, so a canary there proves the
      // channel is closed rather than merely unused today.
      VITE_CANARY: canary("VITE_CANARY"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  if (result.status !== 0) {
    console.error("Client build failed — nothing to scan.");
    process.exit(2);
  }
}

const needles = [
  ...[...SERVER_ONLY, "VITE_CANARY"].map((name) => ({
    label: `canary planted in ${name}`,
    value: canary(name),
  })),
  ...secretsFromEnv(),
];

let files;
try {
  files = [...walk(bundleDir)];
} catch {
  console.error(
    `No bundle at ${relative(root, bundleDir)} — drop --no-build, or build it first.`,
  );
  process.exit(2);
}

const findings = [];

for (const path of files) {
  const content = readFileSync(path, "utf8");
  const where = relative(root, path);
  const lineAt = (index) => content.slice(0, index).split("\n").length;

  for (const { label, value } of needles) {
    const index = content.indexOf(value);
    // The label names the variable; the value itself never gets printed, because
    // this output ends up in CI logs.
    if (index !== -1) findings.push(`${where}:${lineAt(index)} — ${label}`);
  }

  for (const { label, pattern } of SHAPES) {
    const found = pattern.exec(content);
    if (found) findings.push(`${where}:${lineAt(found.index)} — ${label}`);
  }
}

if (findings.length > 0) {
  console.error(`Secrets in the client bundle (${findings.length}):`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log(
  `Client bundle clean: ${files.length} file(s) in ${relative(root, bundleDir)}, ` +
    `${needles.length} value(s) and ${SHAPES.length} shape(s) checked.`,
);
