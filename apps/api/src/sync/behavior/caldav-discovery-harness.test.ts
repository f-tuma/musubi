import assert from "node:assert/strict";
import { test } from "node:test";
import { copyCaldavDiscoveryMaterial, createCaldavDiscoveryMaterialCache } from "../caldav_discovery_material";
import { loadCaldavDiscoverySuite, runCaldavDiscoveryScenario } from "./caldav-discovery-driver";
import { runCaldavDiscoveryCli } from "./caldav-discovery-cli";

await test("DAV material JSON harness rejects unknown commands, duplicate IDs and unbound sessions", async () => {
  const suite = await loadCaldavDiscoverySuite(), scenario = suite.scenarios[0]!;
  await assert.rejects(() => loadCaldavDiscoverySuite({ ...suite, scenarios: [scenario, scenario] }));
  await assert.rejects(() => loadCaldavDiscoverySuite({ ...suite, scenarios: [{ ...scenario, steps: [{ command: "replace-client", session: "a" }] }] }));
  await assert.rejects(() => runCaldavDiscoveryScenario({ ...scenario, steps: [{ command: "commit", session: "missing" }] }));
  const lines: string[] = [];
  assert.equal(await runCaldavDiscoveryCli(["--scenario", "missing", "--json"], line => lines.push(line)), 1);
  assert.equal(JSON.parse(lines.pop()!).error.code, "unknown-scenario");
  assert.equal(await runCaldavDiscoveryCli(["--json", "--json"], line => lines.push(line)), 1);
  assert.equal(JSON.parse(lines.pop()!).error.code, "invalid-arguments");
});

await test("DAV routing material excludes credentials, account data, clients and cursor state", () => {
  const input = { rootUrl: "https://dav.example/", principalUrl: "https://dav.example/principal/", homeUrl: "https://dav.example/home/", credentials: { password: "synthetic-private" }, calendars: [{ syncToken: "private-cursor" }], signal: new AbortController().signal };
  const copied = copyCaldavDiscoveryMaterial(input);
  assert.deepEqual(Object.keys(copied).sort(), ["homeUrl", "principalUrl", "rootUrl"]);
  input.homeUrl = "https://dav.example/changed/";
  assert.equal(copied.homeUrl, "https://dav.example/home/");
  for (const homeUrl of ["https://user:password@dav.example/home/", "file:///etc/passwd", "https://dav.example/home/#fragment"])
    assert.throws(() => copyCaldavDiscoveryMaterial({ ...input, homeUrl }));
  assert.throws(() => createCaldavDiscoveryMaterialCache({ capacity: 0 }));
  assert.throws(() => createCaldavDiscoveryMaterialCache({ ttlMs: Infinity }));
});
