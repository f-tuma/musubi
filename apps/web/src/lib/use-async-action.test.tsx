import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAsyncAction } from "~/lib/use-async-action";

describe("useAsyncAction", () => {
  it("always releases its busy state after success", async () => {
    const action = vi.fn(async () => "saved");
    const { result } = renderHook(() => useAsyncAction());
    let pending: Promise<string | undefined>;

    act(() => {
      pending = result.current.run(action, "Could not save.");
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      expect(await pending).toBe("saved");
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("");
  });

  it("shows an Error message and still releases its busy state", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(
        async () => {
          throw new Error("The server rejected this change.");
        },
        "Could not save.",
      );
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe("The server rejected this change.");
  });

  it("uses the caller's fallback and ignores a duplicate action", async () => {
    let resolveAction: (() => void) | undefined;
    const firstAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );
    const duplicateAction = vi.fn(async () => undefined);
    const { result } = renderHook(() => useAsyncAction());
    let firstPending: Promise<void | undefined>;

    act(() => {
      firstPending = result.current.run(firstAction, "Could not connect.");
    });
    await act(async () => {
      await result.current.run(duplicateAction, "Could not connect.");
    });
    expect(duplicateAction).not.toHaveBeenCalled();

    await act(async () => {
      resolveAction?.();
      await firstPending;
    });

    await act(async () => {
      await result.current.run(
        async () => Promise.reject("unknown failure"),
        "Could not connect.",
      );
    });
    expect(result.current.error).toBe("Could not connect.");
  });
});
