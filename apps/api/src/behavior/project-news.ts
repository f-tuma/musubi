import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Request, Response as ApiResponse } from "express";
import { z } from "zod";
import {
  createProjectNewsHandler, createProjectNewsReader, ProjectNewsUnavailable,
  PROJECT_NEWS_URL, withProjectNewsReadMarker,
} from "../project-news";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const markerValues = z.object({
  lastSeenAnnouncement: z.string().optional(), lastSeenProjectNews: z.string().optional(),
  theme: z.string().max(32).optional(),
}).strict();
const settings = markerValues;
const exchange = z.object({
  kind: z.enum(["json", "text", "stream", "abort", "error"]),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  chunks: z.array(z.number().int().min(1).max(262144)).max(10).optional(),
  expectEtag: z.string().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "stream" && !value.chunks?.length)
    ctx.addIssue({ code: "custom", message: "A stream needs bounded chunks." });
  if (value.kind === "text" && typeof value.body !== "string")
    ctx.addIssue({ code: "custom", message: "Text receipts need text." });
});
const step = z.discriminatedUnion("command", [
  z.object({ command: z.literal("read"), count: z.number().int().min(1).max(10).optional() }).strict(),
  z.object({ command: z.literal("handle"), count: z.number().int().min(1).max(10).optional() }).strict(),
  z.object({ command: z.literal("bridge"), values: markerValues }).strict(),
  z.object({ command: z.literal("advance"), durationMs: z.number().int().min(0).max(172800000) }).strict(),
  z.object({ command: z.literal("settings"), values: settings }).strict(),
]);
const readResult = z.union([z.object({ ids: z.array(z.string()) }).strict(), z.object({ error: z.literal("unavailable") }).strict()]);
const summarySchema = z.object({
  fetches: z.number().int().min(0), aborted: z.number().int().min(0), cancellations: z.number().int().min(0),
  settingsReads: z.number().int().min(0),
  initializations: z.array(z.object({ userId: z.literal("news-reader"), marker: z.string() }).strict()),
  outputs: z.array(z.discriminatedUnion("command", [
    z.object({ command: z.literal("read"), results: z.array(readResult) }).strict(),
    z.object({ command: z.literal("handle"), responses: z.array(z.object({ status: z.number().int(), body: z.unknown() }).strict()) }).strict(),
    z.object({ command: z.literal("bridge"), values: markerValues }).strict(),
  ])),
}).strict();
const scenarioSchema = z.object({
  id, title: z.string().trim().min(1).max(160),
  settings: settings.default({}),
  initialize: z.array(z.object({ initialized: z.boolean(), settings }).strict()).max(10).default([]),
  exchanges: z.array(exchange).max(20),
  timeoutMs: z.number().int().min(1).max(30000).optional(),
  steps: z.array(step).min(1).max(40), expected: summarySchema,
}).strict();
const suiteSchema = z.object({
  schemaVersion: z.literal(1), suite: z.literal("project-news"), driver: z.literal("project-news"),
  scenarios: z.array(scenarioSchema).min(1).max(100),
}).strict();
export type ProjectNewsScenario = z.infer<typeof scenarioSchema>;
export type ProjectNewsSummary = z.infer<typeof summarySchema>;
export class ProjectNewsScenarioFailure extends Error {
  constructor(readonly code: "invalid-suite" | "suite-unavailable" | "invalid-arguments" | "unknown-scenario" | "unexpected-port" | "unconsumed-port" | "expectation-mismatch", message: string) {
    super(message); this.name = "ProjectNewsScenarioFailure";
  }
}
export async function loadProjectNewsSuite(input?: unknown) {
  let value = input;
  if (value === undefined) {
    try { value = JSON.parse(await readFile(new URL("./project-news.json", import.meta.url), "utf8")); }
    catch { throw new ProjectNewsScenarioFailure("suite-unavailable", "The project news suite is unavailable."); }
  }
  const result = suiteSchema.safeParse(value);
  if (!result.success || new Set(result.data.scenarios.map(item => item.id)).size !== result.data.scenarios.length)
    throw new ProjectNewsScenarioFailure("invalid-suite", "Invalid, empty or duplicate project news scenarios.");
  return result.data;
}

/** Invoke the shipped reader, handler and compatibility bridge. Only their
 * fetch, wall clock and settings persistence ports receive JSON receipts. */
