import { calendarTheme, colors, styles } from "@/constants/theme";
import { AddEventModal } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { CalendarHeader } from "@/components/calendar/CalendarHeader";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Calendar, Mode } from "react-native-big-calendar";
import EventDetailModal from "@/components/calendar/EventDetailModal";
import { Event } from "@musubi/types";
import { useEventsStore } from "@/store/useEventsStore";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useVisibleEvents } from "@/hooks/useVisibleEvents";
import { useApi } from "@/services/api";


export default function MainTab() {
  const api = useApi();
  const { events, addEvent, updateEvent, removeEvent } = useEventsStore();
  const {
    weekStartsOn,
    defaultCalendarView,
  } = useSettingsStore();

  const { calendars, activeCals, toggleCal, syncActiveCals } = useCalendarsStore();
  useEffect(() => {
    syncActiveCals(calendars);
  }, [calendars]);

  useEffect(() => {
    setCalMode(defaultCalendarView);
  }, [defaultCalendarView]);


  const [calHeight, setCalHeight] = useState(0);
  const [calMode, setCalMode] = useState<Mode>(defaultCalendarView);
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [jumpDate, setJumpDate] = useState<Date>(new Date());
  const [newEventVisible, setNewEventVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);
  const [startingDate, setStartingDate] = useState<Date | undefined>(new Date());

  const handlerEventEdit = (event: Event) => {
    setEventDetailVisible(false);
    setPrefilledEvent(event);
    setNewEventVisible(true);
  };

  const handleCreateEventOnCell = (date: Date) => {
    setStartingDate(date);
    setNewEventVisible(true);
  }

  const openEventDetail = useCallback((event: Event) => {
    setEventDetail(event);
    setEventDetailVisible(true);
  }, []);

  const { visibleEvents } = useVisibleEvents(events, activeCals);

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
      />
      <CalendarFilterBar
        calendars={calendars}
        activeCals={activeCals}
        onToggle={toggleCal}
      />
      <View
        style={{ flex: 1 }}
        onLayout={(event) => setCalHeight(event.nativeEvent.layout.height)}
      >
        {calHeight > 0 && (
          <Calendar
            events={visibleEvents}
            eventsAreSorted={true}
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
            onPressCell={handleCreateEventOnCell}
          />
        )}
      </View>
      <Pressable style={styles.fab} onPress={() => {
        setPrefilledEvent(undefined);
        setNewEventVisible(true);
      }}>
        <Text style={{ color: colors.bg, fontSize: 28, lineHeight: 30 }}>+</Text>
      </Pressable>
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
