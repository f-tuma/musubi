import { colors, styles } from "@/constants/theme";
import { Calendar, Event, can } from "@musubi/types";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useEventsStore } from "@/store/useEventsStore";
import { presentEventDetail } from "@/store/useEventDetailStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, Pressable, View, useWindowDimensions } from "react-native";
import { ModalPortal as Modal } from "@/components/ui/ModalPortal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { expandRecurringEvents, type Mode } from "@musubi/calendar";
import dayjs from "dayjs";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { AddEventModal, DOCK_PEEK } from "./AddEventModal";
import { Draft, DRILL_OPEN_MIN, minutesToY, Rect } from "@/components/cal/layout";
import { CalendarDrillView, useCalendarDrill } from "./CalendarDrillView";
import { CalendarHeader } from "./CalendarHeader";
import { useCalendarsStore } from "@/store/useCalendarsStore";
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
import { userFacingError } from "@/lib/network";


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
  const { weekStartsOn, defaultCalendarView } = useSettingsStore();

  const [calMode, setCalMode] = useState<CalMode>(
    defaultCalendarView === "week" || defaultCalendarView === "day" ? defaultCalendarView : "month");
  const [base, setBase] = useState(new Date());
  const [anchorDate, setAnchorDate] = useState(new Date());
  // Docked composer, same model as the home tab: no FAB — it peeks in day view
  // (or when there's a draft) and rides drag-to-create.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dockHidden, setDockHidden] = useState(false);   // X hides the sheet until the next draft
  const [newCalendarVisible, setNewCalendarVisible] = useState(false);
  const [calendarSettingsVisible, setCalendarSettingsVisible] = useState(false);
  const [prefilledCalendar, setPreffiledCalendar] = useState<Calendar | undefined>(undefined);
  const [calendarSettings, setCallendarSettings] = useState<Calendar | null>(null);
  const scrollPosRef = useRef(Math.max(0, minutesToY(new Date().getHours() * 60 - 60)));
  // drill-in day view keeps its own scroll memory, reset to noon on each open
  const drillScrollPosRef = useRef(minutesToY(DRILL_OPEN_MIN));

  const insets = useSafeAreaInsets();
  // keyboardAware off: the docked composer owns the keyboard lift; without this
  // the detail sheet would ride the keyboard too and both would move.
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose, false);

  const {
    drill, contentReady: drillContentReady, zoom, monthTransition, drillOpacity,
    openDrill: beginDrill, closeDrill: animateDrillClosed, resetDrill,
  } = useCalendarDrill(anchorDate);

  const openDrill = useCallback((date: Date, rect: Rect) => {
    setDraft(null);
    setDockHidden(false); // a fresh drill always re-shows the composer, even if X hid it last time
    drillScrollPosRef.current = minutesToY(DRILL_OPEN_MIN); // day view always opens at this time
    beginDrill(date, rect);
    setAnchorDate(date);
  }, [beginDrill]);

  useEffect(() => {
    if (!visible) resetDrill(() => setDraft(null)); // sheet dismissed mid-drill
  }, [visible, resetDrill]);

  const closeDrill = useCallback(() => {
    const sourceHeaderDate = drill?.sourceHeaderDate;
    animateDrillClosed(() => {
      setDraft(null);
      if (sourceHeaderDate) setAnchorDate(sourceHeaderDate);
    });
  }, [animateDrillClosed, drill]);

  const switchMode = (mode: Mode) => {
    if (mode !== "month" && mode !== "week" && mode !== "day") return;
    setDraft(null);
    if (drill) {
      if (mode === "month") { closeDrill(); return; }
      resetDrill();
    }
    setBase(anchorDate);
    setCalMode(mode);
  };

  const onTodayPress = () => {
    const now = new Date();
    resetDrill();
    setBase(now);
    setAnchorDate(now);
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

  // Store write — the global host renders the modal; it stacks above this one.
  const openEventDetail = useCallback((event: Event) => presentEventDetail(events, event), [events]);

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
        .catch(err => {
          console.error("Move failed:", err);
          warn();
          localUpdateEvent(fallback);
          showToast({ message: userFacingError(err, "Event could not be moved.") });
        });
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

  const onPageChange = useCallback((date: Date) => setAnchorDate(date), []);

  // Dock model mirrors app/(tabs)/index.tsx: mounted in day/week (or a drill),
  // and it peeks when there's a draft, in day view, or during a drill — no FAB.
  // Gated on canEditEvents so a viewer never gets a composer.
  const dockVisible = canEditEvents && (calMode !== "month" || !!drill);
  const dockPeeking = !!draft || ((calMode === "day" || !!drill) && !dockHidden);

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
          <Pressable style={{ flex: 1 }} onPress={handleClose} accessible={false} />
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
              <CalendarHeader
                anchorDate={anchorDate}
                calMode={drill ? "day" : calMode}
                onModeChange={switchMode}
                onBackToMonth={drill ? closeDrill : undefined}
                drillSourceDate={drill?.sourceHeaderDate}
                drillProgress={monthTransition}
                onTodayPress={onTodayPress}
              />
              <CalendarDrillView
                calMode={calMode}
                base={base}
                events={expandedEvents}
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
                bottomPad={dockPeeking ? DOCK_PEEK + 14 : insets.bottom + 20}
                drillBottomPad={dockHidden && !draft ? insets.bottom + 20 : DOCK_PEEK + 14}
                drill={drill}
                drillContentReady={drillContentReady}
                zoom={zoom}
                monthTransition={monthTransition}
                drillOpacity={drillOpacity}
                backgroundColor={colors.bg1}
              />
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
            dockRevealProgress={drill ? monthTransition : undefined}
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
