import { colors, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Feather } from "@expo/vector-icons";
import { Pressable, Text, View, ScrollView } from "react-native"
import { ModalPortal as Modal } from "@/components/ui/ModalPortal";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar, can, providerFlavor } from "@musubi/types";
import { confirm } from "@/lib/confirm";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useState } from "react";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import MemberRolesModal from "./MemberRolesModal";
import InvitesModal from "./InvitesModal";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { warn } from "@/lib/haptics";


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
  const [isLeaving, setIsLeaving] = useState(false);
  const [rolesVisible, setRolesVisible] = useState(false);
  const [invitesVisible, setInvitesVisible] = useState(false);
  const [exporting, setExporting] = useState(false);

  // One-shot .ics snapshot: fetch → temp file → OS share sheet.
  const exportCalendar = async () => {
    if (!calendar) return;
    setExporting(true);
    try {
      const ics = await api.exportCalendar(calendar.id);
      const file = new File(Paths.cache, `${calendar.name.replace(/[^\w.-]+/g, "_") || "calendar"}.ics`);
      if (file.exists) file.delete(); // stale export from a previous share
      file.write(ics);
      await Sharing.shareAsync(file.uri, { mimeType: "text/calendar" });
    } catch (e) {
      warn();
      console.error("Calendar export failed:", e);
    } finally {
      setExporting(false);
    }
  };

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
      confirm({
        title: `Delete "${calendar.name}"?`,
        message: "The calendar and all its events will be permanently deleted. This can't be undone.",
        confirmLabel: "Delete",
      }, () => {
        onDelete(calendar);
        handleClose();
      });
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
                    label="Invite Links"
                    icon={<Feather size={14} name="send" color={colors.bg3} />}
                    onPress={() => setInvitesVisible(true)}
                  />
                  )}
                  <Btn
                    label="Members"
                    variant="secondary"
                    icon={<Feather size={14} name="users" color={colors.fg2} />}
                    onPress={() => setRolesVisible(true)}
                  />
                  <Btn
                    label="Export (.ics)"
                    variant="secondary"
                    icon={<Feather size={14} name="download" color={colors.fg2} />}
                    loading={exporting}
                    onPress={exportCalendar}
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
      <InvitesModal
        calendar={calendar}
        visible={invitesVisible}
        onClose={() => setInvitesVisible(false)}
      />
    </Modal >
  );
}
