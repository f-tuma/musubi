import { randomUUID } from "node:crypto";
import { admitEventOperationInTransaction } from "./operation-admission";
import { retireKnownUnwrittenOutboxInTransaction } from "./outbox-causal-retirement";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Event } from "@musubi/types";
import { db } from "..";
import { eventOutbox } from "../schema";
import type { DbTransaction } from "./calendars";

export type EventOutboxIntent = Pick<
  typeof eventOutbox.$inferInsert,
  | "id"
  | "actorID"
  | "mutationID"
  | "position"
  | "eventID"
  | "calendarID"
  | "externalCalendarLinkID"
  | "provider"
  | "userID"
  | "accountID"
  | "externalCalendarID"
  | "externalEventID"
  | "expectedEtag"
  | "icalUid"
  | "action"
  | "payload"
>;

/** The entire caller transaction must abort on duplicate identity. In particular,
 * a retried fork must not commit a second event with no corresponding operation. */
export class DuplicateEventMutationError extends Error {
  constructor() {
    super(
      "This mutation identity has already been committed. Reconcile before retrying.",
    );
    this.name = "DuplicateEventMutationError";
  }
}

/** Serializes explicitly keyed attempts before event locks, including creates
 * whose primary key would otherwise hide a duplicate behind a generic DB error. */
