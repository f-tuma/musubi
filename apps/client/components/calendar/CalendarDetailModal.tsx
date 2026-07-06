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
import { AddEventModal } from "./AddEventModal";
import { MonthView } from "@/components/cal/MonthView";
import { TimelineView } from "@/components/cal/TimelineView";
import { Draft, minutesToY, Rect, ZOOM_IN_MS, ZOOM_OUT_MS } from "@/components/cal/layout";
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
  const calendarSpace = height * 0.7;
  const api = useApi();
  const canEditEvents = can(calendar?.role, "editEvents");
  const { events, addEvent, updateEvent, localUpdateEvent } = useEventsStore();
  const { calendars, updateCalendar } = useCalendarsStore();
  const { weekStartsOn, defaultCalendarView, showKanji } = useSettingsStore();

  const [calMode, setCalMode] = useState<CalMode>(
    defaultCalendarView === "week" || defaultCalendarView === "day" ? defaultCalendarView : "month");
  const [base, setBase] = useState(new Date());
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [newEventVisible, setNewEventVisible] = useState(false);
  const [newCalendarVisible, setNewCalendarVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState(false);
  const [calendarSettingsVisible, setCalendarSettingsVisible] = useState(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [prefilledCalendar, setPreffiledCalendar] = useState<Calendar | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);
  const [calendarSettings, setCallendarSettings] = useState<Calendar | null>(null);
  const [startingDate, setStartingDate] = useState<Date | undefined>(undefined);
  const [endingDate, setEndingDate] = useState<Date | undefined>(undefined);
  const scrollPosRef = useRef(Math.max(0, minutesToY(new Date().getHours() * 60 - 60)));

  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);

  // month → day zoom, same feel as the main tab (see app/(tabs)/index.tsx)
  const [drill, setDrill] = useState<null | { date: Date; rect: Rect }>(null);
  const zoom = useSharedValue(0);
  const [bodySize, setBodySize] = useState({ w: 0, h: 0 });

  const openDrill = useCallback((date: Date, rect: Rect) => {
    setAnchorDate(date);
    setDrill({ date, rect });
    zoom.value = 0;
    zoom.value = withTiming(1, { duration: ZOOM_IN_MS, easing: Easing.out(Easing.cubic) });
  }, []);

  const clearDrill = useCallback(() => setDrill(null), []);
  useEffect(() => {
    if (!visible) { setDrill(null); zoom.value = 0; } // sheet dismissed mid-drill
  }, [visible]);
  const closeDrill = useCallback(() => {
    zoom.value = withTiming(0, { duration: ZOOM_OUT_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(clearDrill)();
    });
  }, [clearDrill]);

  const switchMode = (mode: CalMode) => {
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
  const handleDraftChange = useCallback((d: Draft) => {
    if (!canEditEvents) return;
    setPrefilledEvent(undefined);
    setStartingDate(d.start);
    setEndingDate(d.end);
    setNewEventVisible(true);
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
    localUpdateEvent(updated); // optimistic — the block must not snap back
    api.updateEvent(updated)
      .then(result => localUpdateEvent(result))
      .catch(err => {
        console.error("Move failed:", err);
        warn();
        localUpdateEvent(ev); // revert
      });
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
          <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalTitleRow}>
              <View style={styles.calendarCircle}>
                <View style={[styles.calendarCircleInner, { backgroundColor: calendar?.color ?? "" }]} />
              </View>
              <View>
                <Text style={styles.modalTitle}>{calendar?.name}</Text>
                <Text style={{ color: colors.fg3, fontSize: 12 }}>
                  {calendar?.members.length} members · {visibleEvents.length} events
                </Text>
              </View>
              <Tap
                style={{ flex: 1, alignItems: "flex-end", paddingRight: 12 }}
                onPress={() => openCalendarSettings(calendar!)}
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
                    draft={null}
                    onDraftChange={handleDraftChange}
                    canMoveEvent={canMoveEvent}
                    onMoveEvent={onMoveEvent}
                    onPageChange={setAnchorDate}
                    scrollPosRef={scrollPosRef}
                    bottomPad={insets.bottom + 20}
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
                        draft={null}
                        onDraftChange={handleDraftChange}
                        canMoveEvent={canMoveEvent}
                        onMoveEvent={onMoveEvent}
                        onPageChange={setAnchorDate}
                        scrollPosRef={scrollPosRef}
                        bottomPad={insets.bottom + 20}
                      />
                    </Animated.View>
                  </Animated.View>
                )}
              </View>
            </View>
            {canEditEvents && (
              <Tap style={[styles.fab, { bottom: 16 + insets.bottom }]}
                onPress={() => {
                  setPrefilledEvent(undefined);
                  setStartingDate(undefined);
                  setEndingDate(undefined);
                  setNewEventVisible(true);
                }}
              >
                <Feather name="plus" color={colors.bg} size={16} />
              </Tap>
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
      <AddEventModal
        visible={newEventVisible}
        startingDate={startingDate}
        endingDate={endingDate}
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
    </Modal >
  );
}
