import { useEffect, useMemo, useState } from "react";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays } from "@musubi/calendar/layout";
import { AVAILABILITY_SOURCE_LIMIT, type Settings } from "@musubi/types";
import { getServerCapabilities } from "~/api/resources";
import { getServerOrigin } from "~/api/query-keys";
import { getAvailability, getAvailabilitySources } from "./availability";
import { currentAvailabilityResult, type GridAvailabilityInterval } from "./availability-grid";
import { getTimeGridDays } from "./time-grid-math";
export function useGridAvailability({ userId, pageId, anchor, view, weekStartsOn, showWeekend, offline, listOpen }: { userId: string; pageId: string; anchor: Date; view: string; weekStartsOn: Settings["weekStartsOn"]; showWeekend: boolean; offline: boolean; listOpen: boolean }) {
  const client = useQueryClient();
  const origin = getServerOrigin();
  const scope = JSON.stringify([origin, userId, pageId]);
  const [selectedScope, setSelectedScope] = useState<string>();
  const capabilities = useQuery({ queryKey: ["server-capabilities", origin], queryFn: ({ signal }) => getServerCapabilities(signal), staleTime: 300000 });
  const available = (view === "day" || view === "week") && capabilities.data?.googleAvailability === true;
  const shown = available && selectedScope === scope;
  const selecting = useIsMutating({ mutationKey: ["availability-selection", origin, userId] }) > 0;
  const refreshing = useIsMutating({ mutationKey: ["connections-sync", origin, userId] }) > 0;
  const active = shown && !offline && !listOpen && !selecting && !refreshing;
  const days = getTimeGridDays(anchor, view === "day" ? "day" : "week", weekStartsOn, { includeWeekend: showWeekend });
  const start = days[0]!.toISOString(), end = addDays(days[days.length - 1]!, 1).toISOString();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sources = useQuery({ queryKey: ["availability", origin, userId, "sources"], queryFn: ({ signal }) => getAvailabilitySources(signal), enabled: active, retry: false, gcTime: 0, staleTime: 0, refetchInterval: active ? 30000 : false });
  const selected = sources.data?.sources.filter(source => source.enabled) ?? [];
  const signature = JSON.stringify(selected.map(source => [source.id, source.generation]));
  const prefix = useMemo(() => ["availability", origin, userId, "intervals", "grid", pageId], [origin, userId, pageId]);
  useEffect(() => {
    if (!active) return;
    return () => { void client.cancelQueries({ queryKey: prefix }); client.removeQueries({ queryKey: prefix }); };
  }, [active, client, prefix]);
  const result = useQuery({ queryKey: [...prefix, timezone, start, end, signature], enabled: active && selected.length > 0 && selected.length <= AVAILABILITY_SOURCE_LIMIT && !sources.isFetching && !sources.isError,
    queryFn: async ({ signal }) => {
      const value = await getAvailability({ start, end, sourceIds: selected.map(source => source.id) }, signal);
      if (!currentAvailabilityResult(value, selected, start, end)) throw new Error("Availability sources changed");
      return value;
    }, retry: false, gcTime: 0, staleTime: 0 });
  const current = active && !sources.isFetching && !sources.isError && !result.isFetching && !result.isError ? result.data : undefined;
  const intervals: GridAvailabilityInterval[] = current?.sources.flatMap(source => source.status === "available" ? source.intervals.map(interval => ({ ...interval, sourceId: source.sourceId, label: selected.find(item => item.id === source.sourceId)?.label ?? "Availability source" })) : []) ?? [];
  let notice: string | undefined;
  if (shown) {
    if (offline) notice = "Availability is unavailable offline. No free time is confirmed.";
    else if (refreshing) notice = "Connected calendars are refreshing. No free time is confirmed yet.";
    else if (selecting) notice = "Availability selection is changing. No free time is confirmed yet.";
    else if (sources.isError || result.isError) notice = "Availability could not be verified. No free time is confirmed; use Sources and intervals to retry.";
    else if (sources.isPending || sources.isFetching || result.isFetching) notice = "Checking selected availability. No free time is confirmed yet.";
    else if (!selected.length) notice = "No availability sources selected. Choose sources in Sources and intervals.";
    else if (selected.length > AVAILABILITY_SOURCE_LIMIT) notice = `Select up to ${AVAILABILITY_SOURCE_LIMIT} availability sources in Sources and intervals.`;
    else if (current) notice = current.sources.some(source => source.status !== "available") ? "Some availability sources are unavailable or need reconnection. Missing blocks do not confirm free time." : `Availability observed ${current.observedAt}. Busy intervals only for your selected sources.`;
  }
  return { available, shown, toggle: () => setSelectedScope(shown ? undefined : scope), intervals, notice };
}
