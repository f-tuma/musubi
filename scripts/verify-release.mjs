import { existsSync, readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const fail = (message) => {
  console.error(`Release metadata error: ${message}`);
  process.exitCode = 1;
};
const readJson = (relativePath) => {
  try {
    return JSON.parse(readFileSync(new URL(relativePath, root), "utf8"));
  } catch {
    fail(`${relativePath} must contain valid JSON`);
    return {};
  }
};

const rootPackage = readJson("package.json");
const expectedVersion = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(rootPackage.version ?? "")) {
  fail(
    `root package.json version must be X.Y.Z, received ${rootPackage.version ?? "nothing"}`,
  );
}

if (expectedVersion && expectedVersion !== rootPackage.version) {
  fail(
    `requested ${expectedVersion}, but package.json declares ${rootPackage.version}`,
  );
}

if (!/^pnpm@\d+\.\d+\.\d+$/.test(rootPackage.packageManager ?? "")) {
  fail("root packageManager must pin an exact pnpm version");
}

for (const workspaceRoot of ["apps", "packages"]) {
  const directory = new URL(`${workspaceRoot}/`, root);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const relativePath = `${workspaceRoot}/${entry.name}/package.json`;
    if (!existsSync(new URL(relativePath, root))) continue;

    const manifest = readJson(relativePath);
    if (manifest.private !== true) {
      fail(`${relativePath} must be private`);
    }
    if ("version" in manifest) {
      fail(
        `${relativePath} must inherit the product version instead of declaring its own`,
      );
    }
    if ("packageManager" in manifest) {
      fail(
        `${relativePath} must inherit packageManager from the repository root`,
      );
    }
  }
}

const distributionFiles = [
  "apps/client/app.config.ts",
  "apps/client/components/UpdateRequiredModal.tsx",
  "apps/client/eas.json",
];
const placeholderPattern = /<APP_ID>|YOUR[_-]APP[_-]ID|REPLACE[_-]ME/i;

for (const relativePath of distributionFiles) {
  const source = readFileSync(new URL(relativePath, root), "utf8");
  if (placeholderPattern.test(source)) {
    fail(`${relativePath} contains a distribution placeholder`);
  }
}

// An unset listing is valid for API/web release metadata; native production
// iOS configuration requires an App Store or TestFlight update destination. Validate any supplied value
// so a numeric placeholder cannot turn an update action into a dead link.
const appStoreUrlPattern = /^https:\/\/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id(\d+)(?:\?.*)?$/;
const checkAppStoreUrl = (value, source) => {
  if (value === undefined || value === "") return;
  const id = typeof value === "string" ? value.match(appStoreUrlPattern)?.[1] : undefined;
  if (!id || !/[1-9]/.test(id)) {
    fail(`${source} must name a direct apps.apple.com listing with a nonzero numeric app id`);
  }
};
const checkTestFlightUrl = (value, source) => {
  if (value === undefined || value === "") return;
  if (typeof value !== "string" || !/^https:\/\/testflight\.apple\.com\/join\/[a-zA-Z0-9]+$/.test(value)) {
    fail(`${source} must name a direct HTTPS TestFlight join URL`);
  }
};
const eas = readJson("apps/client/eas.json");
for (const [profile, config] of Object.entries(eas.build ?? {})) {
  checkAppStoreUrl(config?.env?.EXPO_PUBLIC_IOS_APP_STORE_URL,
    `apps/client/eas.json build.${profile}.env.EXPO_PUBLIC_IOS_APP_STORE_URL`);
  checkTestFlightUrl(config?.env?.EXPO_PUBLIC_IOS_TESTFLIGHT_URL,
    `apps/client/eas.json build.${profile}.env.EXPO_PUBLIC_IOS_TESTFLIGHT_URL`);
}
checkAppStoreUrl(process.env.EXPO_PUBLIC_IOS_APP_STORE_URL, "EXPO_PUBLIC_IOS_APP_STORE_URL");
checkTestFlightUrl(process.env.EXPO_PUBLIC_IOS_TESTFLIGHT_URL, "EXPO_PUBLIC_IOS_TESTFLIGHT_URL");

const appConfig = readFileSync(
  new URL("apps/client/app.config.ts", root),
  "utf8",
);
if (!/version:\s*rootPackage\.version/.test(appConfig)) {
  fail(
    "apps/client/app.config.ts must read the product version from the root manifest",
  );
}

// The API ships as a `pnpm deploy` closure with no repository root above it, so
// it cannot import this manifest the way the client config does — it mirrors
// the string instead, and this is what keeps the mirror honest. Without it the
// server spent two releases telling every client it was 0.1.3.
const wire = readFileSync(
  new URL("packages/types/src/version.ts", root),
  "utf8",
);
const declared = (name) => wire.match(new RegExp(`${name} = "([^"]+)"`))?.[1];
const productVersion = declared("PRODUCT_VERSION");
const minClientVersion = declared("MIN_CLIENT_VERSION");

