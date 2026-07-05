import * as Notifications from "expo-notifications";
import { Platform } from 'react-native';
import { Event } from "@musubi/types";
import { expandRecurringEvents } from "@musubi/calendar";
import { db } from "./db";
import { notificationsTable } from "@/db/schema";
import { eq } from "drizzle-orm";

// Local event reminders, modeled as DERIVED state: one row per event the user
// wants a reminder for ({eventID, identifier, offsetMinutes, triggerDate}).
// Any change to the event — local edit, SSE update, delta sync — goes through
// syncEventNotification/reconcileEventNotifications, which recompute the next
// trigger from the CURRENT event data and the stored offset. Recurring events
// always target the next future occurrence.

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// How far ahead to look for the next occurrence of a recurring event.
const OCCURRENCE_LOOKAHEAD_MS = 90 * 24 * 3600 * 1000;

// Next start of this event whose (start - offset) is still in the future,
// or null when nothing upcoming (past one-off, ended series, …).
function nextTrigger(event: Event, offsetMinutes: number): { trigger: Date; occurrenceStart: Date } | null {
  const now = Date.now();
  const offsetMs = offsetMinutes * 60_000;

  const candidates = event.recurrence
    ? expandRecurringEvents([event], new Date(now - offsetMs), new Date(now + OCCURRENCE_LOOKAHEAD_MS))
    : [event];

  for (const occ of candidates) {
    const start = new Date(occ.start);
    if (start.getTime() - offsetMs > now) {
      return { trigger: new Date(start.getTime() - offsetMs), occurrenceStart: start };
    }
  }
  return null;
}

async function schedule(event: Event, trigger: Date, occurrenceStart: Date): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: event.title,
      body: occurrenceStart.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: trigger },
  });
}

async function getRow(eventID: string) {
  const [row] = await db.select().from(notificationsTable)
    .where(eq(notificationsTable.eventID, eventID)).limit(1);
  return row ?? null;
}

/** The stored reminder config for an event (used to prefill the edit form). */
export async function getEventNotification(eventID: string) {
  return getRow(eventID);
}

/** Turn the reminder ON (or change its offset) for an event. */
export async function upsertEventNotification(event: Event, offsetMinutes: number) {
  const existing = await getRow(event.id);
  if (existing) await Notifications.cancelScheduledNotificationAsync(existing.identifier).catch(() => { });

  const next = nextTrigger(event, offsetMinutes);
  if (!next) { // nothing upcoming — drop any stale row
    if (existing) await db.delete(notificationsTable).where(eq(notificationsTable.eventID, event.id));
    return;
  }

  const identifier = await schedule(event, next.trigger, next.occurrenceStart);
  if (existing) {
    await db.update(notificationsTable)
      .set({ identifier, offsetMinutes, triggerDate: next.trigger.toISOString() })
      .where(eq(notificationsTable.eventID, event.id));
  } else {
    await db.insert(notificationsTable)
      .values({ identifier, eventID: event.id, offsetMinutes, triggerDate: next.trigger.toISOString() });
  }
}

/** Turn the reminder OFF / the event is gone. */
export async function cancelEventNotification(eventID: string) {
  const row = await getRow(eventID);
  if (!row) return;
  await Notifications.cancelScheduledNotificationAsync(row.identifier).catch(() => { });
  await db.delete(notificationsTable).where(eq(notificationsTable.eventID, eventID));
}

/** Event data changed (local edit, SSE, delta) — reschedule with the stored offset. */
export async function syncEventNotification(event: Event) {
  const row = await getRow(event.id);
  if (!row) return; // no reminder wanted for this event
  await upsertEventNotification(event, row.offsetMinutes);
}

/** Full sweep after a sync: drop reminders for gone events, refresh the rest. */
export async function reconcileEventNotifications(events: Event[]) {
  const byId = new Map(events.map(e => [e.id, e]));
  const rows = await db.select().from(notificationsTable);
  for (const row of rows) {
    const event = byId.get(row.eventID);
    if (!event) {
      await Notifications.cancelScheduledNotificationAsync(row.identifier).catch(() => { });
      await db.delete(notificationsTable).where(eq(notificationsTable.eventID, row.eventID));
    } else {
      await upsertEventNotification(event, row.offsetMinutes);
    }
  }
}

/** Sign-out / account deletion: the next account must not inherit reminders. */
export async function clearAllEventNotifications() {
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => { });
  await db.delete(notificationsTable);
}

export async function registerForPushNotificationsAsync() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("musubiChannel", {
      name: "Musubi Notifications",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7C",
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (finalStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  // Denied is a valid choice — no nagging alert on every launch.
  return finalStatus === "granted";
}
