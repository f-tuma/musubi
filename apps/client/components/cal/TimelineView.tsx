import { Event } from "@musubi/types";
import { colors, fonts } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";
import { tap as tapHaptic, thump } from "@/lib/haptics";
import dayjs from "dayjs";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import InfinitePager from "react-native-infinite-pager";
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import {
  addDays, bucketByDay, clamp, dayKey, daySegments, Draft, fmtTime, GRAB_EDGE_PX,
  GRAB_SCALE, GRAB_SPRING, GRID_H, GUTTER, HOLD_CREATE_MS, HOLD_GRAB_MS, HOUR_H, INK,
  isSameDay, minutesToY, SNAP_DRAG_MIN, SNAP_TAP_MIN, startOfWeek, yToMinutes,
} from "./layout";

type Props = {
  mode: "day" | "week";
  base: Date;                        // page 0 anchor (the day / any date in the week)
  events: Event[];                   // expanded + visibility-filtered, sorted by start
  weekStartsOn: 0 | 1;
  eventColorOf: (e: Event) => string;
  onPressEvent: (e: Event) => void;
  draft: Draft | null;
  onDraftChange: (d: Draft) => void;
  onPageChange: (start: Date) => void;
  scrollPosRef: MutableRefObject<number>;  // shared so swiped-in pages keep the scroll position
  bottomPad: number;                 // room for the docked composer peek
};

export function TimelineView({
  mode, base, events, weekStartsOn, eventColorOf, onPressEvent,
  draft, onDraftChange, onPageChange, scrollPosRef, bottomPad,
}: Props) {
  const [width, setWidth] = useState(0);
  const byDay = useMemo(() => bucketByDay(events), [events]);
  const weekBase = useMemo(() => startOfWeek(base, weekStartsOn), [base, weekStartsOn]);

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
              byDay={byDay}
              eventColorOf={eventColorOf}
              onPressEvent={onPressEvent}
              draft={draft}
              onDraftChange={onDraftChange}
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
  byDay: Map<string, Event[]>;
  eventColorOf: (e: Event) => string;
  onPressEvent: (e: Event) => void;
  draft: Draft | null;
  onDraftChange: (d: Draft) => void;
  scrollPosRef: MutableRefObject<number>;
  bottomPad: number;
};

