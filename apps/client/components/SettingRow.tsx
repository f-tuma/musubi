import { colors, fonts } from "@/constants/theme";
import { Switch, View, Text } from "react-native";
import { Mode } from "@musubi/calendar";
import { Tap } from "@/components/ui/Tap";


type ToggleProps = {
  label: string;
  toggle: boolean;
  onToggle: () => void;
  danger?: boolean;
}

type OptionsProps = {
  label: string;
  value: string;
  options: string[];
  onChange: (value: Mode) => void;
}

// Border color applied inline at usage — the theme can swap at runtime.
const rowStyle = {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  paddingHorizontal: 16,
  paddingVertical: 8,
  borderBottomWidth: 1,
  minHeight: 62,
} as const;

export function SettingRowToggle({ label, toggle, onToggle }: ToggleProps) {
  return (
    <Tap onPress={onToggle} scaleTo={1} style={[rowStyle, { borderColor: colors.line }]}>
      <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg2 }}>
        {label}
      </Text>
      <Switch
        thumbColor={toggle ? colors.accent : colors.bg3}
        trackColor={{
          false: colors.line,
          true: colors.line3,
        }}
        onValueChange={onToggle}
        value={toggle}
      />
    </Tap>
  );
}

// Few options → pick in one tap: inline segmented pills, same visual language
// as the member-role selector.
export function SettingRowOptions({ label, value, options, onChange }: OptionsProps) {
  return (
    <View style={[rowStyle, { borderColor: colors.line }]}>
      <Text style={{ fontFamily: fonts.sans, fontSize: 15, color: colors.fg2 }}>
        {label}
      </Text>
      <View style={{
        flexDirection: "row",
        borderWidth: 1, borderColor: colors.line2, borderRadius: 999, padding: 2, gap: 2,
      }}>
        {options.map((o) => {
          const active = o === value;
          return (
            <Tap
              key={o}
              haptic="select"
              disabled={active}
              onPress={() => onChange(o as Mode)}
              style={{
                paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
                backgroundColor: active ? colors.fill : "transparent",
              }}
            >
              <Text style={{
                fontFamily: fonts.sans, fontSize: 11,
                color: active ? colors.onFill : colors.fg2,
              }}>
                {o[0].toUpperCase() + o.slice(1)}
              </Text>
            </Tap>
          );
        })}
      </View>
    </View>
  );
}
