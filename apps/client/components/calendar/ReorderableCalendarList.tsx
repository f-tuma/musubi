import { Calendar, providerFlavor } from "@musubi/types";
import { colors, fonts, styles } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";
import { tap as tapHaptic, thump } from "@/lib/haptics";
import { Feather, Ionicons } from "@expo/vector-icons";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

// ── Reorder tuning ───────────────────────────────────────────────────────────
const HOLD_MS = 300;          // hold before a row/group lifts
const LIFT_SCALE = 1.01;
const SHIFT_MS = 160;         // make-room / settle animation
const LIFT_SPRING = { damping: 30, stiffness: 400 };

export type CalendarGroup = {
  key: string;
  title: string;
  native?: boolean;             // the Musubi group — pinned first, header not draggable
  provider?: string;
  accountId?: string;
  calendars: Calendar[];
};

type DragState =
  | { kind: "row"; gi: number; from: number; to: number }
  | { kind: "group"; from: number; to: number }   // indices within the ACCOUNT groups only
  | null;

type Props = {
  groups: CalendarGroup[];       // pre-sorted: native first, then accounts in saved order
  eventCount: Record<string, number>;
  onOpen: (c: Calendar) => void;
  onDisconnect: (g: CalendarGroup) => void;
  /** Called with the full new flat calendar-id order after any drag. */
  onReorder: (ids: string[]) => void;
};

function ProviderIcon({ provider }: { provider?: string | null }) {
  if (provider === "google") return <Ionicons name="logo-google" size={13} color={colors.fg3} />;
  if (provider === "apple") return <Ionicons name="logo-apple" size={14} color={colors.fg3} />;
  if (provider === "caldav") return <Ionicons name="cloud" size={14} color={colors.fg3} />;
  return <Feather name="calendar" size={13} color={colors.fg3} />;
}

