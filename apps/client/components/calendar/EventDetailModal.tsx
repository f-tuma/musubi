import { Event, can } from "@musubi/types";
import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Feather, Ionicons } from "@expo/vector-icons";
import { Modal, Pressable, Text, View, ScrollView, Linking, Platform } from "react-native"
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSettingsStore } from "@/store/useSettingsStore";


type Props = {
  event: Event | null,
  visible: boolean,
  onClose: () => void,
  onDelete: (event: Event) => void,
  onEdit: (event: Event) => void,
  canEdit?: boolean, // false for invited members / external calendars → read-only
};

const openMaps = (location: string) => {
  const query = encodeURIComponent(location);
  const url = Platform.OS === 'ios'
    ? `maps:?q=${query}`
    : `geo:0,0?q=${query}`;
  Linking.openURL(url);
};

export default function EventDetailModal({ event, visible, onClose, onDelete, onEdit, canEdit = true }: Props) {
  const { calendars } = useCalendarsStore();

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
            {canEdit && (
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
                  onPress={() => {
                    onEdit(event!);
                    handleClose();
                  }}
                >
                  <Feather size={20} name="edit" color={colors.fg2} />
                  <Text style={{ color: colors.fg2, fontSize: 10 }}>Edit</Text>
                </Pressable>
                <View style={styles.modalActionDivider} />
                <Pressable
                  style={styles.modalActionBtn}
                  disabled={event ? false : true}
                  onPress={() => {
                    onDelete(event!);
                    handleClose();
                  }}
                >
                  <Feather size={20} name="trash" color={colors.accent} />
                  <Text style={{ color: colors.accent, fontSize: 10 }}>Delete</Text>
                </Pressable>
              </View>
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal >
  );
}
