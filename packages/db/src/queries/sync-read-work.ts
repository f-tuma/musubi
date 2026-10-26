import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "..";
import { account, calendarMembers, externalCalendars, syncReadWork } from "../schema";
import type { DbTransaction } from "./calendars";
import { lockCalendarLifecycle, lockUserLifecycle } from "./calendar-lifecycle";
import { getOwnedCaldavAccountBinding } from "./caldav";
import { hasProviderSyncScopes } from "./oauth";

export type SyncReadStream = "discovery" | "events" | "tasks" | "components";
export type SyncReadDeferralKind = "optional-unavailable" | "budget" | "failure";
export type SyncReadWorkAddress = Readonly<{
  userID: string; provider: "google" | "microsoft" | "caldav"; accountID: string;
  sourceID?: string; stream: SyncReadStream; configurationFingerprint: string;
  policyFingerprint?: string;
}>;
export type SyncReadWorkBinding = Readonly<{
  userID: string; provider: SyncReadWorkAddress["provider"]; accountID: string;
  stream: SyncReadStream; configurationFingerprint: string; policyFingerprint: string;
  connection: { kind: "oauth"; rowID: string; generation: number; scope: string | null }
    | { kind: "caldav"; rowID: string; credentialRevision: string; credentialFingerprint: string };
  source?: { id: string; calendarID: string; externalCalendarID: string;
    generation: number; accessRevision: number; configurationFingerprint: string | null;
    fingerprint: string; checkpointRevision: number; cursor: string | null };
}>;
/** Host-private capture. Scheduling metadata and these fields are not authority. */
export type SyncReadWorkCapture = Readonly<{
  workID: string; bindingToken: string; claimToken: string;
  capturedGeneration: string; binding: SyncReadWorkBinding;
}>;
export class SyncReadWorkChanged extends Error {
  constructor() { super("Sync read work source or claim changed."); this.name = "SyncReadWorkChanged"; }
}
function changed(): never { throw new SyncReadWorkChanged(); }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function boundedFingerprint(value: string) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 2048) throw new TypeError("Invalid sync read configuration.");
  return value;
}
function validateAddress(input: SyncReadWorkAddress) {
  if (!["google", "microsoft", "caldav"].includes(input.provider) || !input.userID || !input.accountID ||
    !["discovery", "events", "tasks", "components"].includes(input.stream) ||
    (input.stream === "discovery") !== (input.sourceID === undefined) ||
    input.provider === "caldav" && !["discovery", "components"].includes(input.stream) ||
    input.provider !== "caldav" && input.stream === "components") throw new TypeError("Invalid sync read work address.");
  boundedFingerprint(input.configurationFingerprint);
  if (input.policyFingerprint !== undefined) boundedFingerprint(input.policyFingerprint);
}

/** Caller may already hold the complete lifecycle/canonical lock closure.
 * Graph's configuration transition must happen before this capture, never after. */
