import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import express from "express";
import { parseAndroidAppLinksSha256 } from "../../../../packages/config/src/android-app-links";
import { AppLinksSuiteSchema, appLinksSuite, runAppLinksScenario } from "../behavior/app-links";
import { createAndroidAssetLinksHandler } from "./android_assetlinks";

async function main() {
  for (const scenario of appLinksSuite.scenarios) runAppLinksScenario(scenario);
  assert.throws(() => AppLinksSuiteSchema.parse({ ...appLinksSuite, unknown: true }));
  assert.throws(() => AppLinksSuiteSchema.parse({ ...appLinksSuite, scenarios: [appLinksSuite.scenarios[0], appLinksSuite.scenarios[0]] }));
  assert.throws(() => AppLinksSuiteSchema.parse({ ...appLinksSuite, scenarios: [{ ...appLinksSuite.scenarios[0], kind: "eval" }] }));

  const configURL = new URL("../../../../packages/config/src/index.ts", import.meta.url).href;
  const invalid = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    try { await import(${JSON.stringify(configURL)}); process.stdout.write("incorrectly-booted"); }
    catch (error) { process.stderr.write(error instanceof Error ? error.message : "Configuration rejected"); process.exitCode = 1; }
  `], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 4096,
    env: { ENVIRONMENT: "test", DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused", BETTER_AUTH_URL: "http://localhost:7531", ANDROID_APP_LINKS_SHA256: "invalid-private-config" },
  });
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "Invalid ANDROID_APP_LINKS_SHA256. Expected comma-separated SHA-256 certificate fingerprints.");

  for (const scenario of appLinksSuite.scenarios.filter(item => item.id === "unconfigured-is-not-associated" || item.id === "configured-app-identity")) {
    assert.equal(scenario.kind, "response");
    if (scenario.kind !== "response") throw new Error("Wrong HTTP fixture kind");
    const app = express();
    app.get("/.well-known/assetlinks.json", createAndroidAssetLinksHandler(parseAndroidAppLinksSha256(scenario.fingerprints)));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert(address && typeof address !== "string");
      for (const suffix of ["", "?fresh=1"]) {
        const reply: Response = await fetch(`http://127.0.0.1:${address.port}/.well-known/assetlinks.json${suffix}`, { redirect: "manual" });
        assert.equal(reply.status, scenario.expected.status);
        assert.equal(reply.headers.get("location"), null);
        for (const [name, value] of Object.entries(scenario.expected.headers))
          assert.equal(reply.headers.get(name)?.split(";")[0], value);
        if (scenario.expected.body) assert.deepEqual(await reply.json(), scenario.expected.body);
        else await reply.text();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
  console.log("Android app links JSON, startup and real HTTP tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