// Every item (group header or calendar row) is ABSOLUTELY positioned and its
// top lives in a shared value — one coordinate system, driven from one place.
// That's what makes the drop flicker-free: while dragged an item renders at
// baseY + dragY; at commit its topSV is set to that exact pixel in the same
// batch, so the formula switch can't move it, and the slot-sync effect then
// glides it into its final place.
export function ReorderableCalendarList({ groups, eventCount, onOpen, onDisconnect, onReorder }: Props) {
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  const dragY = useSharedValue(0);
  const lift = useSharedValue(1);
  const [rowH, setRowH] = useState(77);      // measured from the first row (rows are uniform)
  const [headerH, setHeaderH] = useState(34);
  const registry = useRef(new Map<string, SharedValue<number>>());   // id → topSV
  const grabBases = useRef(new Map<string, number>());               // id → visual top at grab
  const live = useRef({ groups, rowH, headerH });
  live.current = { groups, rowH, headerH };

  const setDragBoth = (d: DragState) => { dragRef.current = d; setDrag(d); };

  // ── layout: target top for every item, honoring the drag's hover slot ──
  const layout = useMemo(() => {
    const tops = new Map<string, number>();
    const native = groups.filter(g => g.native);
    let accounts = groups.filter(g => !g.native);
    if (drag?.kind === "group") {
      const arr = [...accounts];
      const [m] = arr.splice(drag.from, 1);
      arr.splice(drag.to, 0, m);
      accounts = arr;
    }
    let y = 0;
    for (const g of [...native, ...accounts]) {
      tops.set(g.key, y);
      y += headerH;
      let cals = g.calendars;
      if (drag?.kind === "row" && groups[drag.gi]?.key === g.key) {
        const arr = [...cals];
        const [m] = arr.splice(drag.from, 1);
        arr.splice(drag.to, 0, m);
        cals = arr;
      }
      for (const c of cals) {
        tops.set(c.id, y);
        y += rowH;
      }
    }
    return { tops, total: y };
  }, [groups, drag, rowH, headerH]);

  // ids that follow the finger instead of their slot
  const draggedIds = useMemo(() => {
    if (!drag) return new Set<string>();
    if (drag.kind === "row") {
      const cal = groups[drag.gi]?.calendars[drag.from];
      return new Set(cal ? [cal.id] : []);
    }
    const g = groups.filter(x => !x.native)[drag.from];
    return new Set(g ? [g.key, ...g.calendars.map(c => c.id)] : []);
  }, [drag, groups]);

  // ── drag lifecycle ──
  const grab = (d: Exclude<DragState, null>, ids: string[]) => {
    if (dragRef.current) return;
    grabBases.current.clear();
    for (const id of ids) grabBases.current.set(id, registry.current.get(id)?.value ?? 0);
    thump();
    setDragBoth(d);
  };

  const beginRow = (gi: number, idx: number) => {
    const cal = live.current.groups[gi]?.calendars[idx];
    if (cal) grab({ kind: "row", gi, from: idx, to: idx }, [cal.id]);
  };
  const moveRow = (ty: number) => {
    const d = dragRef.current;
    if (!d || d.kind !== "row") return;
    const { groups, rowH } = live.current;
    const g = groups[d.gi];
    const minIdx = g.native && g.calendars[0]?.isDefault ? 1 : 0;
    const to = Math.min(Math.max(d.from + Math.round(ty / rowH), minIdx), g.calendars.length - 1);
    if (to !== d.to) { tapHaptic(); setDragBoth({ ...d, to }); }
  };

  const accountHeights = () => {
    const { groups, rowH, headerH } = live.current;
    return groups.filter(g => !g.native).map(g => headerH + g.calendars.length * rowH);
  };
  const beginGroup = (key: string) => {
    const accounts = live.current.groups.filter(x => !x.native);
    const ai = accounts.findIndex(x => x.key === key);
    const g = accounts[ai];
    if (g) grab({ kind: "group", from: ai, to: ai }, [g.key, ...g.calendars.map(c => c.id)]);
  };
  const moveGroup = (ty: number) => {
    const d = dragRef.current;
    if (!d || d.kind !== "group") return;
    const hs = accountHeights();
    let to = d.from;
    let rest = ty;
    while (rest > 0 && to < hs.length - 1 && rest > hs[to + 1] / 2) { rest -= hs[to + 1]; to++; }
    while (rest < 0 && to > 0 && -rest > hs[to - 1] / 2) { rest += hs[to - 1]; to--; }
    if (to !== d.to) { tapHaptic(); setDragBoth({ ...d, to }); }
  };

  const commit = () => {
    const d = dragRef.current;
    if (!d) return;
    // fold the drag into each dragged item's topSV — identical pixel, so the
    // dragged → slotted formula switch can't jump
    for (const [id, base] of grabBases.current) {
      const sv = registry.current.get(id);
      if (sv) sv.value = base + dragY.value;
    }
    setDragBoth(null);
    if (d.from === d.to) return;
    const { groups } = live.current;
    const nextGroups = groups.map(g => ({ ...g, calendars: [...g.calendars] }));
    if (d.kind === "row") {
      const list = nextGroups[d.gi].calendars;
      const [moved] = list.splice(d.from, 1);
      list.splice(d.to, 0, moved);
    } else {
      const acc = nextGroups.filter(g => !g.native);
      const [moved] = acc.splice(d.from, 1);
      acc.splice(d.to, 0, moved);
      const nat = nextGroups.filter(g => g.native);
      nextGroups.length = 0;
      nextGroups.push(...nat, ...acc);
    }
    onReorder(nextGroups.flatMap(g => g.calendars.map(c => c.id)));
  };

  return (
    <View style={{ height: layout.total }}>
      {groups.map((g) => [
        <PositionedItem
          key={g.key}
          id={g.key}
          y={layout.tops.get(g.key) ?? 0}
          dragged={draggedIds.has(g.key)}
          baseY={grabBases.current.get(g.key) ?? 0}
          dragY={dragY}
          lift={lift}
          registry={registry.current}
          onMeasure={h => { if (Math.abs(h - live.current.headerH) > 1) setHeaderH(h); }}
        >
          <SectionHeader
            group={g}
            draggable={!g.native}
            onDisconnect={g.native ? undefined : () => onDisconnect(g)}
            onDragStart={() => beginGroup(g.key)}
            onDragMove={moveGroup}
            onDragEnd={commit}
            dragY={dragY}
            lift={lift}
          />
        </PositionedItem>,
        ...g.calendars.map((c) => (
          <PositionedItem
            key={c.id}
            id={c.id}
            y={layout.tops.get(c.id) ?? 0}
            dragged={draggedIds.has(c.id)}
            baseY={grabBases.current.get(c.id) ?? 0}
            dragY={dragY}
            lift={lift}
            registry={registry.current}
            onMeasure={h => { if (Math.abs(h - live.current.rowH) > 1) setRowH(h); }}
          >
            <RowItem
              cal={c}
              meta={`${c.members.length} members · ${eventCount[c.id] ?? 0} events`}
              draggable={!(g.native && c.isDefault) && g.calendars.length > 1}
              onOpen={() => onOpen(c)}
              onDragStart={() => {
                const curGi = live.current.groups.findIndex(x => x.key === g.key);
                const curIdx = live.current.groups[curGi]?.calendars.findIndex(x => x.id === c.id) ?? 0;
                beginRow(curGi, curIdx);
              }}
              onDragMove={moveRow}
              onDragEnd={commit}
              dragY={dragY}
              lift={lift}
            />
          </PositionedItem>
        )),
      ])}
    </View>
  );
}

