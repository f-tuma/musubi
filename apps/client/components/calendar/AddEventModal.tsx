import "react-native-get-random-values";
import { Calendar, Event, can } from "@musubi/types";
import { activeScheme, colors, fonts, styles } from "@/constants/theme";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ModalPortal as Modal } from "@/components/ui/ModalPortal";
import Animated, { runOnJS, type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { sortCalendars } from "@/lib/calendarOrder";
import { formatDateMedium, formatTime } from "@/lib/datetimeFormat";
import { appColors } from "@/constants/colors";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import DateTimePicker from '@expo/ui/community/datetime-picker';
import { useServer } from "@/contexts/ServerContext";
import { EVENT_HINTS } from "@/constants/event_hints";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useSettingsStore } from "@/store/useSettingsStore";
import { cancelEventNotification, getEventNotification, requestEventNotificationPermission, upsertEventNotification } from "@/services/notifications";
import dayjs from "dayjs";
import { uuidv7 } from 'uuidv7';
import { joinRecurrence, splitRecurrence } from '@musubi/calendar';
import { AdvancedEndType, AdvancedFreq, AdvancedRRuleConfig, buildRRule, describeAdvanced, parseAdvanced, parseRRule, RecurrenceOption } from "@/lib/rrule";
import { validateEventForm } from "@/lib/eventForm";
import { remoteForCalendar } from "@/services/federation";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import * as haptics from "@/lib/haptics";
import { userFacingError } from "@/lib/network";
import { showToast } from "@/components/ui/Toast";
import { tabBarHeight } from "@/constants/layout";

