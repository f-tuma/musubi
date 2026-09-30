import type { TaskDeliveryTarget } from "@musubi/types";

export const taskDeliveryLabel: Record<TaskDeliveryTarget["status"], string> = {
  pending: "Pending", attempting: "Sending", completed: "Delivered", "not-needed": "No change needed",
  conflict: "Provider conflict", "not-written": "Not delivered", unconfirmed: "Delivery unconfirmed",
  retry: "Retry pending", blocked: "Delivery blocked", cancelled: "Delivery stopped",
};
export function taskDeliveryCanRetry(target: TaskDeliveryTarget) {
  return target.owned && !["write-unsupported", "permission-unknown", "destination-unavailable", "conflict", "unconfirmed", "recovery-unavailable"].includes(target.issue ?? "") && (target.status === "not-written" || target.status === "blocked");
}
