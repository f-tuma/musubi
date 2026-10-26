// Owned IPC harness: real production store/runners with pauses at actual SQL/native boundaries.
import { Pool } from "pg";
import { ReferenceTaskStore } from "./task-store.js";
import { deliverReferenceTaskCreate } from "./task-create-runner.js";
import { deliverReferenceTaskUpdate } from "./task-runner.js";
import { deliverReferenceTaskDelete } from "./task-delete-runner.js";
async function main() {
  if (process.env.REFERENCE_TEST_CHILD !== "true" || !process.send || !process.env.REFERENCE_DATABASE_URL || !process.env.REFERENCE_CREDENTIAL_KEY) throw new Error("Owned fixture required");
  let bytes = ""; for await (const chunk of process.stdin) bytes += chunk;
  const input = JSON.parse(bytes) as { operationId: string; fixtureOrigin: string; family: "create" | "update" | "delete"; pause?: string; action?: "queue-update" | "queue-delete"; admission?: unknown };
  const origin = new URL(input.fixtureOrigin); if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("Owned loopback fixture required");
  const pool = new Pool({ connectionString: process.env.REFERENCE_DATABASE_URL, max: 4, statement_timeout: 10_000, query_timeout: 15_000 });
  const checkpoint = async (phase: string) => {
    if (phase !== input.pause) return;
    await new Promise<void>((resolve, reject) => process.send!({ type: "checkpoint", phase }, error => error ? reject(error) : resolve()));
    await new Promise<void>(resolve => { const receive = (value: any) => { if (value?.type === "resume") { process.off("message", receive); resolve(); } }; process.on("message", receive); });
  };
  if (["queueInserted", "activationCanonical", "activationOperation", "ackWritten"].includes(input.pause ?? "")) {
    const connect = pool.connect.bind(pool);
    (pool as any).connect = async (...args: any[]) => {
      const client = await (connect as any)(...args), query = client.query.bind(client);
      client.query = async (...args: any[]) => {
        const result = await query(...args), sql = typeof args[0] === "string" ? args[0].replace(/\s+/g, " ").trim() : "";
        if (sql.startsWith("INSERT INTO reference_task_intents")) await checkpoint("queueInserted");
        if (sql.startsWith("UPDATE reference_task_objects SET content=")) await checkpoint("activationCanonical");
        if (sql.startsWith("INSERT INTO reference_task_operations")) await checkpoint("activationOperation");
        if (sql.startsWith("UPDATE reference_task_operations SET status='acked'")) await checkpoint("ackWritten");
        return result;
      }; return client;
    };
  }
  try {
    const store = new ReferenceTaskStore(pool, process.env.REFERENCE_CREDENTIAL_KEY);
    const ports = { http: { async fetch(url: string, init: RequestInit) { const native = new URL(url); if (native.origin !== "https://tasks.googleapis.com" || !native.pathname.startsWith("/tasks/v1/")) throw new Error("Nonfixture network refused"); const response = await globalThis.fetch(`${origin.origin}${native.pathname}${native.search}`, init); Object.defineProperty(response, "url", { value: native.href }); return response; } }, clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() }, telemetry: { record: (metric: unknown) => process.send!({ type: "metric", metric }) } };
    const result = input.action === "queue-update" ? await store.queueUpdate(input.admission as Parameters<ReferenceTaskStore["queueUpdate"]>[0]) : input.action === "queue-delete" ? await store.queueDelete(input.admission as Parameters<ReferenceTaskStore["queueDelete"]>[0]) : input.family === "create" ? await deliverReferenceTaskCreate(store, input.operationId, ports, { checkpoint }) : input.family === "delete" ? await deliverReferenceTaskDelete(store, input.operationId, ports, { checkpoint }) : await deliverReferenceTaskUpdate(store, input.operationId, ports, { checkpoint });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await pool.end(); process.disconnect?.(); }
}
void main().catch(() => { process.stderr.write("Owned task intent fixture failed\n"); process.exitCode = 1; process.disconnect?.(); });
