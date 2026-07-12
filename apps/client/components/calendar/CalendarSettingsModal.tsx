import { colors, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Feather } from "@expo/vector-icons";
import { Modal, Pressable, Text, View, ScrollView, Share } from "react-native"
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar, Invite, can, providerFlavor } from "@musubi/types";
import { confirm } from "@/lib/confirm";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useState } from "react";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import MemberRolesModal from "./MemberRolesModal";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";


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
  const { authClient, apiUrl } = useServer();
  const [waitingForInvite, setWaitingForInvite] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [rolesVisible, setRolesVisible] = useState(false);

  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);
  const { loadCalendars } = useCalendarsStore();
  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  const isExternal = !!calendar?.provider;      // google/caldav mirror — edits/deletes push to the provider
  const isOwner = userID === calendar?.creatorID;
  // External mirrors: only the connection owner may edit/delete (the server
  // enforces this too); provider-side read-only mirrors have role "viewer",
  // so can() already blocks them.
  const showEdit = can(calendar?.role, "editCalendar") && (!isExternal || isOwner);
  const showDelete = can(calendar?.role, "deleteCalendar") && !calendar?.isDefault && (!isExternal || isOwner);
  const showInvite = can(calendar?.role, "invite");
  const showLeave = !isOwner;                    // non-owners can leave

  // External delete = two-step confirm: first that it's a provider-synced
  // calendar (and where it lives), then the actual deletion.
  const handleDelete = () => {
    if (!calendar) return;
    if (!isExternal) {
      onDelete(calendar);
      handleClose();
      return;
    }
    const flavor = providerFlavor(calendar);
    const providerName = flavor === "apple" ? "Apple Calendar" : flavor === "google" ? "Google Calendar" : "the CalDAV server";
    confirm({
      title: "External calendar",
      message: `"${calendar.name}" is synced from ${calendar.accountLabel ?? "a connected account"}. Deleting it here also deletes it in ${providerName}.`,
      confirmLabel: "Continue",
    }, () => confirm({
      title: "Delete calendar?",
      message: "The calendar and all its events will be permanently deleted. This can't be undone.",
      confirmLabel: "Delete",
    }, () => {
      onDelete(calendar);
      handleClose();
    }));
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
              <Text style={styles.modalTitle}>{calendar?.name}</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.container}>
                <View style={{ gap: 8 }}>
                  {showInvite && (
                  <Btn
                    label="Send Invite"
                    icon={<Feather size={14} name="send" color={colors.bg3} />}
                    loading={waitingForInvite}
                    onPress={async () => {
                      setWaitingForInvite(true);
                      const inviteTemplate: Invite = {
                        id: "create",
                        calendarID: calendar?.id!,
                        expiresAt: new Date(),
                        maxUses: 1,
                      }
                      const invite = await api.createInvite(inviteTemplate);
                      // The calendar's own server serves the invite page — so
                      // self-hosted (and federated) invites don't depend on the
                      // hosted domain.
                      const origin = calendar?.provider === "musubi" && calendar.serverUrl ? calendar.serverUrl : apiUrl;
                      await Share.share({
                        message: `${origin}/invite/${invite.id}`,
                      });
                      setWaitingForInvite(false);
                    }}
                  />
                  )}
                  <Btn
                    label="Members"
                    variant="secondary"
                    icon={<Feather size={14} name="users" color={colors.fg2} />}
                    onPress={() => setRolesVisible(true)}
                  />
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
                  <Tap
                    style={styles.modalActionBtn}
                    disabled={calendar ? false : true}
                    onPress={() => {
                      onEdit(calendar!);
                      handleClose();
                    }}
                  >
                    <Feather size={20} name="edit" color={colors.fg2} />
                    <Text style={{ color: colors.fg2, fontSize: 10 }}>Edit</Text>
                  </Tap>
                )}

                {showEdit && (showDelete || showLeave) && <View style={styles.modalActionDivider} />}

                {showDelete && (
                  <Tap
                    style={styles.modalActionBtn}
                    haptic="warn"
                    disabled={calendar ? false : true}
                    onPress={handleDelete}
                  >
                    <Feather size={20} name="trash" color={colors.accent} />
                    <Text style={{ color: colors.accent, fontSize: 10 }}>Delete</Text>
                  </Tap>
                )}

                {showLeave && (
                  <Tap
                    style={styles.modalActionBtn}
                    haptic="warn"
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
                  </Tap>
                )}
              </View>
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
      <MemberRolesModal
        calendar={calendar}
        visible={rolesVisible}
        onClose={() => setRolesVisible(false)}
      />
    </Modal >
  );
}
