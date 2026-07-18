import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Pressable, Text, View, ScrollView } from "react-native";
import { ModalPortal as Modal } from "@/components/ui/ModalPortal";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar, can } from "@musubi/types";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useState } from "react";
import { Tap } from "@/components/ui/Tap";

type Props = {
  title: string,
  visible: boolean,
  onClose: () => void,
  onSelect: (calendarID: string) => Promise<void>,
  filter?: (cal: Calendar) => boolean, // extra filter on top of "can edit"
  emptyLabel?: string,
};

export default function CalendarPickerModal({ title, visible, onClose, onSelect, filter, emptyLabel }: Props) {
  const { calendars } = useCalendarsStore();
  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);
  const [pending, setPending] = useState<string | null>(null);

  const options = calendars.filter(c => can(c.role, "editEvents") && (!filter || filter(c)));

  return (
    <Modal
      visible={visible}
      onRequestClose={handleClose}
      animationType="none"
      transparent={true}
      statusBarTranslucent={true}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[styles.modalOverlay, fadeStyle]}>
          <Pressable style={{ flex: 1 }} onPress={handleClose} accessible={false} />
        </Animated.View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalTitleRow}>
              <Text style={styles.modalTitle}>{title}</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 4 }} showsVerticalScrollIndicator={false}>
              {options.length === 0 ? (
                <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>
                  {emptyLabel ?? "No calendars available."}
                </Text>
              ) : options.map((c) => (
                <Tap
                  key={c.id}
                  haptic="select"
                  scaleTo={0.99}
                  disabled={pending === c.id}
                  accessibilityLabel={`${c.name} calendar`}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, opacity: pending === c.id ? 0.4 : 1 }}
                  onPress={async () => {
                    setPending(c.id);
                    try { await onSelect(c.id); handleClose(); }
                    finally { setPending(null); }
                  }}
                >
                  <View style={[styles.colorDot, { backgroundColor: c.color }]} />
                  <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.fg }}>{c.name}</Text>
                </Tap>
              ))}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
