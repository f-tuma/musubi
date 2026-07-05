import { MONTH_KANJI } from "@/constants/const";
import { colors, fonts, styles } from "@/constants/theme";
import { useSettingsStore } from "@/store/useSettingsStore";
import { ActivityIndicator, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Tap } from "@/components/ui/Tap";
import { ModeSwitch } from "@/components/cal/ModeSwitch";
import { Mode } from "@musubi/calendar";


type Props = {
  anchorDate: Date;
  calMode: Mode;
  onModeChange: (mode: Mode) => void;
  onTodayPress: () => void;
  onRefresh: () => void;
  refreshing: boolean;
};

export function CalendarHeader({ anchorDate, calMode, onModeChange, onTodayPress, onRefresh, refreshing }: Props) {
  const { showKanji } = useSettingsStore();

  return (
    // zIndex lifts the mode dropdown above the filter bar / calendar body below
    <View style={[styles.header, { zIndex: 30 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <ModeSwitch
          mode={calMode}
          onChange={onModeChange}
          trigger={(open) => (
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
                {anchorDate.toLocaleString("en-UK", { month: "long" })}
              </Text>
              {showKanji &&
                <Text style={{ fontFamily: fonts.kanji, fontSize: 14, color: colors.fg3 }}>
                  {MONTH_KANJI[anchorDate.getMonth()]}
                </Text>
              }
              <Feather name={open ? "chevron-up" : "chevron-down"} size={15} color={colors.fg3} />
            </View>
          )}
        />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
          <Tap onPress={onTodayPress} hitSlop={8}>
            <Text style={{ color: colors.fg3, fontSize: 12, letterSpacing: 1.5 }}>TODAY</Text>
          </Tap>
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.fg3} />
          ) : (
            <Tap onPress={onRefresh} hitSlop={10}>
              <Feather name="refresh-cw" size={16} color={colors.fg3} />
            </Tap>
          )}
        </View>
      </View>
    </View>
  );
}
