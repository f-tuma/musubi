import { sql, type SQL } from "drizzle-orm";
import { db } from "..";
import { eventOutbox, taskOutbox } from "../schema";
import { eligibleEventOutbox, schedulableEventOutbox } from "./event-outbox";
import { eligibleTaskOutbox, schedulableTaskOutbox } from "./task-outbox";

export type SyncWorkFamily = "pull" | "event-delivery" | "task-delivery" | "outlook-move";
export type SyncWorkReference = Readonly<{ family: SyncWorkFamily; id: string }>;
export type SyncWorkCandidate = Readonly<{
  key: string; family: SyncWorkFamily; accountFairnessKey: string; laneKey: string;
  dueAtMs: number; orderKey: string; collisionKeys: readonly string[]; hostRef: SyncWorkReference;
}>;
export type SyncWorkCandidatePage = Readonly<{
  candidates: readonly SyncWorkCandidate[]; nextAccountCursor?: string; nextWakeAtMs?: number;
}>;
type CandidateRow = { id: string; family: SyncWorkFamily; account_key: string; lane_key: string;
  due_ms: string; order_key: string; collision_key: string };
const families: readonly SyncWorkFamily[] = ["pull", "event-delivery", "task-delivery", "outlook-move"];
/** Private scheduling hint shared by independent OAuth refresh and ordinary
 * physical-account work. PostgreSQL owns the exact jsonb text representation;
 * this does not establish grant/source authority or a provider quota identity. */
export async function getSyncPhysicalAccountFairnessKey(provider: "google" | "microsoft" | "caldav", physicalID: string): Promise<string> {
  if (!["google", "microsoft", "caldav"].includes(provider) || typeof physicalID !== "string" || !physicalID || physicalID.length > 2048) throw new TypeError("Invalid physical scheduling identity.");
  const result = await db.execute<{ key: string }>(sql`select md5(jsonb_build_array(${provider}::text,'physical'::text,${physicalID}::text)::text) as key`);
  return result.rows[0]!.key;
}
function candidate(row: CandidateRow): SyncWorkCandidate {
  return { key: `${row.family}:${row.id}`, family: row.family, accountFairnessKey: row.account_key,
    laneKey: row.lane_key, dueAtMs: Number(row.due_ms), orderKey: row.order_key,
    collisionKeys: [row.collision_key], hostRef: { family: row.family, id: row.id } };
}
function readScopeEligibility(): SQL {
  return sql`w.retired_at is null and w.requested_generation>w.completed_generation
    and (w.source_id is null or exists(select 1 from external_calendars s where s.id=w.source_id and not s.disabled and s.calendar_id is not null
      and s.source_generation=w.source_generation and s.provider_access_revision=w.provider_access_revision
      and s.read_configuration_fingerprint is not distinct from w.source_configuration_fingerprint))
    and (w.oauth_account_id is null or exists(select 1 from account a where a.id=w.oauth_account_id and a.sync_status='active'
      and coalesce(length(a.refresh_token),0)>0 and a.sync_read_generation=w.oauth_read_generation and a.scope is not distinct from w.oauth_scope))
    and (w.caldav_account_id is null or exists(select 1 from caldav_accounts d where d.id=w.caldav_account_id
      and to_char(d.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.US')=w.caldav_credential_revision))`;
}
/** No source/account inner joins on retained write rows: decoding and existing
 * executor claims/retirement/family checks retain all actual authority. */
