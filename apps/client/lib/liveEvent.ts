import { Event } from "@musubi/types";

// The open detail modal holds a snapshot; SSE keeps the store fresh. Read the
// live row so remote edits (links, renames, …) show without a reload. For
// recurring events keep the tapped occurrence's start/end (the store row
// carries the series master's times).
export function liveEventDetail(events: Event[], detail: Event | null): Event | null {
  if (!detail) return null;
  const live = events.find(e => e.id === detail.id);
  if (!live) return detail;
  return live.recurrence ? { ...live, start: detail.start, end: detail.end } : live;
}
