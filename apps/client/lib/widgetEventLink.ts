import type { Event, OccurrenceIdentity } from "@musubi/types";
import { expandCalendarView } from "./calendarExpansion";

type WidgetLinkedEvent = Event & { occurrenceIdentity?: OccurrenceIdentity };

/** Resolve a display link against current definitions. A timestamp selects a
 * real occurrence; it never fabricates one or becomes a writable event ID. */
export function resolveWidgetEventLink(
  events: Event[], readableCalendarIds: ReadonlySet<string>, id: string,
  startValue: string | undefined, consumerTimeZone: string,
): WidgetLinkedEvent | undefined {
  const direct = events.find(event => event.id === id);
  const familyId = direct?.seriesID ?? direct?.id ?? id.replace(/_\d+$/, "");
  const family = events.filter(event => event.id === familyId || event.seriesID === familyId);
  if (!family.length) return;
  const readable = (event: Event) => !event.isCanceled
    && event.calendars.some(calendarId => readableCalendarIds.has(calendarId));
  if (startValue === undefined) return direct && readable(direct) ? direct : undefined;
  if (!/^-?\d+$/.test(startValue)) return;
  const startMs = Number(startValue);
  if (!Number.isSafeInteger(startMs) || !Number.isFinite(new Date(startMs).getTime())) return;
  // Keep every replacement in the family during substitution, including an
  // unreadable or cancelled exception, then apply current membership. Filtering
  // first could reopen the master's now-hidden original occurrence.
  const expanded = expandCalendarView<WidgetLinkedEvent>(family, new Date(startMs), new Date(startMs), {
    consumerTimeZone, strict: true, maxCandidates: 50000, maxOccurrences: 10000,
  });
  return expanded.events.find(event => event.start.getTime() === startMs && readable(event)
    && (!direct?.seriesID || event.id === direct.id));
}
