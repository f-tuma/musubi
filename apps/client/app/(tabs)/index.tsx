import { calendarTheme, colors, styles } from "@/constants/theme";
import { AddEventModal } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { CalendarHeader } from "@/components/calendar/CalendarHeader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Calendar, enrichEvents, expandRecurringEvents, type Mode } from "@musubi/calendar";
import Animated, { FadeIn } from "react-native-reanimated";
import { CalendarSkeleton } from "@/components/calendar/CalendarSkeleton";
import * as Haptics from "expo-haptics";
import dayjs from "dayjs";
import EventDetailModal from "@/components/calendar/EventDetailModal";
import { Event } from "@musubi/types";
import { useEventsStore } from "@/store/useEventsStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useApi } from "@/services/api";
import { useRefreshData } from "@/hooks/useRefreshData";


// `monthStart` is anchorDate snapped to the start of its month (see rangeAnchorMs).
// Snapping means swipes WITHIN a month produce an identical [start,end] and reuse
// the expand/enrich memo below: day/3days/week swipe by < 1 month → cache hits.
// Month view still shifts one bucket per swipe (already cheap after the month-view
// memo fixes). Coverage is 3 months (non-month) / 5 months (month), enough to keep
// the visible page populated across an in-window swipe.
function getViewRange(mode: Mode, monthStart: Date): [Date, Date] {
  const m = dayjs(monthStart);
  const span = mode === 'month' ? 2 : 1;
  return [m.subtract(span, 'month').toDate(), m.add(span, 'month').endOf('month').toDate()];
}

