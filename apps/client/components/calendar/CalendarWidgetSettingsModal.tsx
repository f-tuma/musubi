import { CalendarFilterBar } from "@/components/calendar/CalendarFilterBar";
import { Btn } from "@/components/ui/Btn";
import { ModalPortal as Modal } from "@/components/ui/ModalPortal";
import { colors, fonts, styles } from "@/constants/theme";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { getCalendarWidgetSelection, setCalendarWidgetSelection, getTasksWidgetSelection, setTasksWidgetSelection } from "@/services/agendaWidget";
import { useCalendarsStore } from "@/store/useCalendarsStore";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTasksStore } from "@/store/useTasksStore";
import { taskCalendarIDs } from "@musubi/calendar";

type Props = {
  widgetId: number | null;
  onClose: () => void;
  kind?: "calendar" | "tasks";
};

export default function CalendarWidgetSettingsModal({ widgetId, onClose, kind = "calendar" }: Props) {
  const visible = widgetId !== null;
  const allCalendars = useCalendarsStore(state => state.calendars);
  const tasks = useTasksStore(state => state.tasks);
  const calendars = useMemo(() => allCalendars.filter(calendar => kind === "calendar" || calendar.supportsTasks
    || !calendar.provider || tasks.some(task => taskCalendarIDs(task).includes(calendar.id))), [allCalendars, tasks, kind]);
  const insets = useSafeAreaInsets();
  const { slideStyle, fadeStyle, gesture, handleClose } = useModalAnimation(visible, onClose);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [soloId, setSoloId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (widgetId === null) return;
    let cancelled = false;
    setLoading(true);
    const getSelection = kind === "tasks" ? getTasksWidgetSelection : getCalendarWidgetSelection;
    getSelection(widgetId)
      .then(saved => {
        if (cancelled) return;
        setSelected(new Set(saved ?? calendars.map(calendar => calendar.id)));
        setSoloId(null);
      })
      .catch(error => { if (!cancelled) console.warn("Widget selection could not load:", error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [widgetId, kind, calendars]);

  const commit = (next: Set<string>, nextSoloId: string | null) => {
    setSelected(next);
    setSoloId(nextSoloId);
    if (widgetId !== null) {
      const setSelection = kind === "tasks" ? setTasksWidgetSelection : setCalendarWidgetSelection;
      setSelection(widgetId, [...next])
        .catch(error => console.warn("Calendar widget selection failed:", error));
    }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    commit(next, null);
  };

  const solo = (id: string) => {
    if (soloId === id) {
      commit(new Set(calendars.map(calendar => calendar.id)), null);
    } else {
      commit(new Set([id]), id);
    }
  };

  const showAll = () => commit(new Set(calendars.map(calendar => calendar.id)), null);

  return (
    <Modal visible={visible} onRequestClose={handleClose} transparent animationType="none" statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[styles.modalOverlay, fadeStyle]}>
          <Pressable style={{ flex: 1 }} onPress={handleClose} accessible={false} />
        </Animated.View>

          <Animated.View style={[styles.modalSheet, fadeStyle, slideStyle]}>
            <GestureDetector gesture={gesture}>
              <View collapsable={false}>
            <View style={styles.modalHandle} />
            <View style={[styles.modalTitleRow, { paddingBottom: 6 }]}>
              <Text style={styles.modalTitle}>Widget calendars</Text>
            </View>
              </View>
            </GestureDetector>
            <Text style={{
              paddingHorizontal: 16,
              paddingBottom: 14,
              fontFamily: fonts.sans,
              fontSize: 13,
              lineHeight: 18,
              color: colors.fg3,
            }}>
              Choose which calendars appear in this widget. This won&apos;t change your filters in Musubi.
            </Text>

            {loading ? (
              <View style={{ height: 52, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={colors.fg3} />
              </View>
            ) : (
              <CalendarFilterBar
                calendars={calendars}
                activeCals={selected}
                soloCalId={soloId}
                onToggle={toggle}
                onSolo={solo}
              />
            )}

            <Text style={{
              paddingHorizontal: 16,
              paddingTop: 12,
              fontFamily: fonts.sans,
              fontSize: 11,
              color: colors.fg3,
            }}>
              Tap to show or hide · Long-press to show only one
            </Text>
            <View style={{
              flexDirection: "row",
              gap: 10,
              padding: 16,
              paddingBottom: insets.bottom + 16,
            }}>
              <Btn label="Show all" variant="secondary" onPress={showAll} style={{ flex: 1 }} />
              <Btn label="Done" onPress={handleClose} style={{ flex: 1 }} />
            </View>
          </Animated.View>

      </GestureHandlerRootView>
    </Modal>
  );
}
