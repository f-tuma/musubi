import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { create } from "zustand";
import { colors, fonts } from "@/constants/theme";
import { Tap } from "@/components/ui/Tap";

// A single bottom toast — transient message with an optional action (e.g. Undo).
// Imperative API so any code can raise one: `showToast({ message, actionLabel, onAction })`.
type Toast = { id: number; message: string; actionLabel?: string; onAction?: () => void };

let nextId = 0;
type ToastState = {
  toast: Toast | null;
  show: (t: Omit<Toast, "id">) => void;
  hide: () => void;
};
const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (t) => set({ toast: { ...t, id: ++nextId } }),
  hide: () => set({ toast: null }),
}));

/** Raise a toast from anywhere (outside React too). */
export const showToast = (t: Omit<Toast, "id">) => useToastStore.getState().show(t);

const VISIBLE_MS = 4200;  // auto-dismiss after this
const REVEAL_MS = 260;    // ease-in-out fade + small rise, both directions
const TRAVEL = 14;        // it only nudges up a little; the fade does the reveal
const TAB_BAR_H = 70;     // (tabs)/_layout tabBarStyle.height — rest just above it

// Mounted once at the app root; renders whatever toast is currently in the store.
export function ToastHost() {
  const toast = useToastStore((s) => s.toast);
  const hide = useToastStore((s) => s.hide);
  const insets = useSafeAreaInsets();
  const ty = useSharedValue(TRAVEL);
  const op = useSharedValue(0);
  const reveal = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }], opacity: op.value }));

  const dismiss = () => {
    op.value = withTiming(0, { duration: REVEAL_MS, easing: Easing.inOut(Easing.ease) });
    ty.value = withTiming(TRAVEL, { duration: REVEAL_MS, easing: Easing.inOut(Easing.ease) }, (done) => {
      if (done) runOnJS(hide)();
    });
  };

  // Fade + small rise on each new toast, then arm the auto-dismiss timer.
  useEffect(() => {
    if (!toast) return;
    op.value = withTiming(1, { duration: REVEAL_MS, easing: Easing.inOut(Easing.ease) });
    ty.value = withTiming(0, { duration: REVEAL_MS, easing: Easing.inOut(Easing.ease) });
    const t = setTimeout(dismiss, VISIBLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id]);

  if (!toast) return null;

  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + TAB_BAR_H + 12, alignItems: "center", paddingHorizontal: 16 }}>
      <Animated.View style={[{
        flexDirection: "row", alignItems: "center", gap: 14,
        maxWidth: 460, paddingLeft: 18, paddingRight: 8, paddingVertical: 8,
        backgroundColor: colors.fg, borderRadius: 999, borderCurve: "continuous",
        shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
      }, reveal]}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.sans, fontSize: 13, color: colors.bg }}>
          {toast.message}
        </Text>
        {toast.actionLabel && (
          <Tap
            haptic="tap"
            onPress={() => { toast.onAction?.(); dismiss(); }}
            style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.accent }}
          >
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: "#f4f1e8" }}>{toast.actionLabel}</Text>
          </Tap>
        )}
      </Animated.View>
    </View>
  );
}