export async function runProjectNewsScenario(input: unknown): Promise<ProjectNewsSummary> {
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) throw new ProjectNewsScenarioFailure("invalid-suite", "Invalid project news scenario.");
  const scenario = parsed.data;
  let now = 0, exchangeIndex = 0, initializeIndex = 0;
  let currentSettings = scenario.settings, portFailure: ProjectNewsScenarioFailure | undefined;
  const summary: ProjectNewsSummary = { fetches: 0, aborted: 0, cancellations: 0, settingsReads: 0, initializations: [], outputs: [] };
  const mismatch = () => {
    portFailure ??= new ProjectNewsScenarioFailure("unexpected-port", "A production request did not match its declared port receipt.");
    return portFailure;
  };
  const send: typeof globalThis.fetch = async (input, init) => {
    summary.fetches++;
    const receipt = scenario.exchanges[exchangeIndex++];
    if (!receipt) throw mismatch();
    const headers = new Headers(init?.headers);
    try {
      assert.equal(input, PROJECT_NEWS_URL);
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
      assert.equal(headers.get("accept"), "application/json"); assert.equal(headers.get("user-agent"), "Musubi-project-news");
      assert.equal(headers.get("authorization"), null); assert.equal(headers.get("cookie"), null);
      assert.ok(init?.signal instanceof AbortSignal);
      if (receipt.expectEtag !== undefined) assert.equal(headers.get("if-none-match"), receipt.expectEtag);
    } catch { throw mismatch(); }
    if (receipt.kind === "error") throw new Error("Synthetic fetch failure.");
    if (receipt.kind === "abort") {
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        // AbortSignal.timeout uses an unref'ed timer. This bounded fixture keeps
        // the CLI alive until the actual production signal fires.
        const keepAlive = setTimeout(() => reject(mismatch()), (scenario.timeoutMs ?? 5000) + 1000);
        const abort = () => { clearTimeout(keepAlive); summary.aborted++; reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    }
    const status = receipt.status ?? 200;
    if (status === 204 || status === 304) return new Response(null, { status, headers: receipt.headers });
    let chunks: Uint8Array[];
    if (receipt.kind === "stream") chunks = receipt.chunks!.map(size => new Uint8Array(size).fill(120));
    else chunks = [new TextEncoder().encode(receipt.kind === "text" ? receipt.body as string : JSON.stringify(receipt.body))];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]!); else controller.close(); },
      cancel() { summary.cancellations++; },
    }, { highWaterMark: 0 });
    return new Response(body, { status, headers: receipt.headers });
  };
  const reader = createProjectNewsReader({ fetch: send, now: () => now, ...(scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs }) });
  const getSettings = async () => { summary.settingsReads++; return { ...currentSettings }; };
  const handler = createProjectNewsHandler({ read: reader, getSettings, initialize: async (userId, marker) => {
    if (userId !== "news-reader") throw mismatch();
    summary.initializations.push({ userId, marker });
    const receipt = scenario.initialize[initializeIndex++];
    if (!receipt) throw mismatch();
    return structuredClone(receipt);
  } });
  for (const action of scenario.steps) {
    switch (action.command) {
      case "advance": now += action.durationMs; break;
      case "settings": currentSettings = action.values; break;
      case "bridge": summary.outputs.push({ command: "bridge", values: await withProjectNewsReadMarker(action.values, { getSettings, read: reader }) }); break;
      case "handle": {
        const responses = await Promise.all(Array.from({ length: action.count ?? 1 }, async () => {
          let status = 0, body: unknown;
          const response = { status(value: number) { status = value; return this; }, json(value: unknown) { body = value; return this; } };
          await handler({ user: { id: "news-reader" } } as Request, response as unknown as ApiResponse);
          return { status, body };
        }));
        summary.outputs.push({ command: "handle", responses }); break;
      }
      case "read": {
        const pending = Array.from({ length: action.count ?? 1 }, () => reader());
        const results = await Promise.all(pending.map(async work => {
          try { return { ids: (await work).map(item => item.id) }; }
          catch (error) {
            if (!(error instanceof ProjectNewsUnavailable)) throw error;
            return { error: "unavailable" as const };
          }
        }));
        summary.outputs.push({ command: "read", results }); break;
      }
    }
    if (portFailure) throw portFailure;
  }
  if (exchangeIndex !== scenario.exchanges.length || initializeIndex !== scenario.initialize.length)
    throw new ProjectNewsScenarioFailure("unconsumed-port", "The scenario left declared fetch or initializer receipts unused.");
  try { assert.deepStrictEqual(summary, scenario.expected); }
  catch { throw new ProjectNewsScenarioFailure("expectation-mismatch", "Project news evidence differs from its declared expected summary."); }
  return summary;
}
