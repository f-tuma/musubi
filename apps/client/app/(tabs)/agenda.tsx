import { AddEventModal } from "@/components/calendar/AddEventModal";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import EventDetailModal from "@/components/calendar/EventDetailModal";
import { colors, fonts, styles } from "@/constants/theme";
import { Event } from "@musubi/types";
import { eventDay } from "@musubi/calendar";
import { useApi } from "@/services/api";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { RefreshControl } from "react-native";
import { useRefreshData } from "@/hooks/useRefreshData";
import { eventColor } from "@/lib/eventColor";



const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

const PAGE = 14;

export default function AgendaTab() {
  const api = useApi();
  const { events, addEvent, updateEvent, removeEvent } = useEventsStore();
  const { calendars, activeCals, soloCalId, toggleCal, soloCalendar, syncActiveCals } = useCalendarsStore();
  useEffect(() => {
    syncActiveCals(calendars);
  }, [calendars]);

  const [newEventVisible, setNewEventVisible] = useState(false);
  const [eventDetailVisible, setEventDetailVisible] = useState<boolean>(false);
  const [prefilledEvent, setPrefilledEvent] = useState<Event | undefined>(undefined);
  const [eventDetail, setEventDetail] = useState<Event | null>(null);

  const [shown, setShown] = useState(PAGE);
  const scrollRef = useRef<ScrollView>(null);
  // Filter changed → collapse to the first page and jump to top, so a toggle
  // only ever re-renders PAGE rows instead of the whole (possibly huge) list.
  useEffect(() => {
    setShown(PAGE);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [activeCals]);

  const refresh = useRefreshData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  };

  const calendarById = useMemo(
    () => new Map(calendars.map(c => [c.id, c])),
    [calendars]
  );

  const todayKey = useMemo(() => dateKey(new Date()), []);

  const groups = useMemo(() => {
    const now = new Date();
    const sorted = events
      .filter(e =>
        (e.isAllDay
          // all-day: keep today or later by CALENDAR day — its raw UTC-midnight
          // instant is already "past" by mid-morning, which wrongly hid it.
          ? !eventDay(e.start, true).isBefore(eventDay(now), 'day')
          : e.start > now)
        && e.calendars.some(id => activeCals.has(id)))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const result: { date: Date, items: Event[] }[] = [];
    let lastKey = "";
    for (const e of sorted) {
      // Normalize all-day events (stored as UTC-midnight) to their calendar day in
      // the local frame via eventDay, so both the grouping key AND the displayed
      // date (g.date.toLocaleString) land on the right day in any tz. Timed events
      // pass through unchanged.
      const d = eventDay(e.start, e.isAllDay).toDate();
      const key = dateKey(d);
      if (key === lastKey) {
        result[result.length - 1].items.push(e);
      } else {
        result.push({ date: d, items: [e] });
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
        calendars={calendars}
        activeCals={activeCals}
        soloCalId={soloCalId}
        onToggle={toggleCal}
        onSolo={soloCalendar}
      />
      <ScrollView
        ref={scrollRef}
        style={{ paddingHorizontal: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent }) => {
          const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
          const fromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          if (fromBottom < 400) setShown(s => Math.min(s + PAGE, groups.length));
        }}
      >
        {
          groups.slice(0, shown).map((g) => (
            <Animated.View
              key={g.date.toISOString()}
              entering={FadeIn.duration(250)}
            >
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
                        <View style={{ width: 1, backgroundColor: eventColor(e, calendarById), alignSelf: "stretch" }} />
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
            </Animated.View>
          ))
        }
      </ScrollView>
      <Animated.View entering={FadeIn.duration(400)}>
        <Pressable style={styles.fab} onPress={() => {
          if (process.env.EXPO_OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setPrefilledEvent(undefined);
          setNewEventVisible(true);
        }}>
          <Text style={{ color: colors.bg, fontSize: 28, lineHeight: 30 }}>+</Text>
        </Pressable>
      </Animated.View>
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
