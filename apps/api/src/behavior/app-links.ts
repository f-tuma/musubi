import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseAndroidAppLinksSha256 } from "../../../../packages/config/src/android-app-links";
import { createAndroidAssetLinksHandler } from "../handlers/android_assetlinks";

const metadata = { id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().min(1) };
export const AppLinksSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suite: z.literal("app-links"),
  scenarios: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ ...metadata, kind: z.literal("invalid"), fingerprints: z.string(), expectedError: z.string().min(1) }),
    z.strictObject({ ...metadata, kind: z.literal("response"), fingerprints: z.string().optional(), expected: z.strictObject({
      status: z.union([z.literal(200), z.literal(404)]),
      headers: z.record(z.string(), z.string()),
      body: z.array(z.strictObject({
        relation: z.array(z.string()).min(1),
        target: z.strictObject({ namespace: z.string(), package_name: z.string(), sha256_cert_fingerprints: z.array(z.string()).min(1) }),
      })).optional(),
    }) }),
  ])).min(1),
}).superRefine((suite, ctx) => {
  if (new Set(suite.scenarios.map(scenario => scenario.id)).size !== suite.scenarios.length)
    ctx.addIssue({ code: "custom", message: "Scenario IDs must be unique" });
  for (const scenario of suite.scenarios) if (scenario.kind === "response" &&
    (scenario.expected.status === 200) !== (scenario.expected.body !== undefined))
    ctx.addIssue({ code: "custom", message: "Only successful associations have a JSON body" });
});

export const appLinksSuite = AppLinksSuiteSchema.parse(JSON.parse(readFileSync(new URL("./app-links.json", import.meta.url), "utf8")));
export type AppLinksScenario = (typeof appLinksSuite.scenarios)[number];

/** Only Express response/config ports are replaced; production parses and renders. */
export function runAppLinksScenario(scenario: AppLinksScenario) {
  if (scenario.kind === "invalid") {
    assert.throws(() => parseAndroidAppLinksSha256(scenario.fingerprints), { message: scenario.expectedError });
    return;
  }
  const certificates = parseAndroidAppLinksSha256(scenario.fingerprints);
  let status = 0, completed = 0;
  let body: unknown;
  const headers: Record<string, string> = {};
  const response = {
    set(values: Record<string, string>) {
      for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value;
      return this;
    },
    status(value: number) { status = value; return this; },
    type(value: string) { headers["content-type"] = value; return this; },
    json(value: unknown) { body = value; completed++; return this; },
    sendStatus(value: number) { status = value; completed++; return this; },
  };
  createAndroidAssetLinksHandler(certificates)({} as never, response as never, () => assert.fail("Unexpected middleware fallthrough"));
  assert.equal(completed, 1);
  assert.equal(status, scenario.expected.status);
  assert.deepEqual(body, scenario.expected.body);
  assert.deepEqual(headers, scenario.expected.headers);
}

export function runAppLinksSuite(filter?: string) {
  const selected = appLinksSuite.scenarios.filter(scenario => !filter || scenario.id === filter);
  if (!selected.length) throw new Error("unknown-scenario");
  const start = performance.now();
  const results = selected.map(scenario => {
    const started = performance.now();
    try {
      runAppLinksScenario(scenario);
      return { id: scenario.id, title: scenario.title, status: "passed" as const, durationMs: performance.now() - started };
    } catch {
      return { id: scenario.id, title: scenario.title, status: "failed" as const, durationMs: performance.now() - started };
    }
  });
  return { schemaVersion: 1, suite: "app-links", durationMs: performance.now() - start, results };
}
