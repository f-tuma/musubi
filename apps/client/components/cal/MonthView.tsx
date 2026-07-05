import { Event } from "@musubi/types";
import { colors, fonts } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import InfinitePager from "react-native-infinite-pager";
import {
  addMonths, bucketByDay, dayKey, DOW_H, INK, isSameDay, monthGrid, Rect,
} from "./layout";

const MAX_CHIPS = 3;

type Props = {
  base: Date;                       // month shown at page index 0
  events: Event[];                  // expanded + visibility-filtered, sorted by start
  weekStartsOn: 0 | 1;
  eventColorOf: (e: Event) => string;
  onDayPress: (date: Date, rect: Rect) => void;   // rect relative to this view — feeds the day zoom
  onPageChange: (monthStart: Date) => void;
};

export function MonthView({ base, events, weekStartsOn, eventColorOf, onDayPress, onPageChange }: Props) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const byDay = useMemo(() => bucketByDay(events), [events]);
  const today = new Date();

  const dowLabels = useMemo(() => {
    const names = ["S", "M", "T", "W", "T", "F", "S"];
    return Array.from({ length: 7 }, (_, i) => names[(i + weekStartsOn) % 7]);
  }, [weekStartsOn]);

  const cellW = size.w / 7;
  const cellH = (size.h - DOW_H) / 6;

  const renderPage = useCallback(({ index }: { index: number }) => {
    const month = addMonths(base, index);
    const grid = monthGrid(month, weekStartsOn);
    return (
      <View style={{ flex: 1 }}>
        <View style={{ height: DOW_H, flexDirection: "row", alignItems: "center" }}>
          {dowLabels.map((l, i) => (
            <Text key={i} style={{ flex: 1, textAlign: "center", fontFamily: fonts.sans, fontSize: 10, color: colors.fg4, letterSpacing: 1 }}>
              {l}
            </Text>
          ))}
        </View>
        {grid.map((week, r) => (
          <View key={r} style={{ flex: 1, flexDirection: "row" }}>
            {week.map((day, c) => {
              const inMonth = day.getMonth() === month.getMonth();
              const isToday = isSameDay(day, today);
              const dayEvents = byDay.get(dayKey(day)) ?? [];
              const overflow = dayEvents.length - MAX_CHIPS;
              return (
                <Tap
                  key={c}
                  scaleTo={0.96}
                  onPress={() => onDayPress(day, { x: c * cellW, y: DOW_H + r * cellH, w: cellW, h: cellH })}
                  style={{
                    flex: 1, paddingTop: 3, paddingHorizontal: 2,
                    borderTopWidth: 1, borderColor: colors.line,
                    borderRightWidth: c < 6 ? 1 : 0,
                    opacity: inMonth ? 1 : 0.35,
                  }}
                >
                  <View style={{
                    alignSelf: "center", width: 22, height: 22, borderRadius: 11,
                    alignItems: "center", justifyContent: "center", marginBottom: 2,
                    backgroundColor: isToday ? colors.accent : "transparent",
                  }}>
                    <Text style={{
                      fontFamily: fonts.sans, fontSize: 12,
                      color: isToday ? "#f4f1e8" : inMonth ? colors.fg2 : colors.fg4,
                    }}>
                      {day.getDate()}
                    </Text>
                  </View>
                  {dayEvents.slice(0, MAX_CHIPS).map((e, i) => (
                    <View key={e.id + i} style={{
                      backgroundColor: eventColorOf(e), borderRadius: 3,
                      paddingHorizontal: 3, height: 14, justifyContent: "center", marginBottom: 2,
                    }}>
                      <Text numberOfLines={1} style={{ fontFamily: fonts.sans, fontSize: 8.5, color: INK }}>
                        {e.title}
                      </Text>
                    </View>
                  ))}
                  {overflow > 0 && (
                    <Text style={{ fontFamily: fonts.sans, fontSize: 8.5, color: colors.fg3, paddingLeft: 3 }}>
                      +{overflow}
                    </Text>
                  )}
                </Tap>
              );
            })}
          </View>
        ))}
      </View>
    );
  }, [base, byDay, weekStartsOn, dowLabels, cellW, cellH, eventColorOf, onDayPress]);

  return (
    <View style={{ flex: 1 }} onLayout={e => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {size.w > 0 && (
        <InfinitePager
          renderPage={renderPage}
          onPageChange={p => onPageChange(addMonths(base, p))}
          style={{ flex: 1 }}
          pageWrapperStyle={{ flex: 1 }}
        />
      )}
    </View>
  );
}
