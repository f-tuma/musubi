import { styles } from "@/constants/theme";
import { AddEventModal, DOCK_PEEK } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { CalendarHeader } from "@/components/calendar/CalendarHeader";
import { CalendarDrillView, useCalendarDrill } from "@/components/calendar/CalendarDrillView";
import { Draft, DRILL_OPEN_MIN, minutesToY, Rect } from "@/components/cal/layout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { BackHandler, Platform, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { expandRecurringEvents, type Mode } from "@musubi/calendar";
import dayjs from "dayjs";
import { Event } from "@musubi/types";
import { useEventsStore } from "@/store/useEventsStore";
import { useImportStore } from "@/store/useImportStore";
import { presentEventDetail, useEditComposerStore } from "@/store/useEventDetailStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useApi } from "@/services/api";
import { useRefreshData } from "@/hooks/useRefreshData";
import { eventColor } from "@/lib/eventColor";
import { canEditEvent } from "@/lib/eventPermissions";
import { warn } from "@/lib/haptics";
import { showToast } from "@/components/ui/Toast";

type CalMode = "month" | "week" | "day";

const IOS_BACK_EDGE = 24;
const IOS_BACK_DISTANCE = 64;
const IOS_BACK_VELOCITY = 650;

// Expansion window around the anchor month. Swipes within a month reuse the
// expand memo below; month view gets a wider window for its buffered pages.
function getViewRange(mode: CalMode, monthStart: Date): [Date, Date] {
  const m = dayjs(monthStart);
  const span = mode === "month" ? 2 : 1;
  return [m.subtract(span, "month").toDate(), m.add(span, "month").endOf("month").toDate()];
}

