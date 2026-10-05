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
// iOS configuration enforces its build-time presence. Validate any supplied value
// so a numeric placeholder cannot turn an update action into a dead link.
const appStoreUrlPattern = /^https:\/\/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id(\d+)(?:\?.*)?$/;
const checkAppStoreUrl = (value, source) => {
  if (value === undefined || value === "") return;
  const id = typeof value === "string" ? value.match(appStoreUrlPattern)?.[1] : undefined;
  if (!id || !/[1-9]/.test(id)) {
    fail(`${source} must name a direct apps.apple.com listing with a nonzero numeric app id`);
  }
};
const eas = readJson("apps/client/eas.json");
for (const [profile, config] of Object.entries(eas.build ?? {})) {
  checkAppStoreUrl(config?.env?.EXPO_PUBLIC_IOS_APP_STORE_URL,
    `apps/client/eas.json build.${profile}.env.EXPO_PUBLIC_IOS_APP_STORE_URL`);
}
checkAppStoreUrl(process.env.EXPO_PUBLIC_IOS_APP_STORE_URL, "EXPO_PUBLIC_IOS_APP_STORE_URL");

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

if (!process.exitCode) {
  console.log(
    `Release metadata verified: Musubi ${rootPackage.version}, ${rootPackage.packageManager}`,
  );
}
