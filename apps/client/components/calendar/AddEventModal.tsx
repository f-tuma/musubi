import "react-native-get-random-values";
import { Calendar, Event, can } from "@musubi/types";
import { colors, fonts, styles } from "@/constants/theme";
import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { appColors } from "@/constants/colors";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import DateTimePicker from '@expo/ui/community/datetime-picker';
import { useServer } from "@/contexts/ServerContext";
import { EVENT_HINTS } from "@/constants/event_hints";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useSettingsStore } from "@/store/useSettingsStore";
import { cancelEventPushNotification, getEventsNotificationIdentifier, removeNotification, scheduleEventPushNotification, storeNotification, updateEventPushNotification, updateNotificationTriggerDate } from "@/services/notifications";
import dayjs from "dayjs";
import { uuidv7 } from 'uuidv7';
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import * as haptics from "@/lib/haptics";

type Props = {
  visible: boolean;
  startingDate?: Date;
  onClose: () => void;
  onSave: (event: Event) => Promise<void>;
  onEdit: (event: Event) => Promise<void>;
  calendars: Calendar[];
  event?: Event;
};

const withHours = (base: Date, hours: number): Date => {
  const d = new Date(base);
  d.setHours(hours, 0, 0, 0);
  return d;
};

// ─── Recurrence ──────────────────────────────────────────────────────────────

type RecurrenceOption = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly' | 'custom';
type AdvancedFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
type AdvancedEndType = 'never' | 'count';

type AdvancedRRuleConfig = {
  freq: AdvancedFreq;
  interval: number;
  days: Set<number>;  // 0=Sun 1=Mon … 6=Sat
  endType: AdvancedEndType;
  count: number;
};

const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

// Display order Mon–Sun; day = JS weekday number
const WEEKDAYS_DISPLAY = [
  { label: 'M', day: 1 }, { label: 'T', day: 2 }, { label: 'W', day: 3 },
  { label: 'T', day: 4 }, { label: 'F', day: 5 }, { label: 'S', day: 6 }, { label: 'S', day: 0 },
];

const RECURRENCE_OPTIONS: { value: RecurrenceOption; label: string; icon: string }[] = [
  { value: 'none', label: 'None', icon: 'slash' },
  { value: 'daily', label: 'Daily', icon: 'sun' },
  { value: 'weekly', label: 'Weekly', icon: 'repeat' },
  { value: 'weekdays', label: 'Weekdays', icon: 'briefcase' },
  { value: 'monthly', label: 'Monthly', icon: 'calendar' },
  { value: 'yearly', label: 'Yearly', icon: 'award' },
  { value: 'custom', label: 'Custom', icon: 'sliders' },
];

function buildRRule(
  option: RecurrenceOption,
  startDate: Date,
  advanced: AdvancedRRuleConfig,
): string | null {
  switch (option) {
    case 'none': return null;
    case 'daily': return 'FREQ=DAILY';
    case 'weekly': return `FREQ=WEEKLY;BYDAY=${RRULE_DAYS[startDate.getDay()]}`;
    case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'monthly': return 'FREQ=MONTHLY';
    case 'yearly': return 'FREQ=YEARLY';
    case 'custom': {
      const { freq, interval, days, endType, count } = advanced;
      let rule = `FREQ=${freq}`;
      if (interval > 1) rule += `;INTERVAL=${interval}`;
      if (freq === 'WEEKLY' && days.size > 0) {
        rule += `;BYDAY=${[...days].sort().map(d => RRULE_DAYS[d]).join(',')}`;
      }
      if (endType === 'count') rule += `;COUNT=${count}`;
      return rule;
    }
  }
}

function parseRRule(rrule: string | null | undefined): RecurrenceOption {
  if (!rrule) return 'none';
  if (rrule === 'FREQ=DAILY') return 'daily';
  if (rrule === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return 'weekdays';
  if (/^FREQ=WEEKLY;BYDAY=[A-Z]{2}$/.test(rrule)) return 'weekly';
  if (rrule === 'FREQ=MONTHLY') return 'monthly';
  if (rrule === 'FREQ=YEARLY') return 'yearly';
  return 'custom'; // complex rule — open advanced panel
}

function parseAdvanced(rrule: string | null | undefined): AdvancedRRuleConfig {
  const defaults: AdvancedRRuleConfig = {
    freq: 'WEEKLY', interval: 1, days: new Set([1]), endType: 'never', count: 10,
  };
  if (!rrule) return defaults;
  const parts: Record<string, string> = {};
  rrule.replace(/^RRULE:/, '').split(';').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });
  const DAY_MAP: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return {
    freq: (parts.FREQ as AdvancedFreq) ?? 'WEEKLY',
    interval: parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1,
    days: parts.BYDAY
      ? new Set(parts.BYDAY.split(',').map(d => DAY_MAP[d] ?? 1))
      : new Set([1]),
    endType: parts.COUNT ? 'count' : 'never',
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : 10,
  };
}

