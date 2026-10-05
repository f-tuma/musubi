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
  "apps/api/Dockerfile", "apps/web/Dockerfile", "packages/docs/Dockerfile",
];

function verify({ storedListing, environmentListing } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "musubi-release-metadata-"));
  try {
    for (const relative of requiredFiles) {
      const target = join(fixture, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(sourceRoot, relative), target);
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
    writeFileSync(easPath, JSON.stringify(eas));
    const env = { ...process.env };
    delete env.EXPO_PUBLIC_IOS_APP_STORE_URL;
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
