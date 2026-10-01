import type { Calendar, Event, EventDeliveryInbox } from "@musubi/types";

export type NotificationAction =
  | { kind: "delivery"; eventId: string; connectionId?: string }
  | { kind: "event"; eventId: string }
  | { kind: "connections" };

export const eventNoticeKey = (origin: string, userId: string) => ["notifications", origin, userId, "event-changes"] as const;

export type AppNotification = {
  id: string;
  title: string;
  detail: string;
  /** Reading an unresolved failure must never hide the need to recover it. */
  needsAttention: boolean;
  action: NotificationAction;
};

/** A source owns discovery and lifetime; the center only presents its projection. */
export type NotificationSource = { id: string; items: AppNotification[] };

export type EventChangeNotice = {
  eventId: string;
  revision: number;
  kind: "event_created" | "event_updated" | "event_removed";
};

export function collectNotifications(sources: NotificationSource[]): AppNotification[] {
  return [...new Map(sources.flatMap(source => source.items.map(item => {
    const scoped = { ...item, id: `${source.id}:${item.id}` };
    return [scoped.id, scoped] as const;
  }))).values()];
}

export function deliveryNotifications(items: EventDeliveryInbox["items"], connectionId?: string): NotificationSource {
  return {
    id: `delivery:${connectionId ?? "home"}`,
    items: items.map(item => ({
      id: item.eventId,
      title: item.savedTitle || "Untitled event",
      detail: "Delivery needs attention",
      needsAttention: true,
      action: { kind: "delivery", eventId: item.eventId, connectionId },
    })),
  };
}

export function connectionNotifications(calendars: Calendar[]): NotificationSource {
  const accounts = new Map<string, Calendar>();
  for (const calendar of calendars) {
    if (calendar.syncStatus === "reconnect_required") {
      accounts.set(`${calendar.provider}:${calendar.accountId}`, calendar);
    }
  }
  return {
    id: "connections",
    items: [...accounts].map(([id, calendar]) => ({
      id,
      title: calendar.accountLabel ?? calendar.name,
      detail: "Reconnect account",
      needsAttention: true,
      action: { kind: "connections" },
    })),
  };
}

/** No titles from SSE are retained: project against today's readable data. */
export function eventNotifications(changes: EventChangeNotice[], events: Event[]): NotificationSource {
  const readable = new Map(events.map(event => [event.id, event]));
  return {
    id: "events",
    items: changes.flatMap(change => {
      const event = readable.get(change.eventId);
      // Permission loss and removal look alike in a snapshot. Do not retain or
      // expose a historical title, nor offer an action on an unreadable event.
      if (!event || (event.revision ?? 0) < change.revision || change.kind === "event_removed") return [];
      return [{
        id: `${change.eventId}:${change.revision}`,
        title: event.title || "Untitled event",
        detail: event.isCanceled ? "Cancelled by another member" : change.kind === "event_created" ? "Added by another member" : "Changed by another member",
        needsAttention: false,
        action: { kind: "event" as const, eventId: change.eventId },
      }];
    }),
  };
}

/** Unknown actors stay silent; own writes and duplicate/older frames are echoes. */
export function acceptEventNotice(
  current: EventChangeNotice[],
  message: { type?: string; payload?: Record<string, unknown> },
  userId: string,
): EventChangeNotice[] {
  const { type, payload } = message;
  if (type !== "event_created" && type !== "event_updated" && type !== "event_removed") return current;
  if (!payload || typeof payload.actorID !== "string" || payload.actorID === userId || typeof payload.id !== "string" || typeof payload.revision !== "number" || !Number.isSafeInteger(payload.revision) || payload.revision < 0) return current;
  const previous = current.find(item => item.eventId === payload.id);
  if (previous && previous.revision >= payload.revision) return current;
  const notice: EventChangeNotice = { eventId: payload.id, revision: payload.revision, kind: type };
  return [notice, ...current.filter(item => item.eventId !== payload.id)].slice(0, 100);
}
