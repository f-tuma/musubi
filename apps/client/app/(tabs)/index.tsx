import { colors, styles } from "@/constants/theme";
import { AddEventModal, DOCK_PEEK } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { CalendarHeader } from "@/components/calendar/CalendarHeader";
import { MonthView } from "@/components/cal/MonthView";
import { TimelineView } from "@/components/cal/TimelineView";
import { Draft, minutesToY, Rect, ZOOM_IN_MS, ZOOM_OUT_MS } from "@/components/cal/layout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, View } from "react-native";
import { expandRecurringEvents, type Mode } from "@musubi/calendar";
import Animated, {
  Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming,
} from "react-native-reanimated";
import dayjs from "dayjs";
import EventDetailModal from "@/components/calendar/EventDetailModal";
import { Event } from "@musubi/types";
import { useEventsStore } from "@/store/useEventsStore";
import { liveEventDetail } from "@/lib/liveEvent";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useApi } from "@/services/api";
import { useRefreshData } from "@/hooks/useRefreshData";
import { eventColor } from "@/lib/eventColor";
import { canEditEvent } from "@/lib/eventPermissions";
import { warn } from "@/lib/haptics";
import { showToast } from "@/components/ui/Toast";

type CalMode = "month" | "week" | "day";

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

  // month → day zoom: the tapped cell rect grows into a full day view overlay
  const [drill, setDrill] = useState<null | { date: Date; rect: Rect }>(null);
  // gates the docked sheet: it slides up only AFTER the day zoom-in settles
  const [drillReady, setDrillReady] = useState(false);
  const zoom = useSharedValue(0);
  const [bodySize, setBodySize] = useState({ w: 0, h: 0 });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [dockHidden, setDockHidden] = useState(false); // X hides the sheet until the next draft
  const handleDraftChange = useCallback((d: Draft | null) => { setDraft(d); setDockHidden(false); }, []);
  const [newEventVisible, setNewEventVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);
  const scrollPosRef = useRef(Math.max(0, minutesToY(new Date().getHours() * 60 - 60)));

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
    setDrillReady(false);
    setAnchorDate(date); // header + composer follow the drilled day (and its swipes)
    setDrill({ date, rect });
    zoom.value = 0;
    zoom.value = withTiming(1, { duration: ZOOM_IN_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(setDrillReady)(true);
    });
  }, []);

  const clearDrill = useCallback(() => {
    setDrill(null);
    setDraft(null);
  }, []);

  const closeDrill = useCallback(() => {
    setDrillReady(false); // sheet ducks out while the day zooms back
    zoom.value = withTiming(0, { duration: ZOOM_OUT_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(clearDrill)();
    });
  }, [clearDrill]);

  // Android back while drilled into a day → zoom back out to the month.
  useEffect(() => {
    if (!drill) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { closeDrill(); return true; });
    return () => sub.remove();
  }, [drill, closeDrill]);

  const switchMode = useCallback((m: Mode) => {
    if (m !== "month" && m !== "week" && m !== "day") return;
    setDraft(null);
    if (drill) {
      if (m === "month") { closeDrill(); return; }
      // jump straight from the drilled day into another mode, no zoom-out
      zoom.value = 0;
      setDrill(null);
    }
    setBase(anchorDate);
    setCalMode(m);
  }, [drill, anchorDate, closeDrill]);

  const onTodayPress = useCallback(() => {
    const now = new Date();
    zoom.value = 0;
    setDrill(null);
    setDraft(null);
    setBase(now);       // new base remounts the pager at today
    setAnchorDate(now);
  }, []);

  const handlerEventEdit = useCallback((event: Event) => {
    setEventDetailVisible(false);
    setPrefilledEvent(event);
    setNewEventVisible(true);
  }, []);

  const openEventDetail = useCallback((event: Event) => {
    // Recurring occurrences have synthetic ids like "<originalId>_<timestamp>".
    // Display the occurrence's own start/end (the date the user tapped) but
    // keep the original event's id so that edit/delete targets the full series.
    const original = events.find(e => e.id === event.id)
      ?? events.find(e => e.id === event.id?.replace(/_\d+$/, ""));
    setEventDetail(
      original && original.id !== event.id
        ? { ...original, start: event.start, end: event.end }
        : event,
    );
    setEventDetailVisible(true);
  }, [events]);

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
  const dockPeeking = !!draft || ((calMode === "day" || (!!drill && drillReady)) && !dockHidden);

  // Overlay geometry: tapped cell rect → full calendar body. Content is laid out
  // at full size inside and fades in, so nothing reflows mid-animation.
  const overlayStyle = useAnimatedStyle(() => {
    if (!drill) return { opacity: 0 };
    const r = drill.rect;
    return {
      opacity: 1,
      left: interpolate(zoom.value, [0, 1], [r.x, 0]),
      top: interpolate(zoom.value, [0, 1], [r.y, 0]),
      width: interpolate(zoom.value, [0, 1], [r.w, bodySize.w]),
      height: interpolate(zoom.value, [0, 1], [r.h, bodySize.h]),
      borderRadius: interpolate(zoom.value, [0, 1], [10, 0]),
      borderWidth: zoom.value < 1 ? 1 : 0, // hairline helps mid-zoom, but at rest it's a visible edge
    };
  });
  const overlayContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(zoom.value, [0, 0.35, 1], [0, 0.2, 1]),
  }));
  const monthUnderStyle = useAnimatedStyle(() => ({
    flex: 1,
    opacity: 1 - zoom.value * 0.5,
    transform: [{ scale: 1 + zoom.value * 0.03 }],
  }));

  return (
    <View style={styles.screen}>
      <CalendarHeader
        anchorDate={anchorDate}
        calMode={drill ? "day" : calMode}
        onModeChange={switchMode}
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
      <View
        style={{ flex: 1 }}
        onLayout={e => setBodySize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      >
        {calMode === "month" ? (
          <Animated.View style={monthUnderStyle}>
            <MonthView
              key={`m-${base.getTime()}`}
              base={base}
              events={visibleEvents}
              weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
              eventColorOf={eventColorOf}
              onDayPress={openDrill}
              onPageChange={onPageChange}
            />
          </Animated.View>
        ) : (
          <TimelineView
            key={`${calMode}-${base.getTime()}`}
            mode={calMode}
            base={base}
            events={visibleEvents}
            weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
            eventColorOf={eventColorOf}
            onPressEvent={openEventDetail}
            draft={draft}
            onDraftChange={handleDraftChange}
            canMoveEvent={canMoveEvent}
            onMoveEvent={onMoveEvent}
            onPageChange={onPageChange}
            scrollPosRef={scrollPosRef}
            bottomPad={dockPeeking ? DOCK_PEEK + 14 : 28}
          />
        )}

        {drill && (
          <Animated.View style={[{
            position: "absolute",
            backgroundColor: colors.bg,
            overflow: "hidden",
            borderColor: colors.line2,
          }, overlayStyle]}>
            <Animated.View style={[{ width: bodySize.w, height: bodySize.h }, overlayContentStyle]}>
              <TimelineView
                key={`drill-${drill.date.getTime()}`}
                mode="day"
                base={drill.date}
                events={visibleEvents}
                weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
                eventColorOf={eventColorOf}
                onPressEvent={openEventDetail}
                draft={draft}
                onDraftChange={handleDraftChange}
                canMoveEvent={canMoveEvent}
                onMoveEvent={onMoveEvent}
                onPageChange={onPageChange}
                scrollPosRef={scrollPosRef}
                bottomPad={!dockHidden || !!draft ? DOCK_PEEK + 14 : 28} // sheet is expected after the zoom — reserve the gap up front
              />
            </Animated.View>
          </Animated.View>
        )}
      </View>

      {/* Docked event composer — peek with title + quick save, pull up for the
          full form. The draft ghost on the grid feeds its times live. */}
      {dockVisible && (
        <AddEventModal
          docked
          visible={true}
          peekVisible={dockPeeking}
          anchor={anchorDate}
          startingDate={draft?.start}
          endingDate={draft?.end}
          onClose={() => { setDraft(null); setDockHidden(true); }}
          onSave={async (e) => await addEvent(e, api)}
          onEdit={async (e) => await updateEvent(e, api)}
          calendars={calendars}
        />
      )}

      {/* Classic modal — editing an existing event from its detail. */}
      <AddEventModal
        visible={newEventVisible}
        onClose={() => setNewEventVisible(false)}
        onSave={async (e) => await addEvent(e, api)}
        onEdit={async (e) => await updateEvent(e, api)}
        calendars={calendars}
        event={prefilledEvent}
      />
      <EventDetailModal
        visible={eventDetailVisible}
        onClose={() => setEventDetailVisible(false)}
        onEdit={(event: Event) => handlerEventEdit(event)}
        event={liveEventDetail(events, eventDetail)}
      />
    </View>
  );
}
