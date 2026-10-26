import assert from "node:assert/strict";
import { test } from "node:test";
import { googleRsvpDeliveryPolicy, GoogleRsvpDeliverySchema } from "@musubi/types";
import { loadGoogleRsvpSuite, runGoogleRsvpScenario } from "./google-rsvp-delivery-driver";
import { runGoogleRsvpCli } from "./google-rsvp-delivery-cli";

await test("Google policy accepts only explicit fresh own data; historical missing policy is read-only", () => {
  assert.deepEqual(googleRsvpDeliveryPolicy({}), { observeOnly: true });
  const fresh = { kind: "google-rsvp-at-most-once", version: 1 };
  assert.deepEqual(googleRsvpDeliveryPolicy({ googleDelivery: fresh }), { observeOnly: false, delivery: fresh });
  const started = { ...fresh, startedAt: "2026-10-26T12:00:00.000Z" };
  assert.equal(googleRsvpDeliveryPolicy({ googleDelivery: started }).observeOnly, true);
  assert.equal(GoogleRsvpDeliverySchema.safeParse({ ...started, acceptedAt: started.startedAt }).success, false);
  let getters = 0;
  const getter = { get startedAt() { getters++; return undefined; } };
  for (const invalid of [undefined, null, {}, [], { ...fresh, extra: true }, { ...fresh, version: 2 }, { ...fresh, startedAt: undefined }, { ...fresh, startedAt: "invalid" }, { ...fresh, get startedAt() { getters++; return undefined; } }, Object.create(fresh), getter]) assert.throws(() => googleRsvpDeliveryPolicy({ googleDelivery: invalid }));
  assert.throws(() => googleRsvpDeliveryPolicy({ get googleDelivery() { getters++; return fresh; } }));
  assert.throws(() => googleRsvpDeliveryPolicy(Object.create({ googleDelivery: fresh })));
  assert.equal(getters, 0);
});
await test("strict Google JSON harness rejects malformed, duplicate and executable fixtures", async () => {
  const suite = await loadGoogleRsvpSuite(), scenario = suite.scenarios[0]!;
  await assert.rejects(() => loadGoogleRsvpSuite({ ...suite, extra: true }));
  await assert.rejects(() => loadGoogleRsvpSuite({ ...suite, scenarios: [scenario, scenario] }));
  await assert.rejects(() => loadGoogleRsvpSuite({ ...suite, scenarios: [{ ...scenario, baseline: { ...scenario.baseline, executable: () => undefined } }] }));
  await assert.rejects(() => runGoogleRsvpScenario({ ...scenario, exchanges: [...scenario.exchanges, scenario.exchanges[0]!] }), /Not all HTTP/);
  const broken = structuredClone(scenario); broken.exchanges[0]!.url += "-wrong";
  await assert.rejects(() => runGoogleRsvpScenario(broken));
  const output: string[] = [];
  assert.equal(await runGoogleRsvpCli(["--scenario", "missing", "--json"], line => output.push(line)), 1);
  assert.equal(JSON.parse(output.pop()!).error.code, "unknown-scenario");
  assert.equal(await runGoogleRsvpCli(["--json", "--json"], line => output.push(line)), 1);
  assert.equal(JSON.parse(output.pop()!).error.code, "invalid-arguments");
});
