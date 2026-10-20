/** Public stable URLs follow current artwork; mobile snapshots remain private and frozen. */
const base = "https://vardum.com/w/musubi/brand/web-app";

export const BRAND_ASSETS = {
  favicon: `${base}/favicon-linked`,
  appleTouchIcon: `${base}/apple-touch-icon`,
  social: `${base}/og`,
  logoInk: `${base}/logo-ink`,
  logoAccent: `${base}/logo-accent`,
  notificationIcon: `${base}/apple-touch-icon`,
} as const;