export default function MainTab() {
  const api = useApi();
  const { events, addEvent, updateEvent, localUpdateEvent } = useEventsStore();
  const { weekStartsOn, defaultCalendarView } = useSettingsStore();

  const { calendars, activeCals, soloCalId, toggleCal, soloCalendar, syncActiveCals } = useCalendarsStore();
  useEffect(() => {
    syncActiveCals(calendars);
  }, [calendars]);

  // settings' CalendarView still carries a legacy "schedule" value — the agenda tab owns that
  const normalizeMode = (m: string): CalMode => (m === "week" || m === "day") ? m : "month";
  const [calMode, setCalMode] = useState<CalMode>(normalizeMode(defaultCalendarView));
  // `base` = page-0 anchor of the active pager; only changes on mode switch /
  // today, so swipes stay cheap. `anchorDate` follows the visible page (header).
  const [base, setBase] = useState(new Date());
  const [anchorDate, setAnchorDate] = useState(new Date());
  useEffect(() => {
    setCalMode(normalizeMode(defaultCalendarView));
  }, [defaultCalendarView]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [dockHidden, setDockHidden] = useState(false); // X hides the sheet until the next draft
  const handleDraftChange = useCallback((d: Draft | null) => { setDraft(d); setDockHidden(false); }, []);
  const scrollPosRef = useRef(Math.max(0, minutesToY(new Date().getHours() * 60 - 60)));
  // the drill-in day view has its own scroll memory, always reset to noon on open
  const drillScrollPosRef = useRef(minutesToY(DRILL_OPEN_MIN));
  const {
    drill, contentReady: drillContentReady, zoom, monthTransition, drillOpacity,
    openDrill: beginDrill, closeDrill: animateDrillClosed, resetDrill,
  } = useCalendarDrill(anchorDate);

  const refresh = useRefreshData();
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; });
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refreshRef.current(); } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  }, []);

  const openDrill = useCallback((date: Date, rect: Rect) => {
    setDraft(null);
    setDockHidden(false); // a fresh drill always re-shows the composer, even if X hid it last time
    drillScrollPosRef.current = minutesToY(DRILL_OPEN_MIN); // day view always opens at this time
    beginDrill(date, rect);
    setAnchorDate(date); // header + composer follow the drilled day (and its swipes)
  }, [beginDrill]);

  const closeDrill = useCallback(() => {
    const sourceHeaderDate = drill?.sourceHeaderDate;
    animateDrillClosed(() => {
      setDraft(null);
      if (sourceHeaderDate) setAnchorDate(sourceHeaderDate);
    });
  }, [animateDrillClosed, drill]);

  // Android back while drilled into a day → zoom back out to the month.
  // Registered via useFocusEffect (not a plain useEffect) so it's ordered
  // correctly against the navigator's own back handler — otherwise the first
  // edge-swipe gets eaten and you have to swipe twice.
  useFocusEffect(useCallback(() => {
    if (!drill) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { closeDrill(); return true; });
    return () => sub.remove();
  }, [drill, closeDrill]));

  // iOS has no global Back action. Recreate the platform's navigation gesture
  // for this local (non-router) drill state, and only from the leading edge so
  // horizontal swipes elsewhere remain available to the day pager.
  const edgeBackGesture = useMemo(() => Gesture.Pan()
    .enabled(Platform.OS === "ios" && !!drill)
    .hitSlop({ left: 0, width: IOS_BACK_EDGE })
    .activeOffsetX(12)
    .failOffsetY([-16, 16])
    .runOnJS(true)
    .onEnd(e => {
      if (
        e.translationX >= IOS_BACK_DISTANCE
        || (e.translationX >= IOS_BACK_EDGE && e.velocityX >= IOS_BACK_VELOCITY)
      ) closeDrill();
    }), [drill, closeDrill]);

  const switchMode = useCallback((m: Mode) => {
    if (m !== "month" && m !== "week" && m !== "day") return;
    setDraft(null);
    if (drill) {
      if (m === "month") { closeDrill(); return; }
      // jump straight from the drilled day into another mode, no zoom-out
      resetDrill();
    }
    setBase(anchorDate);
    setCalMode(m);
  }, [drill, anchorDate, closeDrill, resetDrill]);

  const onTodayPress = useCallback(() => {
    const now = new Date();
    resetDrill();
    setDraft(null);
    setBase(now);       // new base remounts the pager at today
    setAnchorDate(now);
  }, [resetDrill]);

  // Android calendar VIEW intent (com.android.calendar/time/<ms>, routed via
  // +not-found → root index): jump the calendar to the requested date.
  const { time } = useLocalSearchParams<{ time?: string }>();
  useEffect(() => {
    const ms = Number(time);
    if (!time || !Number.isFinite(ms)) return;
    const target = new Date(ms);
    resetDrill();
    setDraft(null);
    setBase(target);
    setAnchorDate(target);
  }, [time, resetDrill]);

  // An .ics opened via the OS (parsed in app/_layout) → open the composer prefilled.
  const importPending = useImportStore(s => s.pending);
  useEffect(() => {
    if (!importPending) return;
    useEditComposerStore.getState().open({
      title: importPending.title,
      start: importPending.start,
      end: importPending.end,
      isAllDay: importPending.isAllDay,
      description: importPending.description ?? null,
      location: importPending.location ?? null,
    } as Event); // no id → composer treats it as a new event
    useImportStore.getState().setPending(null);
  }, [importPending]);

  // Store write, not setState — opening the detail must not re-render MainTab
  // (and the whole calendar under it). The modal lives in GlobalEventModals.
  const openEventDetail = useCallback((event: Event) => presentEventDetail(events, event), [events]);

  // Snap the expansion anchor to its month; stable across in-month swipes.
  const rangeAnchorMs = useMemo(
    () => dayjs(anchorDate).startOf("month").valueOf(),
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
  const visibleEvents = useMemo(
    () => expandedAll.filter(e => e.calendars.some(id => activeCals.has(id))),
    [expandedAll, activeCals],
  );

  const calendarById = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars]);
  const eventColorOf = useCallback((e: Event) => eventColor(e, calendarById), [calendarById]);

  const onPageChange = useCallback((date: Date) => setAnchorDate(date), []);

  // Drag-to-move existing events: only non-recurring ones the user may edit
  // (moving one occurrence of a series = detached instances, postponed).
  const canMoveEvent = useCallback(
    (e: Event) => !e.recurrence && canEditEvent(e, calendars),
    [calendars],
  );
  const onMoveEvent = useCallback((ev: Event, dayDelta: number, minDelta: number) => {
    const shift = (d: Date) => {
      const n = new Date(d);
      n.setDate(n.getDate() + dayDelta);
      n.setMinutes(n.getMinutes() + minDelta);
      return n;
    };
    const updated = { ...ev, start: shift(ev.start), end: shift(ev.end) };
    // optimistic (block must not snap back); revert locally if the server rejects
    const persist = (next: Event, fallback: Event) => {
      localUpdateEvent(next);
      api.updateEvent(next)
        .then(result => localUpdateEvent(result))
        .catch(err => { console.error("Move failed:", err); warn(); localUpdateEvent(fallback); });
    };
    persist(updated, ev);
    showToast({ message: `“${ev.title || "Event"}” moved`, actionLabel: "Undo", onAction: () => persist(ev, updated) });
  }, [api, localUpdateEvent]);
  const dockVisible = calMode !== "month" || !!drill;
  // one truth for "is the sheet peeking" — drives the sheet AND the timeline's
  // bottom padding (no dead gap under midnight when the sheet is hidden)
  // A drill reserves the composer's space from frame one; its visual reveal is
  // driven separately by monthTransition, in lockstep with the zoom.
  const dockPeeking = !!draft || ((calMode === "day" || !!drill) && !dockHidden);

  return (
    <GestureDetector gesture={edgeBackGesture}>
      <View style={styles.screen}>
        <CalendarHeader
          anchorDate={anchorDate}
          calMode={drill ? "day" : calMode}
          onModeChange={switchMode}
          onBackToMonth={drill ? closeDrill : undefined}
          drillSourceDate={drill?.sourceHeaderDate}
          drillProgress={monthTransition}
          onTodayPress={onTodayPress}
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
        <CalendarDrillView
          calMode={calMode}
          base={base}
          events={visibleEvents}
          weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
          eventColorOf={eventColorOf}
          onDayPress={openDrill}
          onPageChange={onPageChange}
          onPressEvent={openEventDetail}
          draft={draft}
          onDraftChange={handleDraftChange}
          canMoveEvent={canMoveEvent}
          onMoveEvent={onMoveEvent}
          scrollPosRef={scrollPosRef}
          drillScrollPosRef={drillScrollPosRef}
          bottomPad={dockPeeking ? DOCK_PEEK + 14 : 28}
          drillBottomPad={dockHidden && !draft ? 28 : DOCK_PEEK + 14}
          drill={drill}
          drillContentReady={drillContentReady}
          zoom={zoom}
          monthTransition={monthTransition}
          drillOpacity={drillOpacity}
        />

        {/* Docked event composer — peek with title + quick save, pull up for the
            full form. The draft ghost on the grid feeds its times live. */}
        {dockVisible && (
          <AddEventModal
            docked
            visible={true}
            peekVisible={dockPeeking}
            dockRevealProgress={drill ? monthTransition : undefined}
            anchor={anchorDate}
            startingDate={draft?.start}
            endingDate={draft?.end}
            onClose={() => { setDraft(null); setDockHidden(true); }}
            onSave={async (e) => await addEvent(e, api)}
            onEdit={async (e) => await updateEvent(e, api)}
            calendars={calendars}
          />
        )}

      </View>
    </GestureDetector>
  );
}