async function currentBinding(tx: DbTransaction, input: SyncReadWorkAddress, lockLifecycle: boolean): Promise<SyncReadWorkBinding> {
  validateAddress(input);
  if (lockLifecycle) await lockUserLifecycle(tx, [input.userID], "shared");
  let source: SyncReadWorkBinding["source"];
  if (input.sourceID) {
    const [address] = await tx.select({ calendarID: externalCalendars.calendarID }).from(externalCalendars).where(eq(externalCalendars.id, input.sourceID));
    if (!address?.calendarID) changed();
    if (lockLifecycle) await lockCalendarLifecycle(tx, [address.calendarID], "shared");
    const [row] = await tx.select().from(externalCalendars).where(and(eq(externalCalendars.id, input.sourceID),
      eq(externalCalendars.calendarID, address.calendarID), eq(externalCalendars.provider, input.provider),
      eq(externalCalendars.userID, input.userID), eq(externalCalendars.accountID, input.accountID), eq(externalCalendars.disabled, false))).for("share");
    const [member] = await tx.select({ role: calendarMembers.role }).from(calendarMembers)
      .where(and(eq(calendarMembers.calendarID, address.calendarID), eq(calendarMembers.userID, input.userID))).for("share");
    if (!row || !member || !["owner", "editor", "viewer"].includes(member.role) ||
      input.stream === "events" && !row.supportsEvents || input.stream === "tasks" && !row.supportsTasks ||
      input.stream === "components" && (!row.supportsEvents && !row.supportsTasks || row.providerAccessRole?.startsWith("caldav:read=no;")) ||
      input.provider === "microsoft" && input.stream === "events" && row.readConfigurationFingerprint !== input.configurationFingerprint) changed();
    source = { id: row.id, calendarID: address.calendarID, externalCalendarID: row.externalCalendarID,
      generation: row.sourceGeneration, accessRevision: row.providerAccessRevision,
      configurationFingerprint: row.readConfigurationFingerprint, checkpointRevision: row.checkpointRevision, cursor: row.cursor,
      fingerprint: digest(["sync-read-source-v1", row.id, row.calendarID, row.externalCalendarID,
        row.sourceGeneration, row.providerAccessRevision, row.providerAccessRole, row.readConfigurationFingerprint,
        row.supportsEvents, row.supportsTasks]) };
  }
  let connection: SyncReadWorkBinding["connection"];
  if (input.provider === "caldav") {
    const row = await getOwnedCaldavAccountBinding(input.userID, input.accountID, tx);
    if (!row) changed();
    connection = { kind: "caldav", rowID: row.id, credentialRevision: row.credentialRevision, credentialFingerprint: row.credentialFingerprint };
  } else {
    // The current schema does not make this logical address unique. Ambiguity
    // is unavailable; never select an arbitrary physical row as authority.
    const rows = await tx.select({ id: account.id, generation: account.syncReadGeneration, scope: account.scope,
      status: account.syncStatus, hasRefresh: sql<boolean>`coalesce(length(${account.refreshToken}),0)>0` }).from(account)
      .where(and(eq(account.userId, input.userID), eq(account.providerId, input.provider), eq(account.accountId, input.accountID))).limit(2).for("share");
    const row = rows[0];
    if (rows.length !== 1 || !row?.hasRefresh || row.status !== "active" || !hasProviderSyncScopes(input.provider, row.scope ?? "")) changed();
    connection = { kind: "oauth", rowID: row.id, generation: row.generation, scope: row.scope };
  }
  return { userID: input.userID, provider: input.provider, accountID: input.accountID, stream: input.stream,
    configurationFingerprint: input.configurationFingerprint, policyFingerprint: input.policyFingerprint ?? "default", connection, ...(source ? { source } : {}) };
}
function bindingValues(binding: SyncReadWorkBinding) {
  return { userID: binding.userID, provider: binding.provider, accountID: binding.accountID, stream: binding.stream,
    oauthAccountID: binding.connection.kind === "oauth" ? binding.connection.rowID : null,
    caldavAccountID: binding.connection.kind === "caldav" ? binding.connection.rowID : null,
    sourceID: binding.source?.id ?? null, scopeKey: binding.source?.id ?? "account",
    oauthReadGeneration: binding.connection.kind === "oauth" ? binding.connection.generation : null,
    oauthScope: binding.connection.kind === "oauth" ? binding.connection.scope : null,
    caldavCredentialRevision: binding.connection.kind === "caldav" ? binding.connection.credentialRevision : null,
    caldavCredentialFingerprint: binding.connection.kind === "caldav" ? binding.connection.credentialFingerprint : null,
    sourceGeneration: binding.source?.generation ?? null, providerAccessRevision: binding.source?.accessRevision ?? null,
    sourceConfigurationFingerprint: binding.source?.configurationFingerprint ?? null, sourceFingerprint: binding.source?.fingerprint ?? null,
    configurationFingerprint: binding.configurationFingerprint, policyFingerprint: binding.policyFingerprint };
}
type WorkRow = typeof syncReadWork.$inferSelect;
function matches(row: WorkRow, binding: SyncReadWorkBinding) {
  const values = bindingValues(binding);
  return (Object.keys(values) as (keyof typeof values)[]).every(key => row[key] === values[key]);
}
function rowAddress(row: WorkRow): SyncReadWorkAddress {
  return { userID: row.userID, provider: row.provider, accountID: row.accountID, stream: row.stream,
    ...(row.sourceID ? { sourceID: row.sourceID } : {}), configurationFingerprint: row.configurationFingerprint, policyFingerprint: row.policyFingerprint };
}
function claimGuard(capture: SyncReadWorkCapture) {
  if (!/^[1-9][0-9]*$/.test(capture.capturedGeneration)) throw new TypeError("Invalid dirty generation.");
  return and(eq(syncReadWork.id, capture.workID), eq(syncReadWork.bindingToken, capture.bindingToken),
    eq(syncReadWork.claimToken, capture.claimToken), eq(syncReadWork.claimGeneration, BigInt(capture.capturedGeneration)),
    sql`${syncReadWork.retiredAt} is null`,
    sql`${syncReadWork.leaseUntil} > clock_timestamp()`);
}

