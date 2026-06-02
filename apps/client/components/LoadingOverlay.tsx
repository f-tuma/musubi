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
      style={[StyleSheet.absoluteFill, styles.container, animStyle]}
    >
      <Text style={styles.wordmark}>Musubi</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    zIndex: 999,
    justifyContent: "center",
    alignItems: "center",
  },
  wordmark: {
    fontFamily: fonts.serif,
    fontSize: 42,
    color: colors.fg,
    letterSpacing: 1,
  },
});
