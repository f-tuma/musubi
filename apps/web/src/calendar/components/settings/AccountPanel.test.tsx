import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { uploadAvatar } from "~/api/resources";
import { AccountPanel } from "./AccountPanel";

vi.mock("~/api/resources", () => ({
  deleteAccount: vi.fn(),
  uploadAvatar: vi.fn(),
}));

vi.mock("~/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: "Aki", email: "aki@example.com", image: null } },
      refetch: vi.fn(),
    }),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens the photo chooser from the avatar with the keyboard and restores focus on cancel", async () => {
  const user = userEvent.setup();
  render(<AccountPanel onClose={vi.fn()} onNotice={vi.fn()} />);

  const avatar = screen.getByRole("button", { name: "Change photo" });
  const input = screen.getByLabelText("Change profile photo");
  const openPicker = vi.spyOn(input, "click").mockImplementation(() => {});

  expect(avatar.querySelector('[aria-hidden="true"]')).not.toBeNull();
  expect(screen.queryByText("Change photo")).toBeNull();
  avatar.focus();
  await user.keyboard("{Enter}");
  expect(openPicker).toHaveBeenCalledTimes(1);
  await user.keyboard(" ");
  expect(openPicker).toHaveBeenCalledTimes(2);

  screen.getByRole("button", { name: /Display name/ }).focus();
  fireEvent(input, new Event("cancel", { bubbles: true }));
  expect(document.activeElement).toBe(avatar);
  expect(uploadAvatar).not.toHaveBeenCalled();
});

it("keeps deletion behind a typed confirmation", async () => {
  const user = userEvent.setup();
  render(<AccountPanel onClose={vi.fn()} onNotice={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: /Delete account/ }));
  const confirm = screen.getByRole("button", { name: "Delete account" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByRole("textbox", { name: "Type Aki to confirm" }), "Aki");
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
});
