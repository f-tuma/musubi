import { Event, can } from "@musubi/types";
import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Feather, Ionicons } from "@expo/vector-icons";
import { Alert, Modal, Pressable, Text, View, ScrollView, Linking, Platform } from "react-native"
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSettingsStore } from "@/store/useSettingsStore";
import { useEventsStore } from "@/store/useEventsStore";
import { useApi } from "@/services/api";
import { useState } from "react";
import CalendarPickerModal from "./CalendarPickerModal";


type Props = {
  event: Event | null,
  visible: boolean,
  onClose: () => void,
  onEdit: (event: Event) => void,
};

const openMaps = (location: string) => {
  const query = encodeURIComponent(location);
  const url = Platform.OS === 'ios'
    ? `maps:?q=${query}`
    : `geo:0,0?q=${query}`;
  Linking.openURL(url);
};

export default function EventDetailModal({ event, visible, onClose, onEdit }: Props) {
  const { calendars } = useCalendarsStore();

  const api = useApi();
  const { linkEvent, forkEvent, removeEvent } = useEventsStore();
  const [linkVisible, setLinkVisible] = useState(false);
  const [forkVisible, setForkVisible] = useState(false);
  const [unlinkVisible, setUnlinkVisible] = useState(false);

  // Editing content (and deleting) is governed by the event's HOME (origin) calendar —
  // same rule the server enforces. Not the calendar you happen to be viewing it in.
  const originCal = calendars.find(c => c.id === event?.originCalendarID);
  // Origin deleted (null) → server falls back to creator-or-any-linked-editor,
  // so mirror that; origin set but not ours → view-only, as before.
  const canEditContent = event?.originCalendarID
    ? can(originCal?.role, "editEvents")
    : !!event && event.calendars.some(id => can(calendars.find(c => c.id === id)?.role, "editEvents"));

  // Unlink = remove from a non-origin calendar you can edit (home is removed via Delete).
  const canUnlink = !!event && calendars.some(c =>
    event.calendars.includes(c.id) && c.id !== event.originCalendarID && can(c.role, "editEvents"));

  const {
    timeLocale,
  } = useSettingsStore();

  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);


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
            <ScrollView
              horizontal
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ paddingLeft: 20, paddingBottom: 5, }}
            >
              <View style={styles.horizontalPillView}>
                {event?.calendars.map((cal) => {
                  const filteredCalendars = calendars.filter(c => c.id === cal);
                  if (filteredCalendars.length !== 0) {
                    const calendar = filteredCalendars[0];
                    const isOrigin = event?.originCalendarID === cal;
                    const locked = !can(calendar.role, "editEvents");
                    return (
                      <Pressable key={cal} style={styles.pillActive}>
                        {isOrigin
                          ? <Ionicons name="star" size={12} color={calendar.color} />
                          : locked
                            ? <Feather name="lock" size={11} color={calendar.color} />
                            : <View style={[styles.colorDot, { backgroundColor: calendar.color }]} />}
                        <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg }}>
                          {calendar.name}
                        </Text>
                      </Pressable>
                    );
                  }
                })}
              </View>
            </ScrollView>
            <View style={styles.modalTitleRow}>
              <Text style={styles.modalTitle}>{event?.title}</Text>
            </View>
            <ScrollView>
              <View style={styles.fieldContainer}>
                <View style={styles.modalDetailRow}>
                  <Feather size={20} name="calendar" color={colors.fg4} />
                  <Text style={{ color: colors.fg2 }}>
                    {event?.start.toLocaleString(timeLocale, { weekday: "long", month: "long", day: "numeric" })}
                    {new Date(new Date(event?.start!).setHours(0, 0, 0, 0)).getTime()
                      === new Date(new Date(event?.end!).setHours(0, 0, 0, 0)).getTime() ? ""
                      : " – " + event?.end.toLocaleString(timeLocale, { weekday: "long", month: "long", day: "numeric" })
                    }
                  </Text>
                </View>
                {!event?.isAllDay &&
                  <View style={styles.modalDetailRow}>
                    <Feather size={20} name="clock" color={colors.fg4} />
                    <Text style={{ color: colors.fg2 }}>
                      {event?.start.toLocaleString(timeLocale, { hour: "2-digit", minute: "2-digit" })}
                      {" – "}
                      {event?.end.toLocaleString(timeLocale, { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                }
                {event?.location &&
                  <View style={styles.modalDetailRow}>
                    <Feather size={20} name="map-pin" color={colors.fg4} />
                    <Pressable onPress={() => openMaps(event.location!)}>
                      <Text style={{ color: colors.fg2, textDecorationLine: "underline" }}>{event?.location}</Text>
                    </Pressable>
                  </View>
                }
                {event?.url &&
                  <View style={styles.modalDetailRow}>
                    <Feather size={20} name="link" color={colors.fg4} />
                    <Pressable onPress={() => { Linking.openURL(event?.url!) }}>
                      <Text style={{ color: colors.fg2, textDecorationLine: "underline" }}>{event?.url}</Text>
                    </Pressable>
                  </View>
                }
              </View>
              {
                event?.description &&
                <View style={styles.fieldContainer}>
                  <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Note</Text>
                  <View style={{
                    padding: 12,
                    backgroundColor: colors.bg3,
                    borderColor: colors.line,
                    borderWidth: 1,
                    borderRadius: 8
                  }}>
                    <Text style={{ fontFamily: fonts.serif, color: colors.fg2 }}>{event?.description}</Text>
                  </View>
                </View>
              }
            </ScrollView>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingBottom: insets.bottom,
              }}
            >
              <Pressable
                style={styles.modalActionBtn}
                disabled={event ? false : true}
                onPress={() => setLinkVisible(true)}
              >
                <Feather size={20} name="link" color={colors.fg2} />
                <Text style={{ color: colors.fg2, fontSize: 10 }}>Link</Text>
              </Pressable>
              <View style={styles.modalActionDivider} />
              <Pressable
                style={styles.modalActionBtn}
                disabled={event ? false : true}
                onPress={() => setForkVisible(true)}
              >
                <Feather size={20} name="copy" color={colors.fg2} />
                <Text style={{ color: colors.fg2, fontSize: 10 }}>Fork</Text>
              </Pressable>
              {canEditContent && (
                <>
                  <View style={styles.modalActionDivider} />
                  <Pressable
                    style={styles.modalActionBtn}
                    disabled={event ? false : true}
                    onPress={() => {
                      onEdit(event!);
                      handleClose();
                    }}
                  >
                    <Feather size={20} name="edit" color={colors.fg2} />
                    <Text style={{ color: colors.fg2, fontSize: 10 }}>Edit</Text>
                  </Pressable>
                </>
              )}
              {canUnlink && (
                <>
                  <View style={styles.modalActionDivider} />
                  <Pressable
                    style={styles.modalActionBtn}
                    disabled={event ? false : true}
                    onPress={() => setUnlinkVisible(true)}
                  >
                    <Feather size={20} name="minus-circle" color={colors.fg2} />
                    <Text style={{ color: colors.fg2, fontSize: 10 }}>Unlink</Text>
                  </Pressable>
                </>
              )}
              {canEditContent && (
                <>
                  <View style={styles.modalActionDivider} />
                  <Pressable
                    style={styles.modalActionBtn}
                    disabled={event ? false : true}
                    onPress={() => {
                      if (!event) return;
                      Alert.alert(
                        "Delete event",
                        event.recurrence
                          ? "This deletes the entire recurring series from all calendars."
                          : "This removes the event from all calendars.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete", style: "destructive", onPress: () => {
                              removeEvent(event, api); // cascade from origin
                              handleClose();
                            },
                          },
                        ],
                      );
                    }}
                  >
                    <Feather size={20} name="trash" color={colors.accent} />
                    <Text style={{ color: colors.accent, fontSize: 10 }}>Delete</Text>
                  </Pressable>
                </>
              )}
            </View>
            <CalendarPickerModal
              title="Add to calendar"
              visible={linkVisible}
              filter={(c) => !event?.calendars.includes(c.id)}
              emptyLabel="No calendars you can add this to."
              onClose={() => setLinkVisible(false)}
              onSelect={async (calendarID) => { if (event) await linkEvent(event, calendarID, api); }}
            />
            <CalendarPickerModal
              title="Fork to calendar"
              visible={forkVisible}
              filter={(c) => !event?.calendars.includes(c.id)}
              emptyLabel="No calendars you can fork this to."
              onClose={() => setForkVisible(false)}
              onSelect={async (calendarID) => { if (event) await forkEvent(event, calendarID, api); }}
            />
            <CalendarPickerModal
              title="Remove from calendar"
              visible={unlinkVisible}
              filter={(c) => !!event?.calendars.includes(c.id) && c.id !== event?.originCalendarID}
              emptyLabel="No calendars to remove this from."
              onClose={() => setUnlinkVisible(false)}
              onSelect={async (calendarID) => { if (event) await removeEvent(event, api, calendarID); }}
            />
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal >
  );
}
