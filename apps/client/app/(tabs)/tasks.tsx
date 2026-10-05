import { useServer } from "@/contexts/ServerContext";
import { taskCapabilities, taskCalendarIDs, taskDisplayCalendar, uniqueTasks } from "@musubi/calendar";
import { acceptTaskMutation, runTaskMutation } from "@/services/taskCollection";
import { useTaskCollection } from "@/hooks/useTaskCollection";
import CalendarWidgetSettingsModal from "@/components/calendar/CalendarWidgetSettingsModal";
import { TaskEditorModal } from "@/components/tasks/TaskEditorModal";
import { spacing, typeSizes } from "@musubi/design-system";
import { uuidv7 } from "uuidv7";
import { TaskDetailModal } from "@/components/tasks/TaskDetailModal";
import { taskPriorityLabel, formatTaskDate } from "@/lib/taskPresentation";
import { useSettingsStore } from "@/store/useSettingsStore";
import { ProviderIcon } from "@/components/calendar/ProviderIcon";
import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { can, providerFlavor, type Task, type TaskStatus } from "@musubi/types";
import { colors, fonts, styles } from "@/constants/theme";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { Tap } from "@/components/ui/Tap";
import { OptionPicker } from "@/components/ui/OptionPicker";
import { Empty } from "@/components/ui/Empty";
import { showToast } from "@/components/ui/Toast";
import { userFacingError } from "@/lib/network";

const phases: { value: TaskStatus; label: string; icon: "circle" | "clock" | "check-circle" | "x-circle" }[] = [
  { value: "needs-action", label: "Needs action", icon: "circle" },
  { value: "in-process", label: "In progress", icon: "clock" },
  { value: "completed", label: "Completed", icon: "check-circle" },
  { value: "cancelled", label: "Cancelled", icon: "x-circle" },
];

export default function TasksTab() {
  const { apiUrl, authClient } = useServer();
  const scope = JSON.stringify([apiUrl, authClient.useSession().data?.user.id]);
  return <TasksTabScreen key={scope} />;
}

