import { Event } from "@musubi/types";
import { Feather } from "@expo/vector-icons";
import { activeScheme, colors, fonts } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";
import { tap as tapHaptic, thump } from "@/lib/haptics";
import dayjs from "dayjs";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import InfinitePager from "react-native-infinite-pager";
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import Animated, {
  runOnJS, scrollTo, SharedValue, useAnimatedReaction, useAnimatedRef, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from "react-native-reanimated";
import {
  addDays, allDaySpans, bucketByDay, clamp, dayKey, daySegments, Draft,
  GRAB_DOT_HIT, GRAB_SCALE, GRAB_SPRING, GUTTER, HOLD_CREATE_MS, HOLD_GRAB_MS,
  HOUR_H, INK, isSameDay, SNAP_DRAG_MIN, SNAP_TAP_MIN, startOfWeek, ZOOM_HOUR_MAX, ZOOM_HOUR_MIN,
} from "./layout";
import { useSettingsStore } from "@/store/useSettingsStore";
import { formatTime, TimeFormat } from "@/lib/datetimeFormat";

// The day/week timeline. Read this first if you're new to the calendar:
//
// • Layout is minutes → pixels via `hourH` (pixels per hour), a SHARED VALUE so
//   a pinch rescales the whole timeline on the UI thread with no re-render.
//   Everything vertical — hour lines, now-indicator, event blocks — derives
//   its top/height from it. Geometry helpers + tuning live in `layout.ts`.
// • Three gesture layers, from back to front: the grid overlay (drag-to-create
//   the draft "ghost"), the event blocks (tap = open, hold = move), and the
//   ghost itself (corner dots resize, middle moves). Pinch-to-zoom sits on the
//   OUTER page view so it never steals single-finger scroll or taps.
// • Positions live in shared values, never React layout — see the "flicker-free
//   drop" note on TimelineEventBlock for why.
//
// InfinitePager pages the view; one <TimelinePage> renders per visible page.

const ALLDAY_LANES = 3;  // all-day strip shows up to this many bar rows
const ALLDAY_LANE_H = 22;
const GHOST_SETTLE_MS = 120; // ghost eases onto the snapped grid on release
const SNAP_STEP_MS = 70;     // ghost clicks between 15-min steps as you drag

type Props = {
  mode: "day" | "week";
  base: Date;                        // page 0 anchor (the day / any date in the week)
  events: Event[];                   // expanded + visibility-filtered, sorted by start
  weekStartsOn: 0 | 1;
  eventColorOf: (e: Event) => string;
  onPressEvent: (e: Event) => void;
  draft: Draft | null;
  onDraftChange: (d: Draft) => void;
  /** Can this event be picked up and moved? (edit rights + not recurring) */
  canMoveEvent: (e: Event) => boolean;
  /** Hold-drag on an event committed: shift by whole days + snapped minutes. */
  onMoveEvent: (e: Event, dayDelta: number, minDelta: number) => void;
  onPageChange: (start: Date) => void;
  scrollPosRef: MutableRefObject<number>;  // shared so swiped-in pages keep the scroll position
  bottomPad: number;                 // room for the docked composer peek
};

export function TimelineView({
  mode, base, events, weekStartsOn, eventColorOf, onPressEvent,
  draft, onDraftChange, canMoveEvent, onMoveEvent, onPageChange, scrollPosRef, bottomPad,
}: Props) {
  const [width, setWidth] = useState(0);
  const byDay = useMemo(() => bucketByDay(events), [events]);
  const weekBase = useMemo(() => startOfWeek(base, weekStartsOn), [base, weekStartsOn]);
  // Pixels per hour, pinch-zoomable. Lives here so it survives page swipes and
  // is shared by every buffered page; all vertical geometry derives from it on
  // the UI thread (no re-render on zoom → smooth, crisp, no flash).
  const hourH = useSharedValue(HOUR_H);

  const pageStart = (index: number) =>
    mode === "week" ? addDays(weekBase, index * 7) : addDays(base, index);

  return (
    <View style={{ flex: 1 }} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <InfinitePager
          renderPage={({ index }) => (
            <TimelinePage
              days={mode === "week"
                ? Array.from({ length: 7 }, (_, i) => addDays(pageStart(index), i))
                : [pageStart(index)]}
              width={width}
              events={events}
              byDay={byDay}
              hourH={hourH}
              eventColorOf={eventColorOf}
              onPressEvent={onPressEvent}
              draft={draft}
              onDraftChange={onDraftChange}
              canMoveEvent={canMoveEvent}
              onMoveEvent={onMoveEvent}
              scrollPosRef={scrollPosRef}
              bottomPad={bottomPad}
            />
          )}
          onPageChange={p => onPageChange(pageStart(p))}
          style={{ flex: 1 }}
          pageWrapperStyle={{ flex: 1 }}
        />
      )}
    </View>
  );
}