function baseQuery(specific?: SyncWorkReference): SQL {
  const where = (family: SyncWorkFamily, eligible: SQL, id: SQL) => specific
    ? specific.family === family ? sql`${id}=${specific.id}::uuid` : sql`false` : eligible;
  return sql`
    select ${eventOutbox.id} as id,'event-delivery'::text as family,${eventOutbox.provider} as provider,
      ${eventOutbox.userID} as user_id,${eventOutbox.accountID} as account_id,
      ${eventOutbox.externalCalendarLinkID}::text as source_id,'events'::text as stream,
      null::text as physical_id,
      ${eventOutbox.nextAttemptAt} as due_at,${eventOutbox.createdAt} as created_at
    from ${eventOutbox} where ${where("event-delivery", eligibleEventOutbox(), sql`${eventOutbox.id}`)}
    union all
    select ${taskOutbox.id},'task-delivery',${taskOutbox.provider},${taskOutbox.userID},${taskOutbox.accountID},
      ${taskOutbox.externalCalendarLinkID}::text,'tasks',
      null::text,
      ${taskOutbox.nextAttemptAt},${taskOutbox.createdAt}
    from ${taskOutbox} where ${where("task-delivery", eligibleTaskOutbox(), sql`${taskOutbox.id}`)}
    union all
    select m.id,'outlook-move','microsoft',m.actor_id,m.journal->'initial'->'identity'->>'oauthAccountID',m.link_id::text,'events',null,
      m.next_attempt_at,m.created_at from outlook_moves m where ${where("outlook-move", sql`m.status='running' and m.next_attempt_at<=clock_timestamp() and (m.lease_until is null or m.lease_until<=clock_timestamp())`, sql`m.id`)}
    union all
    select w.id,'pull',w.provider,w.user_id,w.account_id,w.source_id::text,w.stream,
      coalesce(w.oauth_account_id,w.caldav_account_id::text),w.not_before,w.created_at
    from sync_read_work w where ${where("pull", sql`${readScopeEligibility()} and w.not_before<=clock_timestamp()
      and (w.lease_until is null or w.lease_until<=clock_timestamp())
      `, sql`w.id`)}`;
}
function keyedQuery(specific?: SyncWorkReference): SQL {
  // Only dirty reads supply a physical FK binding. Write payload captures are
  // retained operation data, never independent pool identities: legacy decoders
  // may ignore them, and an old physical capture must not split today's account.
  // Resolve the current unique owned address without filtering retained rows.
  return sql`with base as (${baseQuery(specific)}), resolved as (
    select b.*,coalesce(b.physical_id,
      case when b.provider='caldav' then (select d.id::text from caldav_accounts d where d.user_id=b.user_id and d.id::text=lower(b.account_id))
      else (select case when count(*)=1 then min(a.id) end from (select id from account where provider_id=b.provider and user_id=b.user_id and account_id=b.account_id limit 2) a) end) as resolved_physical_id
    from base b), accounts as (
    select r.*,md5(jsonb_build_array(provider,case when resolved_physical_id is null then 'logical' else 'physical' end,
      coalesce(resolved_physical_id,jsonb_build_array(user_id,account_id)::text))::text) as account_key from resolved r), keyed as (
    select a.*,md5(jsonb_build_array(account_key,source_id,stream)::text) as lane_key,
      md5(jsonb_build_array('collection',provider,user_id,account_id,coalesce(source_id,'account'))::text) as collision_key
    from accounts a)`;
}
const projection = sql`id,family,account_key,lane_key,ceil(extract(epoch from due_at)*1000)::text as due_ms,
  created_at::text||':'||id::text as order_key,collision_key`;
export async function getSyncWorkCandidate(reference: SyncWorkReference): Promise<SyncWorkCandidate | null> {
  if (!families.includes(reference.family)) throw new TypeError("Invalid work family.");
  const result = await db.execute<CandidateRow>(sql`${keyedQuery(reference)} select ${projection} from keyed limit 1`);
  return result.rows[0] ? candidate(result.rows[0]) : null;
}
/** Rank ALL eligible account/lane heads before the global limit. Rotating an
 * opaque account cursor prevents a static first-page prefix from starving B.
 * Metadata is advisory; existing executors still claim the selected exact ID. */
