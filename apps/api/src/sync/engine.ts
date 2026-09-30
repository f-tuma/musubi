import { beginAvailabilityDiscovery, reconcileAvailabilitySources } from "@musubi/db";
import { deliverEventOutbox } from "./event_delivery";
import { deliverTaskOutbox as executeTaskOutbox } from "./task_delivery";
import { diffTaskProjection, jsonTaskProjection, ProviderTaskWriteError } from "./task_write";
import { randomUUID } from "node:crypto";
import { hasKnownEventTime, EventWriteError, type Event, type Task } from "@musubi/types";
import { config, logger } from "@musubi/config";
import {
  getDueEventOutboxIDs, getEventOutboxBacklog,
  getDueTaskOutboxIDs, getTaskMirrorReadCalendars,
  listGraphFamilyContexts, replaceGraphFamily, removeGraphFamily, type GraphFamilyContext, type GraphFamilyObservation,
  type EventOutboxIntent,
  deleteExternalEvent,
  deleteExternalTask,
  diffEventContent,
  getCalendarMembers,
  getEventCalendars,
  getExternalEvent,
  getExternalTask,
  assertExternalTaskPush,
  getDisabledExternalCalendarIDs,
  getExternalLinkForCalendar,
  getUserExternalCalendars,
  importExternalCalendar,
  importExternalEvent,
  importExternalTask,
  removeCalendar,
  removeGoogleCalendarMirrors,
  setAccountLabel,
  setCursor,
  setExternalCalendarCapabilities,
  setExternalEventSyncData,
  setExternalTaskSyncData,
  setMemberRole,
  reconcileGoogleCalendarAccess,
  reconcileMicrosoftCalendarAccess,
  reconcileCaldavReadAccess, caldavHasRead,
  getGoogleMirrorReadCalendars,
  sweepExternalEvents,
  sweepExternalTasks,
  upsertExternalEvent,
  replaceExternalEventResource,
  upsertExternalTask,
} from "@musubi/db";
import { notifyCalendarMembers } from "../handlers/stream";
import type {
  CalendarAdapter,
  EventWriteOperation,
  NormalizedEvent,
  NormalizedChange,
  NormalizedTask,
  TaskPreparedWrite,
} from "./adapter";
import { googleAdapter } from "./adapters/google";
import { caldavAdapter } from "./adapters/caldav";
import { microsoftAdapter } from "./adapters/microsoft";
import {
  isOptionalTaskError,
  isTransientSyncError,
  providerAuthErrorFields,
  ProviderAuthError,
} from "./errors";
import { recordExternalSyncFailure, recordEventOutboxBacklog, recordSyncRun, recordSyncObjects } from "../metrics";
import { ProviderEventWriteError, requireEventPatch } from "./event_write";
import { type ProviderSyncOptions, runProviderSyncs } from "./orchestrator";

// provider -> adapter. Register new providers here.
const adapters: Record<string, CalendarAdapter> = {
  google: googleAdapter,
  caldav: caldavAdapter,
  microsoft: microsoftAdapter,
};

export function getAdapter(provider: string): CalendarAdapter | null {
  return adapters[provider] ?? null;
}

export async function prepareTaskWrites(task: Task, actions: readonly { calendarID: string; action: "create" | "update" | "delete" }[]): Promise<TaskPreparedWrite[]> {
  const prepared: TaskPreparedWrite[] = [];
  for (const { calendarID, action } of actions) {
    const source = await getExternalLinkForCalendar(calendarID);
    if (!source) continue;
    const captured = { calendarID, action, externalCalendarLinkID: source.id, provider: source.provider, userID: source.userID, accountID: source.accountID, externalCalendarID: source.externalCalendarID, providerAccessRevision: source.providerAccessRevision };
    const adapter = getAdapter(source.provider);
    let projection = {};
    let baseline = null;
    let patch = {};
    let errorCode: string | undefined;
    try {
      if (source.disabled || !source.supportsTasks || !adapter?.projectTask || !adapter.assertTaskWrite) throw new ProviderTaskWriteError("task-source-read-only");
      const secondary = calendarID !== (task.originCalendarID ?? task.calendarID);
      if (secondary && action !== "delete" && task.recurrence) throw new ProviderTaskWriteError("task-recurrence-projection-unsupported");
      projection = jsonTaskProjection(adapter.projectTask(task));
      const external = await getExternalTask(source.provider, task.id, source.externalCalendarID, calendarID, { sourceID: source.id, accountID: source.accountID, providerAccessRevision: source.providerAccessRevision });
      baseline = external?.projectionBaseline ?? null;
      patch = baseline ? diffTaskProjection(baseline, projection) : projection;
      // A pending CREATE may not yet have an address. The immutable predecessor
      // resolves it in the executor; preflight never sends a speculative POST.
      if (action !== "delete" || external) await adapter.assertTaskWrite(source.userID, source.accountID, source.externalCalendarID, { task, action: action === "update" && !external ? "create" : action, external: external ?? undefined, projection, secondary });
    } catch (error) { errorCode = error instanceof ProviderTaskWriteError ? error.code : "task-write-failed"; }
    prepared.push({ ...captured, providerProjection: { version: 1, projection, baseline, patch, ...(errorCode ? { errorCode } : {}) } });
  }
  return prepared;
}

