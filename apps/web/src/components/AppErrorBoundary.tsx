import type { ErrorComponentProps } from "@tanstack/react-router";
import { Link, useRouter } from "@tanstack/react-router";
import { RouteState } from "~/components/route-state";
import { Button } from "~/components/ui/button";
import { useEffect } from "react";
import { reportError } from "~/telemetry";

export function AppErrorBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => reportError(error), [error]);

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
      description={error instanceof Error && error.message
        ? error.message
        : "An unexpected error interrupted the workspace."}
      title="Musubi could not open this view"
    />
  );
}
