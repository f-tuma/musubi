type AppUpdateConfig = {
  platform: string;
  iosAppStoreUrl?: string;
  iosTestFlightUrl?: string;
};

/** Keep the action and its name aligned with the actual distribution channel. */
export function appUpdateTarget({ platform, iosAppStoreUrl, iosTestFlightUrl }: AppUpdateConfig) {
  if (platform !== "ios") {
    return { url: "https://play.google.com/store/apps/details?id=dev.frgtn.musubi", label: "Open Play Store" };
  }
  if (iosAppStoreUrl) return { url: iosAppStoreUrl, label: "Open App Store" };
  if (iosTestFlightUrl) return { url: iosTestFlightUrl, label: "Open TestFlight" };
  return { url: "https://musubi.pro", label: "Open download page" };
}
