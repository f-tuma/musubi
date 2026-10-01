import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";
import { RouteState } from "~/components/route-state";
import { Button } from "~/components/ui/button";

export function AppErrorBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <RouteState
      actions={
        <>
          <Button onClick={() => void router.invalidate()}>Try again</Button>
          <Button asChild variant="secondary">
            <Link to="/">Return home</Link>
          </Button>
        </>
      }
      description={error.message || "An unexpected error interrupted the workspace."}
      title="Musubi could not open this view"
    />
  );
}
