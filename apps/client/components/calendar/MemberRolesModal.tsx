import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Modal, Pressable, Text, View, ScrollView } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar } from "@musubi/types";
import { useEffect, useState } from "react";
import { useApi } from "@/services/api";

type Member = { id: string; name: string; email: string; role: string };

type Props = {
  calendar: Calendar | null,
  visible: boolean,
  onClose: () => void,
}

const ASSIGNABLE: ("viewer" | "editor")[] = ["viewer", "editor"];

export default function MemberRolesModal({ calendar, visible, onClose }: Props) {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);

  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState<string | null>(null); // userID being updated

  useEffect(() => {
    if (!visible || !calendar) return;
    api.getCalendarMembers(calendar.id).then(setMembers).catch(() => setMembers([]));
  }, [visible, calendar?.id]);

  const changeRole = async (userID: string, role: "viewer" | "editor") => {
    setPending(userID);
    try {
      await api.setMemberRole(calendar!.id, userID, role);
      setMembers(prev => prev.map(m => m.id === userID ? { ...m, role } : m));
    } finally {
      setPending(null);
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
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[styles.modalOverlay, fadeStyle]}>
          <Pressable style={{ flex: 1 }} onPress={handleClose} />
        </Animated.View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalTitleRow}>
              <Text style={styles.modalTitle}>Permissions</Text>
            </View>
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16, gap: 12 }}>
              {members.map((m) => {
                const isOwner = m.id === calendar?.creatorID;
                return (
                  <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.fg }}>{m.name}</Text>
                      <Text style={{ fontSize: 11, color: colors.fg3 }}>{m.email}</Text>
                    </View>
                    {isOwner ? (
                      <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>Owner</Text>
                    ) : (
                      <View style={{
                        flexDirection: "row",
                        borderWidth: 1, borderColor: colors.line2, borderRadius: 999, padding: 2, gap: 2,
                        opacity: pending === m.id ? 0.4 : 1,
                      }}>
                        {ASSIGNABLE.map((role) => (
                          <Pressable
                            key={role}
                            disabled={pending === m.id || m.role === role}
                            onPress={() => changeRole(m.id, role)}
                            style={{
                              paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
                              backgroundColor: m.role === role ? colors.fg : "transparent",
                            }}
                          >
                            <Text style={{
                              fontFamily: fonts.sans, fontSize: 11,
                              color: m.role === role ? colors.bg : colors.fg2,
                            }}>
                              {role === "viewer" ? "View" : "Edit"}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
