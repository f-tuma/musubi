// Owned crash fixture process. This module is never imported by the CLI.
import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { deliverReferenceOperation, type ReferenceCheckpoint } from "./runner.js";
import type { ReferenceAdmission, ReferenceDeleteAdmission, ReferenceCreateAdmission } from "./model.js";

async function main() {
  if (process.env.REFERENCE_TEST_CHILD !== "true" || !process.send || !process.env.REFERENCE_DATABASE_URL || !process.env.REFERENCE_CREDENTIAL_KEY)
    throw new Error("Owned child fixture configuration required.");
  const databaseUrl = process.env.REFERENCE_DATABASE_URL, key = process.env.REFERENCE_CREDENTIAL_KEY;
  let data = ""; for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data) as { action: "admit" | "admit-delete" | "admit-create" | "deliver" | "show"; operationId: string; admission?: ReferenceAdmission | ReferenceDeleteAdmission | ReferenceCreateAdmission; pause?: string; fixtureOrigin: string };
  const fixture = new URL(input.fixtureOrigin);
  if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1" || fixture.pathname !== "/" || fixture.search || fixture.hash || fixture.username || fixture.password)
    throw new Error("Owned loopback HTTP fixture required.");
  const pool = new Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 10_000, query_timeout: 15_000 });
  const checkpoint = async (phase: string) => {
    if (input.pause !== phase) return;
    await new Promise<void>((resolve, reject) => process.send!({ type: "checkpoint", phase }, error => error ? reject(error) : resolve()));
    await new Promise<void>(resolve => {
      const receive = (message: unknown) => {
        if (message && typeof message === "object" && "type" in message && message.type === "resume") { process.removeListener("message", receive); resolve(); }
      };
      process.on("message", receive);
    });
  };
  // Kill inside the REAL canonical+intent transaction, after its canonical SQL
  // and before its intent INSERT/COMMIT. The production store stays unmodified.
  if (input.pause === "admissionCanonical") {
    const connect = pool.connect.bind(pool);
    pool.connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: any[]) => Promise<any>;
      client.query = (async (...args: any[]) => {
        const result = await query(...args);
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (sql?.startsWith("UPDATE reference_objects SET revision=")) await checkpoint("admissionCanonical");
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof pool.connect;
  }
  try {
    const store = new ReferenceStore(pool, key);
    let result: unknown;
    if (input.action === "admit" || input.action === "admit-delete" || input.action === "admit-create") {
      result = input.action === "admit" ? await store.admitUpdate(input.admission! as ReferenceAdmission) : input.action === "admit-create"
        ? await store.admitCreate(input.admission!) : await store.admitDelete(input.admission!);
      await checkpoint("afterAdmission");
    } else if (input.action === "show") result = await store.inspectOperation(input.operationId);
    else result = await deliverReferenceOperation(store, input.operationId, {
      http: { fetch: async (url, init) => {
        const native = new URL(url);
        if (native.origin !== "https://www.googleapis.com") throw new Error("Live network forbidden in owned fixture.");
        const response = await globalThis.fetch(`${fixture.origin}${native.pathname}${native.search}`, init);
        // Owned loopback transport stands in for the requested native URL; retain
        // that logical response identity while provider redirect guards stay active.
        Object.defineProperty(response, "url", { value: native.href });
        return response;
      } },
      clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() },
      telemetry: { record: metric => process.send!({ type: "metric", metric }) },
    }, { checkpoint: phase => checkpoint(phase as ReferenceCheckpoint) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await pool.end(); process.disconnect?.(); }
}
void main().catch(() => { process.stderr.write("Owned reference child fixture failed.\n"); process.exitCode = 1; process.disconnect?.(); });
