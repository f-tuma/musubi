// Owned IPC crash harness. Production CLI never imports this module.
import { Pool } from "pg";
import { ReferenceTaskStore } from "./task-store.js";
import { deliverReferenceTaskCreate } from "./task-create-runner.js";
import type { ReferenceTaskCreateAdmission } from "./task-create-model.js";
async function main() {
  if (process.env.REFERENCE_TEST_CHILD !== "true" || !process.send || !process.env.REFERENCE_DATABASE_URL || !process.env.REFERENCE_CREDENTIAL_KEY) throw new Error("Owned fixture required");
  let data = ""; for await (const chunk of process.stdin) data += chunk;
  const input = JSON.parse(data) as { operationId: string; fixtureOrigin: string; pause?: string; action?: "admit"; admission?: ReferenceTaskCreateAdmission };
  const origin = new URL(input.fixtureOrigin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("Owned loopback fixture required");
  const pool = new Pool({ connectionString: process.env.REFERENCE_DATABASE_URL, max: 4, statement_timeout: 10_000, query_timeout: 15_000 });
  const checkpoint = async (phase: string) => {
    if (input.pause !== phase) return;
    await new Promise<void>((resolve, reject) => process.send!({ type: "checkpoint", phase }, error => error ? reject(error) : resolve()));
    await new Promise<void>(resolve => { const receive = (value: any) => { if (value?.type === "resume") { process.off("message", receive); resolve(); } }; process.on("message", receive); });
  };
  if (["admissionCanonical", "adoptionMapping"].includes(input.pause ?? "")) {
    const connect = pool.connect.bind(pool);
    (pool as any).connect = async (...args: any[]) => {
      const client = await (connect as any)(...args), query = client.query.bind(client);
      client.query = async (...values: any[]) => { const result = await query(...values);
        if (typeof values[0] === "string" && values[0].startsWith("UPDATE reference_task_objects SET revision=")) await checkpoint("admissionCanonical");
        if (typeof values[0] === "string" && values[0].startsWith("UPDATE reference_task_bindings SET task_id=")) await checkpoint("adoptionMapping");
        return result;
      }; return client;
    };
  }
  try {
    const store = new ReferenceTaskStore(pool, process.env.REFERENCE_CREDENTIAL_KEY), record = store.recordCreateEvidence.bind(store);
    store.recordCreateEvidence = async (claim, facts, signal) => { const accepted = await record(claim, facts, signal); if (facts.responseAddress && facts.remote.kind === "unobserved") await checkpoint("afterResponseAddress"); return accepted; };
    const result = input.action === "admit" ? await store.admitCreate(input.admission!) : await deliverReferenceTaskCreate(store, input.operationId, {
      http: { async fetch(url, init) {
        const native = new URL(url); if (native.origin !== "https://tasks.googleapis.com" || !native.pathname.startsWith("/tasks/v1/")) throw new Error("Nonfixture network forbidden");
        const response = await globalThis.fetch(`${origin.origin}${native.pathname}${native.search}`, init); Object.defineProperty(response, "url", { value: native.href }); return response;
      } },
      clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record: metric => process.send!({ type: "metric", metric }) },
    }, { checkpoint });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await pool.end(); process.disconnect?.(); }
}
void main().catch(() => { process.stderr.write("Owned task CREATE fixture failed\n"); process.exitCode = 1; process.disconnect?.(); });