export async function deliverTaskOutbox(id: string, adapterFor: (provider: string) => CalendarAdapter | null = getAdapter) {
  const result = await executeTaskOutbox(id, adapterFor);
  if (result) {
    if (!["completed", "not-needed", "cancelled"].includes(result.status)) recordExternalSyncFailure("push", result.provider);
    const members = await getCalendarMembers(result.calendarID);
    notifyCalendarMembers([...new Set([result.userID, ...members.map(member => member.userID)])], "external_sync", { calendars: [result.calendarID] });
  }
  return result;
}

export async function drainTaskOutbox() {
  const candidates = await getDueTaskOutboxIDs(40);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < candidates.length) {
      const { id } = candidates[next++];
      try { await deliverTaskOutbox(id); }
      catch { logger.error("sync.task_outbox.persistence_failed", { code: "delivery-state-unavailable" }); }
    }
  }));
}

export async function deliverEventOutboxAndNotify(id: string) {
  try {
    const result = await deliverEventOutbox(id, getAdapter);
    if (!result) return;
    if (!["completed", "not-needed", "cancelled"].includes(result.status))
      recordExternalSyncFailure("push", result.provider);
    const members = await getCalendarMembers(result.calendarID);
    notifyCalendarMembers([...new Set([result.userID, ...members.map((member) => member.userID)])], "external_sync", { calendars: [result.calendarID] });
  } catch {
    // Never log driver-bound JSON or provider content. Persisted work survives.
    recordExternalSyncFailure("push", "all");
    logger.error("sync.event_outbox.persistence_failed", { code: "delivery-state-unavailable" });
  }
}

export async function drainEventOutbox() {
  const candidates = await getDueEventOutboxIDs(40);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < candidates.length) {
      const { id } = candidates[next++];
      await deliverEventOutboxAndNotify(id);
    }
  }));
  recordEventOutboxBacklog(await getEventOutboxBacklog());
}

// NormalizedEvent -> the primitive column values the DB layer expects.
// (organizer is NOT NULL in the schema; color comes from the calendar.)
function toEventValues(n: NormalizedEvent, calColor: string) {
  return {
    title: n.title,
    color: calColor,
    start: n.start,
    end: n.end,
    isAllDay: n.isAllDay,
    description: n.description,
    location: n.location,
    organizer: n.organizer ?? "",
    recurrence: n.recurrence,
    url: n.url,
  };
}

function toTaskValues(task: NormalizedTask) {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    start: task.start,
    due: task.due,
    isAllDay: task.isAllDay,
    completedAt: task.completedAt,
    percentComplete: task.percentComplete,
    priority: task.priority,
    recurrence: task.recurrence,
    relatedTo: task.relatedTo,
    sequence: task.sequence,
    url: task.url,
  };
}

type ExternalChangeWriter = {
  replaceResource?(externalID: string, events: NormalizedEvent[]): Promise<boolean>;
  deleteEvent(externalID: string): Promise<boolean>;
  deleteTask(externalID: string): Promise<boolean>;
  upsertEvent(event: NormalizedEvent): Promise<boolean>;
  upsertTask(task: NormalizedTask): Promise<boolean>;
  sweepEvents(seenExternalIDs: string[]): Promise<number>;
  sweepTasks(seenExternalIDs: string[]): Promise<number>;
};

/** Apply one complete provider collection delta without mixing VEVENT and VTODO sweeps. */
export async function reconcileExternalChanges(
  changes: NormalizedChange[],
  reset: boolean | undefined,
  writer: ExternalChangeWriter,
): Promise<number> {
  let changed = 0;
  const seenEvents: string[] = [];
  const seenTasks: string[] = [];

  for (const change of changes) {
    if (change.kind === "event-resource") {
      if (!writer.replaceResource) throw new Error("Complete event resource writer is unavailable.");
      seenEvents.push(...change.events.map(event => event.externalId));
      if (await writer.replaceResource(change.externalId, change.events)) changed++;
    } else if (change.kind === "event") {
      if (change.data.status === "cancelled") {
        if (await writer.deleteEvent(change.data.externalId)) changed++;
      } else {
        seenEvents.push(change.data.externalId);
        if (await writer.upsertEvent(change.data)) changed++;
      }
    } else if (change.data.deleted) {
      if (await writer.deleteTask(change.data.externalId)) changed++;
    } else {
      seenTasks.push(change.data.externalId);
      if (await writer.upsertTask(change.data)) changed++;
    }
  }

  if (reset) {
    changed += await writer.sweepEvents(seenEvents);
    changed += await writer.sweepTasks(seenTasks);
  }
  return changed;
}