// Absolutely positioned wrapper: slotted items glide to their target top,
// the dragged one follows baseY + dragY on the UI thread.
function PositionedItem({ id, y, dragged, baseY, dragY, lift, registry, onMeasure, children }: {
  id: string;
  y: number;
  dragged: boolean;
  baseY: number;
  dragY: SharedValue<number>;
  lift: SharedValue<number>;
  registry: Map<string, SharedValue<number>>;
  onMeasure?: (h: number) => void;
  children: React.ReactNode;
}) {
  const topSV = useSharedValue(y);
  const mounted = useRef(false);
  useEffect(() => {
    registry.set(id, topSV);
    return () => { registry.delete(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (dragged) return; // the gesture owns the position
    if (!mounted.current) { mounted.current = true; topSV.value = y; return; }
    topSV.value = withTiming(y, { duration: SHIFT_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [y, dragged]);

  const style = useAnimatedStyle(() => ({
    position: "absolute" as const,
    left: 0, right: 0,
    top: dragged ? baseY + dragY.value : topSV.value,
    zIndex: dragged ? 10 : 0,
    transform: [{ scale: dragged ? lift.value : 1 }],
    elevation: dragged ? 6 : 0,
    shadowColor: "#000",
    shadowOpacity: dragged ? 0.18 : 0,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  }));

  // backgroundColor stays OUT of the worklet: reading `colors` inside a worklet
  // serializes the whole mutable palette to the UI thread, which then blocks
  // applyTheme() from swapping it — breaking dark/light switching. It only
  // depends on `dragged` (a prop), so apply it in the plain style at render.
  return (
    <Animated.View
      style={[style, { backgroundColor: dragged ? colors.bg1 : "transparent" }]}
      onLayout={onMeasure ? e => onMeasure(e.nativeEvent.layout.height) : undefined}
    >
      {children}
    </Animated.View>
  );
}

function SectionHeader({ group, draggable, onDisconnect, onDragStart, onDragMove, onDragEnd, dragY, lift }: {
  group: CalendarGroup;
  draggable: boolean;
  onDisconnect?: () => void;
  onDragStart: () => void;
  onDragMove: (ty: number) => void;
  onDragEnd: () => void;
  dragY: SharedValue<number>;
  lift: SharedValue<number>;
}) {
  const gesture = useMemo(() => Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(HOLD_MS)
    .onStart(() => {
      dragY.value = 0;
      lift.value = withSpring(LIFT_SCALE, LIFT_SPRING);
      runOnJS(onDragStart)();
    })
    .onUpdate(e => { dragY.value = e.translationY; runOnJS(onDragMove)(e.translationY); })
    .onFinalize(() => {
      lift.value = withSpring(1, LIFT_SPRING);
      runOnJS(onDragEnd)();
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [draggable]);

  return (
    <GestureDetector gesture={gesture}>
      <Tap
        disabled={!onDisconnect}
        onPress={onDisconnect}
        style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.bg1 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {draggable && <Feather name="menu" size={11} color={colors.fg4} />}
          <Text style={{ fontFamily: fonts.sansMedium, fontSize: 11, color: colors.fg3, letterSpacing: 0.5, textTransform: "uppercase" }}>{group.title}</Text>
        </View>
        {onDisconnect ? <Feather name="log-out" size={13} color={colors.fg4} /> : null}
      </Tap>
    </GestureDetector>
  );
}

const RowItem = memo(function RowItem({ cal, meta, draggable, onOpen, onDragStart, onDragMove, onDragEnd, dragY, lift }: {
  cal: Calendar;
  meta: string;
  draggable: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragMove: (ty: number) => void;
  onDragEnd: () => void;
  dragY: SharedValue<number>;
  lift: SharedValue<number>;
}) {
  const gesture = useMemo(() => Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(HOLD_MS)
    .onStart(() => {
      dragY.value = 0;
      lift.value = withSpring(LIFT_SCALE, LIFT_SPRING);
      runOnJS(onDragStart)();
    })
    .onUpdate(e => { dragY.value = e.translationY; runOnJS(onDragMove)(e.translationY); })
    .onFinalize(() => {
      lift.value = withSpring(1, LIFT_SPRING);
      runOnJS(onDragEnd)();
    }),
  // handlers reach current state through parent refs — safe to freeze
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [draggable]);

  return (
    <GestureDetector gesture={gesture}>
      <View>
        <Tap onPress={onOpen}>
          <View style={[styles.container, { overflow: "hidden", flexDirection: "row", justifyContent: "space-between", gap: 18 }]}>
            <View style={styles.calendarCircle}>
              <View style={[styles.calendarCircleInner, { backgroundColor: cal.color }]} />
            </View>
            <View style={{ flex: 1, justifyContent: "center" }}>
              <Text style={{ fontFamily: fonts.sansMedium, color: colors.fg2 }}>{cal.name}</Text>
              <Text style={{ fontFamily: fonts.sans, color: colors.fg3, fontSize: 10 }}>{meta}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ProviderIcon provider={providerFlavor(cal)} />
              <Feather name="chevron-right" size={14} color={colors.fg4} />
            </View>
          </View>
          <View style={{ height: 1, backgroundColor: colors.line }} />
        </Tap>
      </View>
    </GestureDetector>
  );
});
