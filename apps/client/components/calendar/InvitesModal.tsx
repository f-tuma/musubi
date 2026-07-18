import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { Pressable, Text, View, ScrollView, Share, ActivityIndicator } from "react-native";
import { ModalPortal as Modal } from "@/components/ui/ModalPortal";
import { Feather } from "@expo/vector-icons";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Calendar, Invite } from "@musubi/types";
import { useEffect, useState } from "react";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import { useSettingsStore } from "@/store/useSettingsStore";
import { Tap } from "@/components/ui/Tap";
import { Btn } from "@/components/ui/Btn";
import { confirm } from "@/lib/confirm";
import { formatDateLong } from "@/lib/datetimeFormat";
import { showToast } from "@/components/ui/Toast";
import { userFacingError } from "@/lib/network";
import { warn } from "@/lib/haptics";

// Create presets — Discord-style. null = unlimited / never.
const USES_OPTIONS = [
  { label: "1", value: 1 },
  { label: "10", value: 10 },
  { label: "25", value: 25 },
  { label: "∞", value: null },
] as const;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const EXPIRY_OPTIONS = [
  { label: "1 hour", ms: HOUR },
  { label: "1 day", ms: DAY },
  { label: "7 days", ms: 7 * DAY },
  { label: "Never", ms: null },
] as const;

type Props = {
  calendar: Calendar | null,
  visible: boolean,
  onClose: () => void,
}

export default function InvitesModal({ calendar, visible, onClose }: Props) {
  const api = useApi();
  const { apiUrl } = useServer();
  const { dateFormat } = useSettingsStore();
  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);

  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState<number | null>(null);      // default ∞ people
  const [expiryMs, setExpiryMs] = useState<number | null>(7 * DAY); // default 7 days
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // inviteID being revoked

  useEffect(() => {
    if (!visible || !calendar) return;
    api.getInvites(calendar.id).then(setInvites).catch((error) => {
      setInvites([]);
      showToast({ message: userFacingError(error, "Could not load invite links.") });
    });
  }, [visible, calendar?.id]);

  // The calendar's own server serves the invite page — self-hosted and federated
  // invites must not depend on the hosted domain.
  const origin = calendar?.provider === "musubi" && calendar.serverUrl ? calendar.serverUrl : apiUrl;
  const linkFor = (i: Invite) => `${origin}/invite/${i.id}`;
  const shareInvite = (i: Invite) => Share.share({
    message: `You're invited to join the calendar "${calendar?.name}" on Musubi 🎋\n\nTap the link to accept:\n${linkFor(i)}`,
  });

  const isExpired = (i: Invite) => !!i.expiresAt && new Date(i.expiresAt).getTime() <= Date.now();
  const isExhausted = (i: Invite) => i.maxUses !== null && i.uses >= i.maxUses;

  // Primary line = the link's RULE (what you configured); secondary = what
  // happened to it. The token itself is meaningless to a human — never shown.
  const ruleLabel = (i: Invite) =>
    `${i.maxUses === null ? "Unlimited" : `${i.maxUses} ${i.maxUses === 1 ? "use" : "uses"}`} · ${i.expiresAt === null ? "never expires" : `until ${formatDateLong(new Date(i.expiresAt), dateFormat)}`}`;
  const usageLabel = (i: Invite) => {
    if (isExpired(i)) return `Expired · ${i.uses} joined`;
    if (isExhausted(i)) return `Used up · ${i.uses} joined`;
    return i.uses === 0 ? "Nobody joined yet" : `${i.uses} joined`;
  };

  const create = async () => {
    if (!calendar) return;
    setCreating(true);
    try {
      const invite = await api.createInvite({
        id: "create",
        calendarID: calendar.id,
        expiresAt: expiryMs === null ? null : new Date(Date.now() + expiryMs),
        maxUses,
        uses: 0,
      });
      setInvites(prev => [invite, ...prev]);
      await shareInvite(invite); // the point of a new link is sharing it
    } catch (error) {
      warn();
      showToast({ message: userFacingError(error, "Could not create an invite link.") });
    } finally {
      setCreating(false);
    }
  };

  const revoke = (i: Invite) => {
    confirm({
      title: "Revoke invite",
      message: "The link stops working immediately. People who already joined stay.",
      confirmLabel: "Revoke",
    }, async () => {
      if (!calendar) return;
      setPending(i.id);
      try {
        await api.revokeInvite(calendar.id, i.id);
        setInvites(prev => prev.filter(x => x.id !== i.id));
      } catch (error) {
        warn();
        showToast({ message: userFacingError(error, "Could not revoke this invite.") });
      } finally {
        setPending(null);
      }
    });
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
              <Text style={styles.modalTitle}>Invite Links</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>

              {/* New link — its own bordered section, same rhythm as other modals. */}
              <View style={styles.fieldContainer}>
                <View style={{ gap: 14 }}>
                  <View>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Max uses</Text>
                    <View style={styles.horizontalPillView}>
                      {USES_OPTIONS.map(o => (
                        <Tap key={o.label} haptic="select" onPress={() => setMaxUses(o.value)}
                          style={maxUses === o.value ? styles.pillActive : styles.pill}>
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: maxUses === o.value ? colors.fg : colors.fg3 }}>
                            {o.label}
                          </Text>
                        </Tap>
                      ))}
                    </View>
                  </View>
                  <View>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Expires</Text>
                    <View style={styles.horizontalPillView}>
                      {EXPIRY_OPTIONS.map(o => (
                        <Tap key={o.label} haptic="select" onPress={() => setExpiryMs(o.ms)}
                          style={expiryMs === o.ms ? styles.pillActive : styles.pill}>
                          <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: expiryMs === o.ms ? colors.fg : colors.fg3 }}>
                            {o.label}
                          </Text>
                        </Tap>
                      ))}
                    </View>
                  </View>
                  <View style={{ marginTop: 8 }}>
                    <Btn
                      label="Create Link"
                      icon={<Feather size={14} name="link" color={colors.bg3} />}
                      loading={creating}
                      onPress={create}
                    />
                  </View>
                </View>
              </View>

              {/* Existing links — rule first, usage second; actions tucked right. */}
              {invites.length > 0 && (
                <View style={[styles.fieldContainer, { borderBottomWidth: 0 }]}>
                  <Text style={[styles.fieldLabel, { fontFamily: fonts.sans, marginBottom: 12 }]}>
                    Active links · {invites.length}
                  </Text>
                  <View style={{ gap: 16 }}>
                    {invites.map(i => {
                      const dead = isExpired(i) || isExhausted(i);
                      return (
                        <View key={i.id} style={{ flexDirection: "row", alignItems: "center", gap: 22 }}>
                          <View style={{ flex: 1, gap: 2, opacity: dead ? 0.5 : 1 }}>
                            <Text numberOfLines={1} style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.fg }}>
                              {ruleLabel(i)}
                            </Text>
                            <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: dead ? colors.accent : colors.fg3 }}>
                              {usageLabel(i)}
                            </Text>
                          </View>
                          {!dead && (
                            <Tap hitSlop={10} onPress={() => shareInvite(i)}>
                              <Feather name="share-2" size={18} color={colors.fg2} />
                            </Tap>
                          )}
                          {pending === i.id
                            ? <ActivityIndicator size="small" color={colors.fg3} />
                            : (
                              <Tap hitSlop={10} haptic="warn" onPress={() => revoke(i)}>
                                <Feather name="trash-2" size={18} color={colors.accent} />
                              </Tap>
                            )}
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
