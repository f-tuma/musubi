import { appColors } from "@/constants/colors";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar } from "@/constants/types";
import { useServer } from "@/contexts/ServerContext";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useEffect, useState } from "react";
import { Text, Modal, Pressable, ScrollView, View, TextInput } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";


type Props = {
  calendar?: Calendar,
  visible: boolean,
  onClose: () => void,
  onCreate: (calendar: Calendar) => void;
  onEdit: (calendar: Calendar) => void;
}


export default function CreateCalendarModal({ calendar, visible, onClose, onCreate, onEdit }: Props) {
  const { authClient } = useServer();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(appColors[0].color);

  const [nameError, setNameError] = useState("");

  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  useEffect(() => {
    if (visible) {
      setNewName(calendar?.name ?? "");
      setNewColor(calendar?.color ?? "");
    }
  }, [calendar, visible]);

  const handleCreate = () => {
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

    if (!passed) {
      return;
    }

    if (calendar) {
      onEdit(newCalendar);
    } else {
      onCreate(newCalendar);
    }
    handleClose();
  };

  const closeSequence = () => {
    onClose();

    setNewName("");
    setNameError("");
    setNewColor(appColors[0].color);
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
                    placeholder="Dragon Slaying"
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
              <View style={styles.modalButtons}>
                <Pressable style={styles.btnSecondary} onPress={handleClose}>
                  <Text style={styles.btnSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.btnPrimary} onPress={handleCreate}>
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