async function reconcileMicrosoftAccessAndNotify(...args: Parameters<typeof reconcileMicrosoftCalendarAccess>) {
  const calendars = await reconcileMicrosoftCalendarAccess(...args);
  if (!calendars) return;
  const members = await Promise.all(calendars.map(id => getCalendarMembers(id)));
  notifyCalendarMembers([...new Set([args[0], ...members.flat().map(member => member.userID)])], "external_sync", { calendars });
}

async function reconcileCaldavAccessAndNotify(...args: Parameters<typeof reconcileCaldavReadAccess>) {
  const calendars = await reconcileCaldavReadAccess(...args);
  if (!calendars) return;
  const members = await Promise.all(calendars.map(id => getCalendarMembers(id)));
  notifyCalendarMembers([...new Set([args[0], ...members.flat().map(member => member.userID)])], "external_sync", { calendars });
}

async function reconcileGoogleAccessAndNotify(...args: Parameters<typeof reconcileGoogleCalendarAccess>) {
  const calendars = await reconcileGoogleCalendarAccess(...args);
  if (!calendars) return;
  const members = await Promise.all(calendars.map(id => getCalendarMembers(id)));
  // Publish the committed downgrade before any subsequent provider fetch can
  // fail. Linked-calendar readers must refresh the same shared canonical row.
  notifyCalendarMembers([...new Set([args[0], ...members.flat().map(member => member.userID)])], "external_sync", { calendars });
}

// A user who lost their last link is absent from subsequent event deltas.
// Include the accepted local revision so a delayed removal cannot evict a newer row.
async function notifyExternalEventUnlinks(
  calendarID: string,
  unlinks: { id: string; revision: number }[],
) {
  if (unlinks.length === 0) return;
  const previousMembers = await getCalendarMembers(calendarID);
  for (const { id, revision } of unlinks) {
    const remainingCalendars = await getEventCalendars(id);
    const remainingMembers = new Set<string>();
    for (const calendar of remainingCalendars) {
      for (const member of await getCalendarMembers(calendar))
        remainingMembers.add(member.userID);
    }
    notifyCalendarMembers(
      previousMembers
        .filter((member) => !remainingMembers.has(member.userID))
        .map((member) => member.userID),
      "event_removed",
      { id, revision },
    );
  }
}

