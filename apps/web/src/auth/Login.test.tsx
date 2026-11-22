import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "~/routes/login";

const mocks = vi.hoisted(() => ({
  social: vi.fn(),
  search: {} as { redirect?: string; error?: string | string[] },
  capabilities: {} as { signUp?: boolean },
}));
vi.mock("~/auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }), signIn: { social: mocks.social } },
}));
vi.mock("~/api/resources", () => ({
  getServerCapabilities: async () => ({ socialsWeb: ["google"], ...mocks.capabilities }),
}));
vi.mock("@tanstack/react-router", async original => ({
  ...await original<object>(),
  createFileRoute: () => (options: { component: unknown }) => ({ options, useSearch: () => mocks.search }),
}));

const LoginRoute = Route.options.component!;
let client: QueryClient;
beforeEach(() => {
  mocks.social.mockReset().mockResolvedValue({});
  mocks.capabilities = {};
  mocks.search = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });

it.each([
  ["/app/p/calendar/tasks?date=2026-09-25", "/app/p/calendar/tasks?date=2026-09-25"],
  ["/invite/shared-calendar", "/invite/shared-calendar"],
  ["https://example.com/app/calendar", "/app/p/default/month"],
  ["//example.com/app/calendar", "/app/p/default/month"],
  [undefined, "/app/p/default/month"],
])("returns OAuth sign-in to the web origin for redirect %s", async (redirect, destination) => {
  mocks.search = { redirect };
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><LoginRoute /></QueryClientProvider>);
  await user.click(await screen.findByRole("button", { name: "Continue with Google" }));
  expect(mocks.social).toHaveBeenCalledExactlyOnceWith({
    provider: "google",
    callbackURL: `${window.location.origin}${destination}`,
    errorCallbackURL: `${window.location.origin}/login?error=oauth`,
  });
});

it("offers no account creation when the server is closed", async () => {
  mocks.capabilities = { signUp: false };
  render(<QueryClientProvider client={client}><LoginRoute /></QueryClientProvider>);
  await screen.findByRole("button", { name: "Continue with Google" });
  expect(screen.queryByRole("button", { name: "Create one" })).toBeNull();
});

it("says why a provider sign-up was refused", async () => {
  mocks.search = { error: ["oauth", "This_server_does_not_accept_new_accounts."] };
  render(<QueryClientProvider client={client}><LoginRoute /></QueryClientProvider>);
  expect(await screen.findByText("This server does not accept new accounts.")).toBeTruthy();
});
