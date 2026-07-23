import { AddEventModal } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { colors, fonts, styles } from "@/constants/theme";
import { Event } from "@musubi/types";
import { eventDay, expandRecurringEvents } from "@musubi/calendar";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { presentEventDetail } from "@/store/useEventDetailStore";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Tap } from "@/components/ui/Tap";
import { Empty } from "@/components/ui/Empty";
import { YearStamp } from "@/components/calendar/YearStamp";
import { useRefreshData } from "@/hooks/useRefreshData";
import { eventColor } from "@/lib/eventColor";
import { useSettingsStore } from "@/store/useSettingsStore";
import { formatTime } from "@/lib/datetimeFormat";
import { useLocalSearchParams } from "expo-router";
import * as Linking from "expo-linking";
import { showToast } from "@/components/ui/Toast";
import { userFacingError } from "@/lib/network";
import { useCurrentDay } from "@/hooks/useCurrentDay";



const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

const PAGE = 14;
const RECURRENCE_HORIZON_YEARS = 2;

export default function AgendaTab() {
  const api = useApi();
  const { events, addEvent, updateEvent } = useEventsStore();
  const { calendars, activeCals, soloCalId, toggleCal, soloCalendar, syncActiveCals } = useCalendarsStore();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const { eventId, occurrenceStart } = useLocalSearchParams<{
    eventId?: string;
    occurrenceStart?: string;
  }>();
  useEffect(() => {
    syncActiveCals(calendars);
  }, [calendars]);

  const [createOpen, setCreateOpen] = useState(false);   // docked composer (FAB)

  const [shown, setShown] = useState(PAGE);
  const scrollRef = useRef<ScrollView>(null);
  const handledWidgetEvent = useRef<string | null>(null);
  // Filter changed → collapse to the first page and jump to top, so a toggle
  // only ever re-renders PAGE rows instead of the whole (possibly huge) list.
  useEffect(() => {
    setShown(PAGE);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [activeCals]);

  const refresh = useRefreshData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async function runRefresh() {
    setRefreshing(true);
    try { await refresh(); }
    catch (e) {
      console.error(e);
      showToast({
        message: userFacingError(e, "Could not refresh agenda."),
        actionLabel: "Retry",
        onAction: () => setTimeout(() => { void runRefresh(); }, 320),
      });
    }
    finally { setRefreshing(false); }
  };

  const calendarById = useMemo(
    () => new Map(calendars.map(c => [c.id, c])),
    [calendars]
  );

  const currentDay = useCurrentDay();
  const todayKey = useMemo(() => dateKey(currentDay), [currentDay]);

  const groups = useMemo(() => {
    const now = new Date();
    const recurrenceStart = eventDay(now).startOf("day").toDate();
    const recurrenceEnd = new Date(recurrenceStart);
    recurrenceEnd.setFullYear(recurrenceEnd.getFullYear() + RECURRENCE_HORIZON_YEARS);

    // One-off events can remain visible however far away they are. Recurring
    // series need a finite window, so materialize their upcoming occurrences
    // for the next two years before applying the normal agenda filters.
    const agendaEvents = [
      ...events.filter(event => !event.recurrence),
      ...expandRecurringEvents(
        events.filter(event => !!event.recurrence),
        recurrenceStart,
        recurrenceEnd,
      ),
    ];

    const sorted = agendaEvents
      .filter(e =>
        (e.isAllDay
          // all-day: keep today or later by CALENDAR day — its raw UTC-midnight
          // instant is already "past" by mid-morning, which wrongly hid it.
          ? !eventDay(e.start, true).isBefore(eventDay(now), 'day')
          : e.start > now)
        && e.calendars.some(id => activeCals.has(id)))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const result: { date: Date, items: Event[] }[] = [];
    let lastKey = "";
    for (const e of sorted) {
      // Normalize all-day events (stored as UTC-midnight) to their calendar day in
      // the local frame via eventDay, so both the grouping key AND the displayed
      // date (g.date.toLocaleString) land on the right day in any tz. Timed events
      // pass through unchanged.
      const d = eventDay(e.start, e.isAllDay).toDate();
      const key = dateKey(d);
      if (key === lastKey) {
        result[result.length - 1].items.push(e);
      } else {
        result.push({ date: d, items: [e] });
        lastKey = key;
      }
    }
    return result;
  }, [events, activeCals, currentDay]);

  // Store write, not setState — opening the detail must not re-render the
  // (long) agenda list. The modal lives in GlobalEventModals.
  const openEventDetail = useCallback((event: Event) => presentEventDetail(events, event), [events]);

  const openWidgetEvent = useCallback((id: string, startValue?: string): boolean => {
    const direct = events.find(event => event.id === id);
    const master = direct ?? events.find(event => event.id === id.replace(/_\d+$/, ""));
    if (!master) return false;

    const startMs = Number(startValue);
    const selected = !direct && Number.isFinite(startMs)
      ? {
          ...master,
          id,
          start: new Date(startMs),
          end: new Date(startMs + master.end.getTime() - master.start.getTime()),
        }
      : master;
    presentEventDetail(events, selected);
    return true;
  }, [events]);

  // Query params cover a cold launch. The URL listener also handles tapping
  // the same widget row again while Agenda is already mounted.
  useEffect(() => {
    if (!eventId) return;
    const key = `${eventId}:${occurrenceStart ?? ""}`;
    if (handledWidgetEvent.current === key) return;
    if (openWidgetEvent(eventId, occurrenceStart)) handledWidgetEvent.current = key;
  }, [eventId, occurrenceStart, openWidgetEvent]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", ({ url }) => {
      const parsed = Linking.parse(url);
      if (parsed.hostname !== "agenda") return;
      const idParam = parsed.queryParams?.eventId;
      const startParam = parsed.queryParams?.occurrenceStart;
      const id = Array.isArray(idParam) ? idParam[0] : idParam;
      const start = Array.isArray(startParam) ? startParam[0] : startParam;
      if (typeof id !== "string") return;
      if (openWidgetEvent(id, typeof start === "string" ? start : undefined)) {
        handledWidgetEvent.current = `${id}:${start ?? ""}`;
      }
    });
    return () => subscription.remove();
  }, [openWidgetEvent]);

  // Year dividers are direct ScrollView children so stickyHeaderIndices can
  // pin them: the year stays at the top until the next year's divider pushes
  // it off. Solid background + padding (not margin) so rows don't show
  // through while pinned.
  const stickyIndices: number[] = [];
  const rows: React.JSX.Element[] = [];
  groups.slice(0, shown).forEach((g, i, sliced) => {
    if (i === 0 || sliced[i - 1].date.getFullYear() !== g.date.getFullYear()) {
      stickyIndices.push(rows.length);
      rows.push(
        <View
          key={`year-${g.date.getFullYear()}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 14, paddingBottom: 2, backgroundColor: colors.bg }}
        >
          <YearStamp date={g.date} full />
          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
        </View>
      );
    }
    rows.push(
      <Animated.View
        key={g.date.toISOString()}
        entering={FadeIn.duration(250)}
      >
        <View style={styles.timelineRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.timelineDay}>
              {g.date.toLocaleString("en-UK", { day: "2-digit" })}
            </Text>
            <Text style={styles.timelineMonth}>
              {g.date.toLocaleString("en-UK", { month: "short" }).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 4, justifyContent: "flex-end" }}>
            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg2 }} >
              {g.date.toLocaleString("en-UK", { weekday: "long" })}
            </Text>
            {dateKey(g.date) === todayKey &&
              <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
                TODAY
              </Text>
            }
          </View>
        </View>
        <View>
          {
            g.items.map(e => (
              <Tap
                onPress={() => openEventDetail(e)}
                key={e.id}
                accessibilityLabel={e.isAllDay
                  ? `All-day event, ${e.title || "Untitled event"}`
                  : `${e.title || "Untitled event"}, ${formatTime(e.start, timeFormat)} to ${formatTime(e.end, timeFormat)}`}
                style={styles.timelineRow}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg2 }}>
                    {formatTime(e.start, timeFormat)}
                  </Text>
                  <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg4 }}>
                    {formatTime(e.end, timeFormat)}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", flex: 4 }}>
                  <View style={{ width: 1, backgroundColor: eventColor(e, calendarById), alignSelf: "stretch" }} />
                  <View style={{ paddingLeft: 16, justifyContent: "center" }}>
                    <Text style={styles.timelineTitle}>{e.title}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {e.calendars.map(c => (
                        <View key={c} style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                          <View style={[styles.colorDot, { backgroundColor: calendarById.get(c)?.color ?? "" }]} />
                          <Text style={styles.timelineMeta}>{calendarById.get(c)?.name ?? ""}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
              </Tap>
            ))
          }
        </View>
      </Animated.View>
    );
  });

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Agenda</Text>
      </View>
      <CalendarFilterBar
        calendars={calendars}
        activeCals={activeCals}
        soloCalId={soloCalId}
        onToggle={toggleCal}
        onSolo={soloCalendar}
      />
      <ScrollView
        ref={scrollRef}
        style={{ paddingHorizontal: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent }) => {
          const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
          const fromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          if (fromBottom < 400) setShown(s => Math.min(s + PAGE, groups.length));
        }}
        stickyHeaderIndices={stickyIndices}
      >
        {groups.length === 0 ? <Empty kanji="静" text="No events ahead" /> : rows}
      </ScrollView>
      {/* FAB hides while the docked composer is open (mirrors the home screen). */}
      {!createOpen && (
        <Animated.View entering={FadeIn.duration(400)}>
          <Tap
            style={styles.fab}
            haptic="thump"
            onPress={() => setCreateOpen(true)}
            accessibilityLabel="Create event"
          >
            <Text style={{ color: colors.onFill, fontSize: 28, lineHeight: 30 }}>+</Text>
          </Tap>
        </Animated.View>
      )}
      {/* Create — docked composer above the tab bar; its keyboard handling keeps
          the focused field visible (unlike the classic modal). */}
      <AddEventModal
        docked
        visible
        peekVisible={createOpen}
        anchor={new Date()}
        onClose={() => setCreateOpen(false)}
        onSave={(e) => addEvent(e, api)}
        onEdit={(e) => updateEvent(e, api)}
        calendars={calendars}
      />
    </View>
  );
}
