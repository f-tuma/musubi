import type { TaskDelivery } from "@musubi/types";
import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, screen, waitFor } from "storybook/test";
import { DESKTOP_MODES } from "../../../.storybook/modes";
import { getServerOrigin, queryKeys } from "~/api/query-keys";
import { TaskDeliveryDialog } from "./TaskDeliveryDialog";

const data: TaskDelivery = { taskId: "review", localRevision: 4, targets: [
  { operationId: "11111111-1111-4111-8111-111111111111", calendarId: "studio", calendarName: "Studio", provider: "caldav", action: "update", status: "completed", revision: 4, owned: true, issue: null, updatedAt: new Date() },
  { operationId: "22222222-2222-4222-8222-222222222222", calendarId: "google", calendarName: "Google Tasks", provider: "google", action: "create", status: "unconfirmed", revision: 4, owned: true, issue: "unconfirmed", updatedAt: new Date() },
] };
function DeliveryStory({ retryable = false }: { retryable?: boolean }) {
  const [client] = useState(() => { const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } }); client.setQueryData([...queryKeys.delivery(getServerOrigin(), "me"), "task", data.taskId], { ...data, targets: data.targets.map(target => retryable && target.status === "unconfirmed" ? { ...target, status: "not-written", issue: "delivery-failed" } : target) }); return client; });
  return <QueryClientProvider client={client}><TaskDeliveryDialog taskId={data.taskId} userId="me" onClose={() => {}} /></QueryClientProvider>;
}
const meta = { title: "Calendar/Tasks/Delivery", component: DeliveryStory, parameters: { chromatic: { modes: DESKTOP_MODES } } } satisfies Meta<typeof DeliveryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UnconfirmedCreate: Story = { play: async () => { await expect(await screen.findByText("Delivery unconfirmed")).toBeVisible(); await expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); } };
export const Retryable: Story = { args: { retryable: true }, play: async () => { await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()); } };
