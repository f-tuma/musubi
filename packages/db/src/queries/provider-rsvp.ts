import { hasProviderSyncScopes } from "./oauth";
import type { DbTransaction } from "./calendars";
import { readGraphRsvpOccurrence } from "./graph-rsvp-occurrence";
import { readProviderRsvpInstance } from "./provider-rsvp-instance";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  isIcloudRsvpDestination,
  BadRequestError,
  EventSchema,
  EventWriteError,
  ForbiddenError,
  EventTimeModelSchema, type EventTimeModel,
  ProviderEventStateSchema,
  GoogleRsvpDeliverySchema, googleRsvpDeliveryPolicy, CaldavRsvpDeliverySchema, GraphRsvpDispatchSchema, microsoftRsvpTargetDesiredState, ProviderRsvpInstanceSchema, ProviderRsvpEditSchema, providerRsvpDesiredState, caldavRsvpDesiredState, type ProviderRsvpInstance, type ProviderRsvpEdit, type ProviderRsvpIntent, type Event,
} from "@musubi/types";
import { config } from "@musubi/config";
import { db } from "..";
import {
  account,
  caldavAccounts,
  calendarEvents,
  calendarMembers,
  events,
  eventOutbox,
  externalCalendars,
  externalEvents,
} from "../schema";
import { lockCalendarLifecycle, lockUserLifecycle } from "./calendar-lifecycle";
import { appendEventOutbox } from "./event-outbox";
import { providerStateVersion } from "./provider-reminders";
import { isDeepStrictEqual } from "node:util";
export type ProviderRsvpContext = { actorID: string; eventID: string; request: ProviderRsvpEdit; event: Event; mappingID: string; externalEventID: string; etag: string; icalUid: string | null; accountID: string; externalCalendarID: string; linkID: string; state: import("@musubi/types").ProviderEventState; instance?: ProviderRsvpInstance; graphOccurrence?: import("@musubi/types").GraphRsvpOccurrence };
export type ProviderRsvpReceipt = { operationID: string; replayed: boolean; status: string };
export type ProviderRsvpPreparation = { kind: "replay"; receipt: ProviderRsvpReceipt } | { kind: "prepared"; context: ProviderRsvpContext };
export async function prepareProviderRsvpEdit(actorID: string, eventID: string, input: unknown): Promise<ProviderRsvpPreparation> {
  return rsvpTransaction(actorID, eventID, input);
}
export async function commitProviderRsvpEdit(prepared: ProviderRsvpContext, baseline: Record<string, unknown>, nativeTime: EventTimeModel): Promise<ProviderRsvpReceipt> {
  const result = await rsvpTransaction(prepared.actorID, prepared.eventID, prepared.request, { context: prepared, baseline, nativeTime: EventTimeModelSchema.parse(nativeTime) });
  if (result.kind !== "replay") throw new Error("RSVP commit did not produce a receipt");
  return result.receipt;
}

/** All attendee RSVP admissions for a native family share one lock, including
 * old occurrence-only clients. Never queue independent sibling responses while
 * a series action may still be in flight. Rechecked before durable dispatch. */
async function lockGraphRsvpFamily(tx: DbTransaction, actorID: string, calendarID: string, eventID: string) {
  const [mapping] = await tx.select({ series: externalEvents.externalSeriesID }).from(externalEvents)
    .where(and(eq(externalEvents.eventID, eventID), eq(externalEvents.calendarID, calendarID), eq(externalEvents.provider, "microsoft")));
  if (!mapping?.series) return undefined;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["musubi:graph-rsvp-family", actorID, calendarID, mapping.series])}, 0))`);
  return mapping.series;
}
async function graphRsvpFamilyAvailable(executor: typeof db | DbTransaction, actorID: string, calendarID: string, seriesID: string, exceptID?: string) {
  const rows = await executor.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
    eq(eventOutbox.calendarID, calendarID), eq(eventOutbox.userID, actorID), eq(eventOutbox.provider, "microsoft"),
    exceptID ? sql`${eventOutbox.id} <> ${exceptID}` : undefined,
    sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`,
    sql`(${eventOutbox.payload}->'rsvp'->'graphOccurrence'->>'externalSeriesID' = ${seriesID}
      or ${eventOutbox.externalEventID} = ${seriesID}
      or exists (select 1 from external_events m where m.event_id = ${eventOutbox.eventID}
        and m.calendar_id = ${calendarID} and m.provider = 'microsoft' and m.external_series_id = ${seriesID}))`,
  )).limit(1);
  return rows.length === 0;
}

