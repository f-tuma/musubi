import { Pool } from "pg";
import { ReferenceStore } from "./store.js";
import { ReferenceHoldError, type ReferenceAdmission, type ReferenceDeleteAdmission, type ReferenceSeed } from "./model.js";
import { deliverReferenceOperation, type ReferenceRunnerPorts } from "./runner.js";

/** The reference executable reads only its own configuration; never Musubi env/auth. */
async function input(signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const abort = () => process.stdin.destroy(new Error("Reference command interrupted."));
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 8_000_000) throw new Error("Reference command input is too large.");
    chunks.push(value);
  }
  signal.throwIfAborted();
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Invalid reference command input."); }
  } finally { signal.removeEventListener("abort", abort); }
}
function ownObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reference command input.");
  return value as Record<string, unknown>;
}
async function main() {
  const command = process.argv[2];
  if (!["migrate", "seed", "admit", "admit-delete", "deliver", "show"].includes(command)) throw new Error("Invalid reference command.");
  const databaseUrl = process.env.REFERENCE_DATABASE_URL;
  const credentialKey = process.env.REFERENCE_CREDENTIAL_KEY;
  if (!databaseUrl || !credentialKey) throw new Error("Missing reference configuration.");
  const pool = new Pool({ connectionString: databaseUrl, max: 4, application_name: "musubi-sync-reference",
    statement_timeout: 10_000, query_timeout: 15_000, idle_in_transaction_session_timeout: 15_000 });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Reference command interrupted."));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const store = new ReferenceStore(pool, credentialKey);
    let result: unknown;
    if (command === "migrate") { await store.migrate(); result = { status: "ready", profile: "sync-profile-v1" }; }
    else {
      const value = ownObject(await input(controller.signal));
      controller.signal.throwIfAborted();
      if (command === "seed") {
        await store.seedBinding(value as unknown as ReferenceSeed);
        result = { status: "seeded", bindingId: value.bindingId };
      } else if (command === "admit") result = await store.admitUpdate(value as unknown as ReferenceAdmission);
      else if (command === "admit-delete") result = await store.admitDelete(value as unknown as ReferenceDeleteAdmission);
      else {
        if (typeof value.operationId !== "string" || !value.operationId || value.operationId.length > 2048)
          throw new Error("Invalid reference operation identity.");
        if (command === "show") result = await store.inspectOperation(value.operationId);
        else {
          const ports: ReferenceRunnerPorts = {
            http: { fetch: (url, init) => globalThis.fetch(url, init) },
            clock: { nowEpochMs: () => Date.now(), nowMonotonicMs: () => performance.now() },
            telemetry: { record: metric => process.stderr.write(`${JSON.stringify({ type: "provider-http", ...metric })}\n`) },
          };
          result = await deliverReferenceOperation(store, value.operationId, ports, { signal: controller.signal });
        }
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    await pool.end();
  }
}
void main().catch(error => {
  const code = error instanceof ReferenceHoldError && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : "command-failed";
  process.stderr.write(`${JSON.stringify({ status: "hold", code })}\n`);
  process.exitCode = 1;
});
