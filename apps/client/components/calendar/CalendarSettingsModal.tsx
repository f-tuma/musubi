import { colors, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Feather } from "@expo/vector-icons";
import { Modal, Pressable, Text, View, ScrollView, Share } from "react-native"
import Animated from "react-native-reanimated";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar, Invite } from "@/constants/types";
import { api } from "@/services/api";
import { authClient } from "@/services/auth-client";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useState } from "react";


type Props = {
  calendar: Calendar | null,
  visible: boolean,
  onClose: () => void,
  onDelete: (calendar: Calendar) => void,
  onEdit: (calendar: Calendar) => void,
  onLeave: () => void,
}

export default function CalendarSettingsModal({ calendar, visible, onClose, onDelete, onEdit, onLeave }: Props) {
  const [waitingForInvite, setWaitingForInvite] = useState(false);

  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);
  const { loadCalendars } = useCalendarsStore();
  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

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
              <Text style={styles.modalTitle}>{calendar?.name}</Text>
            </View>
            <ScrollView>
              <View style={styles.container}>
                <View style={{ gap: 8 }}>
                  <Pressable
                    disabled={waitingForInvite}
                    style={waitingForInvite ? styles.btnDisabled : styles.btnPrimary}
                    onPress={async () => {
                      setWaitingForInvite(true);
                      const inviteTemplate: Invite = {
                        id: "create",
                        calendarID: calendar?.id!,
                        expiresAt: new Date(),
                        maxUses: 1,
                      }
                      const invite = await api.createInvite(inviteTemplate);
                      await Share.share({
                        message: `https://musubi.frgtn.dev/invite/${invite.id}`,
                      });
                      setWaitingForInvite(false);
                    }}
                  >
                    <Feather size={14} name="send" color={colors.bg3} />
                    <Text style={styles.btnPrimaryText}>Send Invite</Text>
                  </Pressable>
                </View>
              </View>
            </ScrollView>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                borderTopWidth: 1,
                borderColor: colors.line,
              }}
            >
              <Pressable
                style={styles.modalActionBtn}
                disabled={calendar ? false : true}
                onPress={() => {
                  onEdit(calendar!);
                  handleClose();
                }}
              >
                <Feather size={20} name="edit" color={colors.fg2} />
                <Text style={{ color: colors.fg2, fontSize: 10 }}>Edit</Text>
              </Pressable>
              <View style={styles.modalActionDivider} />
              {userID === calendar?.creatorID ?

                <Pressable
                  style={styles.modalActionBtn}
                  disabled={calendar ? false : true}
                  onPress={() => {
                    onDelete(calendar!);
                    handleClose();
                  }}
                >
                  <Feather size={20} name="trash" color={colors.accent} />
                  <Text style={{ color: colors.accent, fontSize: 10 }}>Delete</Text>
                </Pressable>

                :

                <Pressable
                  style={styles.modalActionBtn}
                  disabled={calendar ? false : true}
                  onPress={async () => {
                    await api.leaveCalendar(calendar?.id!);
                    loadCalendars(await api.getCalendars());
                    handleClose();
                    onLeave();
                  }}
                >
                  <Feather size={20} name="arrow-left-circle" color={colors.accent} />
                  <Text style={{ color: colors.accent, fontSize: 10 }}>Leave</Text>
                </Pressable>

              }
            </View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal >
  );
}