export async function getSyncWorkCandidates(input: {
  limit?: number; accountCursor?: string; excludedAccounts?: readonly string[];
  excludedCollisionKeys?: readonly string[]; families?: readonly SyncWorkFamily[];
} = {}): Promise<SyncWorkCandidatePage> {
  const limit = input.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || input.accountCursor !== undefined && !/^[a-f0-9]{32}$/.test(input.accountCursor) ||
    input.excludedAccounts && input.excludedAccounts.length > 1000 || input.excludedCollisionKeys && input.excludedCollisionKeys.length > 1000 ||
    input.families?.some(family => !families.includes(family))) throw new TypeError("Invalid work candidate page.");
  if (input.families?.length === 0) return { candidates: [] };
  const result = await db.execute<CandidateRow>(sql`${keyedQuery()}, lane_ranked as (
    select *,row_number() over(partition by account_key,lane_key,family order by due_at,created_at,id) as lane_round
    from keyed where not(account_key=any(${sql.param(input.excludedAccounts ?? [])}::text[]))
      and not(collision_key=any(${sql.param(input.excludedCollisionKeys ?? [])}::text[]))
      and family=any(${sql.param(input.families ?? families)}::text[])), family_ranked as (
    select *,row_number() over(partition by account_key,family order by lane_round,due_at,created_at,id) as family_round from lane_ranked), account_ranked as (
    select *,row_number() over(partition by account_key order by family_round,lane_round,due_at,created_at,family,id) as account_round from family_ranked)
    select ${projection} from account_ranked order by account_round,
      case when account_key>${input.accountCursor ?? ""} then 0 else 1 end,account_key,lane_round,due_at,created_at,id limit ${limit}`);
  const candidates = result.rows.map(candidate);
  const nextWakeAtMs = await getNextSyncWorkEligibility(input.families ?? families);
  return { candidates, ...(candidates.length ? { nextAccountCursor: candidates[candidates.length - 1]!.accountFairnessKey } : {}),
    ...(nextWakeAtMs === undefined ? {} : { nextWakeAtMs }) };
}

/** Future wake hint only. Shared schedulability predicates retain predecessor
 * and retained-history behavior while relaxing due/lease timing. A ready or
 * blocked old head never becomes a zero-delay busy-loop timer. */
export async function getNextSyncWorkEligibility(allowedFamilies: readonly SyncWorkFamily[] = families): Promise<number | undefined> {
  if (allowedFamilies.some(family => !families.includes(family))) throw new TypeError("Invalid work family.");
  if (!allowedFamilies.length) return undefined;
  const result = await db.execute<{ next_ms: string | null }>(sql`with timing as (
    select 'event-delivery'::text as family,greatest(${eventOutbox.nextAttemptAt},case when ${eventOutbox.status}='attempting' then coalesce(${eventOutbox.leaseUntil},${eventOutbox.nextAttemptAt}) else ${eventOutbox.nextAttemptAt} end) as at
      from ${eventOutbox} where ${schedulableEventOutbox()}
    union all select 'task-delivery',greatest(${taskOutbox.nextAttemptAt},case when ${taskOutbox.status}='attempting' then coalesce(${taskOutbox.leaseUntil},${taskOutbox.nextAttemptAt}) else ${taskOutbox.nextAttemptAt} end)
      from ${taskOutbox} where ${schedulableTaskOutbox()}
    union all select 'outlook-move',greatest(next_attempt_at,coalesce(lease_until,next_attempt_at)) from outlook_moves where status='running'
    union all select 'pull',greatest(w.not_before,coalesce(w.lease_until,w.not_before)) from sync_read_work w where ${readScopeEligibility()}
  ), current_clock as materialized(select clock_timestamp() as now)
  select ceil(extract(epoch from min(at))*1000)::text as next_ms from timing,current_clock
    where family=any(${sql.param(allowedFamilies)}::text[]) and at>current_clock.now`);
  const value = result.rows[0]?.next_ms;
  return value == null ? undefined : Number(value);
}
