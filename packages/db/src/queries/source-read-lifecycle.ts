import { sql, type SQL } from "drizzle-orm";
import { externalCalendars } from "../schema";
import type { DbTransaction } from "./calendars";

/** Caller holds the affected calendars' exclusive lifecycle fences. This is
 * read retirement, not permission retirement of accepted provider writes. */
export async function retireExternalSourceReads(tx: DbTransaction, predicate: SQL) {
  await tx.update(externalCalendars).set({
    sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`,
    checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1`,
    cursor: null,
    readCoverage: null,
  }).where(predicate);
}
