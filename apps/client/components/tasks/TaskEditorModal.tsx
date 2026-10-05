import { taskCapabilities, taskHomeCalendarID } from "@musubi/calendar";
import { useRef, useState } from "react";
import { Platform, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { DateTimePicker } from "@/components/ui/DateTimePicker";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TaskUpdateSchema, providerFlavor, type Calendar, type Task, type TaskUpdate } from "@musubi/types";
import { ModalPortal } from "@/components/ui/ModalPortal";
import { BottomSheetFrame } from "@/components/ui/BottomSheetFrame";
import { ProviderIcon } from "@/components/calendar/ProviderIcon";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { colors, fonts, styles } from "@/constants/theme";
import { formatDateMedium, formatTime } from "@/lib/datetimeFormat";
import { useSettingsStore } from "@/store/useSettingsStore";
import { userFacingError } from "@/lib/network";

/** All-day task dates are UTC calendar days, not instants in the device's zone. */
function withTaskAllDay(draft: TaskUpdate, allDay: boolean): TaskUpdate {
  if (draft.isAllDay === allDay) return draft;
  const convert = (date: Date | null | undefined) => {
    if (!date) return date;
    return allDay
      ? new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
      : new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  };
  return { ...draft, isAllDay: allDay, start: convert(draft.start), due: convert(draft.due) };
}

