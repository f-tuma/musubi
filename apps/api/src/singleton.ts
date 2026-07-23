import { config, logger } from "@musubi/config";
import { Client } from "pg";

// Two readable 32-bit keys in PostgreSQL's advisory-lock namespace:
// "MUSU" / "BI01". The lock is session-scoped and held by a dedicated
// connection for the lifetime of this process.
const LOCK_NAMESPACE = 0x4d555355;
const LOCK_ID = 0x42493031;

let lockClient: Client | null = null;

/**
 * Enforce Musubi's current one-API-process-per-database deployment contract.
 *
 * SSE, public rate limits, metrics, and scheduled jobs are process-local.
 * Failing a second process at boot is safer than accepting traffic with
 * misleading partial coordination.
 */
export async function acquireApiSingletonLock() {
  if (lockClient) return;

  const client = new Client({
    application_name: "musubi-api-singleton",
    connectionString: config.db.databaseUrl,
  });
  await client.connect();

  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
      [LOCK_NAMESPACE, LOCK_ID],
    );

    if (!result.rows[0]?.acquired) {
      throw new Error(
        "Another Musubi API process is already using this database. "
        + "Musubi currently supports exactly one API replica.",
      );
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  client.on("error", (error) => {
    // A broken lock connection releases the PostgreSQL session lock. Staying
    // alive could then allow two API processes to serve the same database.
    logger.error("server.singleton_lock_lost", { error });
    process.exit(1);
  });
  lockClient = client;
  logger.info("server.singleton_lock.acquired");
}
