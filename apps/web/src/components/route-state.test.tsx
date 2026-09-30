import { render, screen } from "@testing-library/react";
import { RouteState } from "~/components/route-state";
import { Button } from "~/components/ui/button";

it("connects a busy route state to its title and recovery action", () => {
  render(
    <RouteState
      actions={<Button>Try again</Button>}
      busy
      description="The server did not respond."
      requestId="request-123"
      title="We could not open this calendar"
    />,
  );

  const main = screen.getByRole("main", { name: "We could not open this calendar" });
  expect(main.getAttribute("aria-busy")).toBe("true");
  expect(main.getAttribute("tabindex")).toBe("-1");
  expect(screen.getByText("Request ID: request-123")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
});
