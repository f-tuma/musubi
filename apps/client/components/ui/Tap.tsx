import { forwardRef } from "react";
import { Pressable, PressableProps, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import * as haptics from "@/lib/haptics";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = PressableProps & {
  /** Play a haptic on press-in. Default OFF — haptics are reserved for
   *  important actions (primary/destructive buttons, FABs), not every row. */
  haptic?: keyof typeof haptics | false;
  /** Press-in scale. 0.97 for buttons/pills, 1 to keep only the dim. */
  scaleTo?: number;
};

// Drop-in Pressable with the app-wide press feel: quick dim + subtle spring
// scale on press-in, springs back on release. Replaces bare <Pressable> so
// every touch in the app answers the finger the same way.
export const Tap = forwardRef<View, Props>(function Tap(
  { haptic = false, scaleTo = 0.97, onPressIn, onPressOut, style, disabled, ...rest }, ref,
) {
  const pressed = useSharedValue(0);

  const feedback = useAnimatedStyle(() => ({
    opacity: withTiming(pressed.value ? 0.65 : 1, { duration: pressed.value ? 40 : 160 }),
    transform: [{ scale: withSpring(pressed.value ? scaleTo : 1, { damping: 34, stiffness: 500 }) }],
  }));

  return (
    <AnimatedPressable
      ref={ref}
      // Press feedback waits a beat, so a scroll passing over the element
      // cancels the press before the dim/scale ever shows (native-ripple feel).
      unstable_pressDelay={90}
      disabled={disabled}
      style={[style as any, feedback]}
      onPressIn={(e) => {
        pressed.value = 1;
        if (haptic) haptics[haptic]();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.value = 0;
        onPressOut?.(e);
      }}
      {...rest}
    />
  );
});
