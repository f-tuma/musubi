import { describe, expect, it } from "vitest";
import { isNetworkError, userFacingError } from "./network";

describe("request errors", () => {
  it.each([
    { status: 403, message: "Provider network request failed. No changes were saved." },
    new Error("503: Provider is offline"),
  ])("preserves an HTTP rejection instead of blaming the device connection", error => {
    expect(isNetworkError(error)).toBe(false);
    expect(userFacingError(error)).not.toContain("No internet connection");
  });

  it("preserves the event preflight rejection", () => {
    expect(userFacingError(new Error("Event writing is unknown. No changes were saved.")))
      .toBe("Event writing is unknown. No changes were saved.");
  });

  it.each([new Error("Network request failed"), { status: 0, message: "Transport failed" }])
    ("recognizes an actual transport failure", error => {
      expect(isNetworkError(error)).toBe(true);
      expect(userFacingError(error)).toBe("No internet connection. Check your connection and try again.");
    });

  it.each([new Error("The operation was aborted"), { status: 408, message: "Request timeout" }])
    ("does not diagnose the user's network from a timeout", error => {
      expect(userFacingError(error)).toBe("The request took too long. Please try again.");
    });
});
