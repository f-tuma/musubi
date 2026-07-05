import { Text, View } from "react-native";
import { colors, fonts } from "@/constants/theme";

// Zen empty state: a single kanji, breathing room, one quiet line.
export function Empty({ kanji = "空", text }: { kanji?: string; text: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 48, gap: 12 }}>
      <Text style={{ fontFamily: fonts.kanji, fontSize: 44, color: colors.fg4 }}>{kanji}</Text>
      <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>{text}</Text>
    </View>
  );
}