function describeAdvanced(cfg: AdvancedRRuleConfig): string {
  const FREQ_LABEL: Record<AdvancedFreq, [string, string]> = {
    DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'],
    MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'],
  };
  const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [sing, plur] = FREQ_LABEL[cfg.freq];
  let s = cfg.interval === 1 ? `Every ${sing}` : `Every ${cfg.interval} ${plur}`;
  if (cfg.freq === 'WEEKLY' && cfg.days.size > 0) {
    s += ` on ${[...cfg.days].sort().map(d => DAY_NAME[d]).join(', ')}`;
  }
  if (cfg.endType === 'count') s += `, ${cfg.count} time${cfg.count !== 1 ? 's' : ''}`;
  return s;
}

export function AddEventModal({ visible, startingDate, onClose, onSave, onEdit, calendars, event }: Props) {
  const {
    notificationsOnByDefault,
    timeLocale,
  } = useSettingsStore();

  const insets = useSafeAreaInsets();
  const { authClient } = useServer();

  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newStart, setNewStart] = useState(startingDate ?? new Date());
  const [newEnd, setNewEnd] = useState(startingDate ?? new Date());
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [datePickerMode, setDatePickerMode] = useState<"date" | "time">("date");
  const [datePickerTarget, setDatePickerTarget] = useState<"start" | "end">("start");
  const [notifyBeforeTime, setNotifyBeforeTime] = useState<number>(15);
  const [notifyBeforePickerVisible, setNotifyBeforePickerVisible] = useState(false);
  const [notificationToggle, setNotificationToggle] = useState<boolean>(notificationsOnByDefault);
  const [allDayToggle, setAllDayToggle] = useState(false);
  const [newLocation, setNewLocation] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newRecurrence, setNewRecurrence] = useState<RecurrenceOption>('none');
  const [advFreq, setAdvFreq] = useState<AdvancedFreq>('WEEKLY');
  const [advInterval, setAdvInterval] = useState(1);
  const [advDays, setAdvDays] = useState<Set<number>>(new Set([1]));
  const [advEndType, setAdvEndType] = useState<AdvancedEndType>('never');
  const [advCount, setAdvCount] = useState(10);

  const [selectedCals, setSelectedCals] = useState<Set<string>>(
    () => new Set(calendars.slice(0, 1).map(c => c.id))
  );
  // Explicit origin (home) pick via long-press. Falls back to first selected.
  const [originCal, setOriginCal] = useState<string | null>(null);
  const originEffective = originCal && selectedCals.has(originCal)
    ? originCal
    : [...selectedCals][0];
  const [isLoading, setIsLoading] = useState(false);
  const [eventHint, setEventHint] = useState(EVENT_HINTS[Math.floor(Math.random() * EVENT_HINTS.length)])
  // Note/location/URL are the long tail — folded away until asked for.
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [nameError, setNameError] = useState("");
  const [calendarsError, setCalendarsError] = useState("");
  const [startError, setStartError] = useState("");
  const [endError, setEndError] = useState("");
  const [urlError, setUrlError] = useState("");

  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  const NOTIFY_BEFORE = [
    { label: "15 minutes", value: 15 },
    { label: "30 minutes", value: 30 },
    { label: "1 hour", value: 1 * 60 },
    { label: "Half a day", value: 12 * 60 },
    { label: "1 Day", value: 24 * 60 },
  ]

  const closeSequence = () => {
    onClose();

    setNewTitle('');
    setNameError("");
    setNewStart(new Date());
    setStartError("");
    setNewEnd(new Date());
    setEndError("");
    setNotificationToggle(notificationsOnByDefault);
    setNotifyBeforeTime(15);
    setSelectedCals(new Set(calendars.slice(0, 1).map(c => c.id)));
    setOriginCal(null);
    setNewDescription("");
    setCalendarsError("");
    setNewLocation("");
    setNewUrl("");
    setUrlError("");
    setDetailsOpen(false);
    setNewRecurrence('none');
    setAdvFreq('WEEKLY');
    setAdvInterval(1);
    setAdvDays(new Set([1]));
    setAdvEndType('never');
    setAdvCount(10);
    setEventHint(EVENT_HINTS[Math.floor(Math.random() * EVENT_HINTS.length)]);
  }

  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, closeSequence);

  useEffect(() => {
    if (visible) {
      setNewTitle(event?.title ?? "");
      setNewStart(event?.start ?? startingDate ?? new Date());
      setNewEnd(event?.end ?? startingDate ?? new Date());
      setSelectedCals(new Set(event?.calendars) ?? new Set<string>);
      setOriginCal(event?.originCalendarID ?? null);
      setNewDescription(event?.description ?? "");
      setNewLocation(event?.location ?? "");
      setNewUrl(event?.url ?? "");
      setDetailsOpen(!!(event?.description || event?.location || event?.url));
      const option = parseRRule(event?.recurrence);
      setNewRecurrence(option);
      if (option === 'custom') {
        const adv = parseAdvanced(event?.recurrence);
        setAdvFreq(adv.freq);
        setAdvInterval(adv.interval);
        setAdvDays(adv.days);
        setAdvEndType(adv.endType);
        setAdvCount(adv.count);
      }
    }
  }, [event, visible]);

  useEffect(() => {
    const lastStart = new Date(newStart);
    const lastEnd = new Date(newEnd);

    if (lastStart.getTime() > lastEnd.getTime()) {
      datePickerTarget === "start" ? setNewEnd(newStart) : setNewStart(newEnd);
    }

  }, [newStart, newEnd]);

  const toggleCal = (id: string) => {
    setSelectedCals(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  function roundMinutes(date: Date) {

    date.setHours(date.getHours() + Math.round(date.getMinutes() / 60));
    date.setMinutes(0, 0, 0);

    return date;
  }

  function getDatePickerValue() {
    const current = datePickerTarget === "start" ? new Date(newStart.getTime()) : new Date(newEnd.getTime());
    const final = datePickerMode === "date" ? current : roundMinutes(current);
    return final;
  }

  function setDateFromDatePicker(date: Date) {
    const minutes = datePickerTarget === "start" ? newStart.getMinutes() : newEnd.getMinutes();
    const hours = datePickerTarget === "start" ? newStart.getHours() : newEnd.getHours();

    if (datePickerMode === "date") {
      const fixed_hours = new Date(date.setHours(hours));
      const fixed_minutes = new Date(fixed_hours.setMinutes(minutes));
      datePickerTarget === "start" ? setNewStart(fixed_minutes) : setNewEnd(fixed_minutes);
    } else {
      datePickerTarget === "start" ? setNewStart(date) : setNewEnd(date);
    }
  }

  const setNotification = async (eventConstruct: Event) => {
    const start = eventConstruct.start.toLocaleString(timeLocale, { dateStyle: 'medium', timeStyle: "medium" });
    const end = eventConstruct.end.toLocaleString('en-UK', { dateStyle: 'medium', timeStyle: "medium" });
    const body = `${start}-${end}`;
    const triggerDate = dayjs(eventConstruct.start).subtract(notifyBeforeTime, "minute").toDate();

    if (!event) {
      if (notificationToggle) {
        const identifier = await scheduleEventPushNotification(eventConstruct.title, body, triggerDate)
        storeNotification(identifier, eventConstruct.id, triggerDate)
        console.log("=== NEW NOTIFICATION ===");
        console.log(identifier);
        console.log(eventConstruct.id);
        console.log(triggerDate.toLocaleString(timeLocale, { dateStyle: "medium", timeStyle: "medium" }));
        console.log("========================");
      }
    } else {
      const lastIdentifier = await getEventsNotificationIdentifier(eventConstruct.id);
      if (notificationToggle && lastIdentifier !== null) {
        const newIdentifier = await updateEventPushNotification(lastIdentifier, eventConstruct.title, body, triggerDate);
        updateNotificationTriggerDate(newIdentifier, eventConstruct.id, triggerDate);
        console.log("=== UPDATED NOTIFICATION ===");
        console.log(newIdentifier);
        console.log(eventConstruct.id);
        console.log(triggerDate.toLocaleString(timeLocale, { dateStyle: "medium", timeStyle: "medium" }));
        console.log("============================");
      } else if (notificationToggle && lastIdentifier === null) {
        const identifier = await scheduleEventPushNotification(eventConstruct.title, body, triggerDate);
        storeNotification(identifier, eventConstruct.id, triggerDate);
        console.log("=== NEW NOTIFICATION FROM UPDATE ===");
        console.log(identifier);
        console.log(eventConstruct.id);
        console.log(triggerDate.toLocaleString(timeLocale, { dateStyle: "medium", timeStyle: "medium" }));
        console.log("====================================");
      } else if (!notificationToggle && lastIdentifier !== null) {
        cancelEventPushNotification(lastIdentifier);
        removeNotification(eventConstruct.id);
        console.log("=== REMOVED NOTIFICATION ===");
        console.log(lastIdentifier);
        console.log(eventConstruct.id);
        console.log(triggerDate.toLocaleString(timeLocale, { dateStyle: "medium", timeStyle: "medium" }));
        console.log("============================");
      }
    }
  };

  const handleSave = async () => {
    const allDayUTC = (d: Date) =>
      new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

    const eventConstruct: Event = {
      id: event?.id ?? uuidv7(),
      creatorID: userID!,
      organizer: userID!, //TODO: ADD Organizer selection option in client
      calendars: [...selectedCals],
      originCalendarID: originEffective,
      title: newTitle,
      // color follows the origin calendar; stored as a sensible default (render derives it live)
      color: calendars.find(c => c.id === originEffective)?.color ?? appColors[0].color,
      start: allDayToggle ? allDayUTC(newStart) : newStart,
      end: allDayToggle ? allDayUTC(newEnd) : newEnd,
      isAllDay: allDayToggle,
      isCanceled: false, //TODO: Before cal sync we need a system for event status
      description: newDescription,
      location: newLocation,
      recurrence: buildRRule(newRecurrence, newStart, {
        freq: advFreq, interval: advInterval, days: advDays,
        endType: advEndType, count: advCount,
      }),
      url: newUrl.toLowerCase()
    }

    let passed: boolean = true;

    if (newTitle.length === 0) {
      setNameError("I mean... At least one letter please...");
      passed = false;
    } else {
      setNameError("");
    }
    if ([...selectedCals].length === 0) {
      setCalendarsError("Event needs some cozy place... Give it atleast one...");
      passed = false;
    } else {
      setCalendarsError("");
    }
    if (newStart.getTime() > newEnd.getTime()) {
      setStartError("I don't think so...");
      setEndError("I should probably be the one in front...");
      passed = false;
    } else {
      setStartError("");
      setEndError("");
    }
    if (newUrl) {
      try {
        const { protocol } = new URL(newUrl);
        if (protocol !== "http:" && protocol !== "https:") {
          setUrlError("Invalid URL protocol...");
          passed = false;
        }

      } catch {
        setUrlError("Invalid URL...");
        passed = false;
      }
    }

    if (!passed) {
      return;
    }

    setIsLoading(true);

    try {
      await setNotification(eventConstruct);
      if (event) {
        await onEdit(eventConstruct);
      } else {
        await onSave(eventConstruct);
      }
      haptics.success();
      handleClose();
    } catch (e: any) {
      haptics.warn();
      Alert.alert("Failed to save", e?.message ?? "An unexpected error occured.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
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
          <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
            <GestureDetector gesture={gesture}>
              <View>
                <View style={styles.modalHandle} />

                <View style={styles.modalTitleRow}>
                  <Text style={styles.modalTitle}>{event ? "Edit Event" : "New Event"}</Text>
                </View>

              </View>
            </GestureDetector>
            <ScrollView>
              <View style={styles.fieldContainer}>
                <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Title</Text>
                <TextInput
                  value={newTitle}
                  onChangeText={setNewTitle}
                  placeholder={eventHint}
                  placeholderTextColor={colors.fg4}
                  multiline={true}
                  autoFocus={!event} // creating: pen ready the moment the sheet lands
                  style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                />
                {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
              </View>

              <View style={styles.fieldContainer}>
                <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Calendars</Text>
                <ScrollView
                  horizontal
                >
                  <View style={styles.horizontalPillView}>
                    {calendars.map((cal) => {
                      const active = selectedCals.has(cal.id);
                      const isOrigin = originEffective === cal.id;
                      const locked = !can(cal.role, "editEvents"); // can't add/remove here
                      return (
                        <Tap
                          key={cal.id}
                          haptic="select"
                          disabled={locked}
                          onPress={() => toggleCal(cal.id)}
                          onLongPress={() => { // set as home (origin), selecting it if needed
                            setSelectedCals(prev => new Set(prev).add(cal.id));
                            setOriginCal(cal.id);
                          }}
                          style={active ? styles.pillActive : styles.pill}
                        >
                          {isOrigin
                            ? <Ionicons name="star" size={12} color={cal.color} style={{ opacity: active ? 1 : 0.4 }} />
                            : locked
                              ? <Feather name="lock" size={11} color={cal.color} style={{ opacity: active ? 1 : 0.4 }} />
                              : <View style={[styles.colorDot, { backgroundColor: cal.color, opacity: active ? 1 : 0.4 }]} />}
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: active ? colors.fg : colors.fg3 }}>
                            {cal.name}
                          </Text>
                        </Tap>
                      );
                    })}
                  </View>
                </ScrollView>
                {calendarsError ? <Text style={styles.errorText}>{calendarsError}</Text> : null}
              </View>

              {datePickerVisible &&
                <DateTimePicker
                  presentation="dialog"
                  value={getDatePickerValue()}
                  mode={datePickerMode}
                  onValueChange={(_event, selectedDate) => {
                    setDatePickerVisible(false);
                    setDateFromDatePicker(selectedDate);
                  }}
                  onDismiss={() => {
                    setDatePickerVisible(false);
                  }}
                />}

              {/* One "When" block, platform-calendar style: Starts / Ends rows with
                  date+time chips, all-day inline, quick presets underneath. */}
              <View style={styles.fieldContainer}>
                {([
                  ["Starts", newStart, "start", startError] as const,
                  ["Ends", newEnd, "end", endError] as const,
                ]).map(([label, value, target, error]) => (
                  <View key={target}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 }}>
                      <Text style={[styles.fieldValueText, { fontFamily: fonts.sans, color: colors.fg2 }]}>{label}</Text>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Tap
                          onPress={() => {
                            setDatePickerTarget(target);
                            setDatePickerMode("date");
                            setDatePickerVisible(true);
                          }}
                          style={[local.chip, { backgroundColor: colors.bg3 }]}
                        >
                          <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                            {value.toLocaleString(timeLocale, { dateStyle: 'medium' })}
                          </Text>
                        </Tap>
                        {!allDayToggle &&
                          <Tap
                            onPress={() => {
                              setDatePickerTarget(target);
                              setDatePickerMode("time");
                              setDatePickerVisible(true);
                            }}
                            style={[local.chip, { backgroundColor: colors.bg3 }]}
                          >
                            <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                              {value.toLocaleString(timeLocale, { timeStyle: 'short' })}
                            </Text>
                          </Tap>
                        }
                      </View>
                    </View>
                    {error ? <Text style={styles.errorText}>{error}</Text> : null}
                  </View>
                ))}

                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 }}>
                  <Text style={[styles.fieldValueText, { fontFamily: fonts.sans, color: colors.fg2 }]}>All-day</Text>
                  <Switch
                    thumbColor={allDayToggle ? colors.accent : colors.bg3}
                    trackColor={{ false: colors.line, true: colors.line3 }}
                    onValueChange={(v) => { haptics.tap(); setAllDayToggle(v); }}
                    value={allDayToggle}
                  />
                </View>

                {!allDayToggle &&
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
                    <View style={styles.horizontalPillView}>
                      {([
                        ["sunrise", "Morning", 6, 12],
                        ["sun", "Afternoon", 12, 18],
                        ["moon", "Evening", 18, 24],
                      ] as const).map(([icon, label, from, to]) => {
                        const active = newStart.getHours() === from && newEnd.getHours() === (to % 24)
                          && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0;
                        return (
                          <Tap
                            key={label}
                            haptic="select"
                            onPress={() => {
                              setNewStart(withHours(newStart, from));
                              setNewEnd(withHours(newStart, to));
                            }}
                            style={active ? styles.pillActive : styles.pill}
                          >
                            <Feather name={icon} color={colors.fg2} />
                            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: active ? colors.fg : colors.fg3 }}>
                              {label}
                            </Text>
                          </Tap>
                        );
                      })}
                    </View>
                  </ScrollView>
                }
              </View>

              <View style={styles.fieldContainer}>
                <View style={{ flexDirection: "row", gap: 36, alignItems: "flex-start" }}>
                  <View style={{ flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Notification</Text>
                    <Switch
                      thumbColor={notificationToggle ? colors.accent : colors.bg3}
                      trackColor={{
                        false: colors.line,
                        true: colors.line3,
                      }}
                      onValueChange={(v) => { haptics.tap(); setNotificationToggle(v); }}
                      value={notificationToggle}
                    />
                  </View>
                  {notificationToggle &&
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Notify Before Event</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={styles.horizontalPillView}>
                          {NOTIFY_BEFORE.map((opt) => {
                            const active = notifyBeforeTime === opt.value;
                            return (
                              <Tap
                                key={opt.label}
                                haptic="select"
                                onPress={() => setNotifyBeforeTime(opt.value)}
                                style={active ? styles.pillActive : styles.pill}
                              >
                                <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: active ? colors.fg : colors.fg3 }}>
                                  {opt.label}
                                </Text>
                              </Tap>
                            );
                          })}
                        </View>
                      </ScrollView>
                    </View>
                  }
                </View>
              </View>
              <View style={styles.fieldContainer}>
                <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Repeat</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.horizontalPillView}>
                    {RECURRENCE_OPTIONS.map((opt) => {
                      const active = newRecurrence === opt.value;
                      const isWeekly = opt.value === 'weekly' && active;
                      const weekDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][newStart.getDay()];
                      return (
                        <Tap
                          key={opt.value}
                          haptic="select"
                          onPress={() => {
                            setNewRecurrence(opt.value);
                            if (opt.value === 'custom' && newRecurrence !== 'custom') {
                              setAdvFreq('WEEKLY');
                              setAdvInterval(1);
                              setAdvDays(new Set([newStart.getDay() || 1]));
                              setAdvEndType('never');
                              setAdvCount(10);
                            }
                          }}
                          style={active ? styles.pillActive : styles.pill}
                        >
                          <Feather name={opt.icon as any} size={12} color={active ? colors.fg : colors.fg3} />
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: active ? colors.fg : colors.fg3 }}>
                            {isWeekly ? `Weekly (${weekDay})` : opt.label}
                          </Text>
                        </Tap>
                      );
                    })}
                  </View>
                </ScrollView>

                {newRecurrence === 'custom' && (
                  <View style={{
                    marginTop: 12, backgroundColor: colors.bg2,
                    borderRadius: 12, padding: 14,
                    borderWidth: 1, borderColor: colors.line, gap: 16,
                  }}>

                    {/* ── Every N <freq> ── */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3, width: 38 }}>Every</Text>

                      {/* stepper */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Tap
                          onPress={() => setAdvInterval(v => Math.max(1, v - 1))}
                          style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>−</Text>
                        </Tap>
                        <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg, minWidth: 22, textAlign: 'center' }}>
                          {advInterval}
                        </Text>
                        <Tap
                          onPress={() => setAdvInterval(v => Math.min(99, v + 1))}
                          style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>+</Text>
                        </Tap>
                      </View>

                      {/* freq selector */}
                      <View style={{ flexDirection: 'row', gap: 4, flex: 1 }}>
                        {([['DAILY', 'Day'], ['WEEKLY', 'Week'], ['MONTHLY', 'Month'], ['YEARLY', 'Year']] as const).map(([f, label]) => (
                          <Tap
                            key={f}
                            haptic="select"
                            onPress={() => setAdvFreq(f)}
                            style={{
                              flex: 1, paddingVertical: 5, borderRadius: 8, alignItems: 'center',
                              backgroundColor: advFreq === f ? colors.fg : colors.bg3,
                            }}
                          >
                            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: advFreq === f ? colors.bg : colors.fg3 }}>
                              {label}
                            </Text>
                          </Tap>
                        ))}
                      </View>
                    </View>

                    {/* ── Day picker (weekly only) ── */}
                    {advFreq === 'WEEKLY' && (
                      <View>
                        <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3, marginBottom: 8 }}>On</Text>
                        <View style={{ flexDirection: 'row', gap: 6 }}>
                          {WEEKDAYS_DISPLAY.map(({ label, day }, i) => {
                            const active = advDays.has(day);
                            return (
                              <Tap
                                key={i}
                                haptic="select"
                                onPress={() => setAdvDays(prev => {
                                  const next = new Set(prev);
                                  if (next.has(day) && next.size > 1) next.delete(day);
                                  else next.add(day);
                                  return next;
                                })}
                                style={{
                                  flex: 1, aspectRatio: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
                                  backgroundColor: active ? colors.fg : colors.bg3,
                                }}
                              >
                                <Text style={{ fontFamily: fonts.sansMedium, fontSize: 11, color: active ? colors.bg : colors.fg3 }}>
                                  {label}
                                </Text>
                              </Tap>
                            );
                          })}
                        </View>
                      </View>
                    )}

                    {/* ── Ends ── */}
                    <View>
                      <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3, marginBottom: 8 }}>Ends</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {(['never', 'count'] as const).map(type => (
                          <Tap
                            key={type}
                            haptic="select"
                            onPress={() => setAdvEndType(type)}
                            style={advEndType === type ? styles.pillActive : styles.pill}
                          >
                            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: advEndType === type ? colors.fg : colors.fg3 }}>
                              {type === 'never' ? 'Never' : 'After'}
                            </Text>
                          </Tap>
                        ))}
                        {advEndType === 'count' && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Tap
                              onPress={() => setAdvCount(v => Math.max(1, v - 1))}
                              style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                            >
                              <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>−</Text>
                            </Tap>
                            <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg, minWidth: 22, textAlign: 'center' }}>
                              {advCount}
                            </Text>
                            <Tap
                              onPress={() => setAdvCount(v => Math.min(999, v + 1))}
                              style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                            >
                              <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>+</Text>
                            </Tap>
                            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>
                              {advCount === 1 ? 'time' : 'times'}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>

                    {/* ── Human-readable summary ── */}
                    <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg3, fontStyle: 'italic' }}>
                      {describeAdvanced({ freq: advFreq, interval: advInterval, days: advDays, endType: advEndType, count: advCount })}
                    </Text>

                  </View>
                )}
              </View>

              {/* The long tail — note/location/url stay folded until asked for,
                  so the common flow is title → when → done. */}
              {!detailsOpen ? (
                <Tap
                  onPress={() => setDetailsOpen(true)}
                  style={[styles.fieldContainer, { flexDirection: "row", alignItems: "center", gap: 8 }]}
                >
                  <Feather name="plus" size={14} color={colors.fg3} />
                  <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>
                    Add note, location or link
                  </Text>
                </Tap>
              ) : (
                <>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Note</Text>
                    <TextInput
                      value={newDescription}
                      onChangeText={setNewDescription}
                      placeholder="..."
                      placeholderTextColor={colors.fg4}
                      multiline={true}
                      style={[styles.fieldValueText, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Location</Text>
                    <TextInput
                      value={newLocation}
                      onChangeText={setNewLocation}
                      placeholder="..."
                      placeholderTextColor={colors.fg4}
                      multiline={true}
                      style={[styles.fieldValueText, { fontFamily: fonts.sans }]}
                    />
                  </View>
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>URL</Text>
                    <TextInput
                      value={newUrl}
                      onChangeText={setNewUrl}
                      placeholder="https://..."
                      placeholderTextColor={colors.fg4}
                      multiline={true}
                      style={[styles.fieldValueText, { fontFamily: fonts.sans }]}
                    />
                    {urlError ? <Text style={styles.errorText}>{urlError}</Text> : null}
                  </View>
                </>
              )}
            </ScrollView>
            <View style={[styles.modalButtons, { paddingBottom: insets.bottom + 16 }]}>
              <Btn label="Cancel" variant="secondary" onPress={handleClose} />
              <Btn label={event ? "Save" : "Create"} onPress={handleSave} loading={isLoading} />
            </View>
          </Animated.View>
        </GestureHandlerRootView>
      </Modal >
    </>
  );
}

// Colors stay out of module-level sheets — the theme can swap at runtime.
const local = StyleSheet.create({
  chip: {
    borderRadius: 8,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
});
