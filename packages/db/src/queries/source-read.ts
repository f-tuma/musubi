import { and, eq, sql } from "drizzle-orm";
import { SyncCoverageSchema, type SyncCoverage } from "@musubi/types";
import { db } from "..";
import { account, calendarEvents, calendarMembers, events, externalCalendars, externalEvents, eventOutbox } from "../schema";
import type { DbTransaction } from "./calendars";
import { lockCalendarLifecycle, lockUserLifecycle } from "./calendar-lifecycle";
import type { ExternalCalendarAccessContext } from "./external-access";
import { hasFullProviderReadAccess } from "./microsoft-access";
import { hasProviderSyncScopes } from "./oauth";

export type GraphReadAdmission = {
  userID: string; accountID: string; calendarID: string; sourceID: string;
  sourceGeneration: number; checkpointRevision: number; cursor: string | null;
  configurationFingerprint: string; providerAccessRevision: number;
  providerAccessRole: string | null; connectionID: string; connectionScope: string | null; connectionGeneration: number;
  externalCalendarID: string;
  accessContext?: ExternalCalendarAccessContext;
  knownEventIDs: string[];
  knownMappings: { id: string; externalEventID: string; eventID: string }[];
  readAuthorityVerified: boolean;
};
type GraphReadAddress = Pick<GraphReadAdmission, "userID" | "accountID" | "calendarID" | "sourceID">;
export class GraphReadSourceChanged extends Error {
  constructor() { super("Graph read source or checkpoint changed. Retry with fresh admission."); }
}
const refuse = (): never => { throw new GraphReadSourceChanged(); };
function fingerprint(value: string) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 2048) throw new TypeError("Invalid Graph read configuration fingerprint.");
  return value;
}
async function sourceForRead(tx: DbTransaction, address: GraphReadAddress) {
  const [source] = await tx.select().from(externalCalendars).where(and(
    eq(externalCalendars.id, address.sourceID), eq(externalCalendars.provider, "microsoft"),
    eq(externalCalendars.userID, address.userID), eq(externalCalendars.accountID, address.accountID),
    eq(externalCalendars.calendarID, address.calendarID), eq(externalCalendars.disabled, false), eq(externalCalendars.supportsEvents, true),
  )).for("share");
  const [membership] = await tx.select({ role: calendarMembers.role }).from(calendarMembers).where(and(eq(calendarMembers.calendarID, address.calendarID), eq(calendarMembers.userID, address.userID))).for("share");
  const [connection] = await tx.select({ id: account.id, scope: account.scope, status: account.syncStatus, generation: account.syncReadGeneration, hasRefreshToken: sql<boolean>`coalesce(length(${account.refreshToken}), 0) > 0` }).from(account).where(and(eq(account.userId, address.userID), eq(account.providerId, "microsoft"), eq(account.accountId, address.accountID))).for("share");
  if (!source || !membership || !["owner", "editor", "viewer"].includes(membership.role) || !connection?.hasRefreshToken || connection.status !== "active" || !hasProviderSyncScopes("microsoft", connection.scope ?? "")) refuse();
  return { source, connection };
}

/** Captures one read incarnation before provider IO. The first new profile
 * starts a fresh bounded read; old mappings and accepted writes stay intact. */