/** Queue one personal provider change. No event content/revision, social action,
 * local notification or other destination changes as a side effect. */
async function rsvpTransaction(
  actorID: string,
  eventID: string,
  input: unknown,
  prepared?: { context: ProviderRsvpContext; baseline: Record<string, unknown>; nativeTime: EventTimeModel },
): Promise<ProviderRsvpPreparation> {
  const request = ProviderRsvpEditSchema.parse(input);
  if (request.provider !== "google" && !config.api.providerRsvpEditsEnabled) throw new EventWriteError("event-write", "unsupported");
  eventID = eventID.toLowerCase();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["musubi:event-mutation", actorID, request.operationID])}, 0))`,
    );
    const [initial] = await tx
      .select({ calendarID: events.originCalendarID, seriesID: events.seriesID })
      .from(events)
      .where(eq(events.id, eventID));
    if (!initial?.calendarID)
      throw new ForbiddenError("A live connected source event is required.");
    if (request.provider === "caldav") await lockUserLifecycle(tx, [actorID], "shared");
    await lockCalendarLifecycle(tx, [initial.calendarID], "shared");
    const graphFamily = request.provider === "microsoft" ? await lockGraphRsvpFamily(tx, actorID, initial.calendarID, eventID) : undefined;
    if (initial.seriesID)
      await tx.select({ id: events.id }).from(events).where(eq(events.id, initial.seriesID)).for("update");
    const [event] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventID), isNull(events.deletedAt)))
      .for("update");
    if (!event || event.originCalendarID !== initial.calendarID || event.seriesID !== initial.seriesID)
      throw new ForbiddenError("The event source changed.");
    const [target] = await tx
      .select({ link: externalCalendars, role: calendarMembers.role })
      .from(externalCalendars)
      .innerJoin(
        calendarMembers,
        and(
          eq(calendarMembers.calendarID, externalCalendars.calendarID),
          eq(calendarMembers.userID, actorID),
        ),
      )
      .innerJoin(
        calendarEvents,
        and(
          eq(calendarEvents.calendarID, externalCalendars.calendarID),
          eq(calendarEvents.eventID, eventID),
        ),
      )
      .where(
        and(
          eq(externalCalendars.calendarID, initial.calendarID),
          eq(externalCalendars.userID, actorID),
          eq(externalCalendars.provider, request.provider),
          eq(externalCalendars.disabled, false),
          eq(externalCalendars.supportsEvents, true),
        ),
      )
      .for("share", { of: [calendarMembers, externalCalendars] });
    if (!target || !["owner", "editor"].includes(target.role))
      throw new ForbiddenError(
        "The connected source account must have write access.",
      );
    const [previous] = await tx
      .select()
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.actorID, actorID),
          eq(eventOutbox.mutationID, request.operationID),
        ),
      )
      .for("update");
    if (previous) {
      if (
        previous.externalCalendarLinkID !== target.link.id ||
        previous.accountID !== target.link.accountID
      )
        throw new ForbiddenError(
          "The connected source changed since this operation.",
        );
      if (
        previous.eventID !== eventID ||
        JSON.stringify(
          previous.payload.rsvp?.request &&
            ProviderRsvpEditSchema.parse(previous.payload.rsvp?.request),
        ) !== JSON.stringify(request)
      )
        throw new BadRequestError(
          "This operation ID was already used for another request.",
        );
      return { kind: "replay", receipt: { operationID: previous.id, replayed: true, status: previous.status } };
    }
    // Native time/series evidence must be verified before accepting its ETag.
    if (event.timeModel?.kind === "floating" || event.recurrence || event.isCanceled)
      throw new EventWriteError("event-write", "unsupported");
    const [mapping] = await tx
      .select()
      .from(externalEvents)
      .where(
        and(
          eq(externalEvents.eventID, eventID),
          eq(externalEvents.calendarID, initial.calendarID),
          eq(externalEvents.provider, request.provider),
          eq(externalEvents.externalCalendarID, target.link.externalCalendarID),
        ),
      )
      .for("update");
    if (
      !mapping?.etag ||
      (request.provider !== "microsoft" && mapping.etag.startsWith("W/")) ||
      !mapping.providerState
    )
      throw new EventWriteError("event-write", "unsupported");
    if (request.provider === "caldav" && (event.seriesID || event.originalStart || mapping.externalSeriesID || mapping.originalStart || !mapping.icalUid || !["zoned", "all-day"].includes(event.timeModel?.kind ?? ""))) throw new EventWriteError("event-write", "unsupported");
    const instance = request.provider === "google" ? await readProviderRsvpInstance(tx, event, mapping, actorID) : undefined;
    const graphOccurrence = request.provider === "microsoft" ? readGraphRsvpOccurrence(event, mapping, actorID) : undefined;
    if (request.provider === "microsoft" && (!mapping.icalUid || !!graphOccurrence !== !!request.scope || graphOccurrence?.externalSeriesID !== graphFamily)) throw new EventWriteError("event-write", "unsupported");
    if (graphOccurrence && !(await graphRsvpFamilyAvailable(tx, actorID, initial.calendarID, graphOccurrence.externalSeriesID)))
      throw new BadRequestError("This Outlook series has a pending operation. Reconcile it before responding.");
    if (
      event.revision !== request.expectedRevision ||
      providerStateVersion(mapping) !== request.expectedStateVersion
    )
      throw new BadRequestError(
        "Provider settings changed. Refresh before retrying.",
      );
    const pending = await tx
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventID, eventID),
          eq(eventOutbox.calendarID, initial.calendarID),
          sql`${eventOutbox.status} not in ('completed', 'not-needed', 'cancelled')`,
        ),
      )
      .limit(1);
    if (pending.length)
      throw new BadRequestError(
        "This source has a pending operation. Reconcile it before changing provider RSVP.",
      );
    const [latest] = await tx
      .select({ status: eventOutbox.status })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventID, eventID),
          eq(eventOutbox.calendarID, initial.calendarID),
          eq(eventOutbox.externalCalendarLinkID, target.link.id),
        ),
      )
      .orderBy(
        desc(eventOutbox.revision),
        desc(eventOutbox.createdAt),
        desc(eventOutbox.position),
      )
      .limit(1);
    if (latest?.status === "cancelled")
      throw new BadRequestError(
        "The previous source operation was cancelled. Reconcile delivery before changing provider RSVP.",
      );
    const links = await tx
      .select({ calendarID: calendarEvents.calendarID })
      .from(calendarEvents)
      .where(eq(calendarEvents.eventID, eventID));
    const snapshot = EventSchema.parse({
      ...event,
      calendars: links.map((link) => link.calendarID).sort(),
    });
    const state = ProviderEventStateSchema.parse(mapping.providerState);
    const desiredState = request.provider === "google" ? providerRsvpDesiredState(state, target.link.externalCalendarID, request.response) : prepared ? request.provider === "microsoft" ? microsoftRsvpTargetDesiredState(state, String(prepared.baseline.selfAddress), request.response, request.scope === "series") : caldavRsvpDesiredState(state, String(prepared.baseline.selfAddress), request.response) : state;
    const context: ProviderRsvpContext = { actorID, eventID, request, event: snapshot, mappingID: mapping.id, externalEventID: mapping.externalEventID, etag: mapping.etag, icalUid: mapping.icalUid, accountID: target.link.accountID, externalCalendarID: target.link.externalCalendarID, linkID: target.link.id, state, ...(instance ? { instance } : {}), ...(graphOccurrence ? { graphOccurrence } : {}) };
    if (!prepared) return { kind: "prepared", context };
    if (!isDeepStrictEqual(context, prepared.context)) throw new BadRequestError("RSVP source changed during provider verification.");
    if (request.provider === "caldav" && !(await hasCaldavRsvpBoundary({ userID: actorID, accountID: target.link.accountID, externalCalendarID: target.link.externalCalendarID, externalEventID: mapping.externalEventID }, prepared.baseline, tx, true)))
      throw new EventWriteError("event-write", "unsupported");
    // Raw evidence is server-internal and was normalized/compared by preflight.
    if (prepared.baseline.id !== mapping.externalEventID || prepared.baseline.etag !== mapping.etag)
      throw new BadRequestError("RSVP provider identity changed.");
    if (request.provider === "microsoft" && (request.scope === "series") !== Array.isArray(prepared.baseline.series)) throw new EventWriteError("event-write", "unsupported");
    const rsvp: ProviderRsvpIntent = { request, ...(request.provider === "google" ? { googleDelivery: GoogleRsvpDeliverySchema.parse({ kind: "google-rsvp-at-most-once", version: 1 }) } : {}), ...(request.provider === "caldav" ? { caldavDelivery: CaldavRsvpDeliverySchema.parse({ kind: "caldav-rsvp-at-most-once", version: 1 }) } : {}), baseline: prepared.baseline, nativeTime: prepared.nativeTime, ...(instance ? { instance } : {}), ...(graphOccurrence ? { graphOccurrence } : {}), baselineState: state, desiredState, mappingID: mapping.id };
    const id = randomUUID();
    await appendEventOutbox(tx, snapshot, [
      {
        id,
        actorID,
        mutationID: request.operationID,
        position: 0,
        eventID,
        calendarID: initial.calendarID,
        externalCalendarLinkID: target.link.id,
        provider: request.provider,
        userID: actorID,
        accountID: target.link.accountID,
        externalCalendarID: target.link.externalCalendarID,
        externalEventID: mapping.externalEventID,
        expectedEtag: mapping.etag,
        icalUid: mapping.icalUid,
        action: "update",
        payload: { event: snapshot, rsvp },
      },
    ]);
    return { kind: "replay", receipt: { operationID: id, replayed: false, status: "pending" } };
  });
}

/** Recheck a claimed intent's exact live source before provider work. */
export async function hasProviderRsvpSource(row: import("./event-outbox").EventOutboxRow, executor: typeof db | DbTransaction = db, lock = false): Promise<boolean> {
  const intent = row.payload.rsvp;
  if (!intent || !row.leaseToken || !["google", "caldav", "microsoft"].includes(row.provider) || intent.request.provider !== row.provider || row.action !== "update" || row.actorID !== row.userID) return false;
  const query = executor.select({ event: events, mapping: externalEvents, role: calendarMembers.role })
    .from(events)
    .innerJoin(eventOutbox, and(eq(eventOutbox.id, row.id), eq(eventOutbox.leaseToken, row.leaseToken), eq(eventOutbox.status, "attempting"), sql`${eventOutbox.leaseUntil} > clock_timestamp()`))
    .innerJoin(calendarEvents, and(eq(calendarEvents.eventID, events.id), eq(calendarEvents.calendarID, row.calendarID)))
    .innerJoin(calendarMembers, and(eq(calendarMembers.calendarID, row.calendarID), eq(calendarMembers.userID, row.actorID)))
    .innerJoin(externalCalendars, and(eq(externalCalendars.id, row.externalCalendarLinkID), eq(externalCalendars.calendarID, row.calendarID), eq(externalCalendars.userID, row.userID), eq(externalCalendars.accountID, row.accountID), eq(externalCalendars.provider, row.provider), eq(externalCalendars.externalCalendarID, row.externalCalendarID), eq(externalCalendars.disabled, false), eq(externalCalendars.supportsEvents, true)))
    .innerJoin(externalEvents, and(eq(externalEvents.id, intent.mappingID), eq(externalEvents.eventID, events.id), eq(externalEvents.calendarID, row.calendarID), eq(externalEvents.provider, row.provider), eq(externalEvents.externalCalendarID, row.externalCalendarID), eq(externalEvents.externalEventID, row.externalEventID!)))
    .where(and(eq(events.id, row.eventID), eq(events.originCalendarID, row.calendarID), isNull(events.deletedAt)));
  const [source] = lock ? await query.for("share", { of: [events, calendarEvents, calendarMembers, externalCalendars, externalEvents] }) : await query;
  if (!source || !["owner", "editor"].includes(source.role) || source.event.revision !== row.revision || source.mapping.etag !== row.expectedEtag || providerStateVersion(source.mapping) !== intent.request.expectedStateVersion) return false;
  try {
    if (row.provider === "caldav" && (!(await hasCaldavRsvpBoundary(row, intent.baseline, executor, lock)) || (intent.baseline.mode === "icloud-oneoff-attendee" && !CaldavRsvpDeliverySchema.safeParse(intent.caldavDelivery).success))) return false;
    if (row.provider === "microsoft") return config.api.providerRsvpEditsEnabled && !intent.instance && source.mapping.icalUid === row.icalUid &&
      (intent.request.provider === "microsoft" && !!intent.request.scope === !!intent.graphOccurrence && (intent.request.scope === "series") === Array.isArray(intent.baseline.series)) &&
      (!intent.graphOccurrence || await graphRsvpFamilyAvailable(executor, row.userID, row.calendarID, intent.graphOccurrence.externalSeriesID, row.id)) &&
      isDeepStrictEqual(readGraphRsvpOccurrence(source.event, source.mapping, row.userID), intent.graphOccurrence);
    if (row.provider !== "google") return config.api.providerRsvpEditsEnabled && !intent.instance && !source.event.seriesID && !source.event.originalStart && !source.event.recurrence && !source.event.isCanceled && !source.mapping.externalSeriesID && !source.mapping.originalStart && source.mapping.icalUid === row.icalUid;
    const current = await readProviderRsvpInstance(executor, source.event, source.mapping, row.userID);
    return isDeepStrictEqual(current, intent.instance);
  } catch { return false; }
}

/** Validate persisted evidence at every database trust boundary. Compatibility
 * cannot be inferred from absent tags or enabled configuration. */
export async function hasCaldavRsvpBoundary(
  destination: { userID: string; accountID: string; externalCalendarID: string; externalEventID: string | null },
  baseline: Record<string, unknown>, executor: typeof db | DbTransaction = db, lock = false,
): Promise<boolean> {
  if (!config.api.providerRsvpEditsEnabled) return false;
  const proof = baseline.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const evidence = proof as Record<string, unknown>;
  if (baseline.mode === undefined || baseline.mode === "strict")
    return typeof baseline.scheduleTag === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(baseline.scheduleTag) && evidence.compatibility === undefined && evidence.resourceWrite === undefined && evidence.scheduleTag === undefined;
  if (baseline.mode !== "icloud-oneoff-attendee" || baseline.scheduleTag !== null || evidence.compatibility !== "icloud-oneoff-attendee" || evidence.resourceWrite !== "empty-404" || evidence.scheduleTag !== "empty-404" || !config.api.icloudRsvpEditsEnabled || !destination.externalEventID) return false;
  const query = executor.select({ serverUrl: caldavAccounts.serverUrl, encryptedPassword: caldavAccounts.encryptedPassword }).from(caldavAccounts).where(and(eq(caldavAccounts.id, destination.accountID), eq(caldavAccounts.userID, destination.userID)));
  const [grant] = lock ? await query.for("share") : await query;
  return !!grant?.encryptedPassword && config.api.providerRsvpEditsEnabled && config.api.icloudRsvpEditsEnabled && isIcloudRsvpDestination(grant.serverUrl, destination.externalCalendarID, destination.externalEventID);
}

/** Opaque preview identity includes every native field, including unprojected
 * attendee comments. JSON object key ordering is not a provider edit. */
export function providerRsvpBaselineVersion(mappingID: string, baseline: Record<string, unknown>, instance?: ProviderRsvpInstance): string {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify([mappingID, ordered(baseline), ...(instance ? [ProviderRsvpInstanceSchema.parse(instance)] : [])])).digest("hex");
}

/** Irreversible permission to attempt ONE Graph response action. A persisted
 * marker is never cleared, including HTTP refusal, timeout or process death. */
export async function markGraphRsvpDispatched(row: import("./event-outbox").EventOutboxRow) {
  if (!config.api.providerRsvpEditsEnabled || row.provider !== "microsoft" || row.payload.rsvp?.request.provider !== "microsoft") return false;
  return db.transaction(async tx => {
    await lockUserLifecycle(tx, [row.userID], "shared");
    await lockCalendarLifecycle(tx, [row.calendarID], "shared");
    const family = await lockGraphRsvpFamily(tx, row.userID, row.calendarID, row.eventID);
    if (family !== row.payload.rsvp?.graphOccurrence?.externalSeriesID) return false;
    await tx.select({ id: events.id }).from(events).where(eq(events.id, row.eventID)).for("update");
    await tx.select({ id: eventOutbox.id }).from(eventOutbox).where(eq(eventOutbox.id, row.id)).for("update");
    if (!(await hasProviderRsvpSource(row, tx, true))) return false;
    const [grant] = await tx.select().from(account).where(and(eq(account.userId, row.userID), eq(account.providerId, "microsoft"), eq(account.accountId, row.accountID))).for("share");
    if (!grant || grant.syncStatus !== "active" || !grant.refreshToken || !hasProviderSyncScopes("microsoft", grant.scope ?? "") || !config.api.providerRsvpEditsEnabled) return false;
    const marker = GraphRsvpDispatchSchema.parse({ kind: "graph-rsvp-dispatch", version: 1, startedAt: new Date().toISOString() });
    const [marked] = await tx.update(eventOutbox).set({ payload: { ...row.payload, rsvp: { ...row.payload.rsvp!, graphDispatch: marker } }, uncertain: true, updatedAt: new Date() })
      .where(and(eq(eventOutbox.id, row.id), eq(eventOutbox.status, "attempting"), eq(eventOutbox.leaseToken, row.leaseToken!), sql`${eventOutbox.leaseUntil} > clock_timestamp()`, sql`${eventOutbox.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${eventOutbox.payload}->'rsvp'->'graphDispatch' is null`)).returning({ id: eventOutbox.id });
    return !!marked;
  });
}
export async function markGraphRsvpAccepted(id: string, leaseToken: string) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(eventOutbox).where(and(eq(eventOutbox.id, id), eq(eventOutbox.status, "attempting"), eq(eventOutbox.leaseToken, leaseToken), sql`${eventOutbox.leaseUntil} > clock_timestamp()`)).for("update");
    if (!row || row.payload.rsvp?.request.provider !== "microsoft") return false;
    const marker = GraphRsvpDispatchSchema.parse(row.payload.rsvp.graphDispatch);
    await tx.update(eventOutbox).set({ payload: { ...row.payload, rsvp: { ...row.payload.rsvp, graphDispatch: { ...marker, acceptedAt: new Date().toISOString() } } } }).where(eq(eventOutbox.id, id));
    return true;
  });
}

/** Commit irreversible permission for one CalDAV RSVP PUT. Persist before any
 * possible dispatch; neither refusal nor recovery may clear this marker. */
export async function markCaldavRsvpDispatched(row: import("./event-outbox").EventOutboxRow): Promise<boolean> {
  const intent = row.payload.rsvp;
  const policy = CaldavRsvpDeliverySchema.safeParse(intent?.caldavDelivery);
  const request = ProviderRsvpEditSchema.safeParse(intent?.request);
  if (!config.api.providerRsvpEditsEnabled || row.provider !== "caldav" || row.action !== "update" || !request.success || request.data.provider !== "caldav" || !policy.success || policy.data.startedAt !== undefined || request.data.expectedRevision !== row.revision) return false;
  return db.transaction(async tx => {
    await lockUserLifecycle(tx, [row.userID], "shared");
    await lockCalendarLifecycle(tx, [row.calendarID], "shared");
    await tx.select({ id: events.id }).from(events).where(eq(events.id, row.eventID)).for("update");
    const [current] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, row.id)).for("update");
    if (!current || (["actorID", "userID", "provider", "action", "eventID", "calendarID", "externalCalendarLinkID", "accountID", "externalCalendarID", "externalEventID", "expectedEtag", "icalUid", "revision", "mutationID"] as const).some(key => current[key] !== row[key])) return false;
    if (!(await hasProviderRsvpSource(row, tx, true))) return false;
    const [grant] = await tx.select({ id: caldavAccounts.id, encryptedPassword: caldavAccounts.encryptedPassword }).from(caldavAccounts).where(and(eq(caldavAccounts.id, row.accountID), eq(caldavAccounts.userID, row.userID))).for("share");
    if (!grant?.encryptedPassword || !config.api.providerRsvpEditsEnabled) return false;
    const marker = CaldavRsvpDeliverySchema.parse({ ...policy.data, startedAt: new Date().toISOString() });
    const [marked] = await tx.update(eventOutbox).set({ payload: { ...row.payload, rsvp: { ...intent!, caldavDelivery: marker } }, uncertain: true, updatedAt: new Date() })
      .where(and(eq(eventOutbox.id, row.id), eq(eventOutbox.status, "attempting"), eq(eventOutbox.leaseToken, row.leaseToken!), sql`${eventOutbox.leaseUntil} > clock_timestamp()`, sql`${eventOutbox.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${eventOutbox.payload}->'rsvp'->'caldavDelivery'->'startedAt' is null`)).returning({ id: eventOutbox.id });
    return !!marked;
  });
}


/** Snapshot all original data before yielding. Native history has no new size or
 * depth limits; accessors, callbacks and prototypes cannot become authority. */
function snapshotGoogleRsvpClaim<T>(input: T): T {
  const active = new Set<object>();
  const stack: { source: object; target: object; keys: (string | symbol)[]; index: number }[] = [];
  const allocate = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
      if (["function", "symbol", "bigint"].includes(typeof value)) throw new TypeError("Invalid Google RSVP claim");
      return value;
    }
    if (Object.getPrototypeOf(value) === Date.prototype) {
      if (Reflect.ownKeys(value).length) throw new TypeError("Invalid Google RSVP claim");
      return new Date(Date.prototype.getTime.call(value));
    }
    if (active.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new TypeError("Invalid Google RSVP claim");
    const target: object = Array.isArray(value) ? new Array(Object.getOwnPropertyDescriptor(value, "length")!.value) : {};
    active.add(value);
    stack.push({ source: value, target, keys: Reflect.ownKeys(value), index: 0 });
    return target;
  };
  const result = allocate(input);
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.keys.length) { active.delete(frame.source); stack.pop(); continue; }
    const key = frame.keys[frame.index++]!;
    if (Array.isArray(frame.source) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key)!;
    if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Invalid Google RSVP claim");
    const value = allocate(descriptor.value);
    Object.defineProperty(frame.target, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return result as T;
}
function googleRsvpClaimBasis(row: import("./event-outbox").EventOutboxRow & { reconciling?: boolean }) {
  // Lease renewal is allowed; every other persisted byte belongs to this claim.
  const { leaseUntil: _leaseUntil, updatedAt: _updatedAt, reconciling: _reconciling, ...basis } = row;
  return basis;
}
/** Commit permission for ONE Google attendee PATCH, never an acceptance or
 * notification receipt. Refusal, timeout, manual retry and process death retain
 * this marker forever. No HTTP operation may run inside this transaction. */
export async function markGoogleRsvpDispatched(input: import("./event-outbox").EventOutboxRow, signal?: AbortSignal): Promise<boolean> {
  const claimed = snapshotGoogleRsvpClaim(input);
  const policy = googleRsvpDeliveryPolicy(claimed.payload.rsvp);
  const request = ProviderRsvpEditSchema.safeParse(claimed.payload.rsvp?.request);
  if (!config.api.providerRsvpEditsEnabled || claimed.provider !== "google" || claimed.action !== "update" || claimed.status !== "attempting" || !claimed.leaseToken || claimed.actorID !== claimed.userID || !request.success || request.data.provider !== "google" || request.data.expectedRevision !== claimed.revision || policy.observeOnly || !policy.delivery) return false;
  const original = googleRsvpClaimBasis(claimed);
  const sameClaim = (current: import("./event-outbox").EventOutboxRow) => isDeepStrictEqual(googleRsvpClaimBasis(current), original);
  signal?.throwIfAborted();
  const marked = await db.transaction(async tx => {
    // A substituted caller must not borrow the actual row's source or locks.
    const [address] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, claimed.id));
    signal?.throwIfAborted();
    if (!address || !sameClaim(address)) return false;
    await lockUserLifecycle(tx, [claimed.userID], "shared"); signal?.throwIfAborted();
    await lockCalendarLifecycle(tx, [claimed.calendarID], "shared"); signal?.throwIfAborted();
    if (claimed.payload.rsvp!.instance) {
      await tx.select({ id: events.id }).from(events).where(eq(events.id, claimed.payload.rsvp!.instance.seriesID)).for("update"); signal?.throwIfAborted();
    }
    await tx.select({ id: events.id }).from(events).where(eq(events.id, claimed.eventID)).for("update"); signal?.throwIfAborted();
    const [current] = await tx.select().from(eventOutbox).where(eq(eventOutbox.id, claimed.id)).for("update"); signal?.throwIfAborted();
    if (!current || !sameClaim(current) || !(await hasProviderRsvpSource(current, tx, true))) return false;
    signal?.throwIfAborted();
    const [source] = await tx.select({ role: externalCalendars.providerAccessRole }).from(externalCalendars).where(eq(externalCalendars.id, current.externalCalendarLinkID)).for("share"); signal?.throwIfAborted();
    if (!source || (source.role !== null && source.role !== "owner")) return false;
    const [grant] = await tx.select().from(account).where(and(eq(account.userId, current.userID), eq(account.providerId, "google"), eq(account.accountId, current.accountID))).for("share"); signal?.throwIfAborted();
    if (!grant || grant.syncStatus !== "active" || !grant.refreshToken || !hasProviderSyncScopes("google", grant.scope ?? "") || !config.api.providerRsvpEditsEnabled) return false;
    // The UPDATE rechecks the database clock after every lock/pool wait. A late
    // abort throws out of the callback and rolls back an uncommitted marker.
    const marker = GoogleRsvpDeliverySchema.parse({ ...policy.delivery, startedAt: new Date().toISOString() });
    const [row] = await tx.update(eventOutbox).set({ payload: { ...current.payload, rsvp: { ...current.payload.rsvp!, googleDelivery: marker } }, uncertain: true, updatedAt: new Date() })
      .where(and(eq(eventOutbox.id, claimed.id), eq(eventOutbox.status, "attempting"), eq(eventOutbox.leaseToken, claimed.leaseToken!), sql`${eventOutbox.leaseUntil} > clock_timestamp()`, sql`${eventOutbox.payload} = ${JSON.stringify(claimed.payload)}::jsonb`, sql`${eventOutbox.payload}->'rsvp'->'googleDelivery'->'startedAt' is null`)).returning({ id: eventOutbox.id });
    signal?.throwIfAborted();
    return !!row;
  });
  // Cancellation during COMMIT can leave a permanent possible-send marker, but
  // must never let the native callback proceed to HTTP after the deadline.
  signal?.throwIfAborted();
  return marked;
}
