import { MONTH_KANJI } from "@/constants/const";
import { colors, fonts, styles } from "@/constants/theme";
import { useSettingsStore } from "@/store/useSettingsStore";
import { ActivityIndicator, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Tap } from "@/components/ui/Tap";
import { ModeSwitch } from "@/components/cal/ModeSwitch";
import { YearStamp } from "@/components/calendar/YearStamp";
import { Mode } from "@musubi/calendar";
import Animated, { interpolate, SharedValue, useAnimatedStyle } from "react-native-reanimated";

const CALENDAR_HEADER_HEIGHT = 68;
const BACK_BUTTON_SHIFT = 86;

type Props = {
  anchorDate: Date;
  calMode: Mode;
  onModeChange: (mode: Mode) => void;
  onBackToMonth?: () => void;
  drillSourceDate?: Date;
  drillProgress: SharedValue<number>;
  onTodayPress: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
};

export function CalendarHeader({
  anchorDate, calMode, onModeChange, onBackToMonth, drillSourceDate, drillProgress,
  onTodayPress, onRefresh, refreshing,
}: Props) {
  const { showKanji } = useSettingsStore();
  const drillRequested = !!onBackToMonth;
  // While drilled, the title continues to describe the month underneath. Only
  // its position changes; no header subtree or text content is swapped.
  const displayedDate = drillRequested ? (drillSourceDate ?? anchorDate) : anchorDate;
  const backStyle = useAnimatedStyle(() => ({
    opacity: drillProgress.value,
    transform: [{ translateX: interpolate(drillProgress.value, [0, 1], [-BACK_BUTTON_SHIFT, 0]) }],
  }));
  const titleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(drillProgress.value, [0, 1], [0, BACK_BUTTON_SHIFT]) }],
  }));

  return (
    // zIndex lifts the mode dropdown above the filter bar / calendar body below
    <View style={[styles.header, { zIndex: 30, height: CALENDAR_HEADER_HEIGHT }]}>
      <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, height: 36, justifyContent: 'center', overflow: 'hidden' }}>
          <Animated.View
            pointerEvents={onBackToMonth ? "auto" : "none"}
            style={[{
              position: 'absolute', left: 0, zIndex: 2,
              flexDirection: 'row', alignItems: 'center',
            }, backStyle]}
          >
            <Tap
              onPress={onBackToMonth}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Back to month"
              style={{ flexDirection: 'row', alignItems: 'center', marginLeft: -7, paddingVertical: 4, paddingRight: 4 }}
            >
              <Feather name="chevron-left" size={22} color={colors.accent} />
              <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.accent }}>
                Month
              </Text>
            </Tap>
            <View style={{ width: 1, height: 20, backgroundColor: colors.line2 }} />
          </Animated.View>

          <Animated.View style={[{ alignSelf: 'flex-start', maxWidth: '100%' }, titleStyle]}>
            <ModeSwitch
              mode={calMode}
              onChange={onModeChange}
              trigger={(open) => (
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                  <YearStamp date={displayedDate} size={22} />
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.serif, fontSize: 22, color: colors.fg }}>
                    {displayedDate.toLocaleString("en-UK", { month: "long" })}
                  </Text>
                  {showKanji ? (
                    <Text style={{ fontFamily: fonts.kanji, fontSize: 12, color: colors.fg3 }}>
                      {MONTH_KANJI[displayedDate.getMonth()]}
                    </Text>
                  ) : null}
                  <Feather name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.fg3} />
                </View>
              )}
            />
          </Animated.View>
        </View>

        <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 18 }}>
          <Tap onPress={onTodayPress} hitSlop={8}>
            <Text style={{ color: colors.fg3, fontSize: 12, letterSpacing: 1.5 }}>TODAY</Text>
          </Tap>
          {onRefresh ? (
            refreshing ? (
              <ActivityIndicator size="small" color={colors.fg3} />
            ) : (
              <Tap onPress={onRefresh} hitSlop={10}>
                <Feather name="refresh-cw" size={16} color={colors.fg3} />
              </Tap>
            )
          ) : null}
        </View>
      </View>
    </View>
  );
}
