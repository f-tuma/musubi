import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import Animated from "react-native-reanimated";
import { Pressable, View, Text, TextInput, StyleSheet } from "react-native";
import { useEffect, useRef, useState } from "react";
import ColorPicker, { HueSlider, Panel1, Preview } from "reanimated-color-picker";
import { Btn } from "@/components/ui/Btn";

// Dark text on light colors, light text on dark ones (perceived luminance).
const isLight = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 150;
};

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
  const inputRef = useRef<TextInput>(null);
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

  // In-tree absolute overlay, NOT a RN <Modal>: this is opened from *inside*
  // other modals (CreateCalendarModal) and modal-in-modal is broken on iOS (the
  // inner one doesn't show and its transparent layer eats all touches). Works
  // the same over a plain screen (onboarding). visible stays true through the
  // exit fade (useModalAnimation delays onClose), so the fade-out still plays.
  if (!visible) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 1000 }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.modalOverlay, fadeStyle]}>
        <Pressable style={{ flex: 1 }} onPress={handleClose} />
      </Animated.View>
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center" }}
      >
        <Animated.View style={[{ width: "80%", alignSelf: "center" }, fadeStyle]}>
          {/* Pressable so a tap anywhere outside the hex field drops its caret/keyboard. */}
          <Pressable
            style={{ gap: 16, backgroundColor: colors.bg3, padding: 16, borderRadius: 15 }}
            onPress={() => inputRef.current?.blur()}
          >
            <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 18 }}>Custom color</Text>
            <ColorPicker
              value={pickerValue}
              style={{ gap: 14 }}
              onCompleteJS={({ hex }) => { picked.current = hex; setHexText(hex); inputRef.current?.blur(); }}
            >
              {/* The preview pill doubles as the hex field: Preview paints the
                  live color, the transparent input on top edits the code. */}
              <View>
                <Preview hideInitialColor hideText style={{ borderRadius: 10, height: 44 }} />
                <TextInput
                  ref={inputRef}
                  value={hexText}
                  onChangeText={onHexInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={7}
                  style={{
                    position: "absolute", top: 0, bottom: 0, left: 0, right: 0,
                    textAlign: "center",
                    color: isLight(picked.current) ? "#1a1a1a" : "#f2f2f2",
                    fontFamily: fonts.sans,
                    fontSize: 15,
                  }}
                />
              </View>
              <Panel1 style={{ borderRadius: 10 }} />
              <HueSlider style={{ borderRadius: 10 }} />
            </ColorPicker>
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Btn label="Cancel" variant="secondary" onPress={handleClose} />
              <Btn label="Confirm" onPress={() => { onConfirm(picked.current); handleClose(); }} />
            </View>
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}
