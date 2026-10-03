import { taskDeliveryLabel, taskDeliveryCanRetry } from "@musubi/calendar";
import type { TaskDeliveryTarget } from "@musubi/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getTaskDelivery, retryTaskDelivery } from "~/api/resources";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { Button } from "~/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Empty } from "~/components/ui/empty";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { ItemGroup } from "~/components/ui/item";
import { Row } from "~/components/ui/row";

export { taskDeliveryLabel, taskDeliveryCanRetry } from "@musubi/calendar";

export function TaskDeliveryDialog({ taskId, userId, returnFocus, onClose, onOpenConnections }: {
  taskId: string; userId: string; returnFocus?: HTMLElement | null; onClose: () => void; onOpenConnections?: () => void;
}) {
  const client = useQueryClient();
  const key = [...queryKeys.delivery(getServerOrigin(), userId), "task", taskId];
  const delivery = useQuery({ queryKey: key, queryFn: ({ signal }) => getTaskDelivery(taskId, signal), retry: false, meta: { persist: false } });
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  async function retry(target: TaskDeliveryTarget) {
    if (pending || !taskDeliveryCanRetry(target)) return;
    setPending(target.operationId); setError(undefined);
    try { const result = await retryTaskDelivery(taskId, target.operationId); client.setQueryData(key, result); await client.invalidateQueries({ queryKey: queryKeys.delivery(getServerOrigin(), userId) }); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not retry task delivery."); await delivery.refetch(); }
    finally { setPending(undefined); }
  }
  const targets = delivery.isError ? [] : delivery.data?.targets ?? [];
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent closeLabel="Close task delivery" size="form" returnFocus={returnFocus} aria-busy={delivery.isFetching || !!pending} dismissOnOutsideInteraction={!pending} onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}>
      <DialogHeader><div className="flex items-center gap-2"><DialogTitle>Task delivery</DialogTitle><HelpTooltip label="About task delivery">The task is saved in Musubi. Each provider receives that revision independently. Unconfirmed creation stays visible until the provider result is verified.</HelpTooltip></div></DialogHeader>
      <DialogBody>
        {delivery.isError ? <InlineError actions={<Button size="compact" variant="secondary" onClick={() => void delivery.refetch()}>Retry</Button>}>Could not load task delivery.</InlineError> : null}
        {!targets.length && !delivery.isError ? <Empty title={delivery.isPending ? "Loading delivery" : "No provider deliveries"} /> : null}
        {targets.length ? <ItemGroup>{targets.map(target => <Row key={target.operationId} label={target.calendarName ?? "Calendar"} detail={target.provider} value={taskDeliveryLabel[target.status]} trailing={target.issue === "reconnect-required" && target.owned && onOpenConnections ? <Button size="compact" variant="secondary" disabled={!!pending} onClick={onOpenConnections}>Reconnect</Button> : taskDeliveryCanRetry(target) ? <Button size="compact" variant="secondary" loading={pending === target.operationId} disabled={!!pending} onClick={() => void retry(target)}>Retry</Button> : undefined} />)}</ItemGroup> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </DialogBody>
      <DialogFooter><Button variant="ghost" loading={delivery.isFetching} disabled={!!pending} onClick={() => void delivery.refetch()}>Refresh</Button><Button className="ml-auto" variant="secondary" disabled={!!pending} onClick={onClose}>Close</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
