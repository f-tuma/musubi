import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { TaskDelivery, TaskDeliveryTarget } from "@musubi/types";
import { taskDeliveryCanRetry, taskDeliveryLabel } from "@musubi/calendar";
import { useApi } from "@/services/api";
import { useServer } from "@/contexts/ServerContext";
import { useModalAnimation } from "@/hooks/useModalAnimation";
import { ModalPortal } from "@/components/ui/ModalPortal";
import { BottomSheetFrame } from "@/components/ui/BottomSheetFrame";
import { Btn } from "@/components/ui/Btn";
import { Tap } from "@/components/ui/Tap";
import { colors, styles } from "@/constants/theme";
import { userFacingError } from "@/lib/network";

export function TaskDeliveryModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { apiUrl, authClient } = useServer();
  const scope = JSON.stringify([apiUrl, authClient.useSession().data?.user.id, taskId]);
  return <ScopedTaskDelivery key={scope} taskId={taskId} onClose={onClose} />;
}

function ScopedTaskDelivery({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const api = useApi();
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const [delivery, setDelivery] = useState<TaskDelivery>();
  const [loading, setLoading] = useState(true), [pending, setPending] = useState<string>(), [error, setError] = useState<string>();
  const request = useRef(0);
  const motion = useModalAnimation(true, onClose);
  const close = () => { if (!pending) void motion.handleClose(); };
  const read = useCallback(async (generation: number) => {
    try { const delivery = await apiRef.current.getTaskDelivery(taskId); if (generation === request.current) setDelivery(delivery); }
    catch (error) { if (generation === request.current) { setDelivery(undefined); setError(userFacingError(error, "Could not load task delivery.")); } }
    finally { if (generation === request.current) setLoading(false); }
  }, [taskId]);
  function refresh() { setLoading(true); setError(undefined); void read(++request.current); }
  useEffect(() => { const counter = request; void read(++counter.current); return () => { counter.current++; }; }, [read]);
  async function retry(target: TaskDeliveryTarget) {
    if (pending || !taskDeliveryCanRetry(target)) return;
    setPending(target.operationId); setError(undefined);
    const generation = ++request.current;
    try { const delivery = await apiRef.current.retryTaskDelivery(taskId, target.operationId); if (generation === request.current) setDelivery(delivery); }
    catch (error) { if (generation === request.current) { setError(userFacingError(error, "Could not retry task delivery.")); setDelivery(undefined); } }
    finally { if (generation === request.current) setPending(undefined); }
  }
  return <ModalPortal visible onRequestClose={close}><BottomSheetFrame motion={motion} onClose={close} dismissible={!pending} header={<View style={styles.modalTitleRow}><Text style={styles.modalTitle}>Task delivery</Text><Tap accessibilityLabel="Close task delivery" disabled={!!pending} onPress={close}><Feather name="x" size={20} color={colors.fg3} /></Tap></View>}>
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
      {loading ? <ActivityIndicator color={colors.fg3} /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
      {delivery?.targets.map(target => <View key={target.operationId} style={{ gap: 8 }}><Text style={styles.fieldLabel}>{target.calendarName ?? "Calendar"}</Text><Text style={styles.fieldValueText}>{taskDeliveryLabel[target.status]}</Text>{taskDeliveryCanRetry(target) ? <Btn label="Retry" variant="secondary" loading={pending === target.operationId} disabled={!!pending} onPress={() => void retry(target)} /> : null}</View>)}
      {delivery && !delivery.targets.length ? <Text style={styles.fieldValueText}>No provider deliveries</Text> : null}
      <Btn label="Refresh" variant="secondary" loading={loading} disabled={!!pending} onPress={() => void refresh()} />
    </ScrollView>
  </BottomSheetFrame></ModalPortal>;
}