export default function MainTab() {
  const api = useApi();
  const { events, addEvent, updateEvent, removeEvent } = useEventsStore();
  const {
    weekStartsOn,
    defaultCalendarView,
  } = useSettingsStore();

  const { calendars, activeCals, soloCalId, toggleCal, soloCalendar, syncActiveCals } = useCalendarsStore();
  useEffect(() => {
    syncActiveCals(calendars);
  }, [calendars]);

  useEffect(() => {
    setCalMode(defaultCalendarView);
  }, [defaultCalendarView]);


  const [calHeight, setCalHeight] = useState(0);
  const [calReady, setCalReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setCalReady(true), 500);
    return () => clearTimeout(t);
  }, []);

  const [calMode, setCalMode] = useState<Mode>(defaultCalendarView);
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [jumpDate, setJumpDate] = useState<Date>(new Date());
  const [newEventVisible, setNewEventVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);
  const [startingDate, setStartingDate] = useState<Date | undefined>(new Date());

  // Pull-to-refresh (week/day timeline). Keep `refresh` in a ref so onRefresh —
  // and thus the memoized refreshControl — stay stable and don't re-render the
  // whole calendar on every render (only when `refreshing` toggles).
  const refresh = useRefreshData();
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; });
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refreshRef.current(); } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  }, []);

  const handlerEventEdit = useCallback((event: Event) => {
    setEventDetailVisible(false);
    setPrefilledEvent(event);
    setNewEventVisible(true);
  }, []);

  const handleCreateEventOnCell = useCallback((date: Date) => {
    setStartingDate(date);
    setNewEventVisible(true);
  }, []);

  const goToDay = useCallback((date: Date) => {
    setCalMode('day');
    setAnchorDate(date);
    setJumpDate(date);
  }, []);

  // Quick tap on a day drills into its day view (week/month); in day view a tap
  // creates an event. Long-press always creates (wired to onLongPressCell).
  const handleCellPress = useCallback((date: Date) => {
    if (calMode === 'day') handleCreateEventOnCell(date);
    else goToDay(date);
  }, [calMode, goToDay, handleCreateEventOnCell]);

  const openEventDetail = useCallback((event: Event) => {
    // Recurring occurrences have synthetic ids like "<originalId>_<timestamp>".
    // Display the occurrence's own start/end (the date the user tapped) but
    // keep the original event's id so that edit/delete targets the full series.
    const original = events.find(e => e.id === event.id)
      ?? events.find(e => e.id === event.id?.replace(/_\d+$/, ''));
    setEventDetail(
      original && original.id !== event.id
        ? { ...original, start: event.start, end: event.end }
        : event,
    );
    setEventDetailVisible(true);
  }, [events]);

  // Snap the expansion anchor to its month; changes value only when the month
  // changes, so the range memo below stays stable across in-month swipes.
  const rangeAnchorMs = useMemo(
    () => dayjs(anchorDate).startOf('month').valueOf(),
    [anchorDate],
  );
  const [rangeStart, rangeEnd] = useMemo(
    () => getViewRange(calMode, new Date(rangeAnchorMs)),
    [calMode, rangeAnchorMs],
  );

  // Expand ALL events over the range — the expensive rrule work. Deps are
  // [events, range] only, so toggling a calendar does NOT re-run it.
  const expandedAll = useMemo(
    () => expandRecurringEvents(events, rangeStart, rangeEnd)
      .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [events, rangeStart, rangeEnd],
  );

  // Calendar visibility is applied as a cheap per-cell filter INSIDE the calendar
  // (eventFilter prop), NOT by rebuilding the events array. So toggling a calendar
  // no longer re-expands/re-enriches/re-buckets, and the day grid — memoized on
  // [events, month] — stays put across the ~5 buffered pager pages.
  const eventFilter = useCallback(
    (e: Event) => e.calendars.some(id => activeCals.has(id)),
    [activeCals],
  );

  // Timeline (week/day) shows TIMED events only — all-day events live in the header
  // bar. Building this map from all events rendered them in both places, and
  // zero-duration all-day events (start == end == 00:00) showed as slivers at
  // midnight. Exclude all-day here; the header gets them via the container split.
  const enrichedEventsByDate = useMemo(
    () => enrichEvents(expandedAll.filter(e => !e.isAllDay), true),
    [expandedAll],
  );

  const scrollOffset = useMemo(() =>
    new Date().getHours() * 60 - 60,
    []
  );

  const eventCellStyle = useCallback((e: Event) => ({ backgroundColor: e.color }), []);

  return (

    <View style={styles.screen}>
      <CalendarHeader
        anchorDate={anchorDate}
        calMode={calMode}
        onModeChange={setCalMode}
        onTodayPress={() => setJumpDate(new Date())}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
      <CalendarFilterBar
        calendars={calendars}
        activeCals={activeCals}
        soloCalId={soloCalId}
        onToggle={toggleCal}
        onSolo={soloCalendar}
      />
      <View
        style={{ flex: 1 }}
        onLayout={(event) => setCalHeight(event.nativeEvent.layout.height)}
      >
        {(!calReady || calHeight === 0) && <CalendarSkeleton />}
        {calReady && calHeight > 0 && (
          <Animated.View entering={FadeIn.duration(350)} style={{ flex: 1 }}>
          <Calendar
            events={expandedAll}
            eventFilter={eventFilter}
            eventsAreSorted={true}
            enableEnrichedEvents={true}
            enrichedEventsByDate={enrichedEventsByDate}
            height={calMode === "month" ? calHeight : calHeight + 95}
            theme={calendarTheme}
            eventCellStyle={eventCellStyle}
            allDayEventCellStyle={eventCellStyle}
            mode={calMode}
            weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
            swipeEnabled={true}
            showAllDayEventCell={true}
            date={jumpDate}
            scrollOffsetMinutes={scrollOffset}
            onSwipeEnd={setAnchorDate}
            onPressEvent={openEventDetail}
            onPressCell={handleCellPress}
            onLongPressCell={handleCreateEventOnCell}
          />
          </Animated.View>
        )}
      </View>
      <Animated.View entering={FadeIn.duration(400)}>
        <Pressable style={styles.fab} onPress={() => {
          if (process.env.EXPO_OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setPrefilledEvent(undefined);
          setNewEventVisible(true);
        }}>
          <Text style={{ color: colors.bg, fontSize: 28, lineHeight: 30 }}>+</Text>
        </Pressable>
      </Animated.View>
      <AddEventModal
        visible={newEventVisible}
        startingDate={startingDate}
        onClose={() => {
          setNewEventVisible(false);
          setStartingDate(undefined);
        }}
        onSave={async (e) => await addEvent(e, api)}
        onEdit={async (e) => await updateEvent(e, api)}
        calendars={calendars}
        event={prefilledEvent}
      />
      <EventDetailModal
        visible={eventDetailVisible}
        onClose={() => setEventDetailVisible(false)}
        onDelete={(event: Event) => removeEvent(event, api)}
        onEdit={(event: Event) => handlerEventEdit(event)}
        event={eventDetail}
      />
    </View>
  );
}
