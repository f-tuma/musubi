import { MONTH_KANJI } from "@/constants/const";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar, Event, can } from "@musubi/types";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useEventsStore } from "@/store/useEventsStore";
import { liveEventDetail } from "@/lib/liveEvent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Text, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withTiming,
} from "react-native-reanimated";
import { expandRecurringEvents } from "@musubi/calendar";
import dayjs from "dayjs";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { AddEventModal, DOCK_PEEK } from "./AddEventModal";
import { MonthView } from "@/components/cal/MonthView";
import { TimelineView } from "@/components/cal/TimelineView";
import { Draft, DRILL_OPEN_MIN, minutesToY, Rect, ZOOM_IN_MS, ZOOM_OUT_MS } from "@/components/cal/layout";
import { ModeSwitch } from "@/components/cal/ModeSwitch";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import EventDetailModal from "./EventDetailModal";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Feather } from "@expo/vector-icons";
import CalendarSettingsModal from "./CalendarSettingsModal";
import CreateCalendarModal from "./CreateCalendarModal";
import { useVisibleEvents } from "@/hooks/useVisibleEvents";
import { useApi } from "@/services/api";
import { eventColor } from "@/lib/eventColor";
import { canEditEvent } from "@/lib/eventPermissions";
import { warn } from "@/lib/haptics";
import { showToast, ToastHost } from "@/components/ui/Toast";
import { Tap } from "@/components/ui/Tap";


type CalMode = "month" | "week" | "day";

type Props = {
  calendar: Calendar | null,
  visible: boolean,
  onClose: () => void,
  onDelete: (calendar: Calendar) => void,
  onEdit: (event: Calendar) => void,
}

