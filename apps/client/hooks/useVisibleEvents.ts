import { useMemo } from "react";
import { Event } from "@musubi/types";

export function useVisibleEvents(events: Event[], activeCals: Set<string>) {
  return useMemo(() => {
    const visibleEvents = events
      .filter(e => e.calendars.some(id => activeCals.has(id)))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    return { visibleEvents };
  }, [events, activeCals]);
}
