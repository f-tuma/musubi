import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import Animated from "react-native-reanimated";
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View, Text } from "react-native";
import { useState } from "react";
import { Btn } from "@/components/ui/Btn";
import * as haptics from "@/lib/haptics";


type Props = {
  visible: boolean,
  isDelete?: boolean,
  title: string,
  placeholder: string,
  onConfirm: (value: string) => void,
  onClose: () => void,
  onTest?: (value: string) => Promise<{ ok: boolean, error: string }>,
}


export default function InputModal({ visible, isDelete, title, placeholder, onConfirm, onClose, onTest }: Props) {
  const { fadeStyle, handleClose } = useModalAnimation(visible, onClose);
  const [inputValue, setInputValue] = useState("");
  const [valueError, setValueError] = useState("");
  const [isWaiting, setIsWaiting] = useState(false);

  const handleConfirm = async (value: string) => {
    setIsWaiting(true);
    if (onTest) {
      const { ok, error } = await onTest(value);
      if (!ok) {
        haptics.warn();
        setValueError(error ?? "Uknown error...");
        setIsWaiting(false);
        return;
      }
    }
    onConfirm(value);
    handleClose();
    setIsWaiting(false);
  };

  const handleCancel = async () => {
    handleClose();
    setInputValue("");
    setValueError("");
    setIsWaiting(false);
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
        <Pressable style={{ flex: 1 }} />
      </Animated.View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center" }}
      >
      <Animated.View
        style={[{
          width: "80%",
          minHeight: "10%",
          alignSelf: "center",
          justifyContent: "center",
        }, fadeStyle]}
      >
        <View
          style={{
            gap: 16,
            backgroundColor: colors.bg3,
            padding: 16,
            borderRadius: 15,
          }}
        >
          <Text style={{ color: colors.fg, fontFamily: fonts.serif, fontSize: 18 }}>{title}</Text>
          <TextInput
            style={{
              width: "100%",
              padding: 12,
              borderWidth: 1,
              borderColor: colors.line3,
              borderRadius: 10,
              backgroundColor: colors.bg2,
              color: colors.fg,
              fontFamily: fonts.sans,
              fontSize: 15,
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.fg4}
            onChangeText={(t) => setInputValue(t)}
          />
          {valueError ? <Text style={[styles.errorText, { alignSelf: "center" }]}>{valueError}</Text> : null}
          <View style={{
            flexDirection: "row",
            gap: 16,
          }}
          >
            <Btn label="Cancel" variant="secondary" onPress={handleCancel} />
            <Btn
              label={isDelete ? "Delete" : "Confirm"}
              variant={isDelete ? "destructive" : "primary"}
              loading={isWaiting}
              onPress={() => handleConfirm(inputValue)}
            />
          </View>
        </View>
      </Animated.View>
      </KeyboardAvoidingView>
    </Modal >
  );
}
