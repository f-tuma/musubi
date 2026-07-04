import { MONTH_KANJI } from "@/constants/const";
import { colors, fonts, styles } from "@/constants/theme";
import { useSettingsStore } from "@/store/useSettingsStore";
import { ActivityIndicator, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Tap } from "@/components/ui/Tap";
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
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
          <Text style={{ fontFamily: fonts.serif, fontSize: 26, color: colors.fg }}>
            {anchorDate.toLocaleString("en-UK", { month: "long" })}
          </Text>
          {showKanji &&
            <Text style={{ fontFamily: fonts.kanji, fontSize: 14, color: colors.fg3 }}>
              {MONTH_KANJI[anchorDate.getMonth()]}
            </Text>
          }
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Tap onPress={onTodayPress}>
            <Text style={{ color: colors.fg3, fontSize: 12, letterSpacing: 1.5 }}>TODAY</Text>
          </Tap>
        </View>
      </View>
      <View style={{ flexDirection: 'row', marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{
          flexDirection: 'row',
          borderWidth: 1, borderColor: colors.line2, borderRadius: 999, padding: 2, gap: 2
        }}>
          {(["day", "week", "month"] as Mode[]).map((m) => (
            <Tap
              key={m}
              haptic="select"
              style={{
                paddingHorizontal: 14, paddingVertical: 5, borderRadius: 999,
                backgroundColor: calMode === m ? colors.fg : 'transparent'
              }}
              onPress={() => onModeChange(m)}
            >
              <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: calMode === m ? colors.bg : colors.fg2 }}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </Text>
            </Tap>
          ))}
        </View>
        {refreshing ? (
          <ActivityIndicator size="small" color={colors.fg3} />
        ) : (
          <Tap onPress={onRefresh} hitSlop={10}>
            <Feather name="refresh-cw" size={16} color={colors.fg3} />
          </Tap>
        )}
      </View>
    </View>
  );
}
