/** Public role URLs follow shared masters; native assets are bundled frozen snapshots. */
const base = "https://vardum.com/w/musubi/brand/web-app";

export const BRAND_ASSETS = {
  favicon: `${base}/tab-icon`,
  appleTouchIcon: `${base}/touch-icon`,
  social: `${base}/og`,
  logoInk: `${base}/mark-neutral`,
  logoAccent: `${base}/mark-accent`,
  notificationIcon: `${base}/touch-icon`,
} as const;