function TasksTabScreen() {
  const { tasks, ready, status, refreshing, error, scope, apiRef, refresh } = useTaskCollection();
  const params = useLocalSearchParams<{ taskId?: string | string[]; widgetRefresh?: string | string[]; tasksWidgetId?: string | string[] }>();
  const taskId = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
  const widgetRefresh = Array.isArray(params.widgetRefresh) ? params.widgetRefresh[0] : params.widgetRefresh;
  const tasksWidgetId = Array.isArray(params.tasksWidgetId) ? params.tasksWidgetId[0] : params.tasksWidgetId;
  const widgetSettingsNumber = tasksWidgetId && /^\d+$/.test(tasksWidgetId) ? Number(tasksWidgetId) : NaN;
  const widgetSettingsId = Number.isSafeInteger(widgetSettingsNumber) ? widgetSettingsNumber : null;
  const dateFormat = useSettingsStore(s => s.dateFormat);
  const timeFormat = useSettingsStore(s => s.timeFormat);
  const { calendars, activeCals, soloCalId, toggleCal, soloCalendar } = useCalendarsStore();
  const [phaseFilter, setPhaseFilter] = useState<TaskStatus>("needs-action");
  const [creating, setCreating] = useState<string>();
  const newId = useRef(uuidv7());
  const [detailId, setDetailId] = useState<string>();
  const [selected, setSelected] = useState<Task>();
  const [saving, setSaving] = useState<string>();
  useFocusEffect(useCallback(() => { void refresh().catch(() => {}); }, [refresh]));
  useEffect(() => {
    if (widgetRefresh !== "1" || !scope) return;
    void refresh(true).catch(() => {});
    router.setParams({ widgetRefresh: "" });
  }, [widgetRefresh, scope, refresh]);
  useEffect(() => {
    if (!taskId || !scope) return;
    const task = tasks.find(item => item.id === taskId);
    if (!task && (status === "ready" || status === "unauthorized")) {
      router.setParams({ taskId: "" });
      if (status === "ready") showToast({ message: "This task is no longer available." });
    }
  }, [taskId, scope, tasks, status]);
  // A widget link remains the source of the open detail until it is dismissed.
  // Deriving it avoids copying asynchronous hydration into component state and
  // also lets a repeated link replace whichever task is already open.
  const closeDetail = () => {
    setDetailId(undefined);
    if (taskId) router.setParams({ taskId: "" });
  };
  const openDetail = (id: string) => {
    setDetailId(id);
    if (taskId) router.setParams({ taskId: "" });
  };

  const changeTask = async (task: Task | undefined, change: { status: TaskStatus } | { priority: number }) => {
    if (!task || saving || !taskCapabilities(task, calendars).edit) return;
    setSaving(task.id);
    const api = apiRef.current;
    try {
      const saved = await runTaskMutation(scope, api, task.id, () => "status" in change
        ? api.setTaskStatus(task, change.status) : api.setTaskPriority(task, change.priority));
      if (!saved) closeDetail();
    } catch (e) {
      showToast({ message: userFacingError(e, "Could not update task.") });
    } finally { setSaving(undefined); }
  };

  const detail = tasks.find(task => task.id === (taskId && ready ? taskId : detailId));
  const detailCalendar = detail ? taskDisplayCalendar(detail, calendars) : undefined;
  const detailEditable = !!detail && taskCapabilities(detail, calendars).edit;

  const filtered = uniqueTasks(tasks).filter(task => taskCalendarIDs(task).some(id => activeCals.has(id)));
  const taskCalendars = calendars.filter(calendar => calendar.supportsTasks || !calendar.provider || tasks.some(task => taskCalendarIDs(task).includes(calendar.id)));

  return <View style={styles.screen}>
    <View style={[styles.header, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
      <Text style={styles.screenTitle}>Tasks</Text>
      <Tap accessibilityLabel="Refresh tasks" onPress={() => { void refresh(true).catch(() => {}); }} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        {refreshing ? <ActivityIndicator color={colors.fg3} /> : <Feather name="refresh-cw" size={18} color={colors.fg3} />}
      </Tap>
    </View>
    <CalendarFilterBar calendars={taskCalendars} activeCals={activeCals} soloCalId={soloCalId} onToggle={toggleCal} onSolo={soloCalendar} />
    <View accessibilityRole="tablist" style={{ flexDirection: "row", paddingHorizontal: spacing[2], backgroundColor: colors.bg1, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      {phases.map(phase => <Tap key={phase.value} accessibilityRole="tab" accessibilityLabel={`${phase.label}, ${filtered.filter(task => task.status === phase.value).length} tasks`} accessibilityState={{ selected: phaseFilter === phase.value }}
        onPress={() => setPhaseFilter(phase.value)} scaleTo={1} style={{ flex: 1, minHeight: 52, paddingVertical: spacing[2], alignItems: "center", justifyContent: "center", gap: spacing[1], borderBottomWidth: 2, borderBottomColor: phaseFilter === phase.value ? colors.fg3 : "transparent" }}>
        <Feather name={phase.icon} size={16} color={phaseFilter === phase.value ? colors.fg : colors.fg3} />
        <Text style={{ fontFamily: fonts.sans, fontSize: typeSizes[11], color: phaseFilter === phase.value ? colors.fg : colors.fg3 }}>{phase.label}</Text>
      </Tap>)}
    </View>
    <ScrollView key={phaseFilter} contentContainerStyle={{ paddingHorizontal: spacing[4], paddingTop: spacing[1], paddingBottom: 96, gap: spacing[4] }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(true).catch(() => {}); }} />}>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.fg2 }}>{error}</Text> : null}
      {ready && !filtered.some(task => task.status === phaseFilter) && !refreshing && !error ? <Empty kanji="静" text="No tasks in this view" /> : null}
      {phases.filter(phase => phase.value === phaseFilter).map(phase => {
        const items = filtered.filter(task => task.status === phase.value);
        if (!items.length) return null;
        return <View key={phase.value}>
          {items.map((task, index) => {
            const calendar = taskDisplayCalendar(task, calendars);
            const editable = taskCapabilities(task, calendars).edit;
            return <View key={task.id} style={{ flexDirection: "row", alignItems: "center", gap: spacing[2], paddingVertical: spacing[3], borderBottomWidth: index < items.length - 1 ? 1 : 0, borderBottomColor: colors.line }}>
              <Tap disabled={!editable || !!saving} accessibilityLabel={`Change status of ${task.title}, ${phase.label}`} onPress={() => setSelected(task)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                {saving === task.id ? <ActivityIndicator color={colors.fg3} /> : <Feather name={phase.icon} size={21} color={colors.fg3} />}
              </Tap>
              <Tap onPress={() => openDetail(task.id)} accessibilityLabel={`Open task: ${task.title}`} scaleTo={1} style={{ flex: 1, gap: spacing[1], minHeight: 44, justifyContent: "center" }}>
                <Text style={{ fontFamily: fonts.sans, fontSize: typeSizes[15], color: task.status === "completed" || task.status === "cancelled" ? colors.fg3 : colors.fg, textDecorationLine: task.status === "completed" ? "line-through" : "none" }}>{task.title}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <ProviderIcon provider={calendar ? providerFlavor(calendar) : undefined} color={calendar?.color ?? colors.fg3} />
                  <Text style={{ flexShrink: 1, fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>{calendar?.name ?? "Calendar"}{task.due ? ` · ${formatTaskDate(task.due, task.isAllDay, dateFormat, timeFormat)}` : ""}</Text>
                  {task.priority > 0 && task.priority <= 5 ? <>
                  <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>·</Text>
                  <Feather name="flag" size={13} color={task.priority > 0 && task.priority <= 4 ? colors.accent : colors.fg3} />
                  <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.fg3 }}>{taskPriorityLabel(task.priority)}</Text>
                  </> : null}
                  {task.description ? <Feather name="align-left" size={13} color={colors.fg3} /> : null}
                  {task.recurrence ? <Feather name="repeat" size={13} color={colors.fg3} /> : null}
                </View>
              </Tap>
            </View>;
          })}
        </View>;
      })}
    </ScrollView>
    {!creating && calendars.some(calendar => can(calendar.role, "editTasks") && (!calendar.provider || calendar.supportsTasks === true)) ? <Tap style={styles.fab} haptic="thump" accessibilityLabel="Create task" onPress={() => {
      const editable = calendars.filter(calendar => can(calendar.role, "editTasks") && (!calendar.provider || calendar.supportsTasks === true));
      const target = editable.find(calendar => activeCals.has(calendar.id)) ?? editable[0];
      if (target) { newId.current = uuidv7(); setCreating(target.id); }
    }}><Text style={{ color: colors.onFill, fontSize: 28, lineHeight: 30 }}>+</Text></Tap> : null}
    {creating ? <TaskEditorModal calendarID={creating} calendars={calendars.filter(calendar => can(calendar.role, "editTasks") && (!calendar.provider || calendar.supportsTasks === true))} onClose={() => setCreating(undefined)} onSave={async draft => {
      const api = apiRef.current;
      const saved = await runTaskMutation(scope, api, newId.current, () => api.createTask({ ...draft, id: newId.current }));
      if (!saved) return;
      setPhaseFilter(saved.status);
      if (!activeCals.has(saved.calendarID)) toggleCal(saved.calendarID);
    }} /> : null}
    {detail ? <TaskDetailModal key={detail.id} task={detail} relatedTask={tasks.find(item => item.id === detail.relatedTo)} onOpenRelated={openDetail} calendar={detailCalendar} calendars={calendars} editable={detailEditable} busy={!!saving} onSaved={saved => { if (acceptTaskMutation(scope, detail.id, saved) && !saved) closeDetail(); }} onClose={closeDetail} onStatus={status => void changeTask(detail, { status })} onPriority={priority => void changeTask(detail, { priority })} /> : null}
    <OptionPicker visible={!!selected} title="Task status" options={phases} value={selected?.status} onSelect={value => void changeTask(selected, { status: value as TaskStatus })} onClose={() => setSelected(undefined)} />
    <CalendarWidgetSettingsModal kind="tasks" widgetId={widgetSettingsId} onClose={() => router.setParams({ tasksWidgetId: "" })} />
  </View>;
}
