import { useEffect, type ReactNode } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { Portal } from "./Portal";

type Props = {
  visible: boolean;
  onRequestClose?: () => void;
  // Accepted for drop-in parity with RN <Modal>, but irrelevant to an in-tree
  // overlay (there's no native window to make transparent / animate / extend).
  transparent?: boolean;
  animationType?: "none" | "slide" | "fade";
  statusBarTranslucent?: boolean;
  children?: ReactNode;
};

// Drop-in for RN <Modal> that renders into the root Portal host instead of a
// native window, so a modal can be opened from inside another modal without the
// iOS modal-in-modal bug (inner one invisible + eats all touches). Convert a
// screen by swapping `import { Modal } from "react-native"` for
// `import { ModalPortal as Modal } from "@/components/ui/ModalPortal"`.
export function ModalPortal({ visible, onRequestClose, children }: Props) {
  // RN <Modal> consumes the Android hardware back for free; replicate it.
  // BackHandler fires listeners most-recent-first and stops at the first that
  // returns true, so the top-most (last-mounted) modal closes first.
  useEffect(() => {
    if (!visible || !onRequestClose) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onRequestClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onRequestClose]);

  if (!visible) return null;
  return (
    <Portal>
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {children}
      </View>
    </Portal>
  );
}
