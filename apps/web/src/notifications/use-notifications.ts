import type { Calendar, Event, Task } from "@musubi/types";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { getEventDeliveryInbox, getEvents, getTaskDeliveryInbox, getTasks } from "~/api/resources";
import { collectNotifications, connectionNotifications, deliveryNotifications, eventNoticeKey, eventNotifications, type EventChangeNotice, taskDeliveryNotifications, taskNotifications, taskNoticeKey, type TaskChangeNotice } from "./model";

export function useNotifications(userId: string, calendars: Calendar[], events: Event[], offline = false, tasks: Task[] = []) {
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
  const taskChanges = useQuery<TaskChangeNotice[]>({ queryKey: taskNoticeKey(origin, userId), initialData: [], enabled: false, queryFn: () => [], gcTime: Infinity, meta: { persist: false } });
  const accountTasks = useQuery({ queryKey: queryKeys.tasks(origin, userId), queryFn: ({ signal }) => getTasks(signal), enabled: !offline && (taskChanges.data?.length ?? 0) > 0, retry: false });
  const taskDeliveries = useInfiniteQuery({ queryKey: [...queryKeys.delivery(origin, userId), "task-inbox"], queryFn: ({ pageParam, signal }) => getTaskDeliveryInbox(pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined, enabled: !offline && userId !== "anonymous", retry: false });
  const readableTasks = offline || accountTasks.isError ? [] : accountTasks.data?.tasks ?? tasks;
  const items = collectNotifications([
    deliveryNotifications(deliveries.isError ? [] : deliveries.data?.pages.flatMap(page => page.items) ?? []),
    connectionNotifications(calendars),
    taskNotifications(taskChanges.data ?? [], readableTasks),
    taskDeliveryNotifications(taskDeliveries.isError ? [] : taskDeliveries.data?.pages.flatMap(page => page.items) ?? []),
    eventNotifications(changes.data ?? [], offline || accountEvents.isError ? [] : accountEvents.data?.events ?? events),
  ]);
  return {
    readableTasks,
    readableEvents: offline || accountEvents.isError ? [] : accountEvents.data?.events ?? events,
    items,
    readIds,
    loading: deliveries.isFetching || accountEvents.isFetching || taskDeliveries.isFetching || accountTasks.isFetching,
    error: deliveries.isError || taskDeliveries.isError,
    eventError: accountEvents.isError || accountTasks.isError,
    hasMore: deliveries.hasNextPage || taskDeliveries.hasNextPage,
    read: (ids: string[]) => client.setQueryData<string[]>(readKey, current => [...new Set([...(current ?? []), ...ids])].slice(-1000)),
    refresh: () => {
      void deliveries.refetch();
      void taskDeliveries.refetch();
      if ((taskChanges.data?.length ?? 0) > 0) void accountTasks.refetch();
      if ((changes.data?.length ?? 0) > 0) void accountEvents.refetch();
      void client.invalidateQueries({ queryKey: queryKeys.calendars(origin, userId) });
    },
    loadMore: () => { if (deliveries.hasNextPage) void deliveries.fetchNextPage(); if (taskDeliveries.hasNextPage) void taskDeliveries.fetchNextPage(); },
  };
}
