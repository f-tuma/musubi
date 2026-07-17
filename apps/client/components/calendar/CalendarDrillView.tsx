import { colors, fonts } from "@/constants/theme";
import { MonthView } from "@/components/cal/MonthView";
import { TimelineView } from "@/components/cal/TimelineView";
import {
  bucketByDay, dayKey, Draft, DRILL_OPEN_MIN, GUTTER, HOUR_H,
  isSameDay, minutesToY, Rect, ZOOM_IN_MS, ZOOM_OUT_MS,
} from "@/components/cal/layout";
import { Event } from "@musubi/types";
import {
  memo, MutableRefObject, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing, interpolate, SharedValue, useAnimatedStyle, useSharedValue, withTiming,
} from "react-native-reanimated";
import dayjs from "dayjs";

const DRILL_FADE_OUT_MS = 180;
const EVENT_REVEAL_MS = 90;
const PREVIEW_ALL_DAY_LANES = 3;
const PREVIEW_ALL_DAY_H = 22;
const PREVIEW_SCROLL_Y = minutesToY(DRILL_OPEN_MIN);
const PREVIEW_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const EMPTY_EVENTS: Event[] = [];

/**
 * Cheap, always-mounted visual twin of the day timeline. It has no pager,
 * scroll view, gestures, shared hour-height graph or event worklets, but keeps
 * the same visible geometry at the drill's initial scroll position.
 */
const DayTransitionPreview = memo(function DayTransitionPreview({
  date, events, backgroundColor,
}: {
  date: Date;
  events: Event[];
  backgroundColor: string;
}) {
  const eventsByDay = useMemo(() => bucketByDay(events), [events]);
  const dayEvents = eventsByDay.get(dayKey(date)) ?? EMPTY_EVENTS;
  const allDayLaneCount = Math.min(
    dayEvents.filter((event) => event.isAllDay).length,
    PREVIEW_ALL_DAY_LANES,
  );

  return (
    <View
      pointerEvents="none"
      style={{ flex: 1, backgroundColor }}
    >
      <View style={{
        height: 34,
        paddingLeft: GUTTER,
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: allDayLaneCount > 0 ? 0 : 1,
        borderColor: colors.line,
      }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
          <Text style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.fg4, letterSpacing: 1 }}>
            {dayjs(date).format("dddd").toUpperCase()}
          </Text>
          <View style={{
            minWidth: 21, height: 21, borderRadius: 11, paddingHorizontal: 3,
            alignItems: "center", justifyContent: "center",
          }}>
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 12, color: colors.fg2 }}>
              {date.getDate()}
            </Text>
          </View>
        </View>
      </View>

      {allDayLaneCount > 0 ? (
        <View style={{
          marginLeft: GUTTER,
          height: allDayLaneCount * PREVIEW_ALL_DAY_H + 4,
          borderBottomWidth: 1,
          borderColor: colors.line,
        }} />
      ) : null}

      <View style={{ flex: 1, overflow: "hidden" }}>
        <View style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: -PREVIEW_SCROLL_Y,
          height: 24 * HOUR_H,
        }}>
          {PREVIEW_HOURS.map((hour) => (
            <View key={hour} style={{ position: "absolute", left: 0, right: 0, top: hour * HOUR_H }}>
              <View style={{ position: "absolute", left: GUTTER, right: 0, height: 1, backgroundColor: colors.line }} />
              {hour > 0 ? (
                <Text style={{
                  position: "absolute", top: -6, width: GUTTER - 8, textAlign: "right",
                  fontFamily: fonts.sans, fontSize: 10, color: colors.fg4,
                }}>
                  {hour}:00
                </Text>
              ) : null}
            </View>
          ))}

        </View>
      </View>
    </View>
  );
});

export type CalendarDrill = {
  date: Date;
  rect: Rect;
  sourceHeaderDate: Date;
};

/**
 * Shared month -> day transition state for the home calendar and calendar
 * detail modal. The geometry starts on the UI thread immediately; the heavier
 * timeline joins once the short geometry transition has landed.
 */
