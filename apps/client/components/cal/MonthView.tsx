import { Event } from "@musubi/types";
import { colors, fonts } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";
import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import InfinitePager from "react-native-infinite-pager";
import {
  addMonths, allDaySpans, bucketByDay, dayKey, DOW_H, INK, isSameDay, monthGrid, Rect,
} from "./layout";

const MONTH_LANES = 2;     // at most this many spanning all-day lanes per week row
const BAR_H = 16;          // lane height of a spanning bar
const DAYNUM_H = 27;       // day-number area at the top of a cell
const OVERFLOW_H = 12;     // the "+N" line at the bottom of a cell
const MIN_ROWS = 2;        // never fewer event rows than this, even on tiny cells

type Props = {
  base: Date;                       // month shown at page index 0
  events: Event[];                  // expanded + visibility-filtered, sorted by start
  weekStartsOn: 0 | 1;
  eventColorOf: (e: Event) => string;
  onDayPress: (date: Date, rect: Rect) => void;   // rect relative to this view — feeds the day zoom
  onPageChange: (monthStart: Date) => void;
};

export const MonthView = memo(function MonthView({ base, events, weekStartsOn, eventColorOf, onDayPress, onPageChange }: Props) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const byDay = useMemo(() => bucketByDay(events), [events]);
  const today = new Date();

  const dowLabels = useMemo(() => {
    const names = ["S", "M", "T", "W", "T", "F", "S"];
    return Array.from({ length: 7 }, (_, i) => names[(i + weekStartsOn) % 7]);
  }, [weekStartsOn]);

  const cellW = size.w / 7;
  const cellH = (size.h - DOW_H) / 6;
  // Event rows per cell FIT to the real cell height (device-dependent) instead
  // of a fixed count — tall screens show 4-5 rows, small ones fall back to fewer.
  const rowsPerCell = Math.max(MIN_ROWS, Math.floor((cellH - DAYNUM_H - OVERFLOW_H) / BAR_H));

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
        {grid.map((week, r) => {
          // all-day events run as continuous bars across the row; timed events
          // stay as per-cell chips below them
          const spans = allDaySpans(events, week);
          const bars = spans.filter(sp => sp.lane < MONTH_LANES);
          // Chips shift down PER DAY, by the lanes actually covering that day —
          // a row-wide count stole chip rows from days no bar passes over.
          // (Highest covering lane wins: a day under only a lane-1 bar still
          // offsets past lane 0, because bars sit at fixed lane positions.)
          const lanesOn = (col: number) =>
            Math.max(0, ...bars.filter(sp => sp.startCol <= col && col <= sp.endCol).map(sp => sp.lane + 1));
          const hiddenOn = (col: number) =>
            spans.filter(sp => sp.lane >= MONTH_LANES && sp.startCol <= col && col <= sp.endCol).length;
          return (
            <View key={r} style={{ flex: 1, flexDirection: "row" }}>
              {week.map((day, c) => {
                const inMonth = day.getMonth() === month.getMonth();
                const isToday = isSameDay(day, today);
                const dayLanes = lanesOn(c);
                const chipRows = rowsPerCell - dayLanes;
                const timed = (byDay.get(dayKey(day)) ?? []).filter(e => !e.isAllDay);
                const overflow = timed.length - chipRows + hiddenOn(c);
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
                    {dayLanes > 0 && <View style={{ height: dayLanes * BAR_H }} />}
                    {timed.slice(0, Math.max(chipRows, 0)).map((e, i) => (
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
              {/* spanning bars — purely visual, taps fall through to the day cells */}
              <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
                {bars.map(sp => (
                  <View key={sp.event.id} style={{
                    position: "absolute",
                    // match the chips' horizontal inset (cell paddingHorizontal 2)
                    // so a single-day bar is exactly as wide as a chip below it
                    left: sp.startCol * cellW + 2,
                    width: (sp.endCol - sp.startCol + 1) * cellW - 4,
                    top: DAYNUM_H + sp.lane * BAR_H,
                    height: BAR_H - 2,
                    backgroundColor: eventColorOf(sp.event),
                    borderRadius: 3, paddingHorizontal: 3, justifyContent: "center",
                  }}>
                    <Text numberOfLines={1} style={{ fontFamily: fonts.sans, fontSize: 8.5, color: INK }}>
                      {sp.event.title}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          );
        })}
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
});