type PageProps = {
  days: Date[];
  width: number;
  events: Event[];
  byDay: Map<string, Event[]>;
  hourH: SharedValue<number>;
  eventColorOf: (e: Event) => string;
  onPressEvent: (e: Event) => void;
  draft: Draft | null;
  onDraftChange: (d: Draft) => void;
  canMoveEvent: (e: Event) => boolean;
  onMoveEvent: (e: Event, dayDelta: number, minDelta: number) => void;
  scrollPosRef: MutableRefObject<number>;
  bottomPad: number;
};

function TimelinePage({
  days, width, events, byDay, hourH, eventColorOf, onPressEvent, draft, onDraftChange, canMoveEvent, onMoveEvent, scrollPosRef, bottomPad,
}: PageProps) {
  const colW = (width - GUTTER) / days.length;
  const [now, setNow] = useState(() => new Date());
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0); // live scroll offset — pinch anchors to it
  const hasToday = days.some(d => isSameDay(d, now));
  const timeFormat = useSettingsStore((s) => s.timeFormat);

  // minutes ⇄ pixels at the CURRENT zoom (reads the live hour height)
  const m2y = (m: number) => (m / 60) * hourH.value;
  const y2min = (y: number, snap: number) =>
    clamp(Math.round((y / hourH.value) * 60 / snap) * snap, 0, 24 * 60 - snap);

  // Content stays invisible until the initial scroll is applied, then reveals —
  // so the mount→scroll settle is never seen (no top → target flash on open),
  // without forcing a synchronous full-height layout the way contentOffset does.
  const contentOpacity = useSharedValue(0);
  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: scrollPosRef.current, animated: false });
      contentOpacity.value = withTiming(1, { duration: 100 });
    });
  }, []);

  useEffect(() => {
    if (!hasToday) return;
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [hasToday]);

  // bottom pad follows the docked sheet — ease its changes so showing/hiding
  // the sheet doesn't make the scroll content jump
  const padSV = useSharedValue(bottomPad);
  useEffect(() => { padSV.value = withTiming(bottomPad, { duration: 200 }); }, [bottomPad]);
  const contentStyle = useAnimatedStyle(() => ({ height: 24 * hourH.value + padSV.value + 12, opacity: contentOpacity.value }));
  const gridOverlayStyle = useAnimatedStyle(() => ({ height: 24 * hourH.value }));

  const segmentsByDay = useMemo(
    () => days.map(d => daySegments(byDay.get(dayKey(d)) ?? [], d)),
    [days, byDay],
  );
  // continuous bars across days, not per-day chips
  const spans = useMemo(() => allDaySpans(events, days), [events, days]);
  const visibleSpans = spans.filter(sp => sp.lane < ALLDAY_LANES);
  const hiddenSpans = spans.length - visibleSpans.length;
  const laneCount = Math.min(Math.max(...spans.map(sp => sp.lane + 1), 0), ALLDAY_LANES);
  const hasAllDay = spans.length > 0;

  // Gestures read everything through `live` so their useMemo deps stay empty —
  // recreating a gesture mid-drag (draft updates re-render the page every snap
  // step) would rebind the detector under an active pan.
  const live = useRef({ days, colW, draft });
  live.current = { days, colW, draft };

  const atMinutes = (dayIdx: number, mins: number) => {
    const { days } = live.current;
    const d = new Date(days[clamp(dayIdx, 0, days.length - 1)]);
    d.setHours(0, mins, 0, 0);
    return d;
  };

  // Drag-to-create on empty grid: hold, then drag vertically to set the range
  // (15 min snap). Tap an empty slot for a quick 1h draft (30 min snap).
  // Coordinates are relative to the grid overlay spanning the full scroll content.
  const dragAnchor = useRef({ day: 0, min: 0 });
  const lastSnap = useRef("");
  const handleTap = (x: number, y: number) => {
    const day = Math.floor(x / live.current.colW);
    const min = y2min(y - 30, SNAP_TAP_MIN); // center the block on the finger
    tapHaptic();
    onDraftChange({ start: atMinutes(day, min), end: atMinutes(day, min + 60) });
  };
  const handleDragStart = (x: number, y: number) => {
    const day = Math.floor(x / live.current.colW);
    const min = y2min(y, SNAP_DRAG_MIN);
    dragAnchor.current = { day, min };
    lastSnap.current = `${day}:${min}:${min}`;
    gestureActive.current = true;
    gDay.value = day;
    gStartMin.value = min;
    gDurMin.value = 60;
    thump();
    onDraftChange({ start: atMinutes(day, min), end: atMinutes(day, min + 60) });
  };
  // The ghost snaps to 15-min steps and HOLDS there until the finger crosses
  // toward the next step — visual and draft move together, one click at a time.
  const handleDragMove = (y: number) => {
    const { day, min } = dragAnchor.current;
    const cur = y2min(y, SNAP_DRAG_MIN);
    const key = `${day}:${min}:${cur}`;
    if (key === lastSnap.current) return;
    lastSnap.current = key;
    const sMin = cur < min ? cur : min;
    const eMin = cur > min ? Math.max(cur, min + 15) : min + 60;
    gStartMin.value = withTiming(sMin, { duration: SNAP_STEP_MS });
    gDurMin.value = withTiming(eMin - sMin, { duration: SNAP_STEP_MS });
    onDraftChange({ start: atMinutes(day, sMin), end: atMinutes(day, eMin) });
  };
  // "lifted" scale on the ghost while a hold-drag is active — visible feedback
  // that editing kicked in after the long press
  const grabbing = useSharedValue(1);
  const grabStyle = useAnimatedStyle(() => ({ transform: [{ scale: grabbing.value }] }));

  // Ghost geometry lives in shared values and clicks between 15-min steps in
  // lock-step with the draft times — a short withTiming per step gives the
  // "snap and hold" feel without routing every frame through React state.
  const gDay = useSharedValue(0);
  // Geometry in MINUTES, not pixels: the pixel top/height are derived in
  // ghostStyle from hourH, so the ghost scales with pinch-zoom exactly like the
  // event blocks. Storing frozen pixels here made the ghost drift while zooming.
  const gStartMin = useSharedValue(0); // start, minutes from midnight
  const gDurMin = useSharedValue(60);  // duration, minutes
  const gestureActive = useRef(false);
  const ghostStyle = useAnimatedStyle(() => ({
    left: GUTTER + gDay.value * colW + 2,
    top: (gStartMin.value / 60) * hourH.value,
    height: Math.max((gDurMin.value / 60) * hourH.value, 18),
  }));

  const syncGhostToDraft = (animated: boolean) => {
    const d = live.current.draft;
    if (!d) return;
    const dayIdx = Math.max(live.current.days.findIndex(x => isSameDay(x, d.start)), 0);
    const startMin = d.start.getHours() * 60 + d.start.getMinutes();
    const durMin = (d.end.getTime() - d.start.getTime()) / 60000;
    gDay.value = animated ? withTiming(dayIdx, { duration: GHOST_SETTLE_MS }) : dayIdx;
    gStartMin.value = animated ? withTiming(startMin, { duration: GHOST_SETTLE_MS }) : startMin;
    gDurMin.value = animated ? withTiming(durMin, { duration: GHOST_SETTLE_MS }) : durMin;
  };
  // tap-created (or externally changed) drafts position the ghost from state;
  // during an active drag the gesture owns the visuals
  useEffect(() => { if (!gestureActive.current) syncGhostToDraft(false); }, [draft]);

  const finishDrag = () => {
    gestureActive.current = false;
    syncGhostToDraft(true); // settle onto the snapped grid
  };

  const gridGesture = useMemo(() => Gesture.Race(
    Gesture.Pan()
      .activateAfterLongPress(HOLD_CREATE_MS)
      .onStart(e => {
        grabbing.value = withSpring(GRAB_SCALE, GRAB_SPRING);
        runOnJS(handleDragStart)(e.x, e.y);
      })
      .onUpdate(e => { runOnJS(handleDragMove)(e.y); })
      .onFinalize(() => {
        grabbing.value = withSpring(1, GRAB_SPRING);
        runOnJS(finishDrag)();
      }),
    Gesture.Tap()
      .maxDuration(250)
      .onEnd((e, success) => { if (success) runOnJS(handleTap)(e.x, e.y); }),
  ), []);

  // Draft manipulation, Google style: grab a corner DOT to resize that edge
  // (top-left = start, bottom-right = end), anywhere else to move the whole
  // block (vertically in time, horizontally across days). Resize is gated to a
  // tight box on each dot so the rest of the ghost always moves.
  const grab = useRef<{ mode: "start" | "end" | "move"; day: number; startMin: number; endMin: number } | null>(null);
  const grabStart = (x: number, y: number) => {
    const { draft, days, colW } = live.current;
    if (!draft) return;
    const startMin = draft.start.getHours() * 60 + draft.start.getMinutes();
    const endMin = startMin + (draft.end.getTime() - draft.start.getTime()) / 60000;
    const h = m2y(endMin - startMin);
    const w = colW - 4; // ghost width
    const mode = x <= GRAB_DOT_HIT && y <= GRAB_DOT_HIT ? "start"
      : x >= w - GRAB_DOT_HIT && y >= h - GRAB_DOT_HIT ? "end"
        : "move";
    const day = Math.max(days.findIndex(d => isSameDay(d, draft.start)), 0);
    grab.current = { mode, day, startMin, endMin };
    lastSnap.current = "";
    gestureActive.current = true;
    thump(); // "lifted" — the block is yours now
  };
  // Snapped + deduped: the ghost holds each 15-min step until the finger crosses
  // toward the next one, visual and draft together (same as create).
  const grabMove = (tx: number, ty: number) => {
    const g = grab.current;
    if (!g) return;
    const dMin = Math.round((ty / hourH.value) * 60 / SNAP_DRAG_MIN) * SNAP_DRAG_MIN;
    const dDay = Math.round(tx / live.current.colW);
    const key = `${g.mode}:${dMin}:${dDay}`;
    if (key === lastSnap.current) return;
    lastSnap.current = key;
    if (g.mode === "start") {
      const s = clamp(g.startMin + dMin, 0, g.endMin - 15);
      gStartMin.value = withTiming(s, { duration: SNAP_STEP_MS });
      gDurMin.value = withTiming(g.endMin - s, { duration: SNAP_STEP_MS });
      onDraftChange({ start: atMinutes(g.day, s), end: atMinutes(g.day, g.endMin) });
    } else if (g.mode === "end") {
      const en = clamp(g.endMin + dMin, g.startMin + 15, 24 * 60);
      gDurMin.value = withTiming(en - g.startMin, { duration: SNAP_STEP_MS });
      onDraftChange({ start: atMinutes(g.day, g.startMin), end: atMinutes(g.day, en) });
    } else {
      const dur = g.endMin - g.startMin;
      const day = clamp(g.day + dDay, 0, live.current.days.length - 1);
      const s = clamp(g.startMin + dMin, 0, 24 * 60 - dur);
      gStartMin.value = withTiming(s, { duration: SNAP_STEP_MS });
      gDurMin.value = withTiming(dur, { duration: SNAP_STEP_MS });
      if (day !== gDay.value) gDay.value = withTiming(day, { duration: 80 });
      onDraftChange({ start: atMinutes(day, s), end: atMinutes(day, s + dur) });
    }
  };
  // Short hold to grab — an immediate pan loses the race against the native
  // scroll (vertical movement starts the scroll and cancels us). Holding still
  // for a beat means the scroll never activates; a quick flick still scrolls.
  const draftGesture = useMemo(() => Gesture.Pan()
    .activateAfterLongPress(HOLD_GRAB_MS)
    .onStart(e => {
      grabbing.value = withSpring(GRAB_SCALE, GRAB_SPRING);
      runOnJS(grabStart)(e.x, e.y);
    })
    .onUpdate(e => { runOnJS(grabMove)(e.translationX, e.translationY); })
    .onFinalize(() => {
      grabbing.value = withSpring(1, GRAB_SPRING);
      runOnJS(finishDrag)();
    }),
  []);

  // Pinch to zoom the hour height. Pure UI-thread: updates hourH.value, which
  // every derived style/reaction reads — no React re-render while pinching.
  // Focal correction: the content point under the fingers at pinch start stays
  // put — its content-Y scales with the hour height, so we scroll to keep it at
  // the same viewport-Y (focalY is viewport-relative since the detector wraps
  // the ScrollView). Moving the fingers pans too.
  const zoomBase = useSharedValue(HOUR_H);
  const focalContentY = useSharedValue(0); // content-space y under the fingers at start
  const vFocal = useSharedValue(0);        // that finger's y within the scroll viewport
  const scrollTopSV = useSharedValue(0);   // ScrollView's top offset inside the page
  // Pinch lives on the OUTER page view and is declared simultaneous with the
  // ScrollView's gesture — so single-finger scroll and event taps keep working
  // (the pinch only claims two fingers), and the two-finger pinch can activate
  // alongside the scroll. focalY is page-relative, so subtract the viewport top.
  const pinchGesture = useMemo(() => Gesture.Pinch()
    .onStart(e => {
      zoomBase.value = hourH.value;
      const vf = e.focalY - scrollTopSV.value;
      vFocal.value = vf;
      focalContentY.value = scrollY.value + vf;
    })
    .onUpdate(e => {
      const raw = zoomBase.value * e.scale;
      const nh = raw < ZOOM_HOUR_MIN ? ZOOM_HOUR_MIN : raw > ZOOM_HOUR_MAX ? ZOOM_HOUR_MAX : raw;
      hourH.value = nh;
      // keep the anchor at the same viewport-Y
      const newScroll = focalContentY.value * (nh / zoomBase.value) - vFocal.value;
      scrollTo(scrollRef, 0, newScroll < 0 ? 0 : newScroll, false);
    })
    .simultaneousWithExternalGesture(scrollRef as any), []);

  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <GestureDetector gesture={pinchGesture}>
      <View style={{ flex: 1 }}>
        {/* day header row */}
        <View style={{ flexDirection: "row", paddingLeft: GUTTER, paddingVertical: 6, borderBottomWidth: hasAllDay ? 0 : 1, borderColor: colors.line }}>
          {days.map((d, i) => {
            const today = isSameDay(d, now);
            return (
              <View key={i} style={{ width: colW, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 }}>
                <Text style={{ fontFamily: fonts.sans, fontSize: 10, color: today ? colors.accent : colors.fg4, letterSpacing: 1 }}>
                  {dayjs(d).format(days.length === 1 ? "dddd" : "dd").toUpperCase()}
                </Text>
                <View style={{
                  minWidth: 21, height: 21, borderRadius: 11, paddingHorizontal: 3,
                  alignItems: "center", justifyContent: "center",
                  backgroundColor: today ? colors.accent : "transparent",
                }}>
                  <Text style={{ fontFamily: fonts.sansMedium, fontSize: 12, color: today ? "#f4f1e8" : colors.fg2 }}>
                    {d.getDate()}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>

        {/* all-day events — continuous bars spanning their days */}
        {hasAllDay && (
          <View style={{
            marginLeft: GUTTER, height: laneCount * ALLDAY_LANE_H + 4,
            borderBottomWidth: 1, borderColor: colors.line,
          }}>
            {visibleSpans.map(sp => (
              <Tap key={sp.event.id} onPress={() => onPressEvent(sp.event)} style={{
                position: "absolute",
                left: sp.startCol * colW + 1,
                width: (sp.endCol - sp.startCol + 1) * colW - 2,
                top: sp.lane * ALLDAY_LANE_H,
                height: ALLDAY_LANE_H - 4,
                backgroundColor: eventColorOf(sp.event),
                borderRadius: 4, paddingHorizontal: 5, justifyContent: "center",
              }}>
                <Text numberOfLines={1} style={{ fontFamily: fonts.sans, fontSize: 9.5, color: INK }}>{sp.event.title}</Text>
              </Tap>
            ))}
            {hiddenSpans > 0 && (
              <Text style={{ position: "absolute", right: 4, bottom: 2, fontFamily: fonts.sans, fontSize: 9, color: colors.fg3 }}>
                +{hiddenSpans}
              </Text>
            )}
          </View>
        )}

        <ScrollView
          ref={scrollRef as any} // RNGH ScrollView; reanimated scrollTo resolves the native node
          onLayout={e => { scrollTopSV.value = e.nativeEvent.layout.y; }}
          onScroll={e => { scrollPosRef.current = e.nativeEvent.contentOffset.y; scrollY.value = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={contentStyle}>
            {/* hour lines + labels — each tracks the live hour height */}
            {Array.from({ length: 24 }, (_, h) => (
              <HourLine key={h} h={h} hourH={hourH} />
            ))}
            {/* column separators */}
            {days.length > 1 && days.map((_, i) => i > 0 && (
              <View key={i} style={{ position: "absolute", left: GUTTER + i * colW, top: 0, bottom: 0, width: 1, backgroundColor: colors.line }} />
            ))}

            {/* empty-slot gestures — sits under the event blocks */}
            <GestureDetector gesture={gridGesture}>
              <Animated.View style={[{ position: "absolute", left: GUTTER, top: 0, width: width - GUTTER }, gridOverlayStyle]} />
            </GestureDetector>

            {/* events — hold a movable block to pick it up; locked ones wear 🔒 */}
            {segmentsByDay.map((segs, di) => segs.map((s, si) => {
              const laneW = (colW - 4) / s.cols;
              return (
                <TimelineEventBlock
                  key={s.event.id + si}
                  event={s.event}
                  startMin={s.startMin}
                  endMin={s.endMin}
                  left={GUTTER + di * colW + 2 + s.col * laneW}
                  width={laneW - 2}
                  hourH={hourH}
                  showTime={s.endMin - s.startMin >= 40 && laneW > 60}
                  timeFormat={timeFormat}
                  color={eventColorOf(s.event)}
                  dayIndex={di}
                  daysCount={days.length}
                  colW={colW}
                  movable={canMoveEvent(s.event)}
                  onPress={onPressEvent}
                  onMove={onMoveEvent}
                />
              );
            }))}

            {/* drag/tap draft ghost — grabbable: corner dots resize, middle moves.
                Position comes from shared values (snaps to 15-min steps); the
                times in the label are the snapped draft state. */}
            {draft && (() => {
              const handleDot = {
                position: "absolute" as const, width: 11, height: 11, borderRadius: 6,
                backgroundColor: colors.bg, borderWidth: 2, borderColor: colors.accent,
              };
              return (
                <GestureDetector key="draft" gesture={draftGesture}>
                  <Animated.View style={[{
                    position: "absolute",
                    width: colW - 4,
                    borderRadius: 5, borderWidth: 1.5,
                    // neutral scrim, not accent: reads over any event color beneath
                    // (dark mode darkens what's under, light mode lightens it)
                    borderColor: colors.accent,
                    backgroundColor: activeScheme === "dark" ? "rgba(12,12,14,0.5)" : "rgba(244,241,232,0.6)",
                    paddingHorizontal: 5, paddingTop: 3,
                  }, ghostStyle, grabStyle]}>
                    <Text style={{ fontFamily: fonts.sansMedium, fontSize: 9.5, color: colors.fg2 }}>
                      {formatTime(draft.start, timeFormat)} – {formatTime(draft.end, timeFormat)}
                    </Text>
                    <View style={[handleDot, { top: -6, left: 12 }]} />
                    <View style={[handleDot, { bottom: -6, right: 12 }]} />
                  </Animated.View>
                </GestureDetector>
              );
            })()}

            {/* now indicator */}
            {days.map((d, di) => isSameDay(d, now) && (
              <NowIndicator key="now" hourH={hourH} nowMin={nowMin} left={GUTTER + di * colW} colW={colW} />
            ))}
          </Animated.View>
        </ScrollView>
      </View>
    </GestureDetector>
  );
}

// One hour gridline + its label, positioned at the live hour height.
function HourLine({ h, hourH }: { h: number; hourH: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({ top: h * hourH.value }));
  return (
    <Animated.View style={[{ position: "absolute", left: 0, right: 0 }, style]}>
      <View style={{ position: "absolute", left: GUTTER, right: 0, height: 1, backgroundColor: colors.line }} />
      {h > 0 && (
        <Text style={{ position: "absolute", top: -6, width: GUTTER - 8, textAlign: "right", fontFamily: fonts.sans, fontSize: 10, color: colors.fg4 }}>
          {h}:00
        </Text>
      )}
    </Animated.View>
  );
}

function NowIndicator({ hourH, nowMin, left, colW }: { hourH: SharedValue<number>; nowMin: number; left: number; colW: number }) {
  const style = useAnimatedStyle(() => ({ top: (nowMin / 60) * hourH.value - 1 }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", left, width: colW }, style]}>
      <View style={{ height: 2, backgroundColor: colors.accent, borderRadius: 1 }} />
      <View style={{ position: "absolute", left: -3, top: -2.5, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
    </Animated.View>
  );
}

type BlockProps = {
  event: Event;
  startMin: number; endMin: number;    // event's minutes-from-midnight (clipped to day)
  left: number; width: number;         // horizontal px — unaffected by vertical zoom
  hourH: SharedValue<number>;
  showTime: boolean;
  timeFormat: TimeFormat;
  color: string;
  dayIndex: number;
  daysCount: number;
  colW: number;
  movable: boolean;                     // edit rights + not recurring
  onPress: (e: Event) => void;
  onMove: (e: Event, dayDelta: number, minDelta: number) => void;
};

// An event block: tap opens its detail; a HOLD picks the block up and moves it
// (vertical = continuous time, horizontal = whole-day snaps). Blocks that
// can't move — read-only calendars, recurring series — wear a small lock.
//
// Vertical position/height derive from the shared hour height via a reaction,
// so a pinch reflows every block on the UI thread. Flicker-free drop: on commit
// the raw drag is FOLDED into topSV/leftSV while the transforms zero out in the
// same batch — identical pixel before and after — then the layout effect glides
// to the snapped spot.
function TimelineEventBlock({
  event, startMin, endMin, left, width, hourH, showTime, timeFormat, color, dayIndex, daysCount, colW, movable, onPress, onMove,
}: BlockProps) {
  const live = useRef({ event, dayIndex, daysCount, colW, onMove });
  live.current = { event, dayIndex, daysCount, colW, onMove };

  const baseTop = (h: number) => (startMin / 60) * h;
  const baseH = (h: number) => Math.max(((endMin - startMin) / 60) * h - 2, 18);

  const leftSV = useSharedValue(left);
  // Seed from the default hour height (a constant) — reading hourH.value here
  // would be a render-time shared-value read. The mount effect below immediately
  // corrects to the live value, and the zoom reaction keeps it in sync.
  const topSV = useSharedValue(baseTop(HOUR_H));
  const heightSV = useSharedValue(baseH(HOUR_H));
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const lift = useSharedValue(1);
  const dragging = useSharedValue(false);
  const ndTarget = useSharedValue(0);
  const minPrev = useSharedValue(0);
  const dayIdxSV = useSharedValue(dayIndex);
  const boundsSV = useSharedValue(daysCount - 1);
  const colWSV = useSharedValue(colW);
  useEffect(() => {
    dayIdxSV.value = dayIndex;
    boundsSV.value = daysCount - 1;
    colWSV.value = colW;
  }, [dayIndex, daysCount, colW]);

  // Zoom: reflow to the live hour height on the UI thread (skip while dragging —
  // the gesture owns the position then). Math is inlined; baseTop/baseH are JS
  // closures and can't be called from this worklet.
  useAnimatedReaction(() => hourH.value, (h) => {
    if (dragging.value) return;
    topSV.value = (startMin / 60) * h;
    heightSV.value = Math.max(((endMin - startMin) / 60) * h - 2, 18);
  }, [startMin, endMin]);

  // layout sync: after a committed move the folded top equals the new base, so
  // this glide is the drop's settle onto the grid (horizontal/day too)
  const mounted = useRef(false);
  useEffect(() => {
    const h = hourH.value;
    if (!mounted.current) {
      mounted.current = true;
      leftSV.value = left; topSV.value = baseTop(h); heightSV.value = baseH(h);
      return;
    }
    leftSV.value = withTiming(left, { duration: GHOST_SETTLE_MS });
    topSV.value = withTiming(baseTop(h), { duration: GHOST_SETTLE_MS });
    heightSV.value = baseH(h); // duration is unchanged by a move — snap
  }, [left, startMin, endMin]);

  // live time range preview while dragging (snapped, deduped)
  const [preview, setPreview] = useState<null | { day: number; min: number }>(null);
  const showPreview = (day: number, min: number) => setPreview({ day, min });
  const clearPreview = () => setPreview(null);

  const commit = (rawTx: number, rawTy: number) => {
    const { event, dayIndex, daysCount, colW, onMove } = live.current;
    const dayDelta = clamp(Math.round(rawTx / colW), -dayIndex, daysCount - 1 - dayIndex);
    const minDelta = Math.round((rawTy / hourH.value) * 60 / SNAP_DRAG_MIN) * SNAP_DRAG_MIN;
    setPreview(null);
    if (dayDelta === 0 && minDelta === 0) {
      tx.value = withTiming(0, { duration: GHOST_SETTLE_MS });
      ty.value = withTiming(0, { duration: GHOST_SETTLE_MS });
      return;
    }
    // fold drag into the base coords + zero transforms — one batch, same pixel
    leftSV.value = leftSV.value + tx.value;
    topSV.value = topSV.value + ty.value;
    tx.value = 0;
    ty.value = 0;
    onMove(event, dayDelta, minDelta);
  };
  const startHaptic = () => thump();

  const gesture = useMemo(() => Gesture.Pan()
    .enabled(movable)
    .activateAfterLongPress(HOLD_GRAB_MS)
    .onStart(() => {
      dragging.value = true;
      lift.value = withSpring(GRAB_SCALE, GRAB_SPRING);
      ndTarget.value = 0;
      minPrev.value = 0;
      runOnJS(startHaptic)();
    })
    .onUpdate(e => {
      ty.value = e.translationY;
      const nd = Math.min(Math.max(Math.round(e.translationX / colWSV.value), -dayIdxSV.value), boundsSV.value - dayIdxSV.value);
      const m = Math.round((e.translationY / hourH.value) * 60 / SNAP_DRAG_MIN) * SNAP_DRAG_MIN;
      if (ndTarget.value !== nd) {
        ndTarget.value = nd;
        tx.value = withTiming(nd * colWSV.value, { duration: 80 });
      }
      if (minPrev.value !== m || ndTarget.value !== nd) {
        minPrev.value = m;
        runOnJS(showPreview)(nd, m);
      }
    })
    .onEnd(e => { runOnJS(commit)(e.translationX, e.translationY); })
    .onFinalize(() => {
      dragging.value = false;
      lift.value = withSpring(1, GRAB_SPRING);
      runOnJS(clearPreview)();
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [movable]);

  const animStyle = useAnimatedStyle(() => ({
    left: leftSV.value,
    top: topSV.value,
    height: heightSV.value,
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: lift.value }],
    zIndex: lift.value > 1 ? 10 : 0,
    elevation: lift.value > 1 ? 6 : 0,
    shadowColor: "#000",
    shadowOpacity: lift.value > 1 ? 0.2 : 0,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  }));

  const shiftMs = preview ? (preview.day * 24 * 60 + preview.min) * 60000 : 0;
  const dur = endMin - startMin;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[{ position: "absolute", width }, animStyle]}>
        <Tap
          onPress={() => onPress(event)}
          style={{
            flex: 1,
            backgroundColor: color,
            borderRadius: 5, paddingHorizontal: 5, paddingTop: 3,
            overflow: "hidden",
          }}
        >
          <Text numberOfLines={dur >= 30 ? 2 : 1} style={{ fontFamily: fonts.sansMedium, fontSize: 10.5, color: INK, paddingRight: movable ? 0 : 10 }}>
            {event.title}
          </Text>
          {(showTime || preview !== null) && (
            <Text style={{ fontFamily: fonts.sans, fontSize: 9, color: INK, opacity: 0.65 }}>
              {formatTime(new Date(event.start.getTime() + shiftMs), timeFormat)} – {formatTime(new Date(event.end.getTime() + shiftMs), timeFormat)}
            </Text>
          )}
          {!movable && (
            <Feather name="lock" size={8} color={INK} style={{ position: "absolute", top: 3, right: 3, opacity: 0.5 }} />
          )}
        </Tap>
      </Animated.View>
    </GestureDetector>
  );
}
