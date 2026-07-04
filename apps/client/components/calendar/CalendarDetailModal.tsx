import { MONTH_KANJI } from "@/constants/const";
import { calendarTheme, colors, fonts, styles } from "@/constants/theme";
import { Calendar, Event, can } from "@musubi/types";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useEventsStore } from "@/store/useEventsStore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Text, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { CalendarSkeleton } from "./CalendarSkeleton";
import { Calendar as BigCalendar, enrichEvents, expandRecurringEvents, type Mode } from "@musubi/calendar";
import dayjs from "dayjs";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { AddEventModal } from "./AddEventModal";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import EventDetailModal from "./EventDetailModal";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Feather } from "@expo/vector-icons";
import CalendarSettingsModal from "./CalendarSettingsModal";
import CreateCalendarModal from "./CreateCalendarModal";
import { useVisibleEvents } from "@/hooks/useVisibleEvents";
import { useApi } from "@/services/api";
import { eventColor } from "@/lib/eventColor";


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
  const { events, addEvent, updateEvent, removeEvent } = useEventsStore();
  const { calendars, updateCalendar } = useCalendarsStore();
  const {
    weekStartsOn,
    defaultCalendarView,
    showKanji,
  } = useSettingsStore();

  const [calMode, setCalMode] = useState<Mode>(defaultCalendarView);
  const [calHeight, setCalHeight] = useState(0);
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [jumpDate, setJumpDate] = useState<Date>(new Date());
  const [newEventVisible, setNewEventVisible] = useState(false);
  const [newCalendarVisible, setNewCalendarVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState(false);
  const [calendarSettingsVisible, setCalendarSettingsVisible] = useState(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [prefilledCalendar, setPreffiledCalendar] = useState<Calendar | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);
  const [calendarSettings, setCallendarSettings] = useState<Calendar | null>(null);
  const [startingDate, setStartingDate] = useState<Date | undefined>(new Date());

  // Ensure the skeleton is shown for at least 500ms so the slide-up animation
  // isn't competing with BigCalendar rendering at the same time.
  const [calReady, setCalReady] = useState(false);
  useEffect(() => {
    if (!visible) { setCalReady(false); return; }
    const t = setTimeout(() => setCalReady(true), 500);
    return () => clearTimeout(t);
  }, [visible]);

  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);

  const onModeChange = (mode: Mode) => {
    setCalMode(mode);
  };

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

  const scrollOffset = useMemo(() =>
    new Date().getHours() * 60 - 60,
    []
  );


  const calendarById = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars]);
  const eventCellStyle = useCallback((e: Event) => ({ backgroundColor: eventColor(e, calendarById) }), [calendarById]);

  const activeCal = useMemo(() => calendar ? new Set<string>([calendar.id]) : new Set<string>(), [calendar]);
  const { visibleEvents } = useVisibleEvents(events, activeCal);

  const [rangeStart, rangeEnd] = useMemo(
    () => {
      const d = dayjs(anchorDate);
      switch (calMode) {
        case 'day':
          return [d.subtract(1, 'day').startOf('day').toDate(), d.add(2, 'day').endOf('day').toDate()] as [Date, Date];
        case '3days':
        case 'week':
          return [d.subtract(2, 'week').startOf('day').toDate(), d.add(2, 'week').endOf('day').toDate()] as [Date, Date];
        default:
          return [d.subtract(2, 'month').startOf('month').toDate(), d.add(2, 'month').endOf('month').toDate()] as [Date, Date];
      }
    },
    [calMode, anchorDate],
  );

  const expandedEvents = useMemo(
    () => expandRecurringEvents(visibleEvents, rangeStart, rangeEnd),
    [visibleEvents, rangeStart, rangeEnd],
  );

  const enrichedEventsByDate = useMemo(
    () => enrichEvents(expandedEvents, true),
    [expandedEvents],
  );

  return (
    <Modal
      visible={visible}
      onRequestClose={handleClose}
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
              <Pressable
                style={{ flex: 1, alignItems: "flex-end", paddingRight: 12 }}
                onPress={() => openCalendarSettings(calendar!)}
              >
                <Feather name="settings" size={24} color={colors.fg2} />
              </Pressable>
            </View>
            <View style={{ height: calendarSpace }}>
              <View style={{
                paddingHorizontal: 16, flexDirection: "row", paddingVertical: 8, alignItems: "center",
                borderBottomWidth: 1, borderColor: colors.line
              }}>
                <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, flex: 1 }}>
                  <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
                    {anchorDate.toLocaleString("en-UK", { month: "long" })}
                  </Text>
                  {showKanji &&
                    <Text style={{ fontFamily: fonts.kanji, fontSize: 14, color: colors.fg3 }}>
                      {MONTH_KANJI[new Date().getMonth()]}
                    </Text>
                  }
                </View>
                <View style={{
                  flexDirection: 'row',
                  borderWidth: 1, borderColor: colors.line2, borderRadius: 999, padding: 2, gap: 2
                }}>
                  {(["day", "week", "month"] as Mode[]).map((m) => (
                    <Pressable
                      key={m}
                      style={{
                        paddingHorizontal: 14, paddingVertical: 5, borderRadius: 999,
                        backgroundColor: calMode === m ? colors.fg : 'transparent'
                      }}
                      onPress={() => onModeChange(m)}
                    >
                      <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: calMode === m ? colors.bg : colors.fg2 }}>
                        {m.charAt(0).toUpperCase()}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable
                  style={{ paddingLeft: 16 }}
                  onPress={() => setJumpDate(new Date())}>
                  <Text style={{ color: colors.fg3, fontSize: 12, letterSpacing: 1.5 }}>TODAY</Text>
                </Pressable>
              </View>
              <View
                style={{ flex: 1 }}
                onLayout={(event) => setCalHeight(event.nativeEvent.layout.height)}
              >
                {(!calReady || calHeight === 0) && <CalendarSkeleton />}
                {calReady && calHeight > 0 && (
                  <Animated.View entering={FadeIn.duration(350)} style={{ flex: 1 }}>
                    <BigCalendar
                      events={expandedEvents}
                      eventsAreSorted={true}
                      enableEnrichedEvents={true}
                      enrichedEventsByDate={enrichedEventsByDate}
                      height={calMode === "month" ? calHeight : calHeight + 95}
                      theme={calendarTheme}
                      eventCellStyle={eventCellStyle}
                      mode={calMode}
                      weekStartsOn={weekStartsOn === "sunday" ? 0 : 1}
                      swipeEnabled={true}
                      showAllDayEventCell={false}
                      date={jumpDate}
                      scrollOffsetMinutes={scrollOffset}
                      onSwipeEnd={setAnchorDate}
                      onPressEvent={openEventDetail}
                    />
                  </Animated.View>
                )}
              </View>
            </View>
            {canEditEvents && (
              <Pressable style={[styles.fab, { bottom: 16 + insets.bottom }]}
                onPress={() => {
                  setPrefilledEvent(undefined);
                  setNewEventVisible(true);
                }}
              >
                <Feather name="plus" color={colors.bg} size={16} />
              </Pressable>
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
      <AddEventModal
        visible={newEventVisible}
        startingDate={startingDate}
        onClose={() => setNewEventVisible(false)}
        onSave={(e) => addEvent(e, api)}
        onEdit={(e) => updateEvent(e, api)}
        calendars={calendars}
        event={prefilledEvent}
      />
      <EventDetailModal
        visible={eventDetailVisible}
        onClose={() => setEventDetailVisible(false)}
        onDelete={(event: Event) => removeEvent(event, api)}
        onEdit={(event: Event) => handlerEventEdit(event)}
        event={eventDetail}
        canEdit={canEditEvents}
      />
      <CalendarSettingsModal
        calendar={calendarSettings}
        visible={calendarSettingsVisible}
        onClose={() => {
          setCalendarSettingsVisible(false);
          setStartingDate(undefined);
        }}
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
