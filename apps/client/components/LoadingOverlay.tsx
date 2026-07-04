import { colors, fonts } from "@/constants/theme";
import { useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

type Props = { ready: boolean };

export function LoadingOverlay({ ready }: Props) {
  const opacity = useSharedValue(1);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    if (ready) {
      // Slight delay so the calendar grid has a frame to paint before we reveal it
      opacity.value = withTiming(0, { duration: 500 }, () => {
        runOnJS(setMounted)(false);
      });
    }
  }, [ready]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (!mounted) return null;

  return (
    <Animated.View
      pointerEvents={ready ? "none" : "box-only"}
      style={[StyleSheet.absoluteFill, styles.container, { backgroundColor: colors.bg }, animStyle]}
    >
      <Text style={[styles.wordmark, { color: colors.fg }]}>Musubi</Text>
    </Animated.View>
  );
}

// Colors applied inline — the theme can swap at runtime.
const styles = StyleSheet.create({
  container: {
    zIndex: 999,
    justifyContent: "center",
    alignItems: "center",
  },
  wordmark: {
    fontFamily: fonts.serif,
    fontSize: 42,
    letterSpacing: 1,
  },
});
