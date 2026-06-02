import { Calendar, Event } from "@musubi/types";
import { colors, fonts, styles } from "@/constants/theme";
import { useEffect, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { appColors } from "@/constants/colors";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useServer } from "@/contexts/ServerContext";
import { EVENT_HINTS } from "@/constants/event_hints";
import { Feather } from "@expo/vector-icons";

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
  { value: 'none',     label: 'None',     icon: 'slash'     },
  { value: 'daily',    label: 'Daily',    icon: 'sun'       },
  { value: 'weekly',   label: 'Weekly',   icon: 'repeat'    },
  { value: 'weekdays', label: 'Weekdays', icon: 'briefcase' },
  { value: 'monthly',  label: 'Monthly',  icon: 'calendar'  },
  { value: 'yearly',   label: 'Yearly',   icon: 'award'     },
  { value: 'custom',   label: 'Custom',   icon: 'sliders'   },
];

function buildRRule(
  option: RecurrenceOption,
  startDate: Date,
  advanced: AdvancedRRuleConfig,
): string | null {
  switch (option) {
    case 'none':     return null;
    case 'daily':    return 'FREQ=DAILY';
    case 'weekly':   return `FREQ=WEEKLY;BYDAY=${RRULE_DAYS[startDate.getDay()]}`;
    case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'monthly':  return 'FREQ=MONTHLY';
    case 'yearly':   return 'FREQ=YEARLY';
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
  const insets = useSafeAreaInsets();
  const { authClient } = useServer();

  const [newTitle, setNewTitle] = useState("");
  const [newColor, setNewColor] = useState(appColors[0].color);
  const [newDescription, setNewDescription] = useState("");
  const [newStart, setNewStart] = useState(startingDate ?? new Date());
  const [newEnd, setNewEnd] = useState(startingDate ?? new Date());
  const [allDayToggle, setAllDayToggle] = useState(false);
  const [newLocation, setNewLocation] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newRecurrence, setNewRecurrence] = useState<RecurrenceOption>('none');
  const [advFreq, setAdvFreq] = useState<AdvancedFreq>('WEEKLY');
  const [advInterval, setAdvInterval] = useState(1);
  const [advDays, setAdvDays] = useState<Set<number>>(new Set([1]));
  const [advEndType, setAdvEndType] = useState<AdvancedEndType>('never');
  const [advCount, setAdvCount] = useState(10);

  // const [showStartPicker, setShowStartPicker] = useState(false);
  // const [showEndPicker, setShowEndPicker] = useState(false);

  const [selectedCals, setSelectedCals] = useState<Set<string>>(
    () => new Set(calendars.slice(0, 1).map(c => c.id))
  );
  const [isLoading, setIsLoading] = useState(false);
  const [eventHint, setEventHint] = useState(EVENT_HINTS[Math.floor(Math.random() * EVENT_HINTS.length)])

  const [nameError, setNameError] = useState("");
  const [calendarsError, setCalendarsError] = useState("");
  const [startError, setStartError] = useState("");
  const [endError, setEndError] = useState("");
  const [urlError, setUrlError] = useState("");

  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  const closeSequence = () => {
    onClose();

    setNewTitle('');
    setNameError("");
    setNewStart(new Date());
    setStartError("");
    setNewEnd(new Date());
    setEndError("");
    setSelectedCals(new Set(calendars.slice(0, 1).map(c => c.id)));
    setNewDescription("");
    setCalendarsError("");
    setNewLocation("");
    setNewUrl("");
    setUrlError("");
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
      setNewColor(event?.color ?? appColors[0].color)
      setSelectedCals(new Set(event?.calendars) ?? new Set<string>);
      setNewDescription(event?.description ?? "");
      setNewLocation(event?.location ?? "");
      setNewUrl(event?.url ?? "");
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
    if (newStart.getTime() > newEnd.getTime()) {
      setNewEnd(newStart);
    }
  }, [newStart]);

  const toggleCal = (id: string) => {
    setSelectedCals(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const showDatePicker = (mode: 'start' | 'end') => {
    const current = mode === 'start' ? newStart : newEnd;
    const setter = mode === 'start' ? setNewStart : setNewEnd;

    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'date',
        onChange: (e, date) => {
          if (e.type === 'set' && date) {
            setter(date);
          }
        },
      });
    }
  };

  const showTimePicker = (mode: 'start' | 'end') => {
    const current = mode === 'start' ? newStart : newEnd;
    const setter = mode === 'start' ? setNewStart : setNewEnd;

    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: roundMinutes(current),
        mode: 'time',
        onChange: (e, timeDate) => {
          if (e.type === 'set' && timeDate) {
            setter(timeDate);
          }
        },
      });
    }
  };

  function roundMinutes(date: Date) {

    date.setHours(date.getHours() + Math.round(date.getMinutes() / 60));
    date.setMinutes(0, 0, 0);

    return date;
  }


  const handleSave = async () => {

    const eventConstruct: Event = {
      id: event?.id ?? "create",
      creatorID: userID!,
      organizer: userID!, //TODO: ADD Organizer selection option in client
      calendars: [...selectedCals],
      title: newTitle,
      color: newColor,
      start: allDayToggle ? new Date(newStart.setHours(0, 0, 0, 0)) : newStart,
      end: allDayToggle ? new Date(newEnd.setHours(0, 0, 0, 0)) : newEnd,
      isAllDay: allDayToggle,
      isCanceled: false, //TODO: Before cal sync we need a system for event status
      description: newDescription,
      location: newLocation,
      recurrence: buildRRule(newRecurrence, newStart, {
        freq: advFreq, interval: advInterval, days: advDays,
        endType: advEndType, count: advCount,
      }),
      url: newUrl.toLowerCase(),//TODO: ADD url link field to events
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
      if (event) {
        onEdit(eventConstruct);
      } else {
        onSave(eventConstruct);
      }
    } catch (e: any) {
      setIsLoading(false);
      Alert.alert("Failed to save", e?.message ?? "An unexpected error occured.");
    }
    setIsLoading(false);
    handleClose();
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
                      return (
                        <Pressable
                          key={cal.id}
                          onPress={() => toggleCal(cal.id)}
                          style={active ? styles.pillActive : styles.pill}
                        >
                          <View style={[styles.colorDot, { backgroundColor: cal.color, opacity: active ? 1 : 0.4 }]} />
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: active ? colors.fg : colors.fg3 }}>
                            {cal.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
                {calendarsError ? <Text style={styles.errorText}>{calendarsError}</Text> : null}
              </View>

              <View style={styles.fieldContainer}>
                <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Colors</Text>
                <ScrollView
                  horizontal
                >
                  <View style={styles.horizontalPillView}>
                    {appColors.map((c) => (
                      <Pressable
                        key={c.name}
                        style={{
                          overflow: "hidden",
                          flexDirection: "row",
                          justifyContent: "space-between",
                          gap: 18,
                        }}
                        onPress={() => setNewColor(c.color)}
                      >
                        <View style={[styles.calendarCircle, {
                          borderWidth: c.color === newColor ? 2 : 1,
                          borderColor: c.color === newColor ? colors.fg3 : colors.line3,
                        }]}>
                          <View style={[styles.calendarCircleInner, { backgroundColor: c.color }]} />
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </View>

              <View style={styles.fieldContainer}>
                <View style={{ flexDirection: "row", gap: 36, alignItems: "flex-start" }}>
                  <View>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>All Day</Text>
                    <Switch
                      thumbColor={allDayToggle ? colors.accent : colors.bg3}
                      trackColor={{
                        false: colors.line,
                        true: colors.line3,
                      }}
                      onValueChange={(v) => { setAllDayToggle(v) }}
                      value={allDayToggle}
                    />
                  </View>
                  {!allDayToggle &&
                    <View>
                      <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Quck Time</Text>
                      <View style={{ flexDirection: "row", gap: 16, marginTop: 8 }}>
                        <Pressable
                          onPress={() => {
                            setNewStart(withHours(newStart, 6));
                            setNewEnd(withHours(newStart, 12));
                          }}
                          style={newStart.getHours() === 6 && newEnd.getHours() === 12 && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0 ? styles.pillActive : styles.pill}
                        >
                          <Feather name="sunrise" color={colors.fg2} />
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: newStart.getHours() === 6 && newEnd.getHours() === 12 && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0 ? colors.fg : colors.fg3 }}>
                            Mor
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setNewStart(withHours(newStart, 12));
                            setNewEnd(withHours(newStart, 18));
                          }}
                          style={newStart.getHours() === 12 && newEnd.getHours() === 18 && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0 ? styles.pillActive : styles.pill}
                        >
                          <Feather name="sun" color={colors.fg2} />
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: newStart.getHours() === 12 && newEnd.getHours() === 18 && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0 ? colors.fg : colors.fg3 }}>
                            Arvo
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setNewStart(withHours(newStart, 18));
                            setNewEnd(withHours(newStart, 24));
                          }}
                          style={newStart.getHours() === 18 && newEnd.getHours() === 0 && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0 ? styles.pillActive : styles.pill}
                        >
                          <Feather name="moon" color={colors.fg2} />
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: newStart.getHours() === 18 && newEnd.getHours() === 0 && newStart.getMinutes() === 0 && newEnd.getMinutes() === 0 ? colors.fg : colors.fg3 }}>
                            Eve
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  }
                </View>
                {startError ? <Text style={styles.errorText}>{startError}</Text> : null}
              </View>

              <View style={styles.fieldContainer}>
                <View style={{ flexDirection: "row", gap: 32 }}>
                  <Pressable onPress={() => showDatePicker("start")}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Start Date</Text>
                    <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                      {newStart.toLocaleString('en-UK', { dateStyle: 'medium' })}
                    </Text>
                  </Pressable>
                  {!allDayToggle &&
                    <Pressable onPress={() => showTimePicker("start")}>
                      <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Time</Text>
                      <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                        {newStart.toLocaleString('en-UK', { timeStyle: 'short' })}
                      </Text>
                    </Pressable>
                  }
                </View>
                {startError ? <Text style={styles.errorText}>{startError}</Text> : null}
              </View>

              {/* {Platform.OS === 'ios' && showStartPicker && ( */}
              {/*   <DateTimePicker value={newStart} mode="datetime" */}
              {/*     onChange={(e, date) => { setShowStartPicker(false); if (e.type === 'set' && date) setNewStart(date); }} */}
              {/*   /> */}
              {/* )} */}

              <View style={styles.fieldContainer}>
                <View style={{ flexDirection: "row", gap: 32 }}>
                  <Pressable onPress={() => showDatePicker("end")}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>End Date</Text>
                    <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                      {newEnd.toLocaleString('en-UK', { dateStyle: 'medium' })}
                    </Text>
                  </Pressable>
                  {!allDayToggle &&
                    <Pressable onPress={() => showTimePicker("end")}>
                      <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Time</Text>
                      <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                        {newEnd.toLocaleString('en-UK', { timeStyle: 'short' })}
                      </Text>
                    </Pressable>
                  }
                </View>
                {endError ? <Text style={styles.errorText}>{endError}</Text> : null}
              </View>

              {/* {Platform.OS === 'ios' && showEndPicker && ( */}
              {/*   <DateTimePicker value={newEnd} mode="datetime" */}
              {/*     onChange={(e, date) => { setShowEndPicker(false); if (e.type === 'set' && date) setNewEnd(date); }} */}
              {/*   /> */}
              {/* )} */}

              <View style={styles.fieldContainer}>
                <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Repeat</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.horizontalPillView}>
                    {RECURRENCE_OPTIONS.map((opt) => {
                      const active = newRecurrence === opt.value;
                      const isWeekly = opt.value === 'weekly' && active;
                      const weekDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][newStart.getDay()];
                      return (
                        <Pressable
                          key={opt.value}
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
                        </Pressable>
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
                        <Pressable
                          onPress={() => setAdvInterval(v => Math.max(1, v - 1))}
                          style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>−</Text>
                        </Pressable>
                        <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg, minWidth: 22, textAlign: 'center' }}>
                          {advInterval}
                        </Text>
                        <Pressable
                          onPress={() => setAdvInterval(v => Math.min(99, v + 1))}
                          style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>+</Text>
                        </Pressable>
                      </View>

                      {/* freq selector */}
                      <View style={{ flexDirection: 'row', gap: 4, flex: 1 }}>
                        {([['DAILY', 'Day'], ['WEEKLY', 'Week'], ['MONTHLY', 'Month'], ['YEARLY', 'Year']] as const).map(([f, label]) => (
                          <Pressable
                            key={f}
                            onPress={() => setAdvFreq(f)}
                            style={{
                              flex: 1, paddingVertical: 5, borderRadius: 8, alignItems: 'center',
                              backgroundColor: advFreq === f ? colors.fg : colors.bg3,
                            }}
                          >
                            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: advFreq === f ? colors.bg : colors.fg3 }}>
                              {label}
                            </Text>
                          </Pressable>
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
                              <Pressable
                                key={i}
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
                              </Pressable>
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
                          <Pressable
                            key={type}
                            onPress={() => setAdvEndType(type)}
                            style={advEndType === type ? styles.pillActive : styles.pill}
                          >
                            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: advEndType === type ? colors.fg : colors.fg3 }}>
                              {type === 'never' ? 'Never' : 'After'}
                            </Text>
                          </Pressable>
                        ))}
                        {advEndType === 'count' && (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Pressable
                              onPress={() => setAdvCount(v => Math.max(1, v - 1))}
                              style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                            >
                              <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>−</Text>
                            </Pressable>
                            <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg, minWidth: 22, textAlign: 'center' }}>
                              {advCount}
                            </Text>
                            <Pressable
                              onPress={() => setAdvCount(v => Math.min(999, v + 1))}
                              style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                            >
                              <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>+</Text>
                            </Pressable>
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

              <View style={styles.fieldContainer}>
                <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Note</Text>
                <TextInput
                  value={newDescription}
                  onChangeText={setNewDescription}
                  placeholder="..."
                  placeholderTextColor={colors.fg4}
                  multiline={true}
                  style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
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
                  style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
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
                  style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                />
                {urlError ? <Text style={styles.errorText}>{urlError}</Text> : null}
              </View>
            </ScrollView>
            <View style={[styles.modalButtons, { paddingBottom: insets.bottom + 16 }]}>
              <Pressable style={styles.btnSecondary} onPress={handleClose}>
                <Text style={styles.btnSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={isLoading ? [styles.btnPrimary, { backgroundColor: colors.line }] : styles.btnPrimary}
                onPress={handleSave}
                disabled={isLoading}
              >
                <Text style={styles.btnPrimaryText}>{event ? "Save" : "Create"}</Text>
              </Pressable>
            </View>
          </Animated.View>
        </GestureHandlerRootView>
      </Modal >
    </>
  );
}
