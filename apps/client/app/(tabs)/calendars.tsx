import CalendarDetail from "@/components/calendar/CalendarDetailModal";
import CreateCalendarModal from "@/components/calendar/CreateCalendarModal";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar } from "@/constants/types";
import { useVisibleEvents } from "@/hooks/useVisibleEvents";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";


export default function CalendarsTab() {
  const { calendars, addCalendar, removeCalendar, updateCalendar } = useCalendarsStore();
  const { events } = useEventsStore();
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [calendarDetailVisible, setCalendarDetailVisible] = useState(false);
  const [prefilledCalendar, setPrefilledCalendar] = useState<Calendar | null>(null);

  const handleOpenCalendar = (calendar: Calendar) => {
    setPrefilledCalendar(calendar);
    setCalendarDetailVisible(true);
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
          Calendars
        </Text>
      </View>
      <View style={[styles.modalButtons, { backgroundColor: colors.bg }]}>
        <Pressable style={styles.btnPrimary} onPress={() => setCreateModalVisible(true)}>
          <Feather size={14} name="plus" color={colors.bg3} />
          <Text style={styles.btnPrimaryText}>Create Calendar</Text>
        </Pressable>
      </View>
      <ScrollView style={{ zIndex: -1 }}>
        <View style={{ height: 1, backgroundColor: colors.line }} />
        {calendars.map((c) => {
          const { visibleEvents } = useVisibleEvents(events, new Set([c.id]));
          return (
            <Pressable
              key={c.id}
              onPress={() => handleOpenCalendar(c)}
            >
              <View style={[styles.container, { overflow: "hidden", flexDirection: "row", justifyContent: "space-between", gap: 18 }]}>
                <View style={styles.calendarCircle}>
                  <View style={[styles.calendarCircleInner, { backgroundColor: c.color }]} />
                </View>
                <View style={{ flex: 1, justifyContent: 'center', }}>
                  <Text style={{ fontFamily: fonts.sansMedium, color: colors.fg2 }}>{c.name}</Text>
                  <Text style={{ fontFamily: fonts.sans, color: colors.fg3, fontSize: 10 }}>{c.members.length} members · {visibleEvents.length} events</Text>
                </View>
                <View style={{ justifyContent: 'center' }}>
                  <Feather name="chevron-right" size={14} color={colors.fg4} />
                </View>
              </View >
              <View style={{ height: 1, backgroundColor: colors.line }} />
            </Pressable>
          )
        })}
      </ScrollView>
      <CreateCalendarModal
        visible={createModalVisible}
        onCreate={(calendar) => addCalendar(calendar)}
        onClose={() => setCreateModalVisible(false)}
        onEdit={updateCalendar}
      />
      <CalendarDetail
        calendar={prefilledCalendar}
        visible={calendarDetailVisible}
        onClose={() => setCalendarDetailVisible(false)}
        onEdit={(cal) => setPrefilledCalendar(cal)}
        onDelete={(calendar) => {
          setPrefilledCalendar(null);
          removeCalendar(calendar);
        }}
      />
    </SafeAreaView >
  );
}