export async function requestSyncReadWork(input: SyncReadWorkAddress) {
  input = structuredClone(input);
  return db.transaction(async tx => {
    const binding = await currentBinding(tx, input, true), values = bindingValues(binding);
    const [created] = await tx.insert(syncReadWork).values(values).onConflictDoNothing().returning();
    if (created) return { workID: created.id, requestedGeneration: created.requestedGeneration.toString() };
    const [row] = await tx.select().from(syncReadWork).where(and(
      binding.connection.kind === "oauth" ? eq(syncReadWork.oauthAccountID, binding.connection.rowID) : eq(syncReadWork.caldavAccountID, binding.connection.rowID),
      eq(syncReadWork.scopeKey, values.scopeKey), eq(syncReadWork.stream, binding.stream))).for("update");
    if (!row) changed();
    const rebound = !matches(row, binding);
    const [saved] = await tx.update(syncReadWork).set({ ...values,
      requestedGeneration: sql`${syncReadWork.requestedGeneration}+1`, requestedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      retiredAt: null,
      ...(rebound || row.retiredAt ? { bindingToken: randomUUID(), claimToken: null, claimGeneration: null, leaseUntil: null } : {}),
      ...(rebound ? { lastDeferralKind: null } : {}),
    }).where(eq(syncReadWork.id, row.id)).returning();
    return { workID: saved!.id, requestedGeneration: saved!.requestedGeneration.toString() };
  });
}

