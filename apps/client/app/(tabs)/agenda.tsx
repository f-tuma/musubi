import { AddEventModal } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import EventDetailModal from "@/components/calendar/EventDetailModal";
import { colors, fonts, styles } from "@/constants/theme";
import { Event } from "@musubi/types";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";



const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

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

  const calendarById = useMemo(
    () => new Map(calendars.map(c => [c.id, c])),
    [calendars]
  );

  const todayKey = useMemo(() => dateKey(new Date()), []);

  const groups = useMemo(() => {
    const now = new Date();
    const sorted = events
      .filter(e => e.start > now && e.calendars.some(id => activeCals.has(id)))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const result: { date: Date, items: Event[] }[] = [];
    let lastKey = "";
    for (const e of sorted) {
      const key = dateKey(e.start);
      if (key === lastKey) {
        result[result.length - 1].items.push(e);
      } else {
        result.push({ date: e.start, items: [e] });
        lastKey = key;
      }
    }
    return result;
  }, [events, activeCals]);

  const handlerEventEdit = useCallback((event: Event) => {
    setEventDetailVisible(false);
    setPrefilledEvent(event);
    setNewEventVisible(true);
  }, []);

  const openEventDetail = useCallback((event: Event) => {
    setEventDetail(event);
    setEventDetailVisible(true);
  }, []);

  return (
    <View style={styles.screen}>
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
      <ScrollView style={{ paddingHorizontal: 16 }}>
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
                  {dateKey(g.date) === todayKey &&
                    <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
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
                                <View style={[styles.colorDot, { backgroundColor: calendarById.get(c)?.color ?? "" }]} />
                                <Text style={styles.timelineMeta}>{calendarById.get(c)?.name ?? ""}</Text>
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
    </View>
  );
}
