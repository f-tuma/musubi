import { colors, fonts } from "@/constants/theme";
import { Text, View } from "react-native";

/**
 * The year with a line above it — a compact, zen "year stamp" shown next to
 * month names (last two digits, ‾26) and as the agenda's sticky year divider
 * (`full`, ‾2026). RN has no `overline` text decoration, so the line is a
 * borderTop.
 */
export function YearStamp({ date, size = 12, full = false }: { date: Date; size?: number; full?: boolean }) {
  return (
    <View style={{ borderTopWidth: 1, borderColor: colors.fg3, paddingTop: 1, alignSelf: "center" }}>
      <Text style={{ fontFamily: fonts.serif, fontSize: size, color: colors.fg3, letterSpacing: 1 }}>
        {full ? String(date.getFullYear()) : String(date.getFullYear()).slice(-2)}
      </Text>
    </View>
  );
}