function TimelinePage({
  days, width, byDay, eventColorOf, onPressEvent, draft, onDraftChange, scrollPosRef, bottomPad,
}: PageProps) {
  const colW = (width - GUTTER) / days.length;
  const [now, setNow] = useState(() => new Date());
  const scrollRef = useRef<ScrollView>(null);
  const hasToday = days.some(d => isSameDay(d, now));

  useEffect(() => {
    // restore the shared scroll position when this page mounts (pager buffer)
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: scrollPosRef.current, animated: false }));
  }, []);

  useEffect(() => {
    if (!hasToday) return;
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [hasToday]);

  const segmentsByDay = useMemo(
    () => days.map(d => daySegments(byDay.get(dayKey(d)) ?? [], d)),
    [days, byDay],
  );
  const allDayByDay = useMemo(
    () => days.map(d => (byDay.get(dayKey(d)) ?? []).filter(e => e.isAllDay)),
    [days, byDay],
  );
  const hasAllDay = allDayByDay.some(a => a.length > 0);

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
  const handleTap = (x: number, y: number) => {
    const day = Math.floor(x / live.current.colW);
    const min = yToMinutes(y - 30, SNAP_TAP_MIN); // center the block on the finger
    tapHaptic();
    onDraftChange({ start: atMinutes(day, min), end: atMinutes(day, min + 60) });
  };
  const handleDragStart = (x: number, y: number) => {
    const day = Math.floor(x / live.current.colW);
    const min = yToMinutes(y, SNAP_DRAG_MIN);
    dragAnchor.current = { day, min };
    thump();
    onDraftChange({ start: atMinutes(day, min), end: atMinutes(day, min + 60) });
  };
  const handleDragMove = (y: number) => {
    const { day, min } = dragAnchor.current;
    const cur = yToMinutes(y, SNAP_DRAG_MIN);
    if (cur > min) onDraftChange({ start: atMinutes(day, min), end: atMinutes(day, Math.max(cur, min + 15)) });
    else onDraftChange({ start: atMinutes(day, Math.min(cur, min - 15)), end: atMinutes(day, min + 60) });
  };
  // "lifted" scale on the ghost while a hold-drag is active — visible feedback
  // that editing kicked in after the long press
  const grabbing = useSharedValue(1);
  const grabStyle = useAnimatedStyle(() => ({ transform: [{ scale: grabbing.value }] }));

  const gridGesture = useMemo(() => Gesture.Race(
    Gesture.Pan()
      .activateAfterLongPress(HOLD_CREATE_MS)
      .onStart(e => {
        grabbing.value = withSpring(GRAB_SCALE, GRAB_SPRING);
        runOnJS(handleDragStart)(e.x, e.y);
      })
      .onUpdate(e => { runOnJS(handleDragMove)(e.y); })
      .onFinalize(() => { grabbing.value = withSpring(1, GRAB_SPRING); }),
    Gesture.Tap()
      .maxDuration(250)
      .onEnd((e, success) => { if (success) runOnJS(handleTap)(e.x, e.y); }),
  ), []);

  // Draft manipulation, Google style: grab the top edge to move the start, the
  // bottom edge to move the end, anywhere in the middle to move the whole block
  // (vertically in time, horizontally across days). The corner dots advertise it.
  const grab = useRef<{ mode: "start" | "end" | "move"; day: number; startMin: number; endMin: number } | null>(null);
  const grabStart = (y: number) => {
    const { draft, days } = live.current;
    if (!draft) return;
    const startMin = draft.start.getHours() * 60 + draft.start.getMinutes();
    const endMin = startMin + (draft.end.getTime() - draft.start.getTime()) / 60000;
    const h = minutesToY(endMin - startMin);
    const edge = Math.min(GRAB_EDGE_PX, h / 3);
    grab.current = {
      mode: y <= edge ? "start" : y >= h - edge ? "end" : "move",
      day: Math.max(days.findIndex(d => isSameDay(d, draft.start)), 0),
      startMin, endMin,
    };
    thump(); // "lifted" — the block is yours now
  };
  const grabMove = (tx: number, ty: number) => {
    const g = grab.current;
    if (!g) return;
    const dMin = Math.round((ty / HOUR_H) * 60 / SNAP_DRAG_MIN) * SNAP_DRAG_MIN;
    if (g.mode === "start") {
      const s = clamp(g.startMin + dMin, 0, g.endMin - 15);
      onDraftChange({ start: atMinutes(g.day, s), end: atMinutes(g.day, g.endMin) });
    } else if (g.mode === "end") {
      const en = clamp(g.endMin + dMin, g.startMin + 15, 24 * 60);
      onDraftChange({ start: atMinutes(g.day, g.startMin), end: atMinutes(g.day, en) });
    } else {
      const dur = g.endMin - g.startMin;
      const day = clamp(g.day + Math.round(tx / live.current.colW), 0, live.current.days.length - 1);
      const s = clamp(g.startMin + dMin, 0, 24 * 60 - dur);
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
      runOnJS(grabStart)(e.y);
    })
    .onUpdate(e => { runOnJS(grabMove)(e.translationX, e.translationY); })
    .onFinalize(() => { grabbing.value = withSpring(1, GRAB_SPRING); }),
  []);

  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
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

      {/* all-day events */}
      {hasAllDay && (
        <View style={{ flexDirection: "row", paddingLeft: GUTTER, paddingBottom: 4, borderBottomWidth: 1, borderColor: colors.line }}>
          {days.map((d, i) => (
            <View key={i} style={{ width: colW, paddingHorizontal: 1, gap: 2 }}>
              {allDayByDay[i].slice(0, 2).map(e => (
                <Tap key={e.id} onPress={() => onPressEvent(e)} style={{
                  backgroundColor: eventColorOf(e), borderRadius: 4, paddingHorizontal: 4,
                  height: 18, justifyContent: "center",
                }}>
                  <Text numberOfLines={1} style={{ fontFamily: fonts.sans, fontSize: 9.5, color: INK }}>{e.title}</Text>
                </Tap>
              ))}
              {allDayByDay[i].length > 2 && (
                <Text style={{ fontFamily: fonts.sans, fontSize: 9, color: colors.fg3, paddingLeft: 4 }}>
                  +{allDayByDay[i].length - 2}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        onScroll={e => { scrollPosRef.current = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={32}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ height: GRID_H + bottomPad + 12 }}>
          {/* hour lines + labels */}
          {Array.from({ length: 24 }, (_, h) => (
            <View key={h} style={{ position: "absolute", top: minutesToY(h * 60), left: 0, right: 0 }}>
              <View style={{ position: "absolute", left: GUTTER, right: 0, height: 1, backgroundColor: colors.line }} />
              {h > 0 && (
                <Text style={{ position: "absolute", top: -6, width: GUTTER - 8, textAlign: "right", fontFamily: fonts.sans, fontSize: 10, color: colors.fg4 }}>
                  {h}:00
                </Text>
              )}
            </View>
          ))}
          {/* column separators */}
          {days.length > 1 && days.map((_, i) => i > 0 && (
            <View key={i} style={{ position: "absolute", left: GUTTER + i * colW, top: 0, bottom: 0, width: 1, backgroundColor: colors.line }} />
          ))}

          {/* empty-slot gestures — sits under the event blocks */}
          <GestureDetector gesture={gridGesture}>
            <View style={{ position: "absolute", left: GUTTER, top: 0, width: width - GUTTER, height: GRID_H }} />
          </GestureDetector>

          {/* events */}
          {segmentsByDay.map((segs, di) => segs.map((s, si) => {
            const laneW = (colW - 4) / s.cols;
            const top = minutesToY(s.startMin);
            const height = Math.max(minutesToY(s.endMin - s.startMin) - 2, 18);
            const showTime = height >= 34 && laneW > 60;
            return (
              <Tap
                key={s.event.id + si}
                onPress={() => onPressEvent(s.event)}
                style={{
                  position: "absolute",
                  left: GUTTER + di * colW + 2 + s.col * laneW,
                  top, width: laneW - 2, height,
                  backgroundColor: eventColorOf(s.event),
                  borderRadius: 5, paddingHorizontal: 5, paddingTop: 3,
                  overflow: "hidden",
                }}
              >
                <Text numberOfLines={height > 30 ? 2 : 1} style={{ fontFamily: fonts.sansMedium, fontSize: 10.5, color: INK }}>
                  {s.event.title}
                </Text>
                {showTime && (
                  <Text style={{ fontFamily: fonts.sans, fontSize: 9, color: INK, opacity: 0.65 }}>
                    {fmtTime(s.event.start)} – {fmtTime(s.event.end)}
                  </Text>
                )}
              </Tap>
            );
          }))}

          {/* drag/tap draft ghost — grabbable: edges resize, middle moves */}
          {draft && days.map((d, di) => {
            if (!isSameDay(d, draft.start)) return null;
            const startMin = draft.start.getHours() * 60 + draft.start.getMinutes();
            const endMin = startMin + (draft.end.getTime() - draft.start.getTime()) / 60000;
            const handleDot = {
              position: "absolute" as const, width: 11, height: 11, borderRadius: 6,
              backgroundColor: colors.bg, borderWidth: 2, borderColor: colors.accent,
            };
            return (
              <GestureDetector key="draft" gesture={draftGesture}>
                <Animated.View style={[{
                  position: "absolute",
                  left: GUTTER + di * colW + 2, width: colW - 4,
                  top: minutesToY(startMin), height: Math.max(minutesToY(endMin - startMin), 18),
                  borderRadius: 5, borderWidth: 1.5,
                  borderColor: colors.accent, backgroundColor: `${colors.accent}2b`,
                  paddingHorizontal: 5, paddingTop: 3,
                }, grabStyle]}>
                  <Text style={{ fontFamily: fonts.sansMedium, fontSize: 9.5, color: colors.fg2 }}>
                    {fmtTime(draft.start)} – {fmtTime(draft.end)}
                  </Text>
                  <View style={[handleDot, { top: -6, left: 12 }]} />
                  <View style={[handleDot, { bottom: -6, right: 12 }]} />
                </Animated.View>
              </GestureDetector>
            );
          })}

          {/* now indicator */}
          {days.map((d, di) => isSameDay(d, now) && (
            <View key="now" pointerEvents="none" style={{ position: "absolute", left: GUTTER + di * colW, width: colW, top: minutesToY(nowMin) - 1 }}>
              <View style={{ height: 2, backgroundColor: colors.accent, borderRadius: 1 }} />
              <View style={{ position: "absolute", left: -3, top: -2.5, width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }} />
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