export function useCalendarDrill(anchorDate: Date) {
  const [drill, setDrill] = useState<CalendarDrill | null>(null);
  const [contentReady, setContentReady] = useState(false);
  const zoom = useSharedValue(0);
  const monthTransition = useSharedValue(0);
  const drillOpacity = useSharedValue(1);

  const anchorDateRef = useRef(anchorDate);
  const drillRef = useRef<CalendarDrill | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startFrameRef = useRef<number | null>(null);
  const onClosedRef = useRef<(() => void) | null>(null);
  anchorDateRef.current = anchorDate;

  const cancelPending = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    contentTimerRef.current = null;
    if (startFrameRef.current !== null) cancelAnimationFrame(startFrameRef.current);
    startFrameRef.current = null;
  }, []);

  const resetDrill = useCallback((onReset?: () => void) => {
    cancelPending();
    drillRef.current = null;
    onClosedRef.current = null;
    zoom.value = 0;
    monthTransition.value = 0;
    drillOpacity.value = 1;
    setContentReady(false);
    setDrill(null);
    onReset?.();
  }, [cancelPending, drillOpacity, monthTransition, zoom]);

  const openDrill = useCallback((date: Date, rect: Rect) => {
    cancelPending();
    onClosedRef.current = null;

    const next: CalendarDrill = { date, rect, sourceHeaderDate: anchorDateRef.current };
    drillRef.current = next;
    zoom.value = 0;
    monthTransition.value = 0;
    drillOpacity.value = 1;
    setContentReady(false);
    setDrill(next);

    // Give React one frame to update the already-mounted preview to the tapped
    // day. No heavy timeline mounts in this commit. The UI-thread transition
    // then starts over a complete day-like surface instead of an empty panel.
    startFrameRef.current = requestAnimationFrame(() => {
      startFrameRef.current = null;
      if (drillRef.current !== next) return;
      zoom.value = withTiming(1, { duration: ZOOM_IN_MS, easing: Easing.out(Easing.cubic) });
      monthTransition.value = withTiming(1, { duration: ZOOM_IN_MS, easing: Easing.out(Easing.cubic) });
      contentTimerRef.current = setTimeout(() => {
        contentTimerRef.current = null;
        if (drillRef.current === next) setContentReady(true);
      }, ZOOM_IN_MS);
    });
  }, [cancelPending, drillOpacity, monthTransition, zoom]);

  const closeDrill = useCallback((onClosed?: () => void) => {
    const current = drillRef.current;
    if (!current) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    contentTimerRef.current = null;
    if (startFrameRef.current !== null) cancelAnimationFrame(startFrameRef.current);
    startFrameRef.current = null;
    onClosedRef.current = onClosed ?? null;

    const returnsToTappedDay = isSameDay(anchorDateRef.current, current.date);
    const duration = returnsToTappedDay ? ZOOM_OUT_MS : DRILL_FADE_OUT_MS;
    if (returnsToTappedDay) {
      zoom.value = withTiming(0, { duration, easing: Easing.in(Easing.cubic) });
    } else {
      // A paged-to day no longer belongs to the tapped cell; fade it instead of
      // collapsing it into geometrically unrelated month content.
      drillOpacity.value = withTiming(0, { duration, easing: Easing.out(Easing.quad) });
    }
    monthTransition.value = withTiming(0, { duration, easing: Easing.inOut(Easing.quad) });

    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      drillRef.current = null;
      zoom.value = 0;
      monthTransition.value = 0;
      drillOpacity.value = 1;
      setContentReady(false);
      setDrill(null);
      const finish = onClosedRef.current;
      onClosedRef.current = null;
      finish?.();
    }, duration + 20);
  }, [drillOpacity, monthTransition, zoom]);

  useEffect(() => () => cancelPending(), [cancelPending]);

  return {
    drill,
    contentReady,
    zoom,
    monthTransition,
    drillOpacity,
    openDrill,
    closeDrill,
    resetDrill,
  };
}

type Props = {
  calMode: "month" | "week" | "day";
  base: Date;
  events: Event[];
  weekStartsOn: 0 | 1;
  eventColorOf: (event: Event) => string;
  onDayPress: (date: Date, rect: Rect) => void;
  onPageChange: (date: Date) => void;
  onPressEvent: (event: Event) => void;
  draft: Draft | null;
  onDraftChange: (draft: Draft | null) => void;
  canMoveEvent: (event: Event) => boolean;
  onMoveEvent: (event: Event, dayDelta: number, minuteDelta: number) => void;
  scrollPosRef: MutableRefObject<number>;
  drillScrollPosRef: MutableRefObject<number>;
  bottomPad: number;
  drillBottomPad: number;
  drill: CalendarDrill | null;
  drillContentReady: boolean;
  zoom: SharedValue<number>;
  monthTransition: SharedValue<number>;
  drillOpacity: SharedValue<number>;
  backgroundColor?: string;
};