export async function claimSyncReadWork(workID: string): Promise<{ kind: "claimed"; capture: SyncReadWorkCapture } | { kind: "not-eligible" | "retired" }> {
  let stale: { bindingToken: string; requestedGeneration: bigint } | undefined;
  try { return await db.transaction(async tx => {
    const [initial] = await tx.select().from(syncReadWork).where(eq(syncReadWork.id, workID));
    if (!initial) return { kind: "not-eligible" } as const;
    if (initial.retiredAt) return { kind: "retired" } as const;
    stale = { bindingToken: initial.bindingToken, requestedGeneration: initial.requestedGeneration };
    const binding = await currentBinding(tx, rowAddress(initial), true);
    const [row] = await tx.select().from(syncReadWork).where(eq(syncReadWork.id, workID)).for("update", { skipLocked: true });
    if (!row) return { kind: "not-eligible" } as const;
    if (row.retiredAt) return { kind: "retired" } as const;
    if (!matches(row, binding)) changed();
    // Separate UPDATE evaluates DB time after every source/work row-lock wait.
    const [saved] = await tx.update(syncReadWork).set({ claimToken: randomUUID(), claimGeneration: sql`${syncReadWork.requestedGeneration}`, lastDeferralKind: null,
      leaseUntil: sql`clock_timestamp()+interval '120 seconds'`, lastStartedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(syncReadWork.id, workID), sql`${syncReadWork.retiredAt} is null`, sql`${syncReadWork.requestedGeneration}>${syncReadWork.completedGeneration}`,
        sql`${syncReadWork.notBefore}<=clock_timestamp()`, sql`(${syncReadWork.leaseUntil} is null or ${syncReadWork.leaseUntil}<=clock_timestamp())`)).returning();
    if (!saved) return { kind: "not-eligible" } as const;
    return { kind: "claimed", capture: { workID, bindingToken: saved.bindingToken, claimToken: saved.claimToken!, capturedGeneration: saved.claimGeneration!.toString(), binding } } as const;
  }); } catch (error) {
    if (!(error instanceof SyncReadWorkChanged)) throw error;
    if (!stale) return { kind: "not-eligible" };
    // The authority transaction has rolled back and released all source locks.
    // Retire only the exact observed request/binding. A fresh enqueue/rebind
    // must survive a delayed stale claimant, with no ACK or counter reset.
    const retired = await db.update(syncReadWork).set({ retiredAt: sql`clock_timestamp()`, bindingToken: randomUUID(),
      claimToken: null, claimGeneration: null, leaseUntil: null, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(syncReadWork.id, workID), eq(syncReadWork.bindingToken, stale.bindingToken),
        eq(syncReadWork.requestedGeneration, stale.requestedGeneration), sql`${syncReadWork.retiredAt} is null`,
        sql`${syncReadWork.requestedGeneration}>${syncReadWork.completedGeneration}`)).returning({ id: syncReadWork.id });
    return { kind: retired.length ? "retired" : "not-eligible" };
  }
}

/** Revalidate after the caller's complete canonical/family lock closure. With
 * lockLifecycle:false caller owns those fences. Final cursor CAS owns checkpoint
 * advancement; ACK intentionally does not compare the old checkpoint afterward.
 * This is a FINAL guard: no source/canonical lock upgrade after the work lock.
 * Perform cursor CAS first, then ACK last, so enqueue's source->work order agrees. */
export async function assertSyncReadWorkCurrentInTransaction(tx: DbTransaction, capture: SyncReadWorkCapture,
  options: { lockLifecycle?: boolean; checkCheckpoint?: boolean } = {}) {
  capture = structuredClone(capture);
  const input: SyncReadWorkAddress = { ...capture.binding,
    ...(capture.binding.source ? { sourceID: capture.binding.source.id } : {}) };
  const binding = await currentBinding(tx, input, options.lockLifecycle !== false);
  const [row] = await tx.select().from(syncReadWork).where(eq(syncReadWork.id, capture.workID)).for("update");
  if (!row || !matches(row, binding) || !matches(row, capture.binding) ||
    options.checkCheckpoint !== false && capture.binding.source && (binding.source?.checkpointRevision !== capture.binding.source.checkpointRevision || binding.source.cursor !== capture.binding.source.cursor)) changed();
  const [live] = await tx.select({ id: syncReadWork.id }).from(syncReadWork).where(claimGuard(capture));
  if (!live) changed();
}
export async function ackSyncReadWorkInTransaction(tx: DbTransaction, capture: SyncReadWorkCapture,
  options: { lockLifecycle?: boolean } = {}) {
  capture = structuredClone(capture);
  await assertSyncReadWorkCurrentInTransaction(tx, capture, { ...options, checkCheckpoint: false });
  const [row] = await tx.update(syncReadWork).set({ completedGeneration: BigInt(capture.capturedGeneration),
    claimToken: null, claimGeneration: null, leaseUntil: null, updatedAt: sql`clock_timestamp()` }).where(claimGuard(capture)).returning();
  if (!row) changed();
  return row.requestedGeneration > row.completedGeneration ? "newer-pending" as const : "completed" as const;
}
export async function renewSyncReadWork(capture: SyncReadWorkCapture) {
  capture = structuredClone(capture);
  return db.transaction(async tx => {
    await assertSyncReadWorkCurrentInTransaction(tx, capture, { checkCheckpoint: false });
    return (await tx.update(syncReadWork).set({ leaseUntil: sql`clock_timestamp()+interval '120 seconds'` }).where(claimGuard(capture)).returning({ id: syncReadWork.id })).length === 1;
  }).catch(error => { if (error instanceof SyncReadWorkChanged) return false; throw error; });
}
export async function deferSyncReadWork(capture: SyncReadWorkCapture, retryAtMs: number,
  options: { reason?: SyncReadDeferralKind } = {}) {
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253402300799999) throw new TypeError("Invalid sync retry time.");
  const reason = options.reason ?? "failure";
  if (!["optional-unavailable", "budget", "failure"].includes(reason)) throw new TypeError("Invalid sync deferral reason.");
  return releaseSyncReadWork(capture, retryAtMs, reason);
}
export async function releaseSyncReadWork(capture: SyncReadWorkCapture, retryAtMs?: number, reason?: SyncReadDeferralKind) {
  capture = structuredClone(capture);
  if (retryAtMs !== undefined && (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253402300799999)) throw new TypeError("Invalid sync retry time.");
  return db.transaction(async tx => {
    await tx.select({ id: syncReadWork.id }).from(syncReadWork).where(eq(syncReadWork.id, capture.workID)).for("update");
    const rows = await tx.update(syncReadWork).set({ claimToken: null, claimGeneration: null, leaseUntil: null, updatedAt: sql`clock_timestamp()`,
      ...(reason === undefined ? {} : { lastDeferralKind: reason }),
      ...(retryAtMs === undefined ? {} : { notBefore: sql`greatest(${syncReadWork.notBefore}, ${new Date(retryAtMs).toISOString()}::timestamptz)` }),
    }).where(claimGuard(capture)).returning({ id: syncReadWork.id });
    return rows.length === 1;
  });
}

