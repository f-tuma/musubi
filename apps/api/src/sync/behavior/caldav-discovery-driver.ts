import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createCaldavDiscoveryMaterialCache, type CaldavMaterialBinding, type CaldavMaterialSession } from "../caldav_discovery_material";

const binding = z.object({ userID: z.string().min(1), accountID: z.string().min(1), credentialRevision: z.string().min(1), credentialFingerprint: z.string().min(1), policyFingerprint: z.string().min(1) }).strict().partial();
const step = z.discriminatedUnion("command", [
  z.object({ command: z.literal("begin"), session: z.string().min(1), binding: binding.optional(), refresh: z.boolean().optional(), expectHome: z.string().nullable() }).strict(),
  z.object({ command: z.literal("commit"), session: z.string().min(1), home: z.string().optional() }).strict(),
  z.object({ command: z.literal("invalidate"), session: z.string().min(1) }).strict(),
  z.object({ command: z.literal("advance"), ms: z.number().int().nonnegative() }).strict(),
]);
const scenarioSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().min(1), capacity: z.number().int().positive().optional(), ttlMs: z.number().positive().optional(), steps: z.array(step).min(1) }).strict();
const suiteSchema = z.object({ schemaVersion: z.literal(1), suite: z.literal("caldav-discovery"), scenarios: z.array(scenarioSchema).min(1) }).strict();
export type CaldavDiscoveryScenario = z.infer<typeof scenarioSchema>;
export class CaldavDiscoveryScenarioFailure extends Error {
  constructor(readonly code: "invalid-arguments" | "unknown-scenario" | "invalid-suite" | "suite-unavailable" | "assertion-failed", message: string) { super(message); }
}
export async function loadCaldavDiscoverySuite(input?: unknown) {
  const raw = input ?? JSON.parse(await readFile(new URL("./caldav-discovery.json", import.meta.url), "utf8"));
  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success || new Set(parsed.data.scenarios.map(item => item.id)).size !== parsed.data.scenarios.length)
    throw new CaldavDiscoveryScenarioFailure("invalid-suite", "Invalid DAV discovery scenario manifest.");
  return parsed.data;
}
const defaultBinding: CaldavMaterialBinding = { userID: "owner-a", accountID: "physical-row-a", credentialRevision: "2026-10-26T12:00:00.000001", credentialFingerprint: "private-fixture-credential-a", policyFingerprint: "policy-a" };
const defaultHome = "https://dav.example/home/";

/** Executes the production cache, replacing only its monotonic clock and its
 * host-owned fresh-binding/validated-material ports. This is not SQL/HTTP proof. */
export async function runCaldavDiscoveryScenario(input: CaldavDiscoveryScenario) {
  const scenario = scenarioSchema.parse(input);
  let now = 0, hits = 0, misses = 0;
  const cache = createCaldavDiscoveryMaterialCache({ now: () => now, capacity: scenario.capacity, ttlMs: scenario.ttlMs });
  const sessions = new Map<string, CaldavMaterialSession>();
  for (const item of scenario.steps) {
    if (item.command === "advance") { now += item.ms; continue; }
    if (item.command === "begin") {
      assert.ok(!sessions.has(item.session), "Session IDs are unique.");
      const session = cache.begin({ ...defaultBinding, ...item.binding }, { refresh: item.refresh });
      sessions.set(item.session, session);
      assert.equal(session.material?.homeUrl ?? null, item.expectHome);
      if (session.material) { hits++; assert.ok(Object.isFrozen(session.material)); }
      else misses++;
      continue;
    }
    const session = sessions.get(item.session);
    assert.ok(session, "A command must refer to an existing session.");
    if (item.command === "invalidate") { session.invalidate(); continue; }
    const material = { rootUrl: "https://dav.example/", principalUrl: "https://dav.example/principal/", homeUrl: item.home ?? defaultHome,
      // The production cache must not retain extra DAV account/client fields.
      credentials: { password: "SYNTHETIC_CREDENTIAL_MUST_NOT_BE_RETAINED" }, syncToken: "SYNTHETIC_CURSOR_MUST_NOT_BE_RETAINED" };
    session.commit(material);
    material.homeUrl = "https://dav.example/mutated/";
  }
  return { sessions: sessions.size, hits, misses, boundary: "production-material-cache-ports", sql: false, nativeHttp: false };
}