export async function beginGraphRead(input: GraphReadAddress & { configurationFingerprint: string }): Promise<GraphReadAdmission> {
  const configurationFingerprint = fingerprint(input.configurationFingerprint);
  return db.transaction(async tx => {
    await lockUserLifecycle(tx, [input.userID], "shared");
    await lockCalendarLifecycle(tx, [input.calendarID], "exclusive");
    let { source, connection } = await sourceForRead(tx, input);
    if (source.readConfigurationFingerprint !== configurationFingerprint) {
      [source] = await tx.update(externalCalendars).set({
        sourceGeneration: sql`${externalCalendars.sourceGeneration} + 1`,
        checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1`,
        readConfigurationFingerprint: configurationFingerprint, cursor: null, readCoverage: null,
      }).where(eq(externalCalendars.id, source.id)).returning();
    }
    const mappings = await tx.select({ id: externalEvents.id, externalEventID: externalEvents.externalEventID, eventID: externalEvents.eventID }).from(externalEvents).where(and(eq(externalEvents.provider, "microsoft"), eq(externalEvents.calendarID, input.calendarID))).orderBy(externalEvents.externalEventID);
    return { ...input, configurationFingerprint, sourceGeneration: source.sourceGeneration, checkpointRevision: source.checkpointRevision, cursor: source.cursor,
      providerAccessRevision: source.providerAccessRevision, providerAccessRole: source.providerAccessRole, connectionID: connection.id, connectionScope: connection.scope, connectionGeneration: connection.generation, externalCalendarID: source.externalCalendarID,
      ...(source.providerAccessRole !== null ? { accessContext: { provider: "microsoft" as const, linkID: source.id, revision: source.providerAccessRevision, userID: input.userID, accountID: input.accountID, externalCalendarID: source.externalCalendarID } } : {}),
      knownEventIDs: mappings.map(row => row.externalEventID), knownMappings: mappings, readAuthorityVerified: hasFullProviderReadAccess("microsoft", source.providerAccessRole),
    };
  });
}

/** Discover before locking. Include immutable pending-create addresses as well
 * as mappings and memberships; subsequent helpers may lock their events. */
async function readClosure(tx: DbTransaction, calendarID: string) {
  const seeds = await tx.select({ id: events.id, seriesID: events.seriesID }).from(events).where(sql`${events.id} in (
    select id from events where origin_calendar_id = ${calendarID}
    union select event_id from calendar_events where calendar_id = ${calendarID}
    union select event_id from external_events where calendar_id = ${calendarID}
    union select event_id from event_outbox where calendar_id = ${calendarID} and status not in ('completed', 'not-needed', 'cancelled')
  )`);
  const roots = [...new Set(seeds.map(row => row.seriesID ?? row.id))];
  const rows = roots.length ? await tx.select({ id: events.id, originCalendarID: events.originCalendarID }).from(events).where(sql`${events.id} = any(${sql.param(roots)}::uuid[]) or ${events.seriesID} = any(${sql.param(roots)}::uuid[]) or ${events.id} = any(${sql.param(seeds.map(row => row.id))}::uuid[])`).orderBy(events.id) : [];
  const eventIDs = rows.map(row => row.id);
  const links = eventIDs.length ? await tx.select({ id: calendarEvents.calendarID }).from(calendarEvents).where(sql`${calendarEvents.eventID} = any(${sql.param(eventIDs)}::uuid[])`) : [];
  return { eventIDs, calendarIDs: [...new Set([calendarID, ...rows.flatMap(row => row.originCalendarID ? [row.originCalendarID] : []), ...links.map(row => row.id)])].sort() };
}
const sameIDs = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Complete paging/hydration precedes this call. Callback is database-only;
 * mutations, coverage and checkpoint either commit together or all roll back.
 * The complete related-calendar fence avoids reversed multi-copy event locks. */
export async function applyGraphReadBatch<T>(
  admission: GraphReadAdmission,
  checkpoint: { coverage: SyncCoverage; nextCursor: string; configurationFingerprint: string },
  apply: (tx: DbTransaction, accessContext: ExternalCalendarAccessContext | undefined) => Promise<T>,
): Promise<T> {
  admission = structuredClone(admission);
  const coverage = SyncCoverageSchema.parse(checkpoint.coverage);
  if (coverage.kind !== "window" || !coverage.complete || typeof checkpoint.nextCursor !== "string" || !checkpoint.nextCursor || fingerprint(checkpoint.configurationFingerprint) !== admission.configurationFingerprint) refuse();
  return db.transaction(async tx => {
    await lockUserLifecycle(tx, [admission.userID], "shared");
    const closure = await readClosure(tx, admission.calendarID);
    await lockCalendarLifecycle(tx, closure.calendarIDs, "exclusive");
    const currentClosure = await readClosure(tx, admission.calendarID);
    if (!sameIDs(closure.calendarIDs, currentClosure.calendarIDs) || !sameIDs(closure.eventIDs, currentClosure.eventIDs)) refuse();
    // With every family origin fenced, deterministic union locking also agrees
    // with calendar removal; family helpers' subsequent locks are reentrant.
    if (closure.eventIDs.length) await tx.select({ id: events.id }).from(events).where(sql`${events.id} = any(${sql.param(closure.eventIDs)}::uuid[])`).orderBy(events.id).for("update");
    const { source, connection } = await sourceForRead(tx, admission);
    if (connection.id !== admission.connectionID || connection.scope !== admission.connectionScope || connection.generation !== admission.connectionGeneration || source.externalCalendarID !== admission.externalCalendarID || source.sourceGeneration !== admission.sourceGeneration || source.checkpointRevision !== admission.checkpointRevision || source.cursor !== admission.cursor || source.readConfigurationFingerprint !== admission.configurationFingerprint || source.providerAccessRevision !== admission.providerAccessRevision || source.providerAccessRole !== admission.providerAccessRole || hasFullProviderReadAccess("microsoft", source.providerAccessRole) !== admission.readAuthorityVerified) refuse();
    // A negative read of an old native address cannot tombstone a newly bound
    // local incarnation accepted while provider IO was in flight.
    const mappings = await tx.select({ id: externalEvents.id, externalEventID: externalEvents.externalEventID, eventID: externalEvents.eventID }).from(externalEvents).where(and(eq(externalEvents.provider, "microsoft"), eq(externalEvents.calendarID, admission.calendarID)));
    const currentMappings = new Map(mappings.map(mapping => [mapping.externalEventID, mapping]));
    if (admission.knownMappings.some(previous => {
      const current = currentMappings.get(previous.externalEventID);
      return !current || current.id !== previous.id || current.eventID !== previous.eventID;
    })) refuse();
    const result = await apply(tx, admission.accessContext);
    const [accepted] = await tx.update(externalCalendars).set({ cursor: checkpoint.nextCursor, readCoverage: coverage, checkpointRevision: sql`${externalCalendars.checkpointRevision} + 1` }).where(and(
      eq(externalCalendars.id, admission.sourceID), eq(externalCalendars.provider, "microsoft"), eq(externalCalendars.calendarID, admission.calendarID), eq(externalCalendars.userID, admission.userID), eq(externalCalendars.accountID, admission.accountID),
      eq(externalCalendars.disabled, false), eq(externalCalendars.supportsEvents, true), eq(externalCalendars.sourceGeneration, admission.sourceGeneration), eq(externalCalendars.checkpointRevision, admission.checkpointRevision),
      eq(externalCalendars.providerAccessRevision, admission.providerAccessRevision), eq(externalCalendars.readConfigurationFingerprint, admission.configurationFingerprint), sql`${externalCalendars.cursor} is not distinct from ${admission.cursor}`,
    )).returning({ id: externalCalendars.id });
    if (!accepted) refuse();
    return result;
  }).catch(error => { if (error instanceof GraphReadSourceChanged) throw error; throw new Error("Graph read batch could not be persisted."); });
}
