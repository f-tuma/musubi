import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Route } from "~/routes/app/sw[.]js";
import { subscribeToPush } from "~/push/subscribe";
import { subscribePush } from "~/api/resources";
import workerRoute from "~/server/worker-route";
import { fetchViteEnv } from "nitro/vite/runtime";
import data from "./web-edge.json";

vi.mock("~/api/resources", () => ({
  subscribePush: vi.fn().mockResolvedValue(undefined),
  unsubscribePush: vi.fn(),
}));
vi.mock("nitro/vite/runtime", () => ({ fetchViteEnv: vi.fn() }));

const ScenarioSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    title: z.string().min(1),
    kind: z.literal("nitro-dispatch"),
    request: z.strictObject({ url: z.string().url(), method: z.literal("GET"), headers: z.record(z.string(), z.string()) }),
    expected: z.strictObject({ environment: z.string() }),
  }),
  z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    title: z.string().min(1),
    kind: z.literal("worker-response"),
    expected: z.strictObject({
      status: z.number().int(),
      headers: z.record(z.string(), z.string()),
      bodyIncludes: z.array(z.string()).min(1),
    }),
  }),
  z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    title: z.string().min(1),
    kind: z.literal("registration"),
    expected: z.strictObject({
      scriptURL: z.string(),
      options: z.strictObject({ scope: z.string(), updateViaCache: z.string() }),
      subscribed: z.boolean(),
    }),
  }),
]);
const SuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suite: z.literal("web-edge"),
  scenarios: z.array(ScenarioSchema).min(1),
}).superRefine((suite, ctx) => {
  if (new Set(suite.scenarios.map(scenario => scenario.id)).size !== suite.scenarios.length)
    ctx.addIssue({ code: "custom", message: "Scenario IDs must be unique" });
});

const suite = SuiteSchema.parse(data);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function runScenario(scenario: z.infer<typeof ScenarioSchema>) {
  if (scenario.kind === "nitro-dispatch") {
    const request = new Request(scenario.request.url, { method: scenario.request.method, headers: scenario.request.headers });
    const reply = new Response("The existing SSR service owns this response", { headers: { "x-ssr-fixture": "preserved" } });
    vi.mocked(fetchViteEnv).mockResolvedValueOnce(reply);
    expect(await workerRoute({ req: request } as never)).toBe(reply);
    expect(fetchViteEnv).toHaveBeenCalledExactlyOnceWith(scenario.expected.environment, request);
    return;
  }
  if (scenario.kind === "worker-response") {
    const handlers = Route.options.server?.handlers;
    if (!handlers || typeof handlers === "function") throw new Error("Worker route has no handler record");
    const get = handlers.GET;
    if (typeof get !== "function") throw new Error("Worker route has no GET handler");
    const response = await get({} as never);
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Worker route did not return a Response");
    expect(response.status).toBe(scenario.expected.status);
    for (const [name, value] of Object.entries(scenario.expected.headers))
      expect(response.headers.get(name)).toBe(value);
    const body = await response.text();
    for (const fragment of scenario.expected.bodyIncludes) expect(body).toContain(fragment);
    return;
  }

  const json = { endpoint: "https://push.example.test/fixture", keys: { auth: "fixture-auth", p256dh: "fixture-p256dh" } };
  const subscription = { toJSON: () => json };
  const manager = {
    getSubscription: vi.fn().mockResolvedValue(subscription),
    subscribe: vi.fn().mockRejectedValue(new Error("An existing subscription must be reused")),
  };
  const worker = { pushManager: manager };
  const register = vi.fn().mockResolvedValue(worker);
  vi.stubGlobal("navigator", { serviceWorker: { register, ready: Promise.resolve(worker) } });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", class {});

  expect(await subscribeToPush("AQAB")).toBe(scenario.expected.subscribed);
  expect(register).toHaveBeenCalledExactlyOnceWith(scenario.expected.scriptURL, scenario.expected.options);
  expect(manager.getSubscription).toHaveBeenCalledTimes(1);
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(subscribePush).toHaveBeenCalledExactlyOnceWith(json);
}

const filter = process.env.MUSUBI_SCENARIO;
const selected = suite.scenarios.filter(scenario => !filter || scenario.id === filter);
if (!selected.length) throw new Error(`Unknown web-edge scenario: ${filter}`);
for (const scenario of selected) it(`${scenario.id}: ${scenario.title}`, () => runScenario(scenario));

it("rejects unknown fields and duplicate scenario IDs", () => {
  expect(() => SuiteSchema.parse({ ...data, unknown: true })).toThrow();
  expect(() => SuiteSchema.parse({ ...data, scenarios: [data.scenarios[0], data.scenarios[0]] })).toThrow();
});