// Pull: reconcile calendars, then pull each calendar's changes into Musubi. Scoped
// to ONE connected account of the provider.
async function syncProviderImpl(
  adapter: CalendarAdapter,
  userID: string,
  account: { id: string; label: string },
) {
  const startedAt = performance.now();
  const provider = adapter.provider;
  const accountId = account.id;

  logger.debug("sync.account.started", { provider, userId: userID, accountId });

  // keep the human label fresh on this account's calendars
  await setAccountLabel(provider, userID, accountId, account.label);

  // 1. reconcile the calendar list
  const availabilityContext = provider === "google" && config.api.googleAvailabilityEnabled ? await beginAvailabilityDiscovery(userID, accountId) : undefined;
  const { calendars: remote, taskListsComplete, availabilityCalendars } = await adapter.listCalendars(
    userID,
    accountId,
  );
  const remoteIDs = new Set(remote.map((c) => c.externalId));
  logger.debug("sync.account.calendars_discovered", {
    provider,
    userId: userID,
    accountId,
    calendars: remote.length,
  });

  // Google discovery only returns after all Events pages succeed; free/busy
  // grants are excluded from its authoritative detail-calendar set.
  const absent = (await getUserExternalCalendars(provider, userID, accountId)).filter(link =>
    !remoteIDs.has(link.externalCalendarID) &&
    (taskListsComplete || link.supportsEvents || !link.supportsTasks));
  const changedCalendarIDs: string[] = [];
  if (provider === "google" || provider === "microsoft" || provider === "caldav") {
    const removed = await removeGoogleCalendarMirrors(userID, accountId, absent.filter(link => provider === "caldav" || link.supportsEvents), provider as "google" | "microsoft" | "caldav");
    if (removed.calendarIDs.length) {
      // Memberships were captured before source deletion. Publish the committed
      // invalidation even when a later unrelated calendar fetch fails.
      notifyCalendarMembers(removed.userIDs, "external_sync", { calendars: removed.calendarIDs });
      changedCalendarIDs.push(...removed.calendarIDs);
    }
  }
  if (availabilityContext && availabilityCalendars) {
    await reconcileAvailabilitySources(userID, availabilityContext, availabilityCalendars, account.label);
    notifyCalendarMembers([userID], "external_sync", {});
  }
  for (const link of absent) {
    if (!["google", "microsoft", "caldav"].includes(provider) || provider !== "caldav" && !link.supportsEvents) await removeCalendar(link.calendarID);
  }
  // new remote calendar -> import; existing -> keep the read-only flag fresh
  // (also self-heals calendars imported before readOnly existed, e.g. holidays)
  const links = await getUserExternalCalendars(provider, userID, accountId);
  const disabled = new Set(
    await getDisabledExternalCalendarIDs(provider, userID, accountId),
  );
  for (const cal of remote) {
    if (disabled.has(cal.externalId)) continue; // user opted this calendar out of sync
    const desiredRole = cal.readOnly ? "viewer" : "owner";
    const capabilities = {
      supportsEvents: cal.supportsEvents ?? true,
      supportsTasks: cal.supportsTasks ?? false,
      providerDefaultCalendar: cal.providerDefaultCalendar ?? null,
    };
    const link = links.find((l) => l.externalCalendarID === cal.externalId);
    if (link) {
      if (provider === "google" && cal.googleAccessRole && capabilities.supportsEvents)
        await reconcileGoogleAccessAndNotify(userID, accountId, link.calendarID, cal.googleAccessRole);
      else if (provider === "microsoft" && cal.microsoftAccess && capabilities.supportsEvents) await reconcileMicrosoftAccessAndNotify(userID, accountId, link.calendarID, cal.microsoftAccess);
      else if (provider === "caldav" && cal.caldavAccess) await reconcileCaldavAccessAndNotify(userID, accountId, link.calendarID, cal.caldavAccess, !!cal.readOnly);
      else await setMemberRole(userID, link.calendarID, desiredRole);
      await setExternalCalendarCapabilities(
        provider,
        userID,
        accountId,
        cal.externalId,
        capabilities,
      );
    } else {
      const imported = await importExternalCalendar(
        provider,
        userID,
        accountId,
        account.label,
        cal,
        desiredRole,
      );
      if (provider === "google" && cal.googleAccessRole && capabilities.supportsEvents)
        await reconcileGoogleAccessAndNotify(userID, accountId, imported.id, cal.googleAccessRole);
      else if (provider === "microsoft" && cal.microsoftAccess && capabilities.supportsEvents) await reconcileMicrosoftAccessAndNotify(userID, accountId, imported.id, cal.microsoftAccess);
      else if (provider === "caldav" && cal.caldavAccess) await reconcileCaldavAccessAndNotify(userID, accountId, imported.id, cal.caldavAccess, !!cal.readOnly);
    }
  }

  // 2. pull objects per (now reconciled) calendar. Track which calendars really
  // changed so the scheduled sync can wake connected clients — the etag-aware
  // upsert makes a CalDAV full-fetch a quiet no-op when nothing moved.
  for (const link of await getUserExternalCalendars(
    provider,
    userID,
    accountId,
  )) {
    const accessContext = (provider === "caldav" || ["google", "microsoft"].includes(provider) && link.providerAccessRole !== null) && (link.supportsEvents || provider === "caldav" && link.supportsTasks) ? { provider: provider as "google" | "caldav" | "microsoft", linkID: link.sourceID, revision: link.providerAccessRevision, userID, accountID: accountId, externalCalendarID: link.externalCalendarID } : undefined;
    if (provider === "caldav" && caldavHasRead(link.providerAccessRole) === false) continue;
    const taskOnly = link.supportsTasks && !link.supportsEvents;
    if (taskOnly && !remoteIDs.has(link.externalCalendarID)) continue;
    const calendarStartedAt = performance.now();
    const taskReadStartedAt = new Date();
    let fetched;
    const families: { context: GraphFamilyContext; observation: GraphFamilyObservation | null }[] = [];
    const excludedEventIDs = new Set<string>(), excludedSeriesIDs = new Set<string>();
    try {
      if (provider === "microsoft" && !taskOnly) {
        for (const context of await listGraphFamilyContexts(userID, accountId, link.calendarID)) {
          if (!adapter.readGraphFamily) throw new Error("Complete Graph family reader is unavailable.");
          const mapping = context.mappings.find(value => value.eventID === context.root.id)!;
          const native = await adapter.readGraphFamily(userID, accountId, link.externalCalendarID, { ...context.root, calendars: [link.calendarID] }, { externalEventId: mapping.externalEventID, icalUid: mapping.icalUid, etag: mapping.etag });
          if (!native) {
            families.push({ context, observation: null });
            excludedSeriesIDs.add(mapping.externalEventID);
            for (const value of context.mappings) excludedEventIDs.add(value.externalEventID);
            continue;
          }
          const project = (event: NormalizedEvent): GraphFamilyObservation["master"] => {
            if (!event.timeModel || !event.icalUid || !event.providerState) throw new Error("Incomplete Graph family projection.");
            return { creationOperationID: event.creationOperationID, externalID: event.externalId, icalUid: event.icalUid, etag: event.etag ?? null, providerState: event.providerState, values: { ...toEventValues(event, link.calColor), timeModel: event.timeModel } };
          };
          const observation: GraphFamilyObservation = { master: project(native.master), instances: native.instances.map(value => {
            if (!value.originalStart) throw new Error("Missing Graph original identity.");
            return { ...project(value), originalStart: value.originalStart };
          }), cancelled: native.cancelled };
          families.push({ context, observation });
          excludedSeriesIDs.add(mapping.externalEventID);
          for (const id of [mapping.externalEventID, ...context.mappings.map(value => value.externalEventID), ...native.instances.map(value => value.externalId)]) excludedEventIDs.add(id);
        }
      }
      fetched = await adapter.fetchChanges(
        userID,
        accountId,
        link.externalCalendarID,
        link.cursor,
        families.length ? { excludedEventIDs: [...excludedEventIDs], excludedSeriesIDs: [...excludedSeriesIDs] } : undefined,
      );
    } catch (error) {
      if (
        !taskOnly ||
        (provider !== "google" && provider !== "microsoft") ||
        !isOptionalTaskError(error)
      )
        throw error;
      logger.warn("sync.tasks.fetch_unavailable", {
        provider,
        userId: userID,
        accountId,
        calendarId: link.calendarID,
      });
      continue;
    }
    const { changes, nextCursor } = fetched;
    // A grant-invalidated Google cursor requires authoritative reconciliation
    // even when known-time editing is disabled. The adapter fully pages this list.
    const reset = fetched.reset || (["google", "microsoft"].includes(provider) && !!accessContext && link.cursor === null);

    const unlinkedEventIDs: { id: string; revision: number }[] = [];
    const onUnlink = (id: string, revision: number) => {
      unlinkedEventIDs.push({ id, revision });
    };
    let changed = 0;
    let googleReadChanged = false;
    const trackGoogleRead = async <T extends boolean | number>(write: Promise<T>): Promise<T> => {
      const result = await write;
      if (["google", "microsoft", "caldav"].includes(provider) && result) googleReadChanged = true;
      return result;
    };
    const retainedGraphIDs = new Set<string>();
    const taskScope = { sourceID: link.sourceID, accountID: accountId, providerAccessRevision: link.providerAccessRevision, readStartedAt: taskReadStartedAt };
    try {
      for (const family of families) {
        const result = family.observation ? await replaceGraphFamily(family.context, family.observation) : await removeGraphFamily(family.context);
        if (result.changed) { changed++; googleReadChanged = true; }
        for (const id of result.seenExternalIDs) retainedGraphIDs.add(id);
      }
      changed += await reconcileExternalChanges(changes, reset, {
        replaceResource: (resourceID, observations) => trackGoogleRead(replaceExternalEventResource(provider, userID, link.calendarID, link.externalCalendarID, resourceID, observations.map(event => {
          if (!event.timeModel || !event.icalUid) throw new Error("Resource observation requires a time model and UID.");
          return { providerState: event.providerState, externalId: event.externalId, values: toEventValues(event, link.calColor), etag: event.etag ?? null, icalUid: event.icalUid, time: { timeModel: event.timeModel, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } };
        }), accessContext)),
        deleteEvent: (externalID) =>
          trackGoogleRead(deleteExternalEvent(provider, link.calendarID, externalID, onUnlink, accessContext)),
        deleteTask: (externalID) =>
          link.supportsTasks ? trackGoogleRead(deleteExternalTask(provider, link.calendarID, externalID, accessContext, taskScope)) : Promise.resolve(false),
        upsertEvent: (event) =>
          trackGoogleRead(upsertExternalEvent(
            provider,
            userID,
            link.calendarID,
            link.externalCalendarID,
            event.externalId,
            toEventValues(event, link.calColor),
            event.etag ?? null,
            event.icalUid ?? null,
            event.creationOperationID,
            event.timeModel ? { timeModel: event.timeModel, externalSeriesID: event.externalSeriesID, originalStart: event.originalStart, isCanceled: event.isCanceled } : undefined,
            event.providerOccurrence,
            event.providerState,
            event.reminderTimeEvidence,
            event.sourceSeriesID,
            accessContext,
          )),
        upsertTask: (task) =>
          link.supportsTasks ? trackGoogleRead(upsertExternalTask(
            provider,
            userID,
            link.calendarID,
            link.externalCalendarID,
            task.externalId,
            toTaskValues(task),
            task.etag ?? null,
            task.icalUid ?? null,
            accessContext,
            taskScope,
            adapter.projectTask?.({ ...toTaskValues(task), id: task.externalId, creatorID: userID, calendarID: link.calendarID }),
          )) : Promise.resolve(false),
        sweepEvents: (seenExternalIDs) =>
          trackGoogleRead(sweepExternalEvents(
            provider,
            link.calendarID,
            [...new Set([...seenExternalIDs, ...retainedGraphIDs])],
            onUnlink,
            accessContext,
          )),
        sweepTasks: (seenExternalIDs) =>
          link.supportsTasks ? trackGoogleRead(sweepExternalTasks(provider, link.calendarID, seenExternalIDs, accessContext, taskScope)) : Promise.resolve(0),
      });
    } finally {
      // Earlier unlinks have committed even if a later resource fails.
      await notifyExternalEventUnlinks(link.calendarID, unlinkedEventIDs);
      if (googleReadChanged) {
        const calendars = [...new Set([...await getGoogleMirrorReadCalendars(link.calendarID), ...await getTaskMirrorReadCalendars(link.calendarID)])];
        const members = await Promise.all(calendars.map(id => getCalendarMembers(id)));
        // Include committed partial reads if a later item fails. A linked-only
        // reader must hear about restoration as well as the earlier redaction.
        notifyCalendarMembers([...new Set([userID, ...members.flat().map(member => member.userID)])], "external_sync", { calendars });
        changedCalendarIDs.push(...calendars);
      }
    }

    if (changed > 0) changedCalendarIDs.push(link.calendarID);
    await setCursor(link.calendarID, nextCursor, accessContext);
    recordSyncObjects(provider, changes.filter(({ kind }) => kind === "event").length, changes.filter(({ kind }) => kind === "task").length);
    logger.debug("sync.calendar.completed", {
      provider,
      userId: userID,
      accountId,
      calendarId: link.calendarID,
      fetchedEvents: changes.filter(({ kind }) => kind === "event").length,
      fetchedTasks: changes.filter(({ kind }) => kind === "task").length,
      changedObjects: changed,
      fullSet: !!reset,
      durationMs: Math.round((performance.now() - calendarStartedAt) * 10) / 10,
    });
  }
  logger.debug("sync.account.completed", {
    provider,
    userId: userID,
    accountId,
    calendars: remote.length,
    changedCalendars: changedCalendarIDs.length,
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
  });
  return [...new Set(changedCalendarIDs)];
}