if (productVersion !== rootPackage.version) {
  fail(
    `packages/types/src/version.ts declares PRODUCT_VERSION ${productVersion ?? "nothing"}, ` +
      `but package.json says ${rootPackage.version}`,
  );
}

// Numeric, not lexical: "0.1.10" sorts before "0.1.9" as a string.
const rank = (version) =>
  (version ?? "").split(".").map((part) => Number(part) || 0);
const ahead = (left, right) => {
  const [a = 0, b = 0, c = 0] = rank(left);
  const [x = 0, y = 0, z = 0] = rank(right);
  return a > x || (a === x && (b > y || (b === y && c > z)));
};

if (!minClientVersion || !/^\d+\.\d+\.\d+$/.test(minClientVersion)) {
  fail(
    "packages/types/src/version.ts must declare MIN_CLIENT_VERSION as X.Y.Z",
  );
} else if (ahead(minClientVersion, rootPackage.version)) {
  fail(
    `MIN_CLIENT_VERSION ${minClientVersion} is ahead of the product ` +
      `${rootPackage.version}, which locks out every build including this one`,
  );
}

// The snapshot records when the contract was last re-baselined, so it trails
// the product and only moves on a deliberate break. Ahead of it means someone
// hand-edited the file.
const contract = readJson("packages/types/contracts/wire.json");
if (ahead(contract.version, rootPackage.version)) {
  fail(
    `packages/types/contracts/wire.json claims ${contract.version}, ` +
      `ahead of the product at ${rootPackage.version}`,
  );
}

const workspaceConfig = readFileSync(
  new URL("pnpm-workspace.yaml", root),
  "utf8",
);
if (!/^autoInstallPeers:\s+false\s*$/m.test(workspaceConfig)) {
  fail("pnpm-workspace.yaml must keep autoInstallPeers disabled");
}

for (const relativePath of [
  "apps/api/Dockerfile",
  "apps/web/Dockerfile",
  "packages/docs/Dockerfile",
]) {
  const source = readFileSync(new URL(relativePath, root), "utf8");
  const runtimeStage = source.slice(Math.max(0, source.lastIndexOf("\nFROM ")));
  if (/pnpm@\d/.test(source)) {
    fail(
      `${relativePath} must inherit pnpm from the root manifest through Corepack`,
    );
  }
  if (!source.includes("--frozen-lockfile")) {
    fail(`${relativePath} must install with --frozen-lockfile`);
  }
  if (!/FROM node:[^\s]+@sha256:[a-f0-9]{64}/.test(source)) {
    fail(`${relativePath} must pin the Node base image by digest`);
  }
  if (!/^USER node$/m.test(runtimeStage)) {
    fail(`${relativePath} final stage must run as the non-root node user`);
  }
  if (!/^HEALTHCHECK /m.test(runtimeStage)) {
    fail(`${relativePath} final stage must define a container health check`);
  }
}

// Node toolchain coherence: `.nvmrc` is the one declared Node version. Every
// other declaration has to agree with it or point at it, so a local
// recommendation cannot drift from what the images and CI actually run. This
// loop is separate from the HEALTHCHECK/USER/lockfile rules above on purpose:
// it covers every Dockerfile, including the sync reference image that the
// release rules do not build. Shapes it does not recognise fail closed; it
// never guesses what an `ARG`, `--platform`, heredoc or lowercase `as` means.
// Only `FROM` is classified; `COPY --from=` is assumed to name a stage.
const nvmrcSource = existsSync(new URL(".nvmrc", root))
  ? readFileSync(new URL(".nvmrc", root), "utf8")
  : undefined;
