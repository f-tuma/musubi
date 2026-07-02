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
      handleClose();
    } catch (e: any) {
      Alert.alert("Failed to save", e?.message ?? "An unexpected error occured.");
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

              <ScrollView>
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
                  >
                    <View style={styles.horizontalPillView}>
                      {appColors.map((c) => (
                        <Pressable
                          key={c.name}
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
                        </Pressable>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              </ScrollView>
              <View style={[styles.modalButtons, { paddingBottom: insets.bottom + 16 }]}>
                <Pressable style={styles.btnSecondary} onPress={handleClose}>
                  <Text style={styles.btnSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={isLoading ? [styles.btnPrimary, { backgroundColor: colors.line }] : styles.btnPrimary}
                  disabled={isLoading}
                  onPress={handleCreate}
                >
                  <Text style={styles.btnPrimaryText}>{calendar ? "Save" : "Create"}</Text>
                </Pressable>
              </View>
            </Animated.View >
          </GestureDetector>
        </GestureHandlerRootView>
      </Modal >
    </>
  );
}
