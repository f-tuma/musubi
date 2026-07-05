import { Image, Text, View } from "react-native";
import { colors, fonts } from "@/constants/theme";

// User avatar: shows the profile image if present, otherwise a circle with the
// first letter of the name.
export function Avatar({ name, image, size = 36 }: { name?: string; image?: string | null; size?: number }) {
  const radius = size / 2;

  if (image) {
    return <Image source={{ uri: image }} style={{ width: size, height: size, borderRadius: radius }} />;
  }

  return (
    <View style={{
      width: size, height: size, borderRadius: radius,
      backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line2,
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{ fontFamily: fonts.sans, fontSize: size * 0.4, color: colors.fg2 }}>
        {(name ?? "?").charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}