type Props = {
  visible: boolean;
  startingDate?: Date;
  endingDate?: Date;    // drag-to-create range end
  /** Docked: always-mounted bottom sheet on the calendar — peek shows title +
   *  quick save, pulling the top edge up reveals the full form. */
  docked?: boolean;
  anchor?: Date;        // docked: day in view — default times land here
  /** Docked only: false slides the sheet fully off-screen (week view waits for
   *  a draft); flipping to true brings it back at peek. */
  peekVisible?: boolean;
  /** Docked only: optional 0→1 transition shared with the parent surface.
   *  Keeps the sheet reveal in lockstep with transitions such as month→day. */
  dockRevealProgress?: SharedValue<number>;
  /** Docked only: gap from the window bottom to the sheet's resting edge, used
   *  by the keyboard-lift math. Defaults to the tab bar height (tab screens);
   *  pass the safe-area inset when the docked sheet lives inside a full-screen
   *  modal (no tab bar), e.g. the calendar detail view. */
  dockBottomInset?: number;
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

// ─── Recurrence UI ───────────────────────────────────────────────────────────
// RRULE build/parse logic lives in @/lib/rrule; only the display data is here.

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

// ── Docked sheet tuning ──────────────────────────────────────────────────────
export const DOCK_PEEK = 172;        // visible sliver of the docked sheet: actions + title
const DOCK_MAX_H = 620;              // expanded height cap
const DOCK_HEIGHT_RATIO = 0.8;       // …or this fraction of the window, whichever is smaller
const DOCK_HIDDEN_EXTRA = 30;        // pushed this far past its height when hidden
const DOCK_SNAP_VELOCITY = 400;      // fling speed that snaps open/closed regardless of position
const DOCK_DISMISS_PAST = 60;        // dragged this far past peek = dismiss the sheet entirely
const DOCK_SPRING = { damping: 28, stiffness: 240, mass: 0.8 };
const KB_SHOW_MS = 220;              // keyboard lift in/out timings
const KB_HIDE_MS = 180;

export function AddEventModal({ visible, startingDate, endingDate, docked, anchor, peekVisible = true, dockRevealProgress, dockBottomInset, onClose, onSave, onEdit, calendars, event }: Props) {
  const {
    notificationsOnByDefault,
    timeFormat,
    dateFormat,
    calendarOrder,
  } = useSettingsStore();

  const insets = useSafeAreaInsets();
  const restingBottomInset = dockBottomInset ?? tabBarHeight(insets.bottom);
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
  const [attendeesToggle, setAttendeesToggle] = useState(false);
  const [newLocation, setNewLocation] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newRecurrence, setNewRecurrence] = useState<RecurrenceOption>('none');
  // EXDATE/RDATE lines from the stored recurrence — carried through an edit
  // untouched so deleting one occurrence survives a later series edit.
  const [recurrenceExtras, setRecurrenceExtras] = useState<string[]>([]);
  // UNTIL from "end series here" — the editor UI can't express it (only COUNT),
  // so carry it through and re-apply unless the user picks a new ending.
  const [savedUntil, setSavedUntil] = useState<string | null>(null);
  const [advFreq, setAdvFreq] = useState<AdvancedFreq>('WEEKLY');
  const [advInterval, setAdvInterval] = useState(1);
  const [advDays, setAdvDays] = useState<Set<number>>(new Set([1]));
  const [advEndType, setAdvEndType] = useState<AdvancedEndType>('never');
  const [advCount, setAdvCount] = useState(10);

  // Default to a calendar the user can actually write to (personal first) —
  // the first calendar in the list can be a read-only external one.
  const defaultCalSet = () => {
    const c = calendars.find(c => c.isDefault && can(c.role, "editEvents"))
      ?? calendars.find(c => can(c.role, "editEvents"))
      ?? calendars[0];
    return new Set(c ? [c.id] : []);
  };
  const [selectedCals, setSelectedCals] = useState<Set<string>>(defaultCalSet);
  // Explicit origin (home) pick via long-press. Falls back to first selected.
  const [originCal, setOriginCal] = useState<string | null>(null);
  const originEffective = originCal && selectedCals.has(originCal)
    ? originCal
    : [...selectedCals][0];
  const [isLoading, setIsLoading] = useState(false);
  const [eventHint, setEventHint] = useState(EVENT_HINTS[Math.floor(Math.random() * EVENT_HINTS.length)])
  // Note/location/URL are the long tail — folded away until asked for.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The detail fields sit at the very bottom of the sheet's ScrollView; with
  // Android edge-to-edge there's no system auto-scroll-into-view, so focusing
  // them scrolls to the end manually (delay ≈ keyboard animation).
  const scrollRef = useRef<ScrollView>(null);
  const scrollToBottomField = () => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250);
  };

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
    setSelectedCals(defaultCalSet());
    setOriginCal(null);
    setNewDescription("");
    setCalendarsError("");
    setNewLocation("");
    setNewUrl("");
    setUrlError("");
    setDetailsOpen(false);
    setAttendeesToggle(false);
    setNewRecurrence('none');
    setRecurrenceExtras([]);
    setSavedUntil(null);
    setAdvFreq('WEEKLY');
    setAdvInterval(1);
    setAdvDays(new Set([1]));
    setAdvEndType('never');
    setAdvCount(10);
    setEventHint(EVENT_HINTS[Math.floor(Math.random() * EVENT_HINTS.length)]);
  }

  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(!docked && visible, closeSequence);

  // ── Docked mode: fixed-height sheet pinned to the bottom of the calendar.
  // Two snap points — peek (title + quick save) and fully pulled out.
  const win = useWindowDimensions();
  const DOCK_H = Math.min(win.height * DOCK_HEIGHT_RATIO, DOCK_MAX_H);
  const dockRange = DOCK_H - DOCK_PEEK;
  const dockOff = useSharedValue(peekVisible ? dockRange : DOCK_H + DOCK_HIDDEN_EXTRA);
  const dockStart = useSharedValue(0);

  // Keyboard lift: the window doesn't resize (enforced edge-to-edge), so shift
  // the sheet by exactly how far the keyboard reaches past the tab bar. Uses
  // the keyboard's real top edge (screenY), not its height — more reliable
  // across Android nav modes.
  const kbLift = useSharedValue(0);
  // Same overlap as React state: pads the scroll content so bottom fields
  // (note/location/url) can scroll clear of the keyboard when expanded.
  const [kbPad, setKbPad] = useState(0);
  useEffect(() => {
    if (!docked) return;
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      e => {
        const containerBottom = win.height - restingBottomInset; // sheet's resting bottom, window coords
        const overlap = Math.max(containerBottom - e.endCoordinates.screenY, 0);
        kbLift.value = withTiming(overlap, { duration: KB_SHOW_MS });
        setKbPad(overlap);
      });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => { kbLift.value = withTiming(0, { duration: KB_HIDE_MS }); setKbPad(0); });
    return () => { show.remove(); hide.remove(); };
  }, [docked, win.height, restingBottomInset]);


  // Hide/show the docked sheet (week view: appears with the first draft).
  // When re-shown it lands at peek, never straight into the expanded state.
  useEffect(() => {
    if (!docked) return;
    dockOff.value = withSpring(
      peekVisible ? Math.min(dockOff.value, dockRange) : DOCK_H + DOCK_HIDDEN_EXTRA,
      DOCK_SPRING,
    );
  }, [docked, peekVisible, dockRange]);
  // Swipe-down past peek: the gesture already animated the sheet off-screen —
  // just clean up (closeSequence → onClose hides it for real via peekVisible).
  // Defined BEFORE the gesture: worklets capture JS refs at creation time, so a
  // later const would be captured as undefined (runOnJS(undefined) crash).
  const dismissByGesture = () => {
    Keyboard.dismiss();
    closeSequence();
  };

  const dockGesture = useMemo(() => Gesture.Pan()
    // need a real vertical drag before we take over — otherwise a still tap on
    // the X / Save buttons (they live inside this handle) reads as a micro-pan
    // and the button press is eaten, so the sheet "won't close".
    .activeOffsetY([-12, 12])
    .onStart(() => { dockStart.value = dockOff.value; })
    .onUpdate(e => {
      // From PEEK the drag may continue past the dock — that's the dismiss path.
      // From EXPANDED it stops at peek (two-stage), so collapsing a tall sheet
      // can't accidentally throw the whole composer away.
      const maxY = dockStart.value >= dockRange - 1 ? DOCK_H + DOCK_HIDDEN_EXTRA : dockRange;
      dockOff.value = Math.min(Math.max(dockStart.value + e.translationY, 0), maxY);
    })
    .onEnd(e => {
      const past = dockOff.value - dockRange;
      if (past > DOCK_DISMISS_PAST || (past > 0 && e.velocityY > DOCK_SNAP_VELOCITY)) {
        dockOff.value = withSpring(DOCK_H + DOCK_HIDDEN_EXTRA, { ...DOCK_SPRING, velocity: e.velocityY });
        runOnJS(dismissByGesture)();
        return;
      }
      const expand = e.velocityY < -DOCK_SNAP_VELOCITY || (dockOff.value < dockRange / 2 && e.velocityY < DOCK_SNAP_VELOCITY);
      dockOff.value = withSpring(expand ? 0 : dockRange, DOCK_SPRING);
    }), [dockRange, DOCK_H]);

  // Lift caps at 0 — the expanded sheet keeps its top on screen (title lives
  // there), fields further down scroll instead.
  const dockedSlide = useAnimatedStyle(() => {
    // A parent-owned reveal avoids chaining this sheet's spring after a surface
    // transition. At progress 0 the peek is shifted exactly to the hidden snap;
    // at 1 the regular dockOff position takes over unchanged.
    const revealOffset = dockRevealProgress
      ? (1 - dockRevealProgress.value) * (DOCK_PEEK + DOCK_HIDDEN_EXTRA)
      : 0;
    return {
      transform: [{ translateY: Math.max(dockOff.value - kbLift.value + revealOffset, 0) }],
    };
  });

  const dockedDismiss = () => {
    Keyboard.dismiss();
    dockOff.value = withSpring(dockRange, DOCK_SPRING);
    closeSequence(); // resets fields + onClose (parent clears the draft)
  };
  // typing the title pulls the sheet fully open so the rest of the form shows
  const dockExpand = () => { dockOff.value = withSpring(0, DOCK_SPRING); };
  const dockCollapse = () => { Keyboard.dismiss(); dockOff.value = withSpring(dockRange, DOCK_SPRING); };

  // Backdrop behind an expanded sheet — dims and swallows touches so the
  // calendar underneath can't scroll/move while the form is out of the dock.
  // At peek it's transparent and lets touches through (pointerEvents none).
  const backdropStyle = useAnimatedStyle(() => {
    const raw = (dockRange - dockOff.value) / dockRange;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    return { opacity: t, pointerEvents: t > 0.01 ? "auto" : "none" };
  });

  // Docked: times follow the calendar — the drag/tap draft when there is one,
  // otherwise a sensible default on the day in view.
  useEffect(() => {
    if (!docked) return;
    if (startingDate) {
      setNewStart(startingDate);
      setNewEnd(endingDate ?? new Date(startingDate.getTime() + 3600_000));
    } else {
      const s = new Date(anchor ?? new Date());
      const now = new Date();
      s.setHours(dayjs(s).isSame(now, "day") ? now.getHours() + 1 : 9, 0, 0, 0);
      setNewStart(s);
      setNewEnd(new Date(s.getTime() + 3600_000));
    }
  }, [docked, startingDate?.getTime(), endingDate?.getTime(), anchor?.getTime()]);

  useEffect(() => {
    if (visible) {
      setNewTitle(event?.title ?? "");
      // Docked mode owns its own start/end via the anchor effect above (the day
      // in view + a sensible time) — don't clobber it here with `new Date()`.
      if (!docked) {
        setNewStart(event?.start ?? startingDate ?? new Date());
        setNewEnd(event?.end ?? endingDate ?? startingDate ?? new Date());
      }
      setSelectedCals(new Set(event?.calendars) ?? new Set<string>);
      setOriginCal(event?.originCalendarID ?? null);
      setNewDescription(event?.description ?? "");
      setNewLocation(event?.location ?? "");
      setNewUrl(event?.url ?? "");
      setDetailsOpen(!!(event?.description || event?.location || event?.url));
      setAttendeesToggle(event?.hasAttendees ?? false);
      if (event?.id) {
        // reflect the reminder's REAL state, not the global default
        getEventNotification(event.id).then((row) => {
          setNotificationToggle(!!row);
          if (row) setNotifyBeforeTime(row.offsetMinutes);
        }).catch(() => { });
      }
      const { rrule, extras } = splitRecurrence(event?.recurrence);
      setRecurrenceExtras(extras);
      setSavedUntil(rrule.match(/UNTIL=[^;]+/)?.[0] ?? null);
      const option = parseRRule(rrule || null);
      setNewRecurrence(option);
      if (option === 'custom') {
        const adv = parseAdvanced(rrule);
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

  const handleSave = async () => {
    const allDayUTC = (d: Date) =>
      new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

    const eventConstruct: Event = {
      id: event?.id ?? uuidv7(),
      creatorID: userID!,
      organizer: userID!,
      calendars: [...selectedCals],
      originCalendarID: originEffective,
      title: newTitle,
      // color follows the origin calendar; stored as a sensible default (render derives it live)
      color: calendars.find(c => c.id === originEffective)?.color ?? appColors[0].color,
      start: allDayToggle ? allDayUTC(newStart) : newStart,
      end: allDayToggle ? allDayUTC(newEnd) : newEnd,
      isAllDay: allDayToggle,
      hasAttendees: attendeesToggle,
      isCanceled: false,
      description: newDescription,
      location: newLocation,
      recurrence: (() => {
        let rule = buildRRule(newRecurrence, newStart, {
          freq: advFreq, interval: advInterval, days: advDays,
          endType: advEndType, count: advCount,
        });
        if (rule && savedUntil && !/UNTIL=|COUNT=/.test(rule)) rule += `;${savedUntil}`;
        return joinRecurrence(rule, recurrenceExtras);
      })(),
      url: newUrl.toLowerCase()
    }

    const { ok, errors } = validateEventForm({
      title: newTitle,
      calendarCount: selectedCals.size,
      start: newStart,
      end: newEnd,
      url: newUrl,
    });
    setNameError(errors.name);
    setCalendarsError(errors.calendars);
    setStartError(errors.start);
    setEndError(errors.end);
    setUrlError(errors.url); // clears on a now-valid URL, consistent with the other fields

    // Federation: an event lives on ONE server — its calendars must share an
    // origin (cross-server linking is a future, mirror-based feature).
    const origins = new Set([...selectedCals].map(id => remoteForCalendar(id)?.server ?? "home"));
    if (origins.size > 1) {
      setCalendarsError("These calendars live on different servers — pick calendars from one server.");
      return;
    }

    if (!ok) {
      return;
    }

    setIsLoading(true);

    try {
      // Permission is requested here, in the context of saving a reminder —
      // never on app launch. A denial is a valid choice and must not block the
      // event itself from being created or edited.
      let reminderAllowed = false;
      if (notificationToggle) {
        try { reminderAllowed = await requestEventNotificationPermission(); }
        catch (error) { console.warn("Could not check notification permission:", error); }
      }

      if (event?.id) {
        await onEdit(eventConstruct);
      } else {
        await onSave(eventConstruct);
      }

      try {
        if (notificationToggle && reminderAllowed) {
          await upsertEventNotification(eventConstruct, notifyBeforeTime);
        } else if (!notificationToggle) {
          await cancelEventNotification(eventConstruct.id);
        }
      } catch (error) {
        console.warn("Event saved, but its reminder could not be updated:", error);
        showToast({ message: "Event saved, but the reminder could not be scheduled." });
      }

      if (notificationToggle && !reminderAllowed) {
        showToast({ message: "Event saved without a reminder. Allow notifications in system settings to enable it." });
      }
      haptics.success();
      docked ? dockedDismiss() : handleClose();
    } catch (e: any) {
      haptics.warn();
      Alert.alert("Failed to save", userFacingError(e));
    } finally {
      setIsLoading(false);
    }
  };

  const sheetContent = (
    <>
      {/* the top strip is the pull handle: docked = snap peek/full, modal = dismiss */}
      <GestureDetector gesture={docked ? dockGesture : gesture}>
        <View>
          {/* docked: tighter handle, clearly above the X/Save row */}
          <View style={[styles.modalHandle, docked && { marginVertical: 8 }]} />
          {docked ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
              {/* actions live up here — no Cancel/Create row in docked mode */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Tap onPress={dockedDismiss} hitSlop={14} accessibilityLabel="Close event editor">
                  <Feather name="x" size={20} color={colors.fg2} />
                </Tap>
                <Tap
                  haptic="thump"
                  onPress={handleSave}
                  disabled={isLoading}
                  hitSlop={{ top: 6, bottom: 6 }}
                  accessibilityLabel="Save event"
                  accessibilityState={{ disabled: isLoading, busy: isLoading }}
                  style={{
                  backgroundColor: colors.fill, borderRadius: 999, borderCurve: "continuous",
                  paddingHorizontal: 20, paddingVertical: 8, minWidth: 68, alignItems: "center",
                }}>
                  {isLoading
                    ? <ActivityIndicator size="small" color={colors.onFill} />
                    : <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: colors.onFill }}>Save</Text>}
                </Tap>
              </View>
              <TextInput
                value={newTitle}
                onChangeText={setNewTitle}
                onFocus={dockExpand}
                placeholder={eventHint}
                placeholderTextColor={colors.fg4}
                returnKeyType="done"
                onSubmitEditing={handleSave}
                style={[styles.fieldValueBig, { fontFamily: fonts.sans, paddingVertical: 6, marginTop: 8 }]}
              />
              {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
            </View>
          ) : (
            <View style={styles.modalTitleRow}>
              <Text style={styles.modalTitle}>{event ? "Edit Event" : "New Event"}</Text>
            </View>
          )}
        </View>
      </GestureDetector>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        style={docked ? { flex: 1 } : undefined}
        contentContainerStyle={docked ? { paddingBottom: kbPad } : undefined}

        showsVerticalScrollIndicator={false}>
        {!docked && (
          <View style={styles.fieldContainer}>
            <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Title</Text>
            <TextInput
              value={newTitle}
              onChangeText={setNewTitle}
              placeholder={eventHint}
              placeholderTextColor={colors.fg4}
              multiline={true}
              autoFocus={!event} // creating: pen ready the moment the sheet lands
              style={[styles.fieldValueBig, { fontFamily: fonts.sans, marginBottom: 0 }]}
            />
            {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
          </View>
        )}

        <View style={styles.fieldContainer}>
          <ScrollView
            horizontal

            showsHorizontalScrollIndicator={false}>
            <View style={styles.horizontalPillView}>
              {/* Same order as the Calendars tab (incl. the user's drag order).
                  Only calendars the user can add events to are offered — no point
                  showing one you can't link into. */}
              {sortCalendars(calendars, calendarOrder)
                .filter((cal) => can(cal.role, "editEvents"))
                .map((cal) => {
                const active = selectedCals.has(cal.id);
                const isOrigin = originEffective === cal.id;
                return (
                  <Tap
                    key={cal.id}
                    haptic="select"
                    onPress={() => toggleCal(cal.id)}
                    onLongPress={() => { // set as home (origin), selecting it if needed
                      setSelectedCals(prev => new Set(prev).add(cal.id));
                      setOriginCal(cal.id);
                    }}
                    accessibilityLabel={`${cal.name} calendar`}
                    accessibilityHint="Double tap to include. Long press to make it the primary calendar."
                    accessibilityState={{ selected: active }}
                    style={active ? styles.pillActive : styles.pill}
                  >
                    {isOrigin
                      ? <Ionicons name="star" size={12} color={cal.color} style={{ opacity: active ? 1 : 0.4 }} />
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

        {/* Android: a native dialog opened from the date/time chips below. iOS
            renders its own inline compact picker in the rows (see below) — the
            community picker ignores `presentation` on iOS and would otherwise
            render this dialog inline here, up at the top of the sheet. */}
        {datePickerVisible && Platform.OS !== "ios" &&
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
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  {Platform.OS === "ios" ? (
                    // Native iOS compact picker — shows the date (and time, unless
                    // all-day) inline and opens Apple's own calendar/wheel popover
                    // on tap. Returns the full Date, so set it directly; set the
                    // target first so the start<=end effect bumps the right side.
                    <DateTimePicker
                      value={value}
                      mode={allDayToggle ? "date" : "datetime"}
                      display="compact"
                      accentColor={colors.accent}
                      // Follow the app theme, not the phone's system appearance.
                      themeVariant={activeScheme}
                      onValueChange={(_event, selectedDate) => {
                        setDatePickerTarget(target);
                        target === "start" ? setNewStart(selectedDate) : setNewEnd(selectedDate);
                      }}
                    />
                  ) : (
                    <>
                      <Tap
                        onPress={() => {
                          setDatePickerTarget(target);
                          setDatePickerMode("date");
                          setDatePickerVisible(true);
                        }}
                        hitSlop={{ top: 6, bottom: 6 }}
                        accessibilityLabel={`Choose ${label.toLowerCase()} date`}
                        style={[local.chip, { backgroundColor: colors.bg3 }]}
                      >
                        <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                          {formatDateMedium(value, dateFormat)}
                        </Text>
                      </Tap>
                      {!allDayToggle &&
                        <Tap
                          onPress={() => {
                            setDatePickerTarget(target);
                            setDatePickerMode("time");
                            setDatePickerVisible(true);
                          }}
                          hitSlop={{ top: 6, bottom: 6 }}
                          accessibilityLabel={`Choose ${label.toLowerCase()} time`}
                          style={[local.chip, { backgroundColor: colors.bg3 }]}
                        >
                          <Text style={[styles.fieldValueText, { fontFamily: fonts.sans }]}>
                            {formatTime(value, timeFormat)}
                          </Text>
                        </Tap>
                      }
                    </>
                  )}
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
              ios_backgroundColor={colors.line}
              onValueChange={(v) => { setAllDayToggle(v); }}
              value={allDayToggle}
              accessibilityLabel="All-day event"
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
                      hitSlop={{ top: 6, bottom: 6 }}
                      accessibilityRole="radio"
                      accessibilityLabel={`${label} time preset`}
                      accessibilityState={{ checked: active }}
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
                ios_backgroundColor={colors.line}
                onValueChange={(v) => { setNotificationToggle(v); }}
                value={notificationToggle}
                accessibilityLabel="Event notification"
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
                          hitSlop={{ top: 6, bottom: 6 }}
                          accessibilityRole="radio"
                          accessibilityLabel={`Notify ${opt.label.toLowerCase()} before`}
                          accessibilityState={{ checked: active }}
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

        {/* Attendance toggle — a "kind of event". Non-destructive: switching it
            off keeps event_users rows, re-enabling shows the same people. */}
        <View style={styles.fieldContainer}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.fieldValueText, { fontFamily: fonts.sans, color: colors.fg2 }]}>Attendees</Text>
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 2 }}>
                People can attend and see who's coming
              </Text>
            </View>
            <Switch
              thumbColor={attendeesToggle ? colors.accent : colors.bg3}
              trackColor={{ false: colors.line, true: colors.line3 }}
              ios_backgroundColor={colors.line}
              onValueChange={(v) => { setAttendeesToggle(v); }}
              value={attendeesToggle}
              accessibilityLabel="Allow attendees"
            />
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
                    hitSlop={{ top: 6, bottom: 6 }}
                    accessibilityRole="radio"
                    accessibilityLabel={`${isWeekly ? `Weekly on ${weekDay}` : opt.label} recurrence`}
                    accessibilityState={{ checked: active }}
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

          {/* RFC 5545: a rule anchored to a day some months don't have simply
              skips those months (and Feb 29 → leap years only). Spec-correct,
              but surprising — say it up front instead of letting users find out. */}
          {(() => {
            const day = newStart.getDate();
            const monthlyRule = newRecurrence === 'monthly' || (newRecurrence === 'custom' && advFreq === 'MONTHLY');
            const hint = monthlyRule && day >= 29
              ? `Repeats on day ${day} — months without it are skipped.`
              : newRecurrence === 'yearly' && day === 29 && newStart.getMonth() === 1
                ? "February 29 only exists in leap years — this repeats every 4 years."
                : null;
            return hint && (
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.fg4, marginTop: 8 }}>
                {hint}
              </Text>
            );
          })()}

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
                    disabled={advInterval === 1}
                    hitSlop={9}
                    accessibilityLabel="Decrease recurrence interval"
                    accessibilityState={{ disabled: advInterval === 1 }}
                    style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>−</Text>
                  </Tap>
                  <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg, minWidth: 22, textAlign: 'center' }}>
                    {advInterval}
                  </Text>
                  <Tap
                    onPress={() => setAdvInterval(v => Math.min(99, v + 1))}
                    disabled={advInterval === 99}
                    hitSlop={9}
                    accessibilityLabel="Increase recurrence interval"
                    accessibilityState={{ disabled: advInterval === 99 }}
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
                      hitSlop={{ top: 8, bottom: 8 }}
                      accessibilityRole="radio"
                      accessibilityLabel={`${label} frequency`}
                      accessibilityState={{ checked: advFreq === f }}
                      style={{
                        flex: 1, paddingVertical: 5, borderRadius: 8, alignItems: 'center',
                        backgroundColor: advFreq === f ? colors.fill : colors.bg3,
                      }}
                    >
                      <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: advFreq === f ? colors.onFill : colors.fg3 }}>
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
                          hitSlop={{ top: 3, bottom: 3 }}
                          accessibilityLabel={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]}
                          accessibilityState={{ selected: active }}
                          style={{
                            flex: 1, aspectRatio: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
                            backgroundColor: active ? colors.fill : colors.bg3,
                          }}
                        >
                          <Text style={{ fontFamily: fonts.sansMedium, fontSize: 11, color: active ? colors.onFill : colors.fg3 }}>
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
                      hitSlop={{ top: 6, bottom: 6 }}
                      accessibilityRole="radio"
                      accessibilityLabel={type === 'never' ? 'Never ends' : 'Ends after a number of occurrences'}
                      accessibilityState={{ checked: advEndType === type }}
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
                        disabled={advCount === 1}
                        hitSlop={9}
                        accessibilityLabel="Decrease occurrence count"
                        accessibilityState={{ disabled: advCount === 1 }}
                        style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg3, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Text style={{ fontFamily: fonts.sans, fontSize: 16, color: colors.fg2, lineHeight: 20 }}>−</Text>
                      </Tap>
                      <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg, minWidth: 22, textAlign: 'center' }}>
                        {advCount}
                      </Text>
                      <Tap
                        onPress={() => setAdvCount(v => Math.min(999, v + 1))}
                        disabled={advCount === 999}
                        hitSlop={9}
                        accessibilityLabel="Increase occurrence count"
                        accessibilityState={{ disabled: advCount === 999 }}
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
                onFocus={scrollToBottomField}
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
                onFocus={scrollToBottomField}
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
                onFocus={scrollToBottomField}
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
      {!docked && (
        <View style={[styles.modalButtons, { paddingBottom: insets.bottom + 16 }]}>
          <Btn label="Cancel" variant="secondary" onPress={handleClose} />
          <Btn label={event ? "Save" : "Create"} onPress={handleSave} loading={isLoading} />
        </View>
      )}
    </>
  );

  if (docked) {
    return (
      <>
        <Animated.View
          style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.45)" }, backdropStyle]}
        >
          <Pressable style={{ flex: 1 }} onPress={dockCollapse} accessible={false} />
        </Animated.View>
        <Animated.View style={[styles.modalSheet, {
          height: DOCK_H, maxHeight: DOCK_H, minHeight: 0,
        }, dockedSlide]}>
          {sheetContent}
        </Animated.View>
      </>
    );
  }

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
          <Pressable style={{ flex: 1 }} onPress={handleClose} accessible={false} />
        </Animated.View>
        <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
          {sheetContent}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
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
