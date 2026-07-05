import { Event } from "@musubi/types";
import dayjs from "dayjs";

// Shared geometry, gesture tuning and date math for the custom calendar views.
export const HOUR_H = 64;          // px per hour on the timeline
export const GUTTER = 46;          // time-label column width
export const GRID_H = 24 * HOUR_H;
export const DOW_H = 26;           // weekday initials row in month view
export const INK = "#26241f";      // text on colored event blocks — palette is muted, ink reads on all

// ── Drag-to-create / draft manipulation tuning ──────────────────────────────
export const SNAP_DRAG_MIN = 15;   // minutes — drag resize/move snap
export const SNAP_TAP_MIN = 30;    // minutes — quick-tap draft snap
export const HOLD_CREATE_MS = 280; // hold before drag-to-create activates on the grid
export const HOLD_GRAB_MS = 150;   // hold before an existing draft can be grabbed
export const GRAB_EDGE_PX = 24;    // top/bottom strip of the ghost that resizes instead of moves
export const GRAB_SCALE = 1.04;    // "lifted" ghost scale while dragging
export const GRAB_SPRING = { damping: 30, stiffness: 400 };

// ── Month → day zoom ─────────────────────────────────────────────────────────
export const ZOOM_IN_MS = 300;
export const ZOOM_OUT_MS = 260;

export type Draft = { start: Date; end: Date };
export type Rect = { x: number; y: number; w: number; h: number };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const minutesToY = (m: number) => (m / 60) * HOUR_H;
export const yToMinutes = (y: number, snap: number) =>
  clamp(Math.round((y / HOUR_H) * 60 / snap) * snap, 0, 24 * 60 - snap);

export const startOfDay = (d: Date) => { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; };
export const addDays = (d: Date, n: number) => dayjs(d).add(n, "day").toDate();
export const addMonths = (d: Date, n: number) => dayjs(d).add(n, "month").toDate();
export const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const startOfWeek = (d: Date, weekStartsOn: 0 | 1) => {
  const day = startOfDay(d);
  const diff = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -diff);
};

// All-day events are stored at UTC midnight → key them in UTC, timed ones locally.
export const dayKeyOf = (d: Date, allDay: boolean) =>
  allDay ? d.toISOString().slice(0, 10) : dayjs(d).format("YYYY-MM-DD");
export const dayKey = (d: Date) => dayjs(d).format("YYYY-MM-DD");

// Every day an event touches → its key. End is exclusive for timed events
// (ends at 00:00 → doesn't bleed into the next day).
export function eventDayKeys(e: Event): string[] {
  const startKey = dayKeyOf(e.start, e.isAllDay);
  const endMs = e.isAllDay ? e.end.getTime() : Math.max(e.start.getTime(), e.end.getTime() - 1);
  const endKey = dayKeyOf(new Date(endMs), e.isAllDay);
  if (startKey === endKey) return [startKey];
  const keys: string[] = [];
  let cur = dayjs(startKey);
  while (cur.format("YYYY-MM-DD") <= endKey && keys.length < 60) {
    keys.push(cur.format("YYYY-MM-DD"));
    cur = cur.add(1, "day");
  }
  return keys;
}

export function bucketByDay(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    for (const k of eventDayKeys(e)) {
      const arr = map.get(k);
      arr ? arr.push(e) : map.set(k, [e]);
    }
  }
  // all-day chips first, then by start time (events arrive pre-sorted by start)
  for (const arr of map.values()) arr.sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay));
  return map;
}

// 6 rows × 7 days covering `month`, aligned to the week start.
export function monthGrid(month: Date, weekStartsOn: 0 | 1): Date[][] {
  const first = startOfWeek(dayjs(month).startOf("month").toDate(), weekStartsOn);
  return Array.from({ length: 6 }, (_, r) =>
    Array.from({ length: 7 }, (_, c) => addDays(first, r * 7 + c)));
}

// Timed events clipped to one day + greedy column assignment for overlaps.
export type Segment = { event: Event; startMin: number; endMin: number; col: number; cols: number };
export function daySegments(dayEvents: Event[], day: Date): Segment[] {
  const dayStart = startOfDay(day).getTime();
  const segs: Segment[] = [];
  for (const e of dayEvents) {
    if (e.isAllDay) continue;
    const startMin = clamp((e.start.getTime() - dayStart) / 60000, 0, 24 * 60);
    const endMin = clamp((Math.max(e.end.getTime(), e.start.getTime() + 60000) - dayStart) / 60000, 0, 24 * 60);
    if (endMin <= startMin) continue;
    segs.push({ event: e, startMin, endMin, col: 0, cols: 1 });
  }
  segs.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // cluster = run of transitively overlapping segments; columns shared within it
  let cluster: Segment[] = [];
  let colEnds: number[] = [];
  const flush = () => {
    for (const s of cluster) s.cols = colEnds.length;
    cluster = []; colEnds = [];
  };
  for (const s of segs) {
    if (cluster.length && Math.max(...colEnds) <= s.startMin) flush();
    let col = colEnds.findIndex(end => end <= s.startMin);
    if (col === -1) { col = colEnds.length; colEnds.push(0); }
    colEnds[col] = s.endMin;
    s.col = col;
    cluster.push(s);
  }
  flush();
  return segs;
}

export const fmtTime = (d: Date) => dayjs(d).format("H:mm");
