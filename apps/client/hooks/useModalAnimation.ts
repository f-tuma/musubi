import { useEffect } from "react";
import { Dimensions, Platform } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { useAnimatedKeyboard, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { tap } from "@/lib/haptics";

const isIOS = Platform.OS === 'ios';

// Sheet physics: critically-damped spring so the sheet settles like paper,
// not a linear slide. One spec shared by enter, release and dismiss.
const SPRING = { damping: 28, stiffness: 300, mass: 0.8 };
const DISMISS_DISTANCE = 100;

export function useModalAnimation(visible: boolean, onClose: () => void) {
  const offScreen = Dimensions.get("screen").height / 5;
  const slideAnim = useSharedValue(offScreen);
  const fadeAnim = useSharedValue(0);
  const crossedDismiss = useSharedValue(0); // haptic tick when crossing the threshold
  const keyboard = useAnimatedKeyboard();

  const gesture = Gesture.Pan()
    .onChange((ev) => {
      // Down follows the finger; up rubber-bands (sheet resists, doesn't fly).
      slideAnim.value = ev.translationY > 0
        ? ev.translationY
        : ev.translationY / 12;

      const past = ev.translationY > DISMISS_DISTANCE ? 1 : 0;
      if (past !== crossedDismiss.value) {
        crossedDismiss.value = past;
        scheduleOnRN(tap); // tell the finger it crossed the release point
      }
    })
    .onEnd((ev) => {
      if (ev.translationY > DISMISS_DISTANCE || ev.velocityY > 900) {
        fadeAnim.value = withTiming(0, { duration: 180 }, () => scheduleOnRN(onClose));
        slideAnim.value = withSpring(offScreen, { ...SPRING, velocity: ev.velocityY });
      } else {
        slideAnim.value = withSpring(0, { ...SPRING, velocity: ev.velocityY });
      }
    });

  async function handleClose() {
    slideAnim.value = withSpring(offScreen, SPRING);
    fadeAnim.value = withTiming(0, { duration: 180 }, () => scheduleOnRN(onClose));
  }

  useEffect(() => {
    if (visible) {
      slideAnim.value = withSpring(0, SPRING);
      fadeAnim.value = withTiming(1, { duration: 200 });
    }
  }, [visible]);

  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: slideAnim.value - (isIOS ? keyboard.height.value : 0) }],
  }));

  const fadeStyle = useAnimatedStyle(() => ({
    opacity: fadeAnim.value,
  }));

  return { slideStyle, fadeStyle, gesture, handleClose };
}