/** Shared calendar body used by both full-screen and modal calendars. */
export function CalendarDrillView({
  calMode, base, events, weekStartsOn, eventColorOf, onDayPress,
  onPageChange, onPressEvent, draft, onDraftChange, canMoveEvent,
  onMoveEvent, scrollPosRef, drillScrollPosRef, bottomPad, drillBottomPad,
  drill, drillContentReady, zoom, monthTransition, drillOpacity,
  backgroundColor = colors.bg,
}: Props) {
  const contentReveal = useSharedValue(0);
  useEffect(() => {
    if (!drillContentReady) contentReveal.value = 0;
  }, [contentReveal, drillContentReady]);

  const handleTimelineReady = useCallback(() => {
    contentReveal.value = withTiming(1, { duration: EVENT_REVEAL_MS, easing: Easing.out(Easing.quad) });
  }, [contentReveal]);

  // The overlay and its preview stay mounted even while closed. That makes the
  // first transition frame a shared-value update only — no native tree insert.
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(zoom.value, [0, 0.18, 1], [0, 0.55, 1]) * drillOpacity.value,
    transform: [{ scale: interpolate(zoom.value, [0, 1], [0.985, 1]) }],
  }));
  const overlayContentStyle = useAnimatedStyle(() => ({
    opacity: contentReveal.value,
  }));
  const previewStyle = useAnimatedStyle(() => ({
    opacity: 1 - contentReveal.value,
  }));
  const monthUnderStyle = useAnimatedStyle(() => ({
    flex: 1,
    opacity: 1 - monthTransition.value * 0.45,
    transform: [{ scale: 1 + monthTransition.value * 0.012 }],
  }));

  return (
    <View style={{ flex: 1 }}>
      {calMode === "month" ? (
        <Animated.View style={monthUnderStyle}>
          <MonthView
            key={`m-${base.getTime()}`}
            base={base}
            events={events}
            weekStartsOn={weekStartsOn}
            eventColorOf={eventColorOf}
            onDayPress={onDayPress}
            onPageChange={onPageChange}
          />
        </Animated.View>
      ) : (
        <TimelineView
          key={`${calMode}-${base.getTime()}`}
          mode={calMode}
          base={base}
          events={events}
          weekStartsOn={weekStartsOn}
          eventColorOf={eventColorOf}
          onPressEvent={onPressEvent}
          draft={draft}
          onDraftChange={onDraftChange}
          canMoveEvent={canMoveEvent}
          onMoveEvent={onMoveEvent}
          onPageChange={onPageChange}
          scrollPosRef={scrollPosRef}
          bottomPad={bottomPad}
        />
      )}

      <Animated.View
        pointerEvents={drill ? "auto" : "none"}
        style={[{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          backgroundColor,
          overflow: "hidden",
        }, overlayStyle]}
      >
        <Animated.View style={[{
          position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
        }, previewStyle]}>
          <DayTransitionPreview
            date={drill?.date ?? base}
            events={events}
            backgroundColor={backgroundColor}
          />
        </Animated.View>

        {drill && drillContentReady ? (
          <Animated.View style={[{
            position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
          }, overlayContentStyle]}>
              <TimelineView
                key={`drill-${drill.date.getTime()}`}
                mode="day"
                base={drill.date}
                events={events}
                weekStartsOn={weekStartsOn}
                eventColorOf={eventColorOf}
                onPressEvent={onPressEvent}
                draft={draft}
                onDraftChange={onDraftChange}
                canMoveEvent={canMoveEvent}
                onMoveEvent={onMoveEvent}
                onPageChange={onPageChange}
                scrollPosRef={drillScrollPosRef}
                bottomPad={drillBottomPad}
                onReady={handleTimelineReady}
                coveredByTransition
              />
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  );
}
