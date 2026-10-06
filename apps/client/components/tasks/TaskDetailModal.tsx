import { TaskDeliveryModal } from "./TaskDeliveryModal";
import { taskCapabilities, taskCalendarIDs, taskHomeCalendarID, taskSharingTargets } from "@musubi/calendar";
import { useApi } from "@/services/api";
import { confirm } from "@/lib/confirm";
import { TaskEditorModal } from "./TaskEditorModal";
import { userFacingError } from "@/lib/network";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import Animated from "react-native-reanimated";
import { calendarSupportsTaskLinks, providerFlavor, type Calendar, type Task, type TaskStatus } from "@musubi/types";
import { ProviderIcon } from "@/components/calendar/ProviderIcon";
import { colors, fonts, styles } from "@/constants/theme";
import { ModalPortal } from "@/components/ui/ModalPortal";
import { Tap } from "@/components/ui/Tap";
import { OptionPicker, type PickerOption } from "@/components/ui/OptionPicker";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { useSettingsStore } from "@/store/useSettingsStore";
import { taskPriorityLabel, formatTaskDate, taskRepeatLabel } from "@/lib/taskPresentation";
import { showToast } from "@/components/ui/Toast";

const statuses: PickerOption[] = [
  { value: "needs-action", label: "Needs action", icon: "circle" },
  { value: "in-process", label: "In progress", icon: "clock" },
  { value: "completed", label: "Completed", icon: "check-circle" },
  { value: "cancelled", label: "Cancelled", icon: "x-circle" },
];
function DetailRow({ icon, label, value, link = false }: { icon: React.ComponentProps<typeof Feather>["name"]; label: string; value: string; link?: boolean }) {
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
    <Feather name={icon} size={17} color={colors.fg3} style={{ marginTop: 2 }} />
    <View style={{ flex: 1, gap: 5 }}><Text style={styles.sectionLabel}>{label}</Text><Text selectable={!link} numberOfLines={link ? 2 : undefined} ellipsizeMode="tail" style={[copy(), link && { textDecorationLine: "underline" }]}>{value}</Text></View>
  </View>;
}
// Read theme colors while rendering, including after a light/dark switch.
const copy = () => ({ fontFamily: fonts.sans, fontSize: 14, color: colors.fg2 });

