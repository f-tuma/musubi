import { Link } from "@tanstack/react-router";
import { RouteState } from "~/components/route-state";
import { Button } from "~/components/ui/button";

export function NotFound() {
  return (
    <RouteState
      actions={
        <Button asChild>
          <Link to="/">Open Musubi</Link>
        </Button>
      }
      description="The link may be old, or the page has moved."
      title="Page not found"
    />
  );
}