export async function reserveEventMutation(
  tx: DbTransaction,
  eventID: string,
  intents: readonly EventOutboxIntent[],
) {
  const selected = intents.filter(
    (intent) => intent.eventID.toLowerCase() === eventID?.toLowerCase(),
  );
  if (!selected.length) return;
  const first = selected[0];
  if (
    selected.some(
      (intent) =>
        intent.actorID !== first.actorID ||
        intent.mutationID.toLowerCase() !== first.mutationID.toLowerCase(),
    )
  )
    throw new Error("An event mutation must have one actor and identity.");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${JSON.stringify(["musubi:event-mutation", first.actorID, first.mutationID.toLowerCase()])}, 0))`);
  for (const intent of selected) {
    const [existing] = await tx
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.actorID, intent.actorID),
          eq(eventOutbox.mutationID, intent.mutationID),
          eq(eventOutbox.position, intent.position),
        ),
      )
      .limit(1);
    if (existing) throw new DuplicateEventMutationError();
  }
}

/** Same-revision personal operations must sort after their predecessor even
 * when this transaction started earlier or the host clock moved backwards.
 * Keep microsecond arithmetic in PostgreSQL, not a millisecond JS Date. */
export function eventOutboxCreatedAt(eventID: string, linkID: string) {
  return sql<Date>`greatest(clock_timestamp(), coalesce((select max(created_at) + interval '1 microsecond' from event_outbox where event_id = ${eventID} and external_calendar_link_id = ${linkID}), clock_timestamp()))`;
}

/** Terminal evidence that a private Outlook update had no remote side effect. */
export function stoppedMicrosoftMeetingUpdate() {
  return sql`(${eventOutbox.status} = 'cancelled' and ${eventOutbox.provider} = 'microsoft' and ${eventOutbox.action} = 'update' and ${eventOutbox.payload}->'organizer' is not null and (
    (coalesce(${eventOutbox.errorCode} = 'organizer-not-dispatched', false) and ${eventOutbox.payload}->'organizer'->'dispatch' is null) or
    (coalesce(${eventOutbox.errorCode} = 'outlook-update-rejected', false) and ${eventOutbox.payload}->'organizer'->'dispatch'->>'startedAt' is not null and ${eventOutbox.payload}->'organizer'->'dispatch'->>'acceptedAt' is null)))`;
}
/** A family content intent may release its fence only with explicit no-write evidence. */
export function stoppedGraphOccurrenceContent() {
  return sql`(${eventOutbox.status} = 'cancelled' and ${eventOutbox.provider} = 'microsoft' and ${eventOutbox.action} = 'update' and ${eventOutbox.payload}->'graphOccurrenceContent' is not null and (
    (coalesce(${eventOutbox.errorCode} = 'organizer-not-dispatched', false) and ${eventOutbox.payload}->'graphOccurrenceContent'->'dispatch' is null) or
    (coalesce(${eventOutbox.errorCode} = 'outlook-update-rejected', false) and ${eventOutbox.payload}->'graphOccurrenceContent'->'dispatch'->>'startedAt' is not null and ${eventOutbox.payload}->'graphOccurrenceContent'->'dispatch'->>'acceptedAt' is null)))`;
}
/** Must be called inside the event's local transaction, after its CAS and before
 * COMMIT. No FK to events/maps: delete delivery must survive their removal. */
export async function appendEventOutbox(
  tx: DbTransaction,
  event: Event,
  intents: readonly EventOutboxIntent[],
) {
  for (const intent of intents.filter(
    (item) => item.eventID.toLowerCase() === event.id.toLowerCase(),
  )) {
    const retired = await retireKnownUnwrittenOutboxInTransaction(tx, intent, {
      kind: "event", id: event.id, privacyEpoch: `event:${event.providerReadRetiredRevision ?? 0}`,
    });
    const [predecessor] = await tx
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventID, event.id),
          eq(eventOutbox.calendarID, intent.calendarID),
          eq(eventOutbox.externalCalendarLinkID, intent.externalCalendarLinkID),
          retired.length ? sql`${eventOutbox.id} <> all(${sql.param(retired.map(row => row.id))}::uuid[])` : undefined,
          // A request stopped before its permanent dispatch marker has no
          // remote dependency for a newly observed replacement.
          sql`not (${eventOutbox.status} = 'cancelled' and coalesce(${eventOutbox.errorCode} = 'organizer-not-dispatched', false) and ${eventOutbox.payload}->'graphMeetingCancellation' is not null and ${eventOutbox.payload}->'graphMeetingCancellation'->'dispatch' is null)`,
          sql`not ${stoppedMicrosoftMeetingUpdate()}`,
          sql`not ${stoppedGraphOccurrenceContent()}`,
        ),
      )
      .orderBy(
        desc(eventOutbox.revision),
        desc(eventOutbox.createdAt),
        desc(eventOutbox.position),
      )
      .limit(1);
    const admittedIntent = intent.action === "update" && !intent.externalEventID && !predecessor &&
      retired.some(row => row.action === "create") ? { ...intent, action: "create" as const } : intent;
    const payload = await admitEventOperationInTransaction(tx, event, admittedIntent, predecessor?.id ?? null);
    let inserted: { id: string } | undefined;
    try {
      [inserted] = await tx
        .insert(eventOutbox)
        .values({
          ...admittedIntent,
          createdAt: eventOutboxCreatedAt(event.id, intent.externalCalendarLinkID),
          revision: event.revision!,
          predecessorID: predecessor?.id ?? null,
          payload,
        })
        .onConflictDoNothing()
        .returning({ id: eventOutbox.id });
    } catch {
      // Drizzle errors include bound JSON payloads. Never let those reach logs.
      throw new Error(
        "Event outbox persistence failed; local mutation was rolled back.",
      );
    }
    if (!inserted) throw new DuplicateEventMutationError();
  }
}

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export const EVENT_OUTBOX_LEASE_MS = 120_000;

/** Cancelled history is terminal except where it still blocks a successor. */
export function unresolvedEventOutbox() {
  return sql`(${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled') or (
    ${eventOutbox.status} = 'cancelled' and exists (
      select 1 from event_outbox successor where successor.predecessor_id = ${eventOutbox.id}
      and successor.status not in ('completed', 'not-needed', 'cancelled')
    )
  ))`;
}

/** Shared by claims and monitoring: waiting predecessors/active leases are not due. */
export function eligibleEventOutbox() {
  return sql`${eventOutbox.nextAttemptAt} <= clock_timestamp() and (
    ${eventOutbox.status} in ('pending', 'retry', 'unconfirmed') or
    (${eventOutbox.status} = 'attempting' and (${eventOutbox.leaseUntil} is null or ${eventOutbox.leaseUntil} <= clock_timestamp()))
  ) and (${eventOutbox.predecessorID} is null or exists (
    select 1 from event_outbox predecessor where predecessor.id = ${eventOutbox.predecessorID}
    and predecessor.status in ('completed', 'not-needed')
  ))`;
}

export async function getDueEventOutboxIDs(limit = 50) {
  return db
    .select({ id: eventOutbox.id })
    .from(eventOutbox)
    .where(eligibleEventOutbox())
    .orderBy(
      asc(eventOutbox.nextAttemptAt),
      asc(eventOutbox.createdAt),
      asc(eventOutbox.id),
    )
    .limit(limit);
}

export async function getEventOutboxBacklog() {
  return db
    .select({
      provider: eventOutbox.provider,
      status: eventOutbox.status,
      count: sql<number>`count(*)::int`,
      ageSeconds: sql<number>`greatest(0, extract(epoch from clock_timestamp() - min(${eventOutbox.createdAt})))::float`,
    })
    .from(eventOutbox)
    .where(
      sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`,
    )
    .groupBy(eventOutbox.provider, eventOutbox.status);
}

