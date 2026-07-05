import { colors } from "@/constants/theme";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

export function CalendarSkeleton() {
  const pulse = useSharedValue(0.25);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.55, { duration: 850 }),
        withTiming(0.25, { duration: 850 }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={{ flex: 1, padding: 6, gap: 3 }}>
      <Animated.View style={[{ flexDirection: 'row', gap: 3, marginBottom: 4 }, animStyle]}>
        {Array.from({ length: 7 }).map((_, i) => (
          <View key={i} style={{ flex: 1, height: 12, borderRadius: 4, backgroundColor: colors.bg3 }} />
        ))}
      </Animated.View>
      {Array.from({ length: 5 }).map((_, row) => (
        <Animated.View key={row} style={[{ flexDirection: 'row', gap: 3, flex: 1 }, animStyle]}>
          {Array.from({ length: 7 }).map((_, col) => (
            <View key={col} style={{ flex: 1, borderRadius: 6, backgroundColor: colors.bg2 }} />
          ))}
        </Animated.View>
      ))}
    </View>
  );
}
