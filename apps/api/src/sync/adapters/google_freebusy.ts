import { z } from "zod";
import { observedProviderRequest } from "../provider_http_metrics";
import type { AvailabilityRequest } from "@musubi/types";
const interval = z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).strict();
/** HTTP 200 alone does not prove this calendar's computation succeeded. */
export function normalizeGoogleFreebusy(input: unknown, calendarID: string, range: Pick<AvailabilityRequest, "start" | "end">) {
  const parsed = z.object({ kind: z.literal("calendar#freeBusy"), timeMin: z.iso.datetime({ offset: true }), timeMax: z.iso.datetime({ offset: true }), calendars: z.record(z.string(), z.unknown()) }).parse(input);
  if (Date.parse(parsed.timeMin) !== Date.parse(range.start) || Date.parse(parsed.timeMax) !== Date.parse(range.end)) throw new Error("Free/busy coverage changed");
  const calendar = z.object({ busy: z.array(interval).max(10000), errors: z.array(z.unknown()).optional() }).parse(parsed.calendars[calendarID]);
  if (calendar.errors?.length) throw new Error("Free/busy unavailable");
  const min = Date.parse(range.start), max = Date.parse(range.end);
  const clipped = calendar.busy.map(item => {
    const start = Date.parse(item.start), end = Date.parse(item.end);
    if (start >= end) throw new Error("Invalid busy interval");
    return { start: Math.max(start, min), end: Math.min(end, max) };
  }).filter(item => item.start < item.end).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const item of clipped) {
    const previous = merged[merged.length - 1];
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  return merged.map(item => ({ start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() }));
}
export async function queryGoogleFreebusy(token: string, calendarID: string, range: Pick<AvailabilityRequest, "start" | "end">, signal: AbortSignal, fetchImpl = fetch) {
  const response = await observedProviderRequest(fetchImpl, "https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST", redirect: "error", signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify({ timeMin: range.start, timeMax: range.end, timeZone: "UTC", calendarExpansionMax: 1, items: [{ id: calendarID }] }),
  });
  if (response.status !== 200 || response.headers.has("content-range")) throw new Error("Free/busy unavailable");
  return normalizeGoogleFreebusy(await response.json(), calendarID, range);
}
