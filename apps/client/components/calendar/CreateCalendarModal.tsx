import { appColors } from "@/constants/colors";
import { colors, fonts, styles } from "@/constants/theme";
import { Calendar, providerFlavor } from "@musubi/types";
import { useServer } from "@/contexts/ServerContext";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { ProviderIcon } from "@/components/calendar/ReorderableCalendarList";
import { useEffect, useMemo, useState } from "react";
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
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useApi } from "@/services/api";
import { useRefreshData } from "@/hooks/useRefreshData";


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

  // Where to create: null = this Musubi server, otherwise a connected provider
  // account — one entry per (provider, accountId), derived from synced calendars.
  const allCalendars = useCalendarsStore(s => s.calendars);
  const accounts = useMemo(() => {
    const map = new Map<string, { provider: string; accountId: string; label: string; flavor: string | null }>();
    for (const c of allCalendars) {
      if (!c.provider || !c.accountId) continue;
      const key = `${c.provider}:${c.accountId}`;
      if (!map.has(key)) {
        map.set(key, { provider: c.provider, accountId: c.accountId, label: c.accountLabel || c.provider, flavor: providerFlavor(c) });
      }
    }
    return [...map.values()];
  }, [allCalendars]);
  const [account, setAccount] = useState<(typeof accounts)[number] | null>(null);

  const { data: session } = authClient.useSession();
  const userID = session?.user.id;

  // Import an .ics as the new calendar's content. Picking a file switches the
  // Create flow to the import endpoint; import is home-server + native only,
  // so the account choice resets.
  const api = useApi();
  const refresh = useRefreshData();
  const [importFile, setImportFile] = useState<{ uri: string; name: string } | null>(null);
  const pickImportFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["text/calendar", "application/ics", "text/plain", "application/octet-stream"],
      copyToCacheDirectory: true,
    });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    setImportFile({ uri: asset.uri, name: asset.name });
    setAccount(null);
    if (!newName) setNewName(asset.name.replace(/\.ics$/i, "").slice(0, 16));
  };

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
      // create into a connected account — the server makes it on the provider first
      provider: calendar ? calendar.provider : account?.provider ?? null,
      accountId: calendar ? calendar.accountId : account?.accountId ?? null,
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
      } else if (importFile) {
        const ics = await new File(importFile.uri).text();
        await api.importCalendar(ics, newName, newColor);
        await refresh(); // pulls the new calendar + its events into stores/cache
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
    setAccount(null);
    setImportFile(null);
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
                          color once chosen, the plus stays on top. */}
                      <Tap haptic="select" onPress={() => setPickerOpen(true)}>
                        <View style={[styles.calendarCircle, {
                          borderWidth: isCustomColor ? 2 : 1,
                          borderColor: isCustomColor ? colors.fg3 : colors.line3,
                          alignItems: "center",
                          justifyContent: "center",
                        }]}>
                          {isCustomColor && <View style={[styles.calendarCircleInner, { backgroundColor: newColor }]} />}
                          <Feather name="plus" size={14} color={isCustomColor ? colors.bg : colors.fg3} />
                        </View>
                      </Tap>
                    </View>
                  </ScrollView>
                </View>

                {/* Where the calendar lives — this Musubi server, or a connected
                    provider account (created on the provider, then synced in).
                    Only when creating: calendars can't move between accounts. */}
                {!calendar && accounts.length > 0 && !importFile && (
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Account</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={{ flexDirection: "row", gap: 8, paddingVertical: 12 }}>
                        {[null, ...accounts].map((a) => {
                          const selected = (a?.accountId ?? null) === (account?.accountId ?? null) && (a?.provider ?? null) === (account?.provider ?? null);
                          return (
                            <Tap
                              key={a ? `${a.provider}:${a.accountId}` : "musubi"}
                              haptic="select"
                              onPress={() => setAccount(a)}
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 6,
                                paddingHorizontal: 12,
                                paddingVertical: 7,
                                borderRadius: 999,
                                borderWidth: 1,
                                borderColor: selected ? colors.fg3 : colors.line3,
                                backgroundColor: selected ? colors.bg3 : "transparent",
                              }}
                            >
                              <ProviderIcon provider={a?.flavor} />
                              <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: selected ? colors.fg : colors.fg2 }}>
                                {a?.label ?? "Musubi"}
                              </Text>
                            </Tap>
                          );
                        })}
                      </View>
                    </ScrollView>
                  </View>
                )}

                {/* Fill the new calendar from an .ics file — native calendars only,
                    so picking a file hides the account choice. Only when creating. */}
                {!calendar && (
                  <View style={styles.fieldContainer}>
                    <Text style={[styles.fieldLabel, { fontFamily: fonts.sans }]}>Import</Text>
                    {importFile ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
                        <Feather name="file-text" size={16} color={colors.fg3} />
                        <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.sans, fontSize: 13, color: colors.fg }}>
                          {importFile.name}
                        </Text>
                        <Tap hitSlop={10} onPress={() => setImportFile(null)}>
                          <Feather name="x" size={16} color={colors.fg3} />
                        </Tap>
                      </View>
                    ) : (
                      <Tap onPress={pickImportFile} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}>
                        <Feather name="upload" size={14} color={colors.fg2} />
                        <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg2 }}>
                          Import events from an .ics file
                        </Text>
                      </Tap>
                    )}
                  </View>
                )}
              </ScrollView>
              <View style={[styles.modalButtons, { paddingBottom: insets.bottom + 16 }]}>
                <Btn label="Cancel" variant="secondary" onPress={handleClose} />
                <Btn label={calendar ? "Save" : importFile ? "Import" : "Create"} onPress={handleCreate} loading={isLoading} />
              </View>
            </Animated.View >
          </GestureDetector>
          {/* Rendered INSIDE the Modal window so its absolute overlay sits on
              top of the sheet — as a Modal sibling it was a modal-in-modal
              (broken on iOS: didn't show + ate touches). */}
          <ColorPickerModal
            visible={pickerOpen}
            value={newColor}
            onConfirm={setNewColor}
            onClose={() => setPickerOpen(false)}
          />
        </GestureHandlerRootView>
      </Modal >
    </>
  );
}
