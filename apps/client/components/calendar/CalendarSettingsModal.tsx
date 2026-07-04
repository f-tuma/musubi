import { colors, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Feather } from "@expo/vector-icons";
import { Modal, Pressable, Text, View, ScrollView, Share } from "react-native"
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar, Invite, can } from "@musubi/types";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useState } from "react";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";


type Props = {
  calendar: Calendar | null,
  visible: boolean,
  onClose: () => void,
  onDelete: (calendar: Calendar) => void,
  onEdit: (calendar: Calendar) => void,
  onLeave: () => void,
}

export default function CalendarSettingsModal({ calendar, visible, onClose, onDelete, onEdit, onLeave }: Props) {
  const api = useApi();
  const { authClient } = useServer();
  const [waitingForInvite, setWaitingForInvite] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);
  const { loadCalendars } = useCalendarsStore();
  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  const isExternal = !!calendar?.provider;      // google/caldav mirror — no edit/delete in Musubi
  const isOwner = userID === calendar?.creatorID;
  const showEdit = can(calendar?.role, "editCalendar") && !isExternal;
  const showDelete = can(calendar?.role, "deleteCalendar") && !isExternal;
  const showInvite = can(calendar?.role, "invite");
  const showLeave = !isOwner;                    // non-owners can leave

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
                  {showInvite && (
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
                  )}
                </View>
              </View>
            </ScrollView>
            {(showEdit || showDelete || showLeave) && (
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  borderTopWidth: 1,
                  borderColor: colors.line,
                  paddingBottom: insets.bottom,
                }}
              >
                {showEdit && (
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
                )}

                {showEdit && (showDelete || showLeave) && <View style={styles.modalActionDivider} />}

                {showDelete && (
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
                )}

                {showLeave && (
                  <Pressable
                    style={styles.modalActionBtn}
                    disabled={isLeaving || !calendar}
                    onPress={async () => {
                      setIsLeaving(true);
                      await api.leaveCalendar(calendar?.id!);
                      loadCalendars(await api.getCalendars());
                      handleClose();
                      onLeave();
                    }}
                  >
                    <Feather size={20} name="arrow-left-circle" color={isLeaving ? colors.fg4 : colors.accent} />
                    <Text style={{ color: isLeaving ? colors.fg4 : colors.accent, fontSize: 10 }}>Leave</Text>
                  </Pressable>
                )}
              </View>
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal >
  );
}