/** Persist a native continuation's wake while preserving its exact live claim.
 * No source writes follow this final guard/work-row lock in this transaction. */
export async function postponeSyncReadWork(capture: SyncReadWorkCapture, retryAtMs: number) {
  capture = structuredClone(capture);
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs < 0 || retryAtMs > 253402300799999) throw new TypeError("Invalid sync retry time.");
  return db.transaction(async tx => {
    await assertSyncReadWorkCurrentInTransaction(tx, capture);
    return (await tx.update(syncReadWork).set({ notBefore: sql`greatest(${syncReadWork.notBefore}, ${new Date(retryAtMs).toISOString()}::timestamptz)`,
      updatedAt: sql`clock_timestamp()` }).where(claimGuard(capture)).returning({ id: syncReadWork.id })).length === 1;
  }).catch(error => { if (error instanceof SyncReadWorkChanged) return false; throw error; });
}

/** Read-only host status for strict generation waiters; never dispatch authority. */
export async function getSyncReadWorkStatus(workID: string) {
  const [result] = await db.select({ row: syncReadWork,
    notBeforeMs: sql<string>`ceil(extract(epoch from ${syncReadWork.notBefore})*1000)::text`,
    leaseUntilMs: sql<string | null>`ceil(extract(epoch from ${syncReadWork.leaseUntil})*1000)::text`,
  }).from(syncReadWork).where(eq(syncReadWork.id, workID));
  if (!result) return null;
  const { row } = result;
  return { workID: row.id, requestedGeneration: row.requestedGeneration.toString(), completedGeneration: row.completedGeneration.toString(),
    claimGeneration: row.claimGeneration?.toString() ?? null, claimToken: row.claimToken, bindingToken: row.bindingToken,
    retiredAt: row.retiredAt?.toISOString() ?? null, lastDeferralKind: row.lastDeferralKind,
    notBeforeEpochMs: Number(result.notBeforeMs), leaseUntilEpochMs: result.leaseUntilMs === null ? null : Number(result.leaseUntilMs),
    binding: rowAddress(row), connectionRowID: row.oauthAccountID ?? row.caldavAccountID! };
}