export async function syncProvider(...args: Parameters<typeof syncProviderImpl>) {
  const started = performance.now();
  try {
    const result = await syncProviderImpl(...args);
    recordSyncRun(args[0].provider, "success", (performance.now() - started) / 1000);
    return result;
  } catch (error) {
    recordSyncRun(args[0].provider, "failed", (performance.now() - started) / 1000);
    throw error;
  }
}

// Sync every connected account of every registered provider. listAccounts returns
// [] when the provider isn't connected, so unconnected providers are a clean no-op.
// When anything actually changed, the affected calendars' members get an SSE
// "external_sync" nudge — connected clients run a silent delta refresh, which is
// what makes provider changes land in the app without a manual pull-to-refresh.
export async function syncUser(
  userID: string,
  options: ProviderSyncOptions = {},
) {
  const changedCalendarIDs = await runProviderSyncs(
    Object.values(adapters),
    userID,
    options,
    {
      syncAccount: syncProvider,
      onFailure: ({ stage, provider, accountId, error }) => {
        recordExternalSyncFailure(stage, provider);
        // Provider/network hiccups are warn: the next poll retries them. error
        // is reserved for what a human has to act on (revoked grant, our bug).
        const level = isTransientSyncError(error) ? "warn" : "error";
        logger[level](
          stage === "discovery"
            ? "sync.provider.failed"
            : "sync.account.failed",
          {
            provider,
            userId: userID,
            ...(accountId ? { accountId } : {}),
            error,
            ...providerAuthErrorFields(error),
          },
        );
      },
    },
  );

  if (changedCalendarIDs.length > 0) {
    const memberIDs = new Set<string>();
    for (const cal of changedCalendarIDs) {
      for (const m of await getCalendarMembers(cal)) memberIDs.add(m.userID);
    }
    notifyCalendarMembers([...memberIDs], "external_sync", {
      calendars: changedCalendarIDs,
    });
  }
  return changedCalendarIDs;
}

