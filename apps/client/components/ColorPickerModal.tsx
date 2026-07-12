import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import Animated from "react-native-reanimated";
import { Modal, Pressable, View, Text, TextInput } from "react-native";
import { useEffect, useRef, useState } from "react";
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
  const picked = useRef(value);
  // Two-way sync with the hex field: dragging fills the field, typing a full
  // valid hex drives the picker (via its `value` prop).
  const [hexText, setHexText] = useState(value);
  const [pickerValue, setPickerValue] = useState(value);

  useEffect(() => {
    if (visible) {
      picked.current = value;
      setHexText(value);
      setPickerValue(value);
    }
  }, [visible]);

  const onHexInput = (t: string) => {
    setHexText(t);
    const hex = t.startsWith("#") ? t : `#${t}`;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      picked.current = hex;
      setPickerValue(hex);
    }
  };

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
              value={pickerValue}
              style={{ gap: 14 }}
              onCompleteJS={({ hex }) => { picked.current = hex; setHexText(hex); }}
            >
              <Preview hideInitialColor style={{ borderRadius: 10 }} />
              <Panel1 style={{ borderRadius: 10 }} />
              <HueSlider style={{ borderRadius: 10 }} />
            </ColorPicker>
            <TextInput
              value={hexText}
              onChangeText={onHexInput}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={7}
              placeholder="#RRGGBB"
              placeholderTextColor={colors.fg4}
              style={{
                padding: 12,
                borderWidth: 1,
                borderColor: colors.line3,
                borderRadius: 10,
                backgroundColor: colors.bg2,
                color: colors.fg,
                fontFamily: fonts.sans,
                fontSize: 15,
              }}
            />
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
