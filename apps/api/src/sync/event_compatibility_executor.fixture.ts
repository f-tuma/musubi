import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

type Phase = "before-native-send" | "raw-native-response" | "before-ack" | "ack-committed" | "recover";
type FetchReply = { kind: "fetch-headers" | "fetch-chunk" | "fetch-end" | "fetch-error"; id: number; status?: number; headers?: [string, string][]; body?: string; url?: string; error?: { name: string; message: string } };

/** A separate actual production executor process. Native fetch crosses IPC to
 * the original still-running assertion-bearing fixture, which keeps its real
 * loopback provider state alive when this process is SIGKILLed. No provider or
 * delivery logic is reimplemented here. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test"); assert.equal(process.env.MUSUBI_EVENT_COMPATIBILITY_QA, "1"); assert(process.send);
  const [label, id, provider, requested] = process.argv.slice(2), phase = requested as Phase;
  assert(label === "old" || label === "new"); assert(id); assert(["google", "microsoft", "caldav"].includes(provider!));
  assert(["before-native-send", "raw-native-response", "before-ack", "ack-committed", "recover"].includes(phase));
  const require = createRequire(import.meta.url), crypto = require("node:crypto") as typeof import("node:crypto");
  const seed = process.env.MUSUBI_EVENT_COMPATIBILITY_UUID_SEED; assert(seed); let sequence = 0;
  const originalUuid = crypto.randomUUID, webcrypto = globalThis.crypto, originalWebUuid = webcrypto.randomUUID;
  crypto.randomUUID = () => { const raw = createHash("sha256").update(`${seed}:${sequence++}`).digest("hex").slice(0, 32);
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}`; };
  webcrypto.randomUUID = crypto.randomUUID; syncBuiltinESMExports();
  const stop = async (at: Phase) => {
    if (at !== phase) return;
    process.send!({ kind: "checkpoint", phase: at });
    setInterval(() => {}, 1_000); await new Promise<never>(() => {});
  };
  const waiting = new Map<number, { resolve: (reply: FetchReply) => void; reject: (error: unknown) => void }>();
  const bodies = new Map<number, { stream?: ReadableStreamDefaultController<Uint8Array>; chunks: Uint8Array[]; ended?: boolean; error?: Error; cleanup?: () => void }>(); let nextFetch = 0;
  process.on("message", (message: FetchReply) => {
    const pending = waiting.get(message.id), body = bodies.get(message.id);
    if (message.kind === "fetch-headers") { waiting.delete(message.id); pending?.resolve(message); }
    else if (message.kind === "fetch-chunk" && body) { const bytes = new Uint8Array(Buffer.from(message.body!, "base64")); body.stream ? body.stream.enqueue(bytes) : body.chunks.push(bytes); }
    else if (message.kind === "fetch-end" && body) { body.ended = true; body.stream?.close(); body.cleanup?.(); }
    else if (message.kind === "fetch-error") { const error = new Error(message.error?.message ?? "Native response body failed"); error.name = message.error?.name ?? "Error";
      if (pending) { waiting.delete(message.id); pending.reject(error); } else if (body) { body.error = error; body.stream?.error(error); } body?.cleanup?.(); }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? (input instanceof Request ? input.method : "GET");
    assert(["https://www.googleapis.com", "https://graph.microsoft.com", "https://oauth2.googleapis.com", "https://login.microsoftonline.com"].includes(url.origin) || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "A process probe cannot contact an ambient provider");
    init?.signal?.throwIfAborted();
    // OAuth POST is authentication, never a provider mutation checkpoint.
    const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase()) &&
      url.hostname !== "oauth2.googleapis.com" && url.hostname !== "login.microsoftonline.com" && !url.pathname.includes("/token");
    if (mutation) await stop("before-native-send");
    const requestId = nextFetch++, signal = init?.signal;
    const bodyState: { stream?: ReadableStreamDefaultController<Uint8Array>; chunks: Uint8Array[]; ended?: boolean; error?: Error; cleanup?: () => void } = { chunks: [] }; bodies.set(requestId, bodyState);
    const reply = new Promise<FetchReply>((resolve, reject) => { waiting.set(requestId, { resolve, reject }); });
    const abort = () => { process.send?.({ kind: "fetch-abort", id: requestId }); waiting.get(requestId)?.reject(signal?.reason); waiting.delete(requestId); bodyState.stream?.error(signal?.reason); bodies.delete(requestId); };
    bodyState.cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    process.send!({ kind: "fetch", id: requestId, url: url.href, init: { method, headers: [...new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()],
      ...(init?.body == null ? {} : { body: String(init.body) }), ...(init?.redirect ? { redirect: init.redirect } : {}), ...(init?.cache ? { cache: init.cache } : {}) } });
    try {
      const response = await reply;
      if (response.error) { const error = new Error(response.error.message); error.name = response.error.name; throw error; }
      assert(response.status !== undefined);
      if (mutation && [200, 201, 202, 204].includes(response.status)) await stop("raw-native-response");
      const body = [204, 205, 304].includes(response.status) ? null : new ReadableStream<Uint8Array>({ start(controller) {
        bodyState.stream = controller; for (const chunk of bodyState.chunks) controller.enqueue(chunk); bodyState.chunks = [];
        if (bodyState.error) controller.error(bodyState.error); else if (bodyState.ended) controller.close();
      }, cancel() { process.send?.({ kind: "fetch-abort", id: requestId }); bodies.delete(requestId); } });
      const value = new Response(body, { status: response.status, headers: response.headers });
      Object.defineProperty(value, "url", { value: response.url ?? url.href }); return value;
    } catch (error) { signal?.removeEventListener("abort", abort); throw error; }
  };
  const pg = require("pg") as typeof import("pg"), connect = pg.Pool.prototype.connect, pools = new Set<import("pg").Pool>();
  pg.Pool.prototype.connect = function (this: import("pg").Pool, ...args: unknown[]): unknown { pools.add(this); return Reflect.apply(connect, this, args); } as typeof connect;
  const query = pg.Client.prototype.query, completed = new WeakSet<object>();
  pg.Client.prototype.query = function (this: import("pg").Client, ...args: unknown[]): unknown {
    const configuration = args[0] as string | { text?: string; values?: unknown[] }, text = typeof configuration === "string" ? configuration : configuration?.text;
    const values = Array.isArray(args[1]) ? args[1] : typeof configuration === "string" ? undefined : configuration?.values;
    const finalUpdate = typeof text === "string" && /^update "event_outbox"/i.test(text) && Array.isArray(values) && values.includes("completed");
    const invoke = () => Reflect.apply(query, this, args);
    if (finalUpdate) {
      completed.add(this);
      if (phase === "before-ack") return stop("before-ack").then(invoke);
    }
    const result = invoke();
    if (typeof text === "string" && text.trim().toLowerCase() === "commit" && completed.has(this)) {
      completed.delete(this); return Promise.resolve(result).then(async value => { await stop("ack-committed"); return value; });
    }
    return result;
  } as typeof query;
  try {
    const { config } = await import("@musubi/config");
    const captured = JSON.parse(process.env.MUSUBI_EVENT_COMPATIBILITY_CONFIG ?? "{}") as { api?: Record<string, unknown>; security?: Record<string, unknown> };
    if (captured.api) Object.assign(config.api, captured.api); if (captured.security) Object.assign(config.security, captured.security);
    const { googleAdapter } = await import("./adapters/google"), { microsoftAdapter } = await import("./adapters/microsoft"), { caldavAdapter } = await import("./adapters/caldav");
    const adapter = provider === "google" ? googleAdapter : provider === "microsoft" ? microsoftAdapter : caldavAdapter;
    const baseline = process.env.MUSUBI_EVENT_COMPATIBILITY_OLD_PATH; if (label === "old") assert(baseline);
    const module = require(label === "old" ? baseline! : "./event_delivery") as { deliverEventOutbox: (id: string, adapterFor: () => typeof adapter, options: { timeoutMs?: number }) => Promise<unknown> };
    const options = JSON.parse(process.env.MUSUBI_EVENT_COMPATIBILITY_DELIVERY_OPTIONS ?? "{}") as { timeoutMs?: number };
    const result = await module.deliverEventOutbox(id, () => adapter, options);
    process.send!({ kind: "result", result: result ?? null });
  } finally {
    pg.Client.prototype.query = query; pg.Pool.prototype.connect = connect; globalThis.fetch = originalFetch;
    await Promise.all([...pools].map(pool => pool.end())); crypto.randomUUID = originalUuid; webcrypto.randomUUID = originalWebUuid; syncBuiltinESMExports();
  }
}
void main().then(() => { process.disconnect?.(); process.exit(0); }, error => { console.error(error); process.disconnect?.(); process.exit(1); });