export type CalendarEventWrite = Omit<EventWriteOperation, "external"> & {
  calendarIDs: string[];
};

export type EventDeliveryReceipt = {
  action: EventWriteOperation["action"];
  eventID: string;
  calendarID: string;
  provider: string;
  accountID: string;
  externalCalendarID: string;
  externalEventID?: string;
  status:
    | "not-attempted"
    | "completed"
    | "not-needed"
    | "conflict"
    | "not-written"
    | "unconfirmed";
};

/** Sanitized by the handler; individual delivery receipts do not imply
 * multi-target atomicity. Durable status is tracked separately in event_outbox. */
export class EventDeliveryError extends Error {
  constructor(
    readonly receipts: EventDeliveryReceipt[],
    readonly failure: Error,
  ) {
    super("Event provider delivery did not complete.");
    this.name = "EventDeliveryError";
  }
}

/** Validate the ENTIRE operation before returning a delivery function. Handlers
 * call this before touching event/link rows, including before removed-copy deletes.
 * Mutating handlers pass a durable identity and store .outbox in their local
 * transaction. The transient form is for capability-only preflight and adapter
 * boundary probes; it must not be used to deliver a local API mutation.
 */
export async function prepareEventWrites(
  writes: CalendarEventWrite[],
  durable?: { actorID: string; mutationID: string },
) {
  const prepared: Array<{
    outboxID?: string;
    operation: CalendarEventWrite;
    calendarID: string;
    link: NonNullable<Awaited<ReturnType<typeof getExternalLinkForCalendar>>>;
    adapter: CalendarAdapter;
    external: Awaited<ReturnType<typeof getExternalEvent>> | null;
    receipt: EventDeliveryReceipt;
  }> = [];
  for (const write of writes) {
    // Legacy handlers provide a server-read previous snapshot. This narrows
    // payloads, but is NOT local CAS. Next-stage CAS supplies its actual patch.
    const operation = structuredClone(write);
    if (
      operation.action === "update" &&
      operation.patch === undefined &&
      operation.previous
    ) {
      operation.patch = diffEventContent(operation.previous, operation.event);
    }
    for (const calendarID of new Set(operation.calendarIDs)) {
      const link = await getExternalLinkForCalendar(calendarID);
      if (!link) continue;
      if (hasKnownEventTime(operation.event))
        throw new EventWriteError("event-write", "unsupported", "This event requires a time-model-aware provider write. No changes were saved.");
      if (!link.supportsEvents)
        throw new EventWriteError("event-write", "unsupported");
      const adapter = getAdapter(link.provider);
      if (!adapter?.assertEventWrite)
        throw new EventWriteError("event-write", "unknown");
      const external =
        operation.action === "create"
          ? null
          : await getExternalEvent(
              link.provider,
              operation.event.id,
              link.externalCalendarID,
              calendarID,
            );
      if (operation.action === "update" && external)
        requireEventPatch(operation.patch);
      try {
        await adapter.assertEventWrite(
          link.userID,
          link.accountID,
          link.externalCalendarID,
          {
            ...operation,
            external: external ?? undefined,
          },
        );
      } catch (error) {
        if (
          error instanceof EventWriteError ||
          error instanceof ProviderAuthError ||
          error instanceof ProviderEventWriteError
        )
          throw error;
        throw new EventWriteError("event-write", "unknown");
      }
      prepared.push({
        operation,
        calendarID,
        link,
        adapter,
        external,
        receipt: {
          action: operation.action,
          eventID: operation.event.id,
          calendarID,
          provider: link.provider,
          accountID: link.accountID,
          externalCalendarID: link.externalCalendarID,
          externalEventID: external?.externalEventId,
          status: "not-attempted",
        },
      });
    }
  }
  const outbox: EventOutboxIntent[] = [];
  if (durable) {
    for (const item of prepared) {
      const { operation, link, external, calendarID } = item;
      if (
        operation.action === "update" &&
        !Object.keys(operation.patch ?? {}).length
      )
        continue;
      item.outboxID = randomUUID();
      outbox.push({
        id: item.outboxID,
        ...durable,
        position: outbox.length,
        eventID: operation.event.id,
        calendarID,
        externalCalendarLinkID: link.id,
        provider: link.provider,
        userID: link.userID,
        accountID: link.accountID,
        externalCalendarID: link.externalCalendarID,
        externalEventID: external?.externalEventId ?? null,
        expectedEtag: external?.etag ?? null,
        icalUid: external?.icalUid ?? null,
        action: operation.action,
        payload: {
          event: operation.event,
          patch: operation.patch,
          scopeEditValidated: operation.scopeEditValidated,
          createIdentityVersion: 1,
          providerProjection: item.adapter.projectEvent?.(operation.event),
        },
      });
    }
  }
  let failure: EventDeliveryError | undefined;
  const deliver = async (
    onlyAction?: EventWriteOperation["action"],
    committedRevision?: number | ReadonlyMap<string, number>,
  ) => {
    if (failure) throw failure;
    for (const item of prepared) {
      const { outboxID, operation, calendarID, adapter, receipt } = item;
      let { link, external } = item;
      let acceptedRevision =
        typeof committedRevision === "number"
          ? committedRevision
          : committedRevision?.get(operation.event.id);
      const { action } = operation;
      let event = operation.event;
      if (onlyAction && action !== onlyAction) continue;
      // A closure is single-attempt; calling it again cannot retry a conflict
      // or re-send completed creates/deletes. Reconciliation is a new request.
      if (receipt.status !== "not-attempted") continue;
      try {
        if (durable) {
          if (!outboxID) {
            receipt.status =
              action === "update" && external ? "completed" : "not-needed";
            continue;
          }
          const stored = await deliverEventOutbox(outboxID, getAdapter);
          if (stored?.resultRef) receipt.externalEventID = stored.resultRef.externalEventId;
          if (stored?.status === "completed" || stored?.status === "not-needed") {
            receipt.status = stored.status;
            continue;
          }
          throw new ProviderEventWriteError(
            stored?.status === "conflict" ? "provider-conflict" : "provider-write-failed",
            stored?.uncertain || !stored || ["attempting", "pending", "retry", "unconfirmed"].includes(stored.status)
              ? "unconfirmed" : "not-written",
          );
        }
        if (action === "create") {
          const external = await adapter.pushCreate(
            link.userID,
            link.accountID,
            link.externalCalendarID,
            event,
          );
          receipt.externalEventID = external.externalEventId;
          const accepted = await importExternalEvent(
            link.provider,
            event.id,
            calendarID,
            link.externalCalendarID,
            external.externalEventId,
            external.etag ?? null,
            external.icalUid ?? null,
            acceptedRevision,
          );
          if (!accepted)
            throw new ProviderEventWriteError(
              "provider-write-failed",
              "unconfirmed",
            );
        } else {
          if (!external) {
            receipt.status = "not-needed";
            continue;
          }
          if (action === "update") {
            const result = await adapter.pushUpdate(
              link.userID,
              link.accountID,
              link.externalCalendarID,
              external.externalEventId,
              event,
              external,
              operation.patch,
            );
            if (result) {
              const accepted = await setExternalEventSyncData(
                link.provider,
                event.id,
                link.externalCalendarID,
                {
                  etag: result.etag ?? null,
                  icalUid: result.icalUid ?? external.icalUid ?? null,
                },
                calendarID,
                acceptedRevision === undefined
                  ? undefined
                  : {
                      revision: acceptedRevision,
                      etag: external.etag,
                      externalEventID: external.externalEventId,
                    },
              );
              if (!accepted)
                throw new ProviderEventWriteError(
                  "provider-write-failed",
                  "unconfirmed",
                );
            }
          } else {
            await adapter.pushDelete(
              link.userID,
              link.accountID,
              link.externalCalendarID,
              external.externalEventId,
              external,
            );
          }
        }
        receipt.status = "completed";
      } catch (e) {
        receipt.status =
          e instanceof ProviderEventWriteError
            ? e.code === "provider-conflict"
              ? "conflict"
              : e.outcome
            : "unconfirmed";
        recordExternalSyncFailure("push", link.provider);
        logger.error("sync.push.failed", {
          action,
          provider: link.provider,
          userId: link.userID,
          accountId: link.accountID,
          calendarId: calendarID,
          eventId: event.id,
          error: e,
        });
        failure = new EventDeliveryError(
          prepared.map(({ receipt }) => ({ ...receipt })),
          e instanceof Error
            ? e
            : new Error("Unknown provider delivery failure"),
        );
        throw failure;
      }
    }
    return prepared.map(({ receipt }) => ({ ...receipt }));
  };
  return Object.assign(deliver, { outbox });
}

