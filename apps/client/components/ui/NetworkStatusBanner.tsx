import { Feather } from "@expo/vector-icons";
import * as Network from "expo-network";
import { Text, View } from "react-native";
import { colors, fonts } from "@/constants/theme";

/** Persistent, app-wide feedback. Cached data remains usable underneath it. */
export function NetworkStatusBanner() {
  const state = Network.useNetworkState();
  const offline = state.isConnected === false || state.isInternetReachable === false;

  if (!offline) return null;

  return (
    <View
      accessibilityRole="alert"
      style={{
        minHeight: 32,
        paddingHorizontal: 16,
        paddingVertical: 7,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        backgroundColor: colors.accent,
      }}
    >
      <Feather name="wifi-off" size={13} color="#f4f1e8" />
      <Text style={{ color: "#f4f1e8", fontFamily: fonts.sansMedium, fontSize: 12 }}>
        Offline — cached calendars are still available
      </Text>
    </View>
  );
}
