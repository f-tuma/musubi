import { RouteState } from "~/components/route-state";
import { Button } from "~/components/ui/button";

type WorkspaceDataStateProps = {
  detail: string;
  kind: "error" | "loading" | "offline";
  onRetry?: () => void;
  requestId?: string;
  title: string;
};

export function WorkspaceDataState({ detail, kind, onRetry, requestId, title }: WorkspaceDataStateProps) {
  return (
    <RouteState
      actions={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
      busy={kind === "loading"}
      description={detail}
      requestId={requestId}
      title={title}
    />
  );
}