export async function pushTaskToCalendar(
  task: Task,
  action: "create" | "update" | "delete",
) {
  const link = await getExternalLinkForCalendar(task.calendarID);
  if (!link?.supportsTasks) return;
  const adapter = getAdapter(link.provider);
  if (
    !adapter?.pushTaskCreate ||
    !adapter.pushTaskUpdate ||
    !adapter.pushTaskDelete
  )
    return;

  const accessContext = link.provider === "caldav" ? { provider: "caldav" as const, linkID: link.id, revision: link.providerAccessRevision, userID: link.userID, accountID: link.accountID, externalCalendarID: link.externalCalendarID } : undefined;
  const scope = { sourceID: link.id, accountID: link.accountID, providerAccessRevision: link.providerAccessRevision };
  const beforeMutation = async () => { if (accessContext) await assertExternalTaskPush(task, accessContext); };
  try {
    await beforeMutation();
    const external = await getExternalTask(
      link.provider,
      task.id,
      link.externalCalendarID,
      task.calendarID,
      scope,
    );
    if (action === "delete") {
      if (!external) return;
      await adapter.pushTaskDelete(
        link.userID,
        link.accountID,
        link.externalCalendarID,
        external.externalTaskId,
        { ...external, beforeMutation },
      );
      return;
    }

    if (!external) {
      const created = await adapter.pushTaskCreate(
        link.userID,
        link.accountID,
        link.externalCalendarID,
        task,
        beforeMutation,
      );
      await beforeMutation();
      await importExternalTask(
        link.provider,
        task.id,
        task.calendarID,
        link.externalCalendarID,
        created.externalTaskId,
        created.etag ?? null,
        created.icalUid ?? null,
        accessContext ? { task, context: accessContext } : undefined,
      );
      return;
    }

    const result = await adapter.pushTaskUpdate(
      link.userID,
      link.accountID,
      link.externalCalendarID,
      external.externalTaskId,
      task,
      { ...external, beforeMutation },
    );
    if (result) {
      await beforeMutation();
      await setExternalTaskSyncData(
        link.provider,
        task.id,
        link.externalCalendarID,
        {
          etag: result.etag ?? null,
          icalUid: result.icalUid ?? external.icalUid ?? null,
        },
        accessContext ? { task, context: accessContext } : undefined,
        task.calendarID,
        scope,
      );
    }
  } catch (error) {
    recordExternalSyncFailure("push", link.provider);
    logger.error("sync.task.push.failed", {
      action,
      provider: link.provider,
      userId: link.userID,
      accountId: link.accountID,
      calendarId: task.calendarID,
      taskId: task.id,
      error,
    });
  }
}