/** Short claim transaction; no network and no event/map locks. Every completion
 * is fenced by this claim's token. Expired attempts require reconciliation. */
export async function claimEventOutbox(id: string) {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(eventOutbox)
      .where(and(eq(eventOutbox.id, id), eligibleEventOutbox()))
      .for("update", { skipLocked: true });
    if (!previous) return undefined;
    const [row] = await tx
      .update(eventOutbox)
      .set({
        status: "attempting",
        attempts: sql`${eventOutbox.attempts} + 1`,
        attemptedAt: new Date(),
        updatedAt: new Date(),
        uncertain: true,
        leaseToken: randomUUID(),
        leaseUntil: sql`clock_timestamp() + interval '120 seconds'`,
      })
      .where(eq(eventOutbox.id, id))
      .returning();
    return {
      ...row,
      reconciling:
        previous.uncertain ||
        previous.status === "attempting" ||
        previous.status === "unconfirmed",
    };
  });
}

export async function renewEventOutboxLease(id: string, leaseToken: string) {
  const rows = await db
    .update(eventOutbox)
    .set({ leaseUntil: sql`clock_timestamp() + interval '120 seconds'` })
    .where(
      and(
        eq(eventOutbox.id, id),
        eq(eventOutbox.status, "attempting"),
        eq(eventOutbox.leaseToken, leaseToken),
        sql`${eventOutbox.leaseUntil} > clock_timestamp()`,
      ),
    )
    .returning({ id: eventOutbox.id });
  return rows.length === 1;
}

export async function setEventOutboxProjection(
  id: string,
  leaseToken: string,
  projection: NonNullable<EventOutboxRow["payload"]["providerProjection"]>,
) {
  const rows = await db
    .update(eventOutbox)
    .set({
      payload: sql`jsonb_set(${eventOutbox.payload}, '{providerProjection}', ${JSON.stringify(projection)}::jsonb)`,
    })
    .where(
      and(
        eq(eventOutbox.id, id),
        eq(eventOutbox.status, "attempting"),
        eq(eventOutbox.leaseToken, leaseToken),
        sql`${eventOutbox.leaseUntil} > clock_timestamp()`,
      ),
    )
    .returning({ id: eventOutbox.id });
  return rows.length === 1;
}

export async function finishEventOutbox(
  id: string,
  leaseToken: string,
  status: Exclude<EventOutboxRow["status"], "pending" | "attempting">,
  errorCode: string | null = null,
  details: Pick<
    Partial<EventOutboxRow>,
    "uncertain" | "nextAttemptAt" | "resultRef" | "remoteSnapshot"
  > = {},
) {
  const rows = await db
    .update(eventOutbox)
    .set({
      status,
      errorCode,
      updatedAt: new Date(),
      leaseToken: null,
      leaseUntil: null,
      uncertain: status === "unconfirmed",
      ...details,
    })
    .where(
      and(
        eq(eventOutbox.id, id),
        eq(eventOutbox.status, "attempting"),
        eq(eventOutbox.leaseToken, leaseToken),
        sql`${eventOutbox.leaseUntil} > clock_timestamp()`,
      ),
    )
    .returning({ id: eventOutbox.id });
  return rows.length === 1;
}
