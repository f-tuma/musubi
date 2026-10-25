import assert from "node:assert/strict";
import { caldavAdapter } from "./adapters/caldav";
import { deliverEventOutbox } from "./event_delivery";
import type { CalendarAdapter } from "./adapter";

/** Owned integration child; no API bootstrap import or production pause hook. */
async function main() {
  assert.equal(process.env.ENVIRONMENT, "test");
  let bytes = ""; for await (const chunk of process.stdin) bytes += chunk;
  const input: { operationId: string; fixtureOrigin: string; pause?: "beforeCreate" | "afterCreate" } = JSON.parse(bytes);
  assert.match(input.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const origin = new URL(input.fixtureOrigin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.pathname, "/");
  assert.equal(origin.username, ""); assert.equal(origin.password, ""); assert.equal(origin.search, ""); assert.equal(origin.hash, "");
  assert(input.pause === undefined || input.pause === "beforeCreate" || input.pause === "afterCreate");
  const checkpoint = async (phase: "beforeCreate" | "afterCreate") => {
    if (input.pause !== phase) return;
    process.stdout.write(JSON.stringify({ kind: "checkpoint", phase }) + "\n"); await new Promise<void>(() => {});
  };
  const adapter: CalendarAdapter = {
    ...caldavAdapter,
    caldavPersonalCreateV1(...args) {
      const bridge = caldavAdapter.caldavPersonalCreateV1!(...args);
      return { ...bridge, ports: { ...bridge.ports, http: { async fetchPinned(url, init, address) {
        assert.equal(url.origin, origin.origin, "Only the owned synthetic DAV origin is reachable");
        if (init.method === "PUT") await checkpoint("beforeCreate");
        const response = await bridge.ports.http.fetchPinned(url, init, address);
        if (init.method === "PUT") await checkpoint("afterCreate");
        return response;
      } } } };
    },
  };
  const result = await deliverEventOutbox(input.operationId, () => adapter);
  process.stdout.write(JSON.stringify({ kind: "result", status: result?.status, errorCode: result?.errorCode }) + "\n");
}
main().then(() => process.exit(0), () => { process.stderr.write("DAV CREATE process fixture failed.\n"); process.exit(1); });
