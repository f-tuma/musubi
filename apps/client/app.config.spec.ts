import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rootPackage from "../../package.json";

const listing = "https://apps.apple.com/cz/app/musubi/id1234567890";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("EAS_BUILD_PROFILE", undefined);
  vi.stubEnv("EAS_BUILD_PLATFORM", undefined);
  vi.stubEnv("EXPO_PUBLIC_IOS_APP_STORE_URL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const config = async () => (await import("./app.config")).default;

describe("native release configuration", () => {
  it("inherits the product version and keeps the download fallback when no iOS listing is supplied", async () => {
    const result = await config();
    expect(result.version).toBe(rootPackage.version);
    expect(result.extra?.iosAppStoreUrl).toBeUndefined();
  });

  it("does not require an iOS listing for production Android", async () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "production");
    vi.stubEnv("EAS_BUILD_PLATFORM", "android");
    expect((await config()).extra?.iosAppStoreUrl).toBeUndefined();
  });

  it("requires the real listing for production iOS before building", async () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "production");
    vi.stubEnv("EAS_BUILD_PLATFORM", "ios");
    await expect(config()).rejects.toThrow("required for production iOS EAS builds");
  });

  it("embeds a configured direct listing for the update action", async () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "production");
    vi.stubEnv("EAS_BUILD_PLATFORM", "ios");
    vi.stubEnv("EXPO_PUBLIC_IOS_APP_STORE_URL", listing);
    expect((await config()).extra?.iosAppStoreUrl).toBe(listing);
  });

  it.each([
    "https://apps.apple.com/app/id0000000000",
    "https://apps.apple.com/app/id0",
    "http://apps.apple.com/app/id1234567890",
    "https://example.test/app/id1234567890",
    "https://apps.apple.com/app/musubi",
  ])("rejects an invalid supplied listing: %s", async value => {
    vi.stubEnv("EXPO_PUBLIC_IOS_APP_STORE_URL", value);
    await expect(config()).rejects.toThrow("nonzero numeric app id");
  });
});