export default function CalendarDetail({ calendar, visible, onClose, onDelete, onEdit }: Props) {
  const { height } = useWindowDimensions();
  const calendarSpace = height * 0.8;
  const api = useApi();
  const { events, addEvent, updateEvent, localUpdateEvent } = useEventsStore();
  const { calendars, updateCalendar } = useCalendarsStore();
  // Read the calendar live from the store by id: an edit round-trip (and the SSE
  // calendar_updated frame) returns the bare calendars row without per-user
  // fields, so the copy passed in as a prop can lose `role`. The store merges and
  // keeps role — deriving from it keeps permissions (and name/colour) correct
  // after an in-place edit, instead of showing an owner as locked-out.
  const liveCalendar = useMemo(
    () => calendars.find((c) => c.id === calendar?.id) ?? calendar,
    [calendars, calendar],
  );
  const canEditEvents = can(liveCalendar?.role, "editEvents");
  const { weekStartsOn, defaultCalendarView, showKanji } = useSettingsStore();

  const [calMode, setCalMode] = useState<CalMode>(
    defaultCalendarView === "week" || defaultCalendarView === "day" ? defaultCalendarView : "month");
  const [base, setBase] = useState(new Date());
  const [anchorDate, setAnchorDate] = useState(new Date());
  // Docked composer, same model as the home tab: no FAB — it peeks in day view
  // (or when there's a draft) and rides drag-to-create.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dockHidden, setDockHidden] = useState(false);   // X hides the sheet until the next draft
  const [dockPeekReady, setDockPeekReady] = useState(false);
  const [newEventVisible, setNewEventVisible] = useState(false); // classic modal (edit from detail)
  const [newCalendarVisible, setNewCalendarVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState(false);
  const [calendarSettingsVisible, setCalendarSettingsVisible] = useState(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [prefilledCalendar, setPreffiledCalendar] = useState<Calendar | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);
  const [calendarSettings, setCallendarSettings] = useState<Calendar | null>(null);
  const scrollPosRef = useRef(Math.max(0, minutesToY(new Date().getHours() * 60 - 60)));
  // drill-in day view keeps its own scroll memory, reset to noon on each open
  const drillScrollPosRef = useRef(minutesToY(DRILL_OPEN_MIN));

  const insets = useSafeAreaInsets();
  // keyboardAware off: the docked composer owns the keyboard lift; without this
  // the detail sheet would ride the keyboard too and both would move.
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose, false);

  // month → day zoom, same feel as the main tab (see app/(tabs)/index.tsx)
  const [drill, setDrill] = useState<null | { date: Date; rect: Rect }>(null);
  const zoom = useSharedValue(0);
  const [bodySize, setBodySize] = useState({ w: 0, h: 0 });

  const openDrill = useCallback((date: Date, rect: Rect) => {
    setDraft(null);
    setDockHidden(false); // a fresh drill always re-shows the composer, even if X hid it last time
    setAnchorDate(date);
    drillScrollPosRef.current = minutesToY(DRILL_OPEN_MIN); // day view always opens at this time
    setDrill({ date, rect });
    zoom.value = 0;
    // mount the day view while the overlay is tiny + invisible (zoom 0), then
    // animate a frame later — keeps the heavy mount off the animation's frames.
    // The composer peeks up only once the zoom settles (dockPeekReady).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      zoom.value = withTiming(1, { duration: ZOOM_IN_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(setDockPeekReady)(true);
      });
    }));
  }, []);

  const clearDrill = useCallback(() => { setDrill(null); setDraft(null); }, []);
  useEffect(() => {
    if (!visible) { setDrill(null); zoom.value = 0; setDraft(null); setDockPeekReady(false); } // sheet dismissed mid-drill
  }, [visible]);
  const closeDrill = useCallback(() => {
    setDockPeekReady(false); // sheet ducks out while the day zooms back
    zoom.value = withTiming(0, { duration: ZOOM_OUT_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(clearDrill)();
    });
  }, [clearDrill]);

  const switchMode = (mode: CalMode) => {
    setDraft(null);
    if (drill) {
      if (mode === "month") { closeDrill(); return; }
      zoom.value = 0;
      setDrill(null);
    }
    setBase(anchorDate);
    setCalMode(mode);
  };

  const onTodayPress = () => {
    const now = new Date();
    zoom.value = 0;
    setDrill(null);
    setBase(now);
    setAnchorDate(now);
  };

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

  const handlerEventEdit = (event: Event) => {
    setEventDetailVisible(false);
    setPrefilledEvent(event);
    setNewEventVisible(true);
  };

  const handlerCalendarEdit = (calendar: Calendar) => {
    setCalendarSettingsVisible(false);
    setPreffiledCalendar(calendar);
    setNewCalendarVisible(true);
  }

  const handlerCalendarRemove = async (calendar: Calendar) => {
    onDelete(calendar);
    onClose();
  };

  const openEventDetail = useCallback((event: Event) => {
    const original = events.find(e => e.id === event.id)
      ?? events.find(e => e.id === event.id?.replace(/_\d+$/, ''));
    setEventDetail(
      original && original.id !== event.id
        ? { ...original, start: event.start, end: event.end }
        : event,
    );
    setEventDetailVisible(true);
  }, [events]);

  const openCalendarSettings = (calendar: Calendar) => {
    setCallendarSettings(calendar);
    setCalendarSettingsVisible(true);
  };

  // Tap/drag on an empty slot → straight into the event form with that range.
  const handleDraftChange = useCallback((d: Draft | null) => {
    if (!canEditEvents) return;
    setDraft(d);
    setDockHidden(false);
  }, [canEditEvents]);

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

  const calendarById = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars]);
  const eventColorOf = useCallback((e: Event) => eventColor(e, calendarById), [calendarById]);

  const activeCal = useMemo(() => calendar ? new Set<string>([calendar.id]) : new Set<string>(), [calendar]);
  const { visibleEvents } = useVisibleEvents(events, activeCal);

  const [rangeStart, rangeEnd] = useMemo(
    () => {
      const d = dayjs(anchorDate);
      const span = calMode === "month" ? 2 : 1;
      return [d.subtract(span, "month").startOf("month").toDate(), d.add(span, "month").endOf("month").toDate()] as [Date, Date];
    },
    [calMode, dayjs(anchorDate).startOf("month").valueOf()],
  );

  const expandedEvents = useMemo(
    () => expandRecurringEvents(visibleEvents, rangeStart, rangeEnd)
      .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [visibleEvents, rangeStart, rangeEnd],
  );

  // Dock model mirrors app/(tabs)/index.tsx: mounted in day/week (or a drill),
  // and it peeks when there's a draft, in day view, or once a drill settles —
  // no FAB. Gated on canEditEvents so a viewer never gets a composer.
  const dockVisible = canEditEvents && (calMode !== "month" || !!drill);
  const dockPeeking = !!draft || ((calMode === "day" || (!!drill && dockPeekReady)) && !dockHidden);

  return (
    <Modal
      visible={visible}
      onRequestClose={() => drill ? closeDrill() : handleClose()}
      animationType="none"
      transparent={true}
      statusBarTranslucent={true}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[styles.modalOverlay, fadeStyle]}>
          <Pressable style={{ flex: 1 }} onPress={handleClose} />
        </Animated.View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.modalSheet, { maxHeight: "95%" }, fadeStyle, slideStyle]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalTitleRow}>
              <View style={styles.calendarCircle}>
                <View style={[styles.calendarCircleInner, { backgroundColor: liveCalendar?.color ?? "" }]} />
              </View>
              <View>
                <Text style={styles.modalTitle}>{liveCalendar?.name}</Text>
                <Text style={{ color: colors.fg3, fontSize: 12 }}>
                  {liveCalendar?.members.length} members · {visibleEvents.length} events
                </Text>
              </View>
              <Tap
                style={{ flex: 1, alignItems: "flex-end", paddingRight: 12 }}
                onPress={() => openCalendarSettings(liveCalendar!)}
              >
                <Feather name="settings" size={24} color={colors.fg2} />
              </Tap>
            </View>
            <View style={{ height: calendarSpace }}>
              <View style={{
                paddingHorizontal: 16, flexDirection: "row", paddingVertical: 8, alignItems: "center",
                justifyContent: "space-between",
                borderBottomWidth: 1, borderColor: colors.line,
                zIndex: 30, // mode dropdown floats above the calendar below
              }}>
                <ModeSwitch
                  mode={drill ? "day" : calMode}
                  onChange={switchMode}
                  trigger={(open) => (
                    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                      <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
                        {anchorDate.toLocaleString("en-UK", { month: "long" })}
                      </Text>
                      {showKanji &&
                        <Text style={{ fontFamily: fonts.kanji, fontSize: 14, color: colors.fg3 }}>
                          {MONTH_KANJI[anchorDate.getMonth()]}
                        </Text>
                      }
                      <Feather name={open ? "chevron-up" : "chevron-down"} size={15} color={colors.fg3} />
                    </View>
                  )}
                />
                <Tap
                  style={{ paddingLeft: 16 }}
                  onPress={onTodayPress}>
                  <Text style={{ color: colors.fg3, fontSize: 12, letterSpacing: 1.5 }}>TODAY</Text>
                </Tap>
              </View>
              <View
                style={{ flex: 1 }}
                onLayout={e => setBodySize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
              >
                {calMode === "month" ? (
                  <Animated.View style={monthUnderStyle}>
                    <MonthView
                      key={`m-${base.getTime()}`}
                      base={base}
                      events={expandedEvents}
                      weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
                      eventColorOf={eventColorOf}
                      onDayPress={openDrill}
                      onPageChange={setAnchorDate}
                    />
                  </Animated.View>
                ) : (
                  <TimelineView
                    key={`${calMode}-${base.getTime()}`}
                    mode={calMode}
                    base={base}
                    events={expandedEvents}
                    weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
                    eventColorOf={eventColorOf}
                    onPressEvent={openEventDetail}
                    draft={draft}
                    onDraftChange={handleDraftChange}
                    canMoveEvent={canMoveEvent}
                    onMoveEvent={onMoveEvent}
                    onPageChange={setAnchorDate}
                    scrollPosRef={scrollPosRef}
                    bottomPad={dockPeeking ? DOCK_PEEK + 14 : insets.bottom + 20}
                  />
                )}

                {drill && (
                  <Animated.View style={[{
                    position: "absolute",
                    backgroundColor: colors.bg1,
                    overflow: "hidden",
                    borderWidth: 1,
                    borderColor: colors.line2,
                  }, overlayStyle]}>
                    <Animated.View style={[{ width: bodySize.w, height: bodySize.h }, overlayContentStyle]}>
                      <TimelineView
                        key={`drill-${drill.date.getTime()}`}
                        mode="day"
                        base={drill.date}
                        events={expandedEvents}
                        weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
                        eventColorOf={eventColorOf}
                        onPressEvent={openEventDetail}
                        draft={draft}
                        onDraftChange={handleDraftChange}
                        canMoveEvent={canMoveEvent}
                        onMoveEvent={onMoveEvent}
                        onPageChange={setAnchorDate}
                        scrollPosRef={drillScrollPosRef}
                        bottomPad={dockHidden && !draft ? insets.bottom + 20 : DOCK_PEEK + 14}
                      />
                    </Animated.View>
                  </Animated.View>
                )}
              </View>
            </View>
          </Animated.View>
        </GestureDetector>
        {/* Docked composer — no FAB. Peeks in day view / with a draft, same
            model as the home tab. No tab bar in this modal, so the keyboard
            inset is the safe area. Lives inside this GestureHandlerRootView
            (the app-root one is occluded by the native Modal). */}
        {dockVisible && (
          <AddEventModal
            docked
            visible
            peekVisible={dockPeeking}
            dockBottomInset={insets.bottom}
            anchor={anchorDate}
            startingDate={draft?.start}
            endingDate={draft?.end}
            onClose={() => { setDraft(null); setDockHidden(true); }}
            onSave={(e) => addEvent(e, api)}
            onEdit={(e) => updateEvent(e, api)}
            calendars={calendars}
          />
        )}
      </GestureHandlerRootView>
      {/* Edit — classic modal, opened from an event's detail. */}
      <AddEventModal
        visible={newEventVisible}
        onClose={() => setNewEventVisible(false)}
        onSave={(e) => addEvent(e, api)}
        onEdit={(e) => updateEvent(e, api)}
        calendars={calendars}
        event={prefilledEvent}
      />
      <EventDetailModal
        visible={eventDetailVisible}
        onClose={() => setEventDetailVisible(false)}
        onEdit={(event: Event) => handlerEventEdit(event)}
        event={liveEventDetail(events, eventDetail)}
      />
      <CalendarSettingsModal
        calendar={calendarSettings}
        visible={calendarSettingsVisible}
        onClose={() => setCalendarSettingsVisible(false)}
        onDelete={(cal: Calendar) => handlerCalendarRemove(cal)}
        onEdit={(cal) => handlerCalendarEdit(cal)}
        onLeave={() => handleClose()}
      />
      <CreateCalendarModal
        calendar={prefilledCalendar}
        visible={newCalendarVisible}
        onClose={() => setNewCalendarVisible(false)}
        onCreate={async () => { }} // Keep empty... should not create new calendars ever...
        onEdit={async (cal) => {
          await updateCalendar(cal, api);
          onEdit(cal);
        }}
      />
      {/* own host: the root one is occluded by this native Modal */}
      <ToastHost />
    </Modal >
  );
}
