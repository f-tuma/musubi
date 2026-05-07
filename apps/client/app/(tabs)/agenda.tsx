import { AddEventModal } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import EventDetailModal from "@/components/calendar/EventDetailModal";
import { colors, fonts, styles } from "@/constants/theme";
import { Event } from "@/constants/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";



export default function AgendaTab() {
  const api = useApi();
  const { events, addEvent, updateEvent, removeEvent } = useEventsStore();
  const { calendars, activeCals, toggleCal, syncActiveCals } = useCalendarsStore();
  useEffect(() => {
    syncActiveCals(calendars);
  }, [calendars]);

  const [newEventVisible, setNewEventVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState<boolean>(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);

  const groups = useMemo(() => {
    const sorted = events
      .filter(e => e.calendars.some(id => activeCals.has(id)))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const result: { date: Date, items: Event[] }[] = [];
    sorted.forEach(e => {
      const g = result[result.length - 1];
      const eDate = e.start.toLocaleString("en-UK", { year: "numeric", month: "numeric", day: "numeric" });
      if (g && g.date.toLocaleString("en-UK", { year: "numeric", month: "numeric", day: "numeric" }) === eDate) {
        g.items.push(e);
      } else {
        result.push({ date: e.start, items: [e] });
      }
    });
    return result;
  }, [events, activeCals]);

  const handlerEventEdit = (event: Event) => {
    setEventDetailVisible(false);
    setPrefilledEvent(event);
    setNewEventVisible(true);
  };

  const openEventDetail = (event: Event) => {
    setEventDetail(event);
    setEventDetailVisible(true);
  };

  const getCalendarFromId = (id: string) => {
    return calendars.filter(cal => cal.id === id)[0];
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
          Agenda
        </Text>
      </View>
      <CalendarFilterBar
        onToggle={toggleCal}
        calendars={calendars}
        activeCals={activeCals}
      />
      <ScrollView style={{ zIndex: -1, paddingHorizontal: 16 }}>
        {
          groups.map(g => (
            <View key={g.date.toISOString()}>
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
                  {
                    new Date().toLocaleString("en-UK", {
                      year: "numeric",
                      month: "numeric",
                      day: "numeric"
                    }) === g.date.toLocaleString("en-UK", {
                      year: "numeric",
                      month: "numeric",
                      day: "numeric"
                    }) &&
                    < Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
                      TODAY
                    </Text>
                  }
                </View>
              </View>
              <View>
                {
                  g.items.map(e => (
                    <Pressable onPress={() => openEventDetail(e)} key={e.id} style={styles.timelineRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg2 }}>
                          {e.start.toLocaleString("en-UK", { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                        <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg4 }}>
                          {e.end.toLocaleString("en-UK", { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                      </View>
                      <View style={{ flexDirection: "row", flex: 4 }}>
                        <View style={{ width: 1, backgroundColor: e.color, alignSelf: "stretch" }} />
                        <View style={{ paddingLeft: 16, justifyContent: "center" }}>
                          <Text style={styles.timelineTitle}>{e.title}</Text>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            {e.calendars.map(c => (
                              <View key={c} style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                                <View style={[styles.colorDot, { backgroundColor: getCalendarFromId(c)?.color ?? "" }]} />
                                <Text style={styles.timelineMeta}>{getCalendarFromId(c)?.name ?? ""}</Text>
                              </View>
                            ))}
                          </View>
                        </View>
                      </View>
                    </Pressable>
                  ))
                }
              </View>
            </View>
          ))
        }
      </ScrollView>
      <Pressable style={styles.fab} onPress={() => {
        setPrefilledEvent(undefined);
        setNewEventVisible(true);
      }}>
        <Text style={{ color: colors.bg, fontSize: 28, lineHeight: 30 }}>+</Text>
      </Pressable>
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
        onDelete={(event: Event) => removeEvent(event, api)}
        onEdit={(event: Event) => handlerEventEdit(event)}
        event={eventDetail}
      />
    </SafeAreaView >
  );
}
