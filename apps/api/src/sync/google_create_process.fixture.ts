import assert from "node:assert/strict";
import { googleAdapter } from "./adapters/google";
import { deliverEventOutbox } from "./event_delivery";
import type { CalendarAdapter } from "./adapter";

/** Owned integration child, never imported by the API bootstrap. It drives the
 * real registered writer and can stop at a transport boundary for SIGKILL QA. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  let bytes = ""; for await (const chunk of process.stdin) bytes += chunk;
  const input: { operationId: string; fixtureOrigin: string; pause?: "beforePost" | "afterPost" } = JSON.parse(bytes);
  assert.match(input.operationId, /^[0-9a-f-]{36}$/);
  const origin = new URL(input.fixtureOrigin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.pathname, "/");
  assert.equal(origin.username, ""); assert.equal(origin.password, ""); assert.equal(origin.search, ""); assert.equal(origin.hash, "");
  assert(input.pause === undefined || input.pause === "beforePost" || input.pause === "afterPost");
  const original = globalThis.fetch;
  globalThis.fetch = (supplied, init) => {
    const url = new URL(typeof supplied === "string" ? supplied : supplied instanceof URL ? supplied.href : supplied.url);
    assert.equal(url.origin, "https://www.googleapis.com");
    return original(`${origin.origin}${url.pathname}${url.search}`, init).then(response => {
      Object.defineProperty(response, "url", { value: url.href }); return response;
    });
  };
  const checkpoint = async (phase: "beforePost" | "afterPost") => {
    if (input.pause !== phase) return;
    process.stdout.write(JSON.stringify({ kind: "checkpoint", phase }) + "\n");
    await new Promise<void>(() => {});
  };
  const adapter: CalendarAdapter = {
    ...googleAdapter,
    googlePersonalCreateV1(...args) {
      const bridge = googleAdapter.googlePersonalCreateV1!(...args);
      return { ...bridge, ports: { ...bridge.ports, http: { async fetch(url, init) {
        if (init.method === "POST") await checkpoint("beforePost");
        const response = await bridge.ports.http.fetch(url, init);
        if (init.method === "POST") await checkpoint("afterPost");
        return response;
      } } } };
    },
  };
  const result = await deliverEventOutbox(input.operationId, () => adapter);
  process.stdout.write(JSON.stringify({ kind: "result", status: result?.status, errorCode: result?.errorCode }) + "\n");
}

main().then(() => process.exit(0), () => { process.stderr.write("CREATE process fixture failed.\n"); process.exit(1); });
