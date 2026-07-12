import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import Animated from "react-native-reanimated";
import { Modal, Pressable, View, Text } from "react-native";
import { useRef } from "react";
import ColorPicker, { HueSlider, Panel1, Preview } from "reanimated-color-picker";
import { Btn } from "@/components/ui/Btn";

type Props = {
  visible: boolean,
  /** Initial color (hex). */
  value: string,
  onConfirm: (hex: string) => void,
  onClose: () => void,
}

/** Custom color picker — opened from the "+" swatch after the preset colors. */
export default function ColorPickerModal({ visible, value, onConfirm, onClose }: Props) {
  const { fadeStyle, handleClose } = useModalAnimation(visible, onClose);
  // Ref, not state — the picker redraws itself while dragging; re-rendering
  // the modal on every completed gesture is wasted work.
  const picked = useRef(value);

  return (
    <Modal
      visible={visible}
      onRequestClose={handleClose}
      animationType="none"
      transparent={true}
      statusBarTranslucent={true}
    >
      <Animated.View style={[styles.modalOverlay, fadeStyle]}>
        <Pressable style={{ flex: 1 }} onPress={handleClose} />
      </Animated.View>
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center" }}
      >
        <Animated.View style={[{ width: "80%", alignSelf: "center" }, fadeStyle]}>
          <View style={{ gap: 16, backgroundColor: colors.bg3, padding: 16, borderRadius: 15 }}>
            <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 18 }}>Custom color</Text>
            <ColorPicker
              value={value}
              style={{ gap: 14 }}
              onCompleteJS={({ hex }) => { picked.current = hex; }}
            >
              <Preview hideInitialColor style={{ borderRadius: 10 }} />
              <Panel1 style={{ borderRadius: 10 }} />
              <HueSlider style={{ borderRadius: 10 }} />
            </ColorPicker>
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Btn label="Cancel" variant="secondary" onPress={handleClose} />
              <Btn label="Confirm" onPress={() => { onConfirm(picked.current); handleClose(); }} />
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
