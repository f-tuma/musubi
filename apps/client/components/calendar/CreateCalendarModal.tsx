import { appColors } from "@/constants/colors";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar } from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useEffect, useState } from "react";
import { Text, Modal, Pressable, ScrollView, View, TextInput, Alert } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated from "react-native-reanimated";
import { CALENDAR_HINTS } from "@/constants/calendar_hints";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import * as haptics from "@/lib/haptics";
import ColorPickerModal from "@/components/ColorPickerModal";
import { Feather } from "@expo/vector-icons";


type Props = {
  calendar?: Calendar,
  visible: boolean,
  onClose: () => void,
  onCreate: (calendar: Calendar) => Promise<void>;
  onEdit: (calendar: Calendar) => Promise<void>;
}


export default function CreateCalendarModal({ calendar, visible, onClose, onCreate, onEdit }: Props) {
  const insets = useSafeAreaInsets();
  const { authClient } = useServer();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(appColors[0].color);
  const [calendarHint, setCalendarHint] = useState(CALENDAR_HINTS[Math.floor(Math.random() * CALENDAR_HINTS.length)]);

  const [nameError, setNameError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const isCustomColor = !appColors.some(c => c.color === newColor);

  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  useEffect(() => {
    if (visible) {
      setNewName(calendar?.name ?? "");
      setNewColor(calendar?.color ?? appColors[0].color);
    }
  }, [calendar, visible]);

  const handleCreate = async () => {
    const newCalendar: Calendar = {
      id: calendar?.id ?? "create",
      creatorID: userID!,
      name: newName,
      color: newColor,
      members: calendar?.members ?? [],
      invite: "create",
    };

    let passed = true;

    if (newName.length === 0) {
      setNameError("You can do atleast one letter champ...");
      passed = false;
    } else {
      setNameError("");
    }

    if (newName.length > 16) {
      setNameError("Thats too much letters, don't you think... Keep it under 16 please...");
      passed = false;
    } else {
      setNameError("");
    }

    if (!passed) {
      return;
    }

    setIsLoading(true);
    try {
      if (calendar) {
        await onEdit(newCalendar);
      } else {
        await onCreate(newCalendar);
      }
      haptics.success();
      handleClose();
    } catch (e: any) {
      haptics.warn();
      Alert.alert("Failed to save", e?.message ?? "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  const closeSequence = () => {
    onClose();

    setNewName("");
    setNameError("");
    setNewColor(appColors[0].color);
    setCalendarHint(CALENDAR_HINTS[Math.floor(Math.random() * CALENDAR_HINTS.length)]);
    setIsLoading(false);
  };

  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, closeSequence);

  return (
    <>
      <Modal
        visible={visible}
        onRequestClose={handleClose}
        animationType="none"
        transparent={true}
        statusBarTranslucent={true}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Animated.View style={[styles.modalOverlay, fadeStyle]}>
            <Pressable style={{ flex: 1 }} onPress={handleClose} />
          </Animated.View>
          <GestureDetector gesture={gesture}>
            <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
              <View style={styles.modalHandle} />
              <View style={styles.modalTitleRow}>
                <Text style={styles.modalTitle}>{calendar ? "Edit Calendar" : "New Calendar"}</Text>
              </View>

              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.fieldContainer}>
                  <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Name</Text>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    placeholder={calendarHint}
                    placeholderTextColor={colors.fg4}
                    style={[styles.fieldValueBig, { fontFamily: fonts.sans }]}
                  />
                  {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
                </View>

                <View style={styles.fieldContainer}>
                  <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Colors</Text>
                  <ScrollView
                    horizontal
                  
  showsHorizontalScrollIndicator={false}>
                    <View style={styles.horizontalPillView}>
                      {appColors.map((c) => (
                        <Tap
                          key={c.name}
                          haptic="select"
                          style={{
                            overflow: "hidden",
                            flexDirection: "row",
                            justifyContent: "space-between",
                            gap: 18,
                          }}
                          onPress={() => setNewColor(c.color)}
                        >
                          <View style={[styles.calendarCircle, {
                            borderWidth: c.color === newColor ? 2 : 1,
                            borderColor: c.color === newColor ? colors.fg3 : colors.line3,
                          }]}>
                            <View style={[styles.calendarCircleInner, { backgroundColor: c.color }]} />
                          </View>
                        </Tap>
                      ))}
                      {/* Custom color — opens the picker; filled with the picked
                          color once chosen, the pencil stays on top. */}
                      <Tap haptic="select" onPress={() => setPickerOpen(true)}>
                        <View style={[styles.calendarCircle, {
                          borderWidth: isCustomColor ? 2 : 1,
                          borderColor: isCustomColor ? colors.fg3 : colors.line3,
                          alignItems: "center",
                          justifyContent: "center",
                        }]}>
                          {isCustomColor && <View style={[styles.calendarCircleInner, { backgroundColor: newColor }]} />}
                          <Feather name="edit-2" size={12} color={isCustomColor ? colors.bg : colors.fg3} />
                        </View>
                      </Tap>
                    </View>
                  </ScrollView>
                </View>
              </ScrollView>
              <View style={[styles.modalButtons, { paddingBottom: insets.bottom + 16 }]}>
                <Btn label="Cancel" variant="secondary" onPress={handleClose} />
                <Btn label={calendar ? "Save" : "Create"} onPress={handleCreate} loading={isLoading} />
              </View>
            </Animated.View >
          </GestureDetector>
        </GestureHandlerRootView>
      </Modal >
      <ColorPickerModal
        visible={pickerOpen}
        value={newColor}
        onConfirm={setNewColor}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}
