import { useEffect } from "react";
import { Dimensions, Keyboard, Platform } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

// Sheet physics: critically-damped spring so the sheet settles like paper,
// not a linear slide. One spec shared by enter, release and dismiss.
const SPRING = { damping: 32, stiffness: 300, mass: 0.8 };
const DISMISS_DISTANCE = 100;

export function useModalAnimation(visible: boolean, onClose: () => void) {
  const offScreen = Dimensions.get("screen").height / 5;
  const slideAnim = useSharedValue(offScreen);
  const fadeAnim = useSharedValue(0);
  // The sheet must ride the keyboard manually on both platforms: edge-to-edge
  // Android has no system adjustResize, and reanimated's useAnimatedKeyboard
  // doesn't see the keyboard inside a native <Modal> window on Android — so we
  // feed a shared value from RN's Keyboard events instead (those DO fire there).
  const keyboardHeight = useSharedValue(0);
  useEffect(() => {
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvt, (e) => {
      keyboardHeight.value = withTiming(e.endCoordinates.height, { duration: 220 });
    });
    const hide = Keyboard.addListener(hideEvt, () => {
      keyboardHeight.value = withTiming(0, { duration: 180 });
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  const gesture = Gesture.Pan()
    .onChange((ev) => {
      // Down follows the finger; up rubber-bands (sheet resists, doesn't fly).
      slideAnim.value = ev.translationY > 0
        ? ev.translationY
        : ev.translationY / 12;
    })
    .onEnd((ev) => {
      if (ev.translationY > DISMISS_DISTANCE || ev.velocityY > 900) {
        fadeAnim.value = withTiming(0, { duration: 180 });
        slideAnim.value = withSpring(offScreen, { ...SPRING, velocity: ev.velocityY });
        scheduleOnRN(deferredClose);
      } else {
        slideAnim.value = withSpring(0, { ...SPRING, velocity: ev.velocityY });
      }
    });

  // Close on a plain timer, NOT the animation callback — an interrupted
  // animation can drop its callback, leaving an invisible "ghost" modal
  // that blocks all touches.
  function deferredClose() {
    setTimeout(onClose, 190);
  }

  async function handleClose() {
    slideAnim.value = withSpring(offScreen, SPRING);
    fadeAnim.value = withTiming(0, { duration: 180 });
    deferredClose();
  }

  useEffect(() => {
    if (visible) {
      slideAnim.value = withSpring(0, SPRING);
      fadeAnim.value = withTiming(1, { duration: 200 });
    }
  }, [visible]);

  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: slideAnim.value - keyboardHeight.value }],
  }));

  const fadeStyle = useAnimatedStyle(() => ({
    opacity: fadeAnim.value,
  }));

  return { slideStyle, fadeStyle, gesture, handleClose };
}
