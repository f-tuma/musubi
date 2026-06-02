import { MONTH_KANJI } from "@/constants/const";
import { colors, fonts, styles } from "@/constants/theme";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Pressable, Text, View } from "react-native";
import { Mode } from "@musubi/calendar";


type Props = {
  anchorDate: Date;
  calMode: Mode;
  onModeChange: (mode: Mode) => void;
  onTodayPress: () => void;
};

export function CalendarHeader({ anchorDate, calMode, onModeChange, onTodayPress }: Props) {
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
          <Pressable onPress={onTodayPress}>
            <Text style={{ color: colors.fg3, fontSize: 12, letterSpacing: 1.5 }}>TODAY</Text>
          </Pressable>
        </View>
      </View>
      <View style={{
        flexDirection: 'row', marginTop: 12, alignSelf: 'flex-start',
        borderWidth: 1, borderColor: colors.line2, borderRadius: 999, padding: 2, gap: 2
      }}>
        {(["day", "week", "month"] as Mode[]).map((m) => (
          <Pressable
            key={m}
            style={{
              paddingHorizontal: 14, paddingVertical: 5, borderRadius: 999,
              backgroundColor: calMode === m ? colors.fg : 'transparent'
            }}
            onPress={() => onModeChange(m)}
          >
            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: calMode === m ? colors.bg : colors.fg2 }}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