export function TaskEditorModal({ task, calendarID, calendars, onSave, onClose }: {
  task?: Task; calendarID: string; calendars: Calendar[];
  onSave: (draft: TaskUpdate) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<TaskUpdate>(() => TaskUpdateSchema.parse(task ? { ...task, calendarID: taskHomeCalendarID(task) ?? task.calendarID, expectedRevision: task.revision } : {
    calendarID, title: "", status: "needs-action", isAllDay: false, priority: 0, percentComplete: 0,
  }));
  const [busy, setBusy] = useState(false), pending = useRef(false);
  const [error, setError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(!!(task?.description || task?.url));
  
  const [picker, setPicker] = useState<{ key: "start" | "due"; mode: "date" | "time" }>();
  const motion = useModalAnimation(true, onClose);
  const insets = useSafeAreaInsets();
  const dateFormat = useSettingsStore(s => s.dateFormat), timeFormat = useSettingsStore(s => s.timeFormat);
  const editable = calendars.some(calendar => calendar.id === draft.calendarID) && (!task || taskCapabilities(task, calendars).edit);
  const googleTasks = calendars.find(calendar => calendar.id === draft.calendarID)?.provider === "google";
  const dateOnly = googleTasks || draft.isAllDay;
  const close = () => { if (!pending.current) void motion.handleClose(); };
  const patch = (change: Partial<TaskUpdate>) => setDraft(previous => ({ ...previous, ...change }));
  const value = picker ? draft[picker.key] : undefined;
  // An empty picker starts on today in the device's zone, even for all-day tasks.
  const pickerValue = value && draft.isAllDay ? new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) : value ?? new Date();
  async function save() {
    if (pending.current || !editable || !draft.title.trim()) return;
    pending.current = true; setBusy(true); setError("");
    try {
      await onSave(TaskUpdateSchema.parse({ ...withTaskAllDay(draft, dateOnly), title: draft.title.trim() }));
      void motion.handleClose();
    } catch (error) { setError(userFacingError(error, "Could not save task.")); pending.current = false; setBusy(false); }
  }
  return <ModalPortal visible onRequestClose={close}>
    <BottomSheetFrame motion={motion} onClose={close} dismissible={!busy}
      header={<View style={styles.modalTitleRow}><Text style={styles.modalTitle}>{task ? "Edit task" : "New task"}</Text><Tap onPress={close} disabled={busy} accessibilityLabel="Close task editor" style={{ padding: 12, marginLeft: "auto" }}><Feather name="x" size={20} color={colors.fg3} /></Tap></View>}>
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled">
        <View style={styles.fieldContainer}><Text style={styles.fieldLabel}>Title</Text>
          <TextInput accessibilityLabel="Task title" value={draft.title} editable={!busy && editable} onChangeText={title => patch({ title })} placeholder="What needs to be done?" placeholderTextColor={colors.fg4} multiline style={[styles.fieldValueBig, { fontFamily: fonts.sans }]} />
        </View>
        <View style={styles.fieldContainer}><ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={styles.horizontalPillView}>
          {calendars.map(calendar => <Tap key={calendar.id} disabled={!!task || busy} haptic="select" onPress={() => setDraft(previous => withTaskAllDay({ ...previous, calendarID: calendar.id }, calendar.provider === "google" || previous.isAllDay))} accessibilityLabel={`${calendar.name} calendar`} accessibilityState={{ selected: calendar.id === draft.calendarID }} style={[calendar.id === draft.calendarID ? styles.pillActive : styles.pill, calendar.id === draft.calendarID && styles.pillEmphasized]}>
            {calendar.provider ? <ProviderIcon provider={providerFlavor(calendar)} color={calendar.color} /> : <View style={[styles.colorDot, { backgroundColor: calendar.color }]} />}
            <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: calendar.id === draft.calendarID ? colors.fg : colors.fg3 }}>{calendar.name}</Text>
          </Tap>)}
        </View></ScrollView></View>
        <View style={styles.fieldContainer}>
        {(["start", "due"] as const).map(key => <View key={key} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 56, paddingVertical: 6 }}>
          <Text style={[styles.fieldValueText, { fontFamily: fonts.sans, color: colors.fg2 }]}>{key === "start" ? "Starts" : "Due"}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Tap disabled={busy || !editable} onPress={() => setPicker({ key, mode: "date" })} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.bg3 }} accessibilityLabel={key + " date"}>
              <Text style={styles.fieldValueText}>{draft[key] ? formatDateMedium(draft.isAllDay ? new Date(draft[key]!.getUTCFullYear(), draft[key]!.getUTCMonth(), draft[key]!.getUTCDate()) : draft[key]!, dateFormat) : "Add date"}</Text>
            </Tap>
            {!dateOnly && draft[key] ? <Tap disabled={busy || !editable} onPress={() => setPicker({ key, mode: "time" })} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.bg3 }} accessibilityLabel={key + " time"}><Text style={styles.fieldValueText}>{formatTime(draft[key]!, timeFormat)}</Text></Tap> : null}
            {draft[key] ? <Tap disabled={busy || !editable} onPress={() => patch({ [key]: null })} style={{ padding: 12 }} accessibilityLabel={"Clear " + key}><Feather name="x" size={18} color={colors.fg3} /></Tap> : null}
          </View>
        </View>)}
        {picker && !busy && editable ? <DateTimePicker value={pickerValue} mode={picker.mode} is24Hour={timeFormat === "24h"} presentation={Platform.OS === "ios" ? "inline" : "dialog"}
          onDismiss={() => setPicker(undefined)} onValueChange={(_event, date) => {
            if (date) setDraft(previous => ({
              ...withTaskAllDay(previous, dateOnly),
              [picker.key]: dateOnly ? new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) : date,
            }));
            setPicker(undefined);
          }} /> : null}
        {!googleTasks && (draft.start || draft.due) ? <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 56, paddingVertical: 6 }}><Text style={[styles.fieldValueText, { color: colors.fg2 }]}>All-day</Text>
        <Switch disabled={busy || !editable} accessibilityLabel="All-day task" value={draft.isAllDay} thumbColor={draft.isAllDay ? colors.accent : colors.bg3} trackColor={{ false: colors.line, true: colors.line3 }} onValueChange={allDay => setDraft(previous => withTaskAllDay(previous, allDay))} /></View> : null}</View>
        {!detailsOpen ? <Tap onPress={() => setDetailsOpen(true)} style={[styles.fieldContainer, { flexDirection: "row", alignItems: "center", gap: 8 }]}><Feather name="plus" size={14} color={colors.fg3} /><Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.fg3 }}>Add note or link</Text></Tap> : <>
        <View style={styles.fieldContainer}><View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 8 }}><Feather name="file-text" size={16} color={colors.fg3} /><Text style={[styles.fieldValueText, { color: colors.fg2 }]}>Notes</Text></View><TextInput accessibilityLabel="Task notes" placeholder="Add notes" placeholderTextColor={colors.fg4} multiline editable={!busy && editable} value={draft.description ?? ""} onChangeText={description => patch({ description })} style={[styles.fieldValueText, { minHeight: 60, textAlignVertical: "top" }]} /></View>
        <View style={styles.fieldContainer}><Text style={styles.fieldLabel}>Link</Text><TextInput accessibilityLabel="Task link" placeholder="Add link" placeholderTextColor={colors.fg4} autoCapitalize="none" editable={!busy && editable} value={draft.url ?? ""} onChangeText={url => patch({ url: url || null })} style={styles.fieldValueText} /></View>
        </>}
        {error || !editable ? <Text accessibilityRole="alert" style={styles.errorText}>{error || "This calendar is no longer editable."}</Text> : null}
      </ScrollView>
      <View style={[styles.modalButtons, { paddingBottom: 16 + insets.bottom }]}>
        <Btn label="Cancel" variant="secondary" disabled={busy} onPress={close} />
        <Btn label={task ? "Save" : "Create"} loading={busy} disabled={!editable || !draft.title.trim()} onPress={() => { void save(); }} />
      </View>
    </BottomSheetFrame>

  </ModalPortal>;
}
