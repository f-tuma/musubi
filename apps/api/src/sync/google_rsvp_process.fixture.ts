import assert from "node:assert/strict";
import { Client } from "pg";
import { config } from "@musubi/config";
import { googleAdapter } from "./adapters/google";
import { deliverEventOutbox } from "./event_delivery";

/** Owned loopback-only process QA. No API bootstrap imports this fixture. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  config.api.providerRsvpEditsEnabled = true;
  let text = ""; for await (const part of process.stdin) text += part;
  const input: { operationId: string; fixtureOrigin: string; pause?: string } = JSON.parse(text);
  assert.match(input.operationId, /^[0-9a-f-]{36}$/);
  const origin = new URL(input.fixtureOrigin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.pathname, "/"); assert.equal(origin.username + origin.password + origin.search + origin.hash, "");
  const phases = ["before-marker", "after-marker", "raw-response", "readback", "ack-commit"];
  assert(input.pause === undefined || phases.includes(input.pause));
  const checkpoint = async (phase: string) => {
    if (input.pause !== phase) return;
    process.stdout.write(JSON.stringify({ kind: "checkpoint", phase }) + "\n");
    await new Promise<void>(() => {});
  };
  const original = globalThis.fetch;
  let patched = false;
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request)); assert.equal(url.origin, "https://www.googleapis.com");
    const response = await original(`${origin.origin}${url.pathname}${url.search}`, init);
    if (init?.method === "PATCH") { patched = true; await checkpoint("raw-response"); }
    else if (patched && url.pathname.includes("/events/")) await checkpoint("readback");
    return response;
  };
  const pending = new WeakSet<Client>(), originalQuery = Client.prototype.query;
  (Client.prototype as any).query = function (this: Client, ...args: any[]) {
    const query = typeof args[0] === "string" ? args[0] : args[0]?.text, values = args[0]?.values ?? args[1];
    if (typeof query === "string" && /^update "event_outbox"/i.test(query) && Array.isArray(values) && values.includes(input.operationId) && values.includes("completed")) pending.add(this);
    const actual = Reflect.apply(originalQuery, this, args);
    if (typeof query === "string" && query.trim().toLowerCase() === "commit" && pending.has(this)) { pending.delete(this); return Promise.resolve(actual).then(async value => { await checkpoint("ack-commit"); return value; }); }
    return actual;
  };
  const adapter = { ...googleAdapter, async writeRsvp(...args: Parameters<NonNullable<typeof googleAdapter.writeRsvp>>) {
    const beforeWrite = args[6];
    args[6] = async () => { await checkpoint("before-marker"); await beforeWrite!(); await checkpoint("after-marker"); };
    return googleAdapter.writeRsvp!(...args);
  } };
  const row = await deliverEventOutbox(input.operationId, () => adapter);
  process.stdout.write(JSON.stringify({ kind: "result", status: row?.status, errorCode: row?.errorCode }) + "\n");
}
main().then(() => process.exit(0), () => { process.stderr.write("Google RSVP process fixture failed.\n"); process.exit(1); });
