// One flattened ordering used everywhere calendars line up (Calendars tab,
// filter-bar pills, add-event pills): Musubi group first, personal calendar
// pinned on top, then the user's saved drag order (user_settings.calendarOrder).
// Calendars not in the saved order (new/never reordered) keep their natural
// position at the end of their group — the sort is stable.
type Orderable = { id: string; provider?: string | null; isDefault?: boolean | null };

export function sortCalendars<T extends Orderable>(calendars: T[], order: string[]): T[] {
  const idx = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...calendars].sort((a, b) =>
    (a.provider ? 1 : 0) - (b.provider ? 1 : 0)
    || (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)
    || idx(a.id) - idx(b.id));
}
