import type { Calendar, Event } from "@musubi/types";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { getEventDeliveryInbox, getEvents } from "~/api/resources";
import { collectNotifications, connectionNotifications, deliveryNotifications, eventNoticeKey, eventNotifications, type EventChangeNotice } from "./model";

export function useNotifications(userId: string, calendars: Calendar[], events: Event[], offline = false) {
  const origin = getServerOrigin();
  const client = useQueryClient();
  const readKey = ["notifications", origin, userId, "read"] as const;
  const read = useQuery<string[]>({ queryKey: readKey, initialData: [], enabled: false, queryFn: () => [], gcTime: Infinity });
  const readIds = new Set(read.data);
  const deliveries = useInfiniteQuery({
    queryKey: [...queryKeys.delivery(origin, userId), "inbox"],
    queryFn: ({ pageParam, signal }) => getEventDeliveryInbox(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: !offline && userId !== "anonymous",
    retry: false,
  });
  const changes = useQuery<EventChangeNotice[]>({
    queryKey: eventNoticeKey(origin, userId),
    initialData: [],
    enabled: false,
    // Only SSE writes this session source. Never persist event snapshots.
    queryFn: () => [],
    gcTime: Infinity,
    meta: { persist: false },
  });
  // The normal calendar query covers one range. Notifications must also find
  // readable subjects elsewhere; this is the existing authenticated account
  // read, activated only after another member has actually changed an event.
  const accountEvents = useQuery({
    queryKey: ["events", origin, userId, "notification-subjects"],
    queryFn: ({ signal }) => getEvents(undefined, signal),
    enabled: !offline && (changes.data?.length ?? 0) > 0,
    retry: false,
    gcTime: 0,
    meta: { persist: false },
  });
  const items = collectNotifications([
    deliveryNotifications(deliveries.isError ? [] : deliveries.data?.pages.flatMap(page => page.items) ?? []),
    connectionNotifications(calendars),
    eventNotifications(changes.data ?? [], offline || accountEvents.isError ? [] : accountEvents.data?.events ?? events),
  ]);
  return {
    readableEvents: offline || accountEvents.isError ? [] : accountEvents.data?.events ?? events,
    items,
    readIds,
    loading: deliveries.isFetching || accountEvents.isFetching,
    error: deliveries.isError,
    eventError: accountEvents.isError,
    hasMore: deliveries.hasNextPage,
    read: (ids: string[]) => client.setQueryData<string[]>(readKey, current => [...new Set([...(current ?? []), ...ids])].slice(-1000)),
    refresh: () => {
      void deliveries.refetch();
      if ((changes.data?.length ?? 0) > 0) void accountEvents.refetch();
      void client.invalidateQueries({ queryKey: queryKeys.calendars(origin, userId) });
    },
    loadMore: () => { void deliveries.fetchNextPage(); },
  };
}