export function TaskDetailModal({ task, calendar, calendars = calendar ? [calendar] : [], editable, busy: externalBusy, onClose, onStatus, onPriority, onSaved, relatedTask, onOpenRelated }: {
  relatedTask?: Task; onOpenRelated?: (id: string) => void;
  task: Task; calendar?: Calendar; calendars?: Calendar[]; editable: boolean; busy: boolean;
  onSaved: (task: Task | null) => void; onClose: () => void; onStatus: (status: TaskStatus) => void; onPriority: (priority: number) => void;
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [multilineTitle, setMultilineTitle] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const busy = externalBusy || actionBusy;
  const [showDelivery, setShowDelivery] = useState(false);
  const [sharingMenu, setSharingMenu] = useState(false);
  const [sharingAction, setSharingAction] = useState<"link" | "fork">();
  const capabilities = taskCapabilities(task, calendars);
  const memberships = calendars.filter(member => taskCalendarIDs(task).includes(member.id));
  const targets = taskSharingTargets(task, calendars, sharingAction ?? "link");
  const canShare = capabilities.link || capabilities.fork || capabilities.unlinkCalendarIDs.length > 0;
  const [picker, setPicker] = useState<"status" | "priority">();
  const { fadeStyle, slideStyle, gesture, handleClose } = useModalAnimation(true, onClose);
  const insets = useSafeAreaInsets();
  const dateFormat = useSettingsStore(s => s.dateFormat);
  const timeFormat = useSettingsStore(s => s.timeFormat);
  const date = (value: Date, timed = !task.isAllDay) => formatTaskDate(value, !timed, dateFormat, timeFormat);
  const close = () => { if (!busy) handleClose(); };
  const priorities = [...new Set([0, 1, 5, 9, task.priority])].sort((a, b) => a - b).map(value => ({ value: String(value), label: taskPriorityLabel(value) }));
  const repeat = taskRepeatLabel(task);
  const status = statuses.find(item => item.value === task.status)?.label ?? task.status;
  async function share(calendarID: string) {
    if (busy || !sharingAction) return;
    const operation = sharingAction;
    if (!(operation === "link" ? capabilities.link : capabilities.fork)) return;
    setActionBusy(true);
    try {
      const saved = operation === "link" ? await api.linkTask(task, calendarID) : await api.forkTask(task, calendarID);
      if (operation === "link") { onSaved(saved); if (!saved) onClose(); } else onClose();
    }
    catch (error) { showToast({ message: userFacingError(error, "Could not share task.") }); }
    finally { setActionBusy(false); }
  }
  function unlink(calendarID: string) {
    if (busy || !capabilities.unlinkCalendarIDs.includes(calendarID)) return;
    confirm({ title: "Remove from calendar?", message: calendars.find(member => member.id === calendarID)?.provider === "microsoft" ? "Only the Musubi link is removed; the Microsoft task stays in To Do." : calendars.find(member => member.id === calendarID)?.name ?? "", confirmLabel: "Remove" }, () => {
      setActionBusy(true);
      void api.removeTask(task, calendarID).then(saved => { onSaved(saved); if (!saved) onClose(); }).catch(error => showToast({ message: userFacingError(error, "Could not remove task from calendar.") })).finally(() => setActionBusy(false));
    });
  }
  return <ModalPortal visible onRequestClose={close}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Animated.View style={[styles.modalOverlay, fadeStyle]}><Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close task detail" /></Animated.View>

      <Animated.View style={[styles.modalSheet, { paddingHorizontal: 22, paddingBottom: editable ? 0 : Math.max(20, insets.bottom), maxHeight: "88%" }, fadeStyle, slideStyle]}>
        <GestureDetector gesture={gesture.enabled(!busy)}>
          <View collapsable={false}>
        <View style={styles.modalHandle} />
        <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-start", paddingTop: 6, paddingBottom: multilineTitle ? 12 : 0 }}>
          <View style={{ flex: 1, flexDirection: "row", gap: 14, alignItems: "stretch" }}>
          <View style={{ width: 3, borderRadius: 2, backgroundColor: calendar?.color ?? colors.fg3, marginVertical: 4 }} />
          <Text accessibilityRole="header" onTextLayout={event => setMultilineTitle(event.nativeEvent.lines.length > 1)} style={{ flex: 1, fontFamily: fonts.serif, fontSize: 26, lineHeight: 32, color: colors.fg, textDecorationLine: task.status === "completed" ? "line-through" : "none" }}>{task.title}</Text>
          </View>
          <Tap onPress={close} accessibilityLabel="Close task" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Feather name="x" size={20} color={colors.fg3} /></Tap>
        </View>
          </View>
        </GestureDetector>
        <ScrollView contentContainerStyle={{ gap: 20, paddingTop: 4, paddingBottom: 24 }}>
          {memberships.length ? (
            <View style={[styles.horizontalPillView, { flexWrap: "wrap" }]}>
              {memberships.map(member => <View key={member.id} accessible accessibilityLabel={`${member.name} · ${member.id === taskHomeCalendarID(task) ? "Home calendar" : "Linked calendar, read-only"}`} style={[styles.pill, styles.pillEmphasized, { borderColor: colors.line3 }]}>
                {member.provider ? <ProviderIcon provider={providerFlavor(member)} color={member.color} /> : <View style={[styles.colorDot, { backgroundColor: member.color }]} />}
                {member.id !== taskHomeCalendarID(task) ? <Feather name="lock" size={11} color={colors.fg3} /> : null}
                <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg2 }}>{member.name}{member.id === taskHomeCalendarID(task) ? " · Home" : !calendarSupportsTaskLinks(member) ? " · Unsupported link" : ""}</Text>
              </View>)}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Tap disabled={!editable || busy} onPress={() => setPicker("status")} accessibilityLabel={`Task status: ${status}`} style={{ flex: 1, minHeight: 48, padding: 12, borderRadius: 12, backgroundColor: colors.bg3 }}><View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><TaskStatusIcon status={task.status} color={colors.fg3} /><Text style={[copy(), { flexShrink: 1 }]}>{status}</Text></View></Tap>
            <Tap disabled={!editable || busy} onPress={() => setPicker("priority")} accessibilityLabel={`Task priority: ${taskPriorityLabel(task.priority)}`} style={{ flex: 1, minHeight: 48, padding: 12, borderRadius: 12, backgroundColor: colors.bg3, flexDirection: "row", alignItems: "center", gap: 8 }}><Feather name="flag" size={15} color={colors.fg3} /><Text style={[copy(), { flexShrink: 1 }]}>{taskPriorityLabel(task.priority)}</Text></Tap>
          </View>
          {busy ? <ActivityIndicator color={colors.fg3} /> : null}
          {task.description ? <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Feather name="file-text" size={17} color={colors.fg3} accessible={false} />
              <Text style={styles.sectionLabel}>Notes</Text>
            </View>
            <View style={{ padding: 12, backgroundColor: colors.bg3, borderColor: colors.line, borderWidth: 1, borderRadius: 8 }}>
              <Text selectable style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.fg2 }}>{task.description}</Text>
            </View>
          </View> : null}
          <View style={{ gap: 12 }}>
            <DetailRow icon="calendar" label="Starts" value={task.start ? date(task.start) : "Not set"} />
            <DetailRow icon="clock" label="Due" value={`${task.due ? date(task.due) : "Not set"}${task.isAllDay ? " · All day" : ""}`} />
            {task.completedAt ? <DetailRow icon="check-circle" label="Completed" value={date(task.completedAt, true)} /> : null}
            {repeat ? <DetailRow icon="repeat" label="Repeat" value={repeat} /> : null}
            {task.relatedTo ? relatedTask && onOpenRelated ? (
              <Tap disabled={busy} accessibilityRole="link" accessibilityLabel={`Open related task: ${relatedTask.title}`} onPress={() => onOpenRelated(relatedTask.id)}>
                <DetailRow icon="git-branch" label="Related task" value={relatedTask.title || "Untitled task"} link />
              </Tap>
            ) : <DetailRow icon="git-branch" label="Related task" value={relatedTask?.title || "Task unavailable"} /> : null}
            {task.url ? <Tap onPress={() => {
              if (!/^https?:\/\//i.test(task.url!)) { showToast({ message: "This link type cannot be opened." }); return; }
              void Linking.openURL(task.url!).catch(() => showToast({ message: "Could not open task link." }));
            }} accessibilityRole="link" accessibilityLabel="Open task link"><DetailRow icon="link" label="Link" value={task.url} link /></Tap> : null}
          </View>
        </ScrollView>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginHorizontal: -22, paddingBottom: insets.bottom, borderTopWidth: 1, borderTopColor: colors.line }}>
          {editable ? <Tap style={styles.modalActionBtn} accessibilityLabel="Edit task" disabled={busy} onPress={() => setEditing(true)}><Feather name="edit-2" size={20} color={colors.fg} /><Text style={{ color: colors.fg, fontSize: 10 }}>Edit</Text></Tap> : null}
          {canShare ? <Tap style={styles.modalActionBtn} accessibilityLabel="Task sharing actions" disabled={busy} onPress={() => setSharingMenu(true)}><Feather name="link" size={20} color={colors.fg} /><Text style={{ color: colors.fg, fontSize: 10 }}>Share</Text></Tap> : null}
          {capabilities.delete ? <Tap style={styles.modalActionBtn} accessibilityLabel="Delete task" haptic="warn" disabled={busy} onPress={() => confirm({ title: "Delete task?", message: task.title, confirmLabel: "Delete" }, () => {
            if (busy) return;
            setActionBusy(true);
            void api.removeTask(task).then(() => { onSaved(null); onClose(); }).catch(error => showToast({ message: userFacingError(error, "Could not delete task.") })).finally(() => setActionBusy(false));
          })}><Feather name="trash" size={20} color={colors.accent} /><Text style={{ color: colors.accent, fontSize: 10 }}>Delete</Text></Tap> : null}
          <Tap style={styles.modalActionBtn} accessibilityLabel="Task delivery" disabled={busy} onPress={() => setShowDelivery(true)}><Feather name="send" size={20} color={colors.fg} /><Text style={{ color: colors.fg, fontSize: 10 }}>Delivery</Text></Tap>
        </View>
      </Animated.View>

    </GestureHandlerRootView>
    {editing && editable && calendar ? <TaskEditorModal key={task.id + ":" + (task.providerReadRetiredGeneration ?? 0)} task={task} calendarID={calendar.id} calendars={[calendar]} onClose={() => setEditing(false)} onSave={async draft => {
      const saved = await api.updateTask(task, draft); onSaved(saved);
    }} /> : null}
    {showDelivery ? <TaskDeliveryModal taskId={task.id} onClose={() => setShowDelivery(false)} /> : null}
    <OptionPicker visible={sharingMenu} title="Task sharing" options={[
      ...(capabilities.link ? [{ label: "Link to another calendar", value: "link", icon: "link" as const }] : []),
      ...(capabilities.fork ? [{ label: "Make an independent copy", value: "fork", icon: "copy" as const }] : []),
      ...memberships.filter(member => capabilities.unlinkCalendarIDs.includes(member.id)).map(member => ({ label: `Remove from ${member.name}`, value: `unlink:${member.id}`, icon: "minus-circle" as const })),
    ]} onSelect={value => { if (busy) return; if (value.startsWith("unlink:")) unlink(value.slice(7)); else setSharingAction(value as "link" | "fork"); }} onClose={() => setSharingMenu(false)} />
    <OptionPicker visible={!!sharingAction} searchable title={sharingAction === "link" ? "Link to a calendar" : "Make an independent copy"} options={targets.map(member => ({ value: member.id, label: member.name }))} onSelect={calendarID => void share(calendarID)} onClose={() => setSharingAction(undefined)} />
    <OptionPicker visible={!!picker} title={picker === "priority" ? "Task priority" : "Task status"} options={picker === "priority" ? priorities : statuses}
      value={picker === "priority" ? String(task.priority) : task.status} onSelect={value => { if (picker === "priority") onPriority(Number(value)); else onStatus(value as TaskStatus); }} onClose={() => setPicker(undefined)} />
  </ModalPortal>;
}
