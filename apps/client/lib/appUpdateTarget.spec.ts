import { describe, expect, it } from "vitest";
import { appUpdateTarget } from "./appUpdateTarget";

const beta = "https://testflight.apple.com/join/EqzdPVfC";
const store = "https://apps.apple.com/app/musubi/id1234567890";

describe("mobile update destination", () => {
  it("sends beta iOS users directly to the actual TestFlight channel", () => {
    expect(appUpdateTarget({ platform: "ios", iosTestFlightUrl: beta }))
      .toEqual({ url: beta, label: "Open TestFlight" });
  });
  it("prefers the App Store once a public listing is configured", () => {
    expect(appUpdateTarget({ platform: "ios", iosAppStoreUrl: store, iosTestFlightUrl: beta }))
      .toEqual({ url: store, label: "Open App Store" });
  });
  it("retains the explicit download fallback for an unconfigured preview", () => {
    expect(appUpdateTarget({ platform: "ios" }))
      .toEqual({ url: "https://musubi.pro", label: "Open download page" });
  });
  it("keeps Android on Play even when both iOS channels are configured", () => {
    expect(appUpdateTarget({ platform: "android", iosAppStoreUrl: store, iosTestFlightUrl: beta }))
      .toEqual({ url: "https://play.google.com/store/apps/details?id=dev.frgtn.musubi", label: "Open Play Store" });
  });
});
