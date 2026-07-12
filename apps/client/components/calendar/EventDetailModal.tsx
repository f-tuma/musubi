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
import { useEventsStore } from "@/store/useEventsStore";
import { Attendee, useApi } from "@/services/api";
import { useEffect, useState } from "react";
import CalendarPickerModal from "./CalendarPickerModal";
import { Tap } from "@/components/ui/Tap";
import { Avatar } from "@/components/Avatar";
import { useServer } from "@/contexts/ServerContext";
import { useAttendeesStore } from "@/store/useAttendeesStore";
import { chooseOption, confirm } from "@/lib/confirm";
import { formatDateLong, formatTime } from "@/lib/datetimeFormat";
import { excludeOccurrence, endSeriesBefore } from "@musubi/calendar";
import { syncEventNotification } from "@/services/notifications";


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
  const { authClient } = useServer();
  const { data: session } = authClient.useSession();
  const userID = session?.user.id;
  const { events, linkEvent, forkEvent, removeEvent, updateEvent } = useEventsStore();
  const [linkVisible, setLinkVisible] = useState(false);
  const [forkVisible, setForkVisible] = useState(false);
  const [unlinkVisible, setUnlinkVisible] = useState(false);

  // Attendees live in a shared store so the SSE "attendance_changed" frame can
  // update an open modal. Fetched fresh on open (stale entry shows meanwhile);
  // missing entry (offline / fetch failed) → section stays hidden.
  const { byEvent, setAttendees } = useAttendeesStore();
  const attendees = event ? byEvent[event.id] : undefined;
  useEffect(() => {
    if (visible && event) api.getEventAttendees(event).then(a => setAttendees(event.id!, a)).catch(() => { });
    // api is a fresh object every render — deps on it would refetch in a loop
  }, [visible, event?.id]);

  // TEST ONLY — 10 fake attendees to eyeball the facepile + expanded list; remove after review.
  const TEST_ATTENDEES: Attendee[] = [
    "Aiko Tanaka", "Filip Dvořák", "Hana Musilová", "Jan Svoboda", "Kenji Watanabe",
    "Lucie Králová", "Marek Horák", "Nina Procházková", "Petr Beneš", "Yuki Sato",
  ].map((name, i) => ({ id: `test-${i}`, name, image: null }));
  const shownAttendees = [...(attendees ?? []), ...TEST_ATTENDEES];

  // Collapsed by default on every open; tap the facepile to expand.
  const [attendeesOpen, setAttendeesOpen] = useState(false);
  useEffect(() => { setAttendeesOpen(false); }, [visible]);

  const isAttending = !!userID && !!attendees?.some(a => a.id === userID);
  const toggleAttendance = async () => {
    if (!event || !userID || !attendees || !session) return;
    const next = !isAttending;
    // Optimistic flip; the server's list (PUT response or SSE frame) replaces it.
    setAttendees(event.id!, next
      ? [...attendees, { id: userID, name: session.user.name, image: session.user.image }]
      : attendees.filter(a => a.id !== userID));
    try {
      setAttendees(event.id!, await api.setAttendance(event, next));
    } catch {
      setAttendees(event.id!, attendees); // revert
    }
  };

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
    timeFormat,
    dateFormat,
  } = useSettingsStore();

  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);

  // `event` carries the tapped occurrence's start/end; the store row holds the
  // series master (true anchor times) — updates must be built from the master.
  const master = events.find(e => e.id === event?.id);

  const deleteAll = () => {
    if (!event) return;
    removeEvent(event, api); // cascade from origin
    handleClose();
  };
  const deleteThisOccurrence = () => {
    if (!event || !master?.recurrence) return deleteAll();
    const updated = { ...master, recurrence: excludeOccurrence(master.recurrence, event.start) };
    updateEvent(updated, api);
    syncEventNotification(updated).catch(() => { });
    handleClose();
  };
  const deleteFollowing = () => {
    if (!event || !master?.recurrence) return deleteAll();
    // Ending before the first occurrence would leave an invisible husk.
    if (event.start.getTime() <= master.start.getTime()) return deleteAll();
    const updated = { ...master, recurrence: endSeriesBefore(master.recurrence, event.start) };
    updateEvent(updated, api);
    syncEventNotification(updated).catch(() => { });
    handleClose();
  };

  // Identity color: origin calendar first, else first visible linked calendar.
  const accent = (originCal ?? calendars.find(c => event?.calendars.includes(c.id)))?.color ?? colors.fg3;

  const sameDay = event && new Date(new Date(event.start).setHours(0, 0, 0, 0)).getTime()
    === new Date(new Date(event.end).setHours(0, 0, 0, 0)).getTime();
  const durationLabel = (() => {
    if (!event || event.isAllDay) return null;
    const mins = Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000);
    if (mins <= 0) return null;
    const h = Math.floor(mins / 60), m = mins % 60;
    return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
  })();

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

            {/* Identity first: brush-stroke accent + title + when. */}
            <View style={{ flexDirection: "row", gap: 14, paddingHorizontal: 22, paddingTop: 6, paddingBottom: 18 }}>
              <View style={{ width: 3, borderRadius: 2, backgroundColor: accent, alignSelf: "stretch", marginTop: 6, marginBottom: 2 }} />
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={[styles.modalTitle, { fontSize: 26, lineHeight: 32 }]}>{event?.title}</Text>
                <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.fg2 }}>
                  {event && formatDateLong(event.start, dateFormat)}
                  {!event || sameDay ? "" : " – " + formatDateLong(event.end, dateFormat)}
                </Text>
                {!event?.isAllDay &&
                  <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>
                    {event && formatTime(event.start, timeFormat)}
                    {" – "}
                    {event && formatTime(event.end, timeFormat)}
                    {durationLabel ? `  ·  ${durationLabel}` : ""}
                  </Text>
                }
                {event?.isAllDay &&
                  <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>All day</Text>
                }
              </View>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Where it lives — quiet metadata under the identity block. No
                  bottom border when nothing follows (avoids an empty "section"). */}
              <View style={[
                styles.fieldContainer,
                { paddingTop: 12, paddingBottom: 12 },
                !(event?.location || event?.url || event?.description || shownAttendees.length) && { borderBottomWidth: 0 },
              ]}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.horizontalPillView}>
                    {event?.calendars.map((cal) => {
                      const calendar = calendars.find(c => c.id === cal);
                      if (!calendar) return null;
                      const isOrigin = event?.originCalendarID === cal;
                      const locked = !can(calendar.role, "editEvents");
                      return (
                        <View key={cal} style={styles.pill}>
                          {isOrigin
                            ? <Ionicons name="star" size={12} color={calendar.color} />
                            : locked
                              ? <Feather name="lock" size={11} color={calendar.color} />
                              : <View style={[styles.colorDot, { backgroundColor: calendar.color }]} />}
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg2 }}>
                            {calendar.name}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              </View>
              {(event?.location || event?.url) ? (
                <View style={styles.fieldContainer}>
                  {event?.location &&
                    <View style={styles.modalDetailRow}>
                      <Feather size={20} name="map-pin" color={colors.fg4} />
                      <Tap style={{ flex: 1 }} onPress={() => openMaps(event.location!)}>
                        <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.fg2, textDecorationLine: "underline" }}>
                          {event?.location}
                        </Text>
                      </Tap>
                    </View>
                  }
                  {event?.url &&
                    <View style={styles.modalDetailRow}>
                      <Feather size={20} name="link" color={colors.fg4} />
                      <Tap style={{ flex: 1 }} onPress={() => { Linking.openURL(event?.url!) }}>
                        {/* Long links are all query params at the tail — ellipsize keeps the useful start. */}
                        <Text numberOfLines={1} ellipsizeMode="tail" style={{ color: colors.fg2, textDecorationLine: "underline" }}>
                          {event?.url}
                        </Text>
                      </Tap>
                    </View>
                  }
                </View>
              ) : null}
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
              {shownAttendees.length > 0 && (
                <View style={[styles.fieldContainer, { borderBottomWidth: 0 }]}>
                  {/* Same row anatomy as MemberRolesModal: label left, pill action right.
                      The label doubles as the expand/collapse toggle (chevron lives here so
                      it survives the facepile ↔ list swap below). */}
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <Tap scaleTo={1} hitSlop={10} onPress={() => setAttendeesOpen(o => !o)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Text style={[styles.fieldLabel, { fontFamily: fonts.sans, marginBottom: 0 }]}>
                        Attendees · {shownAttendees.length}
                      </Text>
                      <Feather name={attendeesOpen ? "chevron-up" : "chevron-down"} size={14} color={colors.fg4} />
                    </Tap>
                    <Tap
                      onPress={toggleAttendance}
                      haptic={isAttending ? "warn" : "success"}
                      style={{
                        borderWidth: 1, borderColor: colors.line2, borderRadius: 999, padding: 2,
                        backgroundColor: isAttending ? "transparent" : colors.fill,
                      }}
                    >
                      <View style={{ paddingHorizontal: 12, paddingVertical: 5 }}>
                        <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: isAttending ? colors.fg2 : colors.onFill }}>
                          {isAttending ? "Leave" : "Attend"}
                        </Text>
                      </View>
                    </Tap>
                  </View>
                  {/* Facepile "falls apart" into the list on expand — one or the other, never both. */}
                  {!attendeesOpen ? (
                    <Tap scaleTo={1} onPress={() => setAttendeesOpen(true)}>
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        {shownAttendees.slice(0, 7).map((a, i) => (
                          // bg1 ring separates the overlapping circles from each other
                          <View key={a.id} style={{ marginLeft: i === 0 ? 0 : -10, borderWidth: 2, borderColor: colors.bg1, borderRadius: 999 }}>
                            <Avatar name={a.name} image={a.image} size={32} />
                          </View>
                        ))}
                        {shownAttendees.length > 7 && (
                          <View style={{
                            marginLeft: -10, width: 36, height: 36, borderRadius: 18,
                            borderWidth: 2, borderColor: colors.bg1, backgroundColor: colors.bg3,
                            alignItems: "center", justifyContent: "center",
                          }}>
                            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg2 }}>
                              +{shownAttendees.length - 7}
                            </Text>
                          </View>
                        )}
                      </View>
                    </Tap>
                  ) : (
                    <ScrollView style={{ maxHeight: 216 }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                      <View style={{ gap: 12 }}>
                        {shownAttendees.map(a => (
                          <View key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                            <Avatar name={a.name} image={a.image} size={32} />
                            <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.fg, flex: 1 }} numberOfLines={1}>
                              {a.name}
                            </Text>
                            {a.id === userID && (
                              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg3 }}>You</Text>
                            )}
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  )}
                </View>
              )}
            </ScrollView>
            {/* Actions ordered by frequency of use: Edit leads (brightest), sharing
                verbs sit in the middle, Delete last. */}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                paddingBottom: insets.bottom,
                borderTopWidth: 1,
                borderTopColor: colors.line,
              }}
            >
              {canEditContent && (
                <>
                  <Tap
                    style={styles.modalActionBtn}
                    disabled={event ? false : true}
                    onPress={() => {
                      // Recurring: edit the SERIES → prefill with the master's
                      // anchor times, not the tapped occurrence's (saving those
                      // would shift the whole series).
                      onEdit(master ?? event!);
                      handleClose();
                    }}
                  >
                    <Feather size={20} name="edit-2" color={colors.fg} />
                    <Text style={{ color: colors.fg, fontSize: 10 }}>Edit</Text>
                  </Tap>
                  <View style={styles.modalActionDivider} />
                </>
              )}
              <Tap
                style={styles.modalActionBtn}
                disabled={event ? false : true}
                onPress={() => setLinkVisible(true)}
              >
                <Feather size={20} name="link" color={colors.fg2} />
                <Text style={{ color: colors.fg2, fontSize: 10 }}>Link</Text>
              </Tap>
              <View style={styles.modalActionDivider} />
              <Tap
                style={styles.modalActionBtn}
                disabled={event ? false : true}
                onPress={() => setForkVisible(true)}
              >
                <Feather size={20} name="copy" color={colors.fg2} />
                <Text style={{ color: colors.fg2, fontSize: 10 }}>Fork</Text>
              </Tap>
              {canUnlink && (
                <>
                  <View style={styles.modalActionDivider} />
                  <Tap
                    style={styles.modalActionBtn}
                    disabled={event ? false : true}
                    onPress={() => setUnlinkVisible(true)}
                  >
                    <Feather size={20} name="minus-circle" color={colors.fg2} />
                    <Text style={{ color: colors.fg2, fontSize: 10 }}>Unlink</Text>
                  </Tap>
                </>
              )}
              {canEditContent && (
                <>
                  <View style={styles.modalActionDivider} />
                  <Tap
                    style={styles.modalActionBtn}
                    haptic="warn"
                    disabled={event ? false : true}
                    onPress={() => {
                      if (!event) return;
                      if (event.recurrence) {
                        chooseOption("Delete recurring event", undefined, [
                          { label: "This event only", onPress: deleteThisOccurrence },
                          { label: "This and following events", onPress: deleteFollowing },
                          { label: "All events", destructive: true, onPress: deleteAll },
                        ]);
                      } else {
                        confirm({
                          title: "Delete event",
                          message: "This removes the event from all calendars.",
                          confirmLabel: "Delete",
                        }, deleteAll);
                      }
                    }}
                  >
                    <Feather size={20} name="trash" color={colors.accent} />
                    <Text style={{ color: colors.accent, fontSize: 10 }}>Delete</Text>
                  </Tap>
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
