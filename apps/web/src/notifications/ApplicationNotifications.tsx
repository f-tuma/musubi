import type { Calendar, Event, Settings } from "@musubi/types";
import { useState } from "react";
import { EventDeliveryDialog } from "~/calendar/components/EventDeliveryDialog";
import { NotificationCenter } from "./NotificationCenter";
import { useNotifications } from "./use-notifications";
import { NotificationEventDialog } from "./NotificationEventDialog";
import { canEditEvent } from "~/calendar/event-permissions";

type Props = {
  userId: string;
  calendars: Calendar[];
  events: Event[];
  offline?: boolean;
  onOpenConnections: (returnFocus: HTMLElement | null) => void;
  onEditEvent?: (event: Event) => void;
  timeFormat?: Settings["timeFormat"];
};

export function ApplicationNotifications({ userId, calendars, events, offline, onOpenConnections, onEditEvent, timeFormat }: Props) {
  const notifications = useNotifications(userId, calendars, events, offline);
  const [delivery, setDelivery] = useState<{ eventId: string; connectionId?: string; returnFocus: HTMLElement | null }>();
  const [selected, setSelected] = useState<{ eventId: string; returnFocus: HTMLElement | null }>();
  const selectedEvent = notifications.readableEvents.find(event => event.id === selected?.eventId);
  return <>
    <NotificationCenter
      items={notifications.items}
      readIds={notifications.readIds}
      loading={notifications.loading}
      error={notifications.error}
      eventError={notifications.eventError}
      hasMore={notifications.hasMore}
      onRead={notifications.read}
      onRefresh={notifications.refresh}
      onLoadMore={notifications.loadMore}
      onActivate={(item, returnFocus) => {
        if (item.action.kind === "delivery") setDelivery({ ...item.action, returnFocus });
        else if (item.action.kind === "connections") onOpenConnections(returnFocus);
        else setSelected({ eventId: item.action.eventId, returnFocus });
      }}
    />
    {delivery ? <EventDeliveryDialog
      userId={userId}
      eventId={delivery.eventId}
      connectionId={delivery.connectionId}
      returnFocus={delivery.returnFocus}
      onClose={() => setDelivery(undefined)}
    /> : null}
    {selected ? <NotificationEventDialog
      event={selectedEvent}
      error={notifications.eventError}
      loading={notifications.loading}
      timeFormat={timeFormat}
      returnFocus={selected.returnFocus}
      onClose={() => setSelected(undefined)}
      onRetry={notifications.refresh}
      onEdit={!offline && onEditEvent && selectedEvent && canEditEvent(selectedEvent, calendars) ? event => {
        setSelected(undefined);
        onEditEvent(event);
      } : undefined}
    /> : null}
  </>;
}