// Exactly one trailing newline (LF or CRLF) is tolerated; anything else is not
// the exact `X.Y.Z` the images pin.
const nodeVersion = nvmrcSource?.replace(/\r?\n$/, "");
if (nvmrcSource === undefined) {
  fail(".nvmrc is missing; it must declare the exact Node version X.Y.Z that the images run");
} else if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  fail(`.nvmrc must contain an exact Node version X.Y.Z, received ${JSON.stringify(nvmrcSource)}`);
} else {
  const nodeMajor = nodeVersion.split(".")[0];
  const pinnedStage = /^FROM node:(\d+\.\d+\.\d+)-alpine@sha256:[a-f0-9]{64} AS ([A-Za-z0-9_-]+)$/;
  const aliasStage = /^FROM ([A-Za-z0-9_-]+) AS ([A-Za-z0-9_-]+)$/;
  for (const relativePath of [
    "apps/api/Dockerfile",
    "apps/web/Dockerfile",
    "packages/docs/Dockerfile",
    "apps/sync-reference/Dockerfile",
  ]) {
    const stages = new Set();
    let pinned = 0;
    readFileSync(new URL(relativePath, root), "utf8").split("\n").forEach((line, index) => {
      const text = line.trim();
      if (!/^FROM\b/i.test(text)) return;
      const where = `${relativePath}:${index + 1}`;
      const image = text.match(pinnedStage);
      if (image) {
        if (image[1] !== nodeVersion) {
          fail(`${where} pins Node ${image[1]}, but .nvmrc declares ${nodeVersion}: ${text}`);
        }
        stages.add(image[2]);
        pinned += 1;
        return;
      }
      const alias = text.match(aliasStage);
      if (alias) {
        if (!stages.has(alias[1])) {
          fail(`${where} builds on undeclared stage "${alias[1]}"; an alias must name an earlier stage of the same file: ${text}`);
        }
        stages.add(alias[2]);
        return;
      }
      fail(
        `${where} must be "FROM node:${nodeVersion}-alpine@sha256:<digest> AS <stage>" (the .nvmrc version) ` +
          `or "FROM <earlier stage> AS <stage>", received: ${text}`,
      );
    });
    if (pinned === 0) {
      fail(`${relativePath} must declare at least one digest-pinned node:${nodeVersion}-alpine stage matching .nvmrc`);
    }
  }

  // CI floats on the patch level by design (`node-version: <major>`), so the
  // check is major equality plus one `node-version` per `setup-node` step in
  // each workflow; a step that resolves Node some other way is unknown shape.
  const workflowDirectory = new URL(".github/workflows/", root);
  const workflows = existsSync(workflowDirectory)
    ? readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name)).sort()
    : [];
  if (workflows.length === 0) fail(".github/workflows must contain the live workflow files");
  for (const name of workflows) {
    const relativePath = `.github/workflows/${name}`;
    let setupNodeSteps = 0;
    let nodeVersionLines = 0;
    readFileSync(new URL(name, workflowDirectory), "utf8").split("\n").forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      if (line.includes("actions/setup-node@")) setupNodeSteps += 1;
      if (!/^\s*node-version:/.test(line)) return;
      nodeVersionLines += 1;
      const where = `${relativePath}:${index + 1}`;
      const bareMajor = line.match(/^\s*node-version:\s*(['"]?)(\d+)\1\s*(#.*)?$/);
      if (!bareMajor) {
        const value = line.replace(/^\s*node-version:\s*/, "").trim();
        fail(`${where} node-version must be the bare major of .nvmrc (${nodeMajor}), received: ${value || "nothing"}`);
      } else if (bareMajor[2] !== nodeMajor) {
        fail(`${where} node-version ${bareMajor[2]} does not match .nvmrc major ${nodeMajor} (${nodeVersion})`);
      }
    });
    if (setupNodeSteps !== nodeVersionLines) {
      fail(
        `${relativePath} declares actions/setup-node ${setupNodeSteps} time(s) but node-version ${nodeVersionLines} time(s); ` +
          `every setup-node step must pin node-version to the .nvmrc major ${nodeMajor}`,
      );
    }
  }

  const alphaPins = readFileSync(new URL("scripts/sync-alpha-common.mjs", root), "utf8");
  const alphaMajor = alphaPins.match(/nodeMajor:\s*(\d+)/)?.[1];
  if (!alphaMajor) {
    fail(`scripts/sync-alpha-common.mjs must declare PINS.nodeMajor equal to the .nvmrc major ${nodeMajor}`);
  } else if (alphaMajor !== nodeMajor) {
    fail(`scripts/sync-alpha-common.mjs declares PINS.nodeMajor ${alphaMajor}, but .nvmrc declares ${nodeVersion} (major ${nodeMajor})`);
  }
}

// The guides point at `.nvmrc` instead of repeating a number; the literal
// check only keeps the pointer present and the stale floor out, it does not
// judge the sentence around it.
for (const relativePath of [
  "README.md",
  "packages/docs/src/content/docs/guides/running-locally.mdx",
  "packages/docs/src/content/docs/guides/troubleshooting.mdx",
]) {
  const guide = readFileSync(new URL(relativePath, root), "utf8");
  if (!guide.includes(".nvmrc")) {
    fail(`${relativePath} must point contributors at .nvmrc for the Node version`);
  }
  const stale = guide.split("\n").findIndex((line) => line.includes("22.12"));
  if (stale !== -1) {
    fail(`${relativePath}:${stale + 1} still names the stale Node floor 22.12; point at .nvmrc instead`);
  }
}

if (!process.exitCode) {
  console.log(
    `Release metadata verified: Musubi ${rootPackage.version}, ${rootPackage.packageManager}`,
  );
}
