/**
 * Canonical theme values shared by all Musubi renderers.
 *
 * These names describe purpose, never a platform or a component. Platform
 * packages may adapt them to CSS custom properties, React Native themes, or
 * other renderer-specific representations without changing their meaning.
 */
export const themeTokens = {
  light: {
    surfaceCanvas: "#f4f1e8",
    surfacePanel: "#efebe0",
    surfaceRaised: "#e8e3d5",
    surfaceSunken: "#dfd9c9",
    surfaceOverlay: "rgba(244, 241, 232, 0.94)",
    borderSubtle: "rgba(28, 27, 24, 0.08)",
    borderMedium: "rgba(28, 27, 24, 0.13)",
    borderStrong: "rgba(28, 27, 24, 0.24)",
    textPrimary: "#1c1b18",
    textSecondary: "rgba(28, 27, 24, 0.74)",
    // The lightest ink that still clears 4.5:1 as small text on every surface —
    // 0.64 gives 4.52:1 on the sunken one, which is the worst case. Anything
    // lighter is a decoration, not text (see textFaint).
    textMuted: "rgba(28, 27, 24, 0.64)",
    // Icons, dividers and disabled controls only. Text in this level fails AA
    // at every size, so it must not carry words.
    textFaint: "rgba(28, 27, 24, 0.32)",
    accentPrimary: "#b3492f",
    // Pure white keeps destructive controls above 4.5:1 on the shu accent.
    accentOnPrimary: "#fff",
    controlFill: "#4a4741",
    controlOnFill: "#f4f1e8",
    shadowRaised: "0 1px 2px rgba(47, 41, 31, 0.12)",
    shadowOverlay: "0 24px 64px rgba(47, 41, 31, 0.16)",
  },
  dark: {
    surfaceCanvas: "#0c0c0e",
    surfacePanel: "#131316",
    surfaceRaised: "#1a1a1e",
    surfaceSunken: "#222226",
    surfaceOverlay: "rgba(19, 19, 22, 0.96)",
    borderSubtle: "rgba(232, 228, 217, 0.06)",
    borderMedium: "rgba(232, 228, 217, 0.1)",
    borderStrong: "rgba(232, 228, 217, 0.18)",
    textPrimary: "#e8e4d9",
    textSecondary: "rgba(232, 228, 217, 0.72)",
    textMuted: "rgba(232, 228, 217, 0.56)",
    textFaint: "rgba(232, 228, 217, 0.28)",
    accentPrimary: "#c8553d",
    accentOnPrimary: "#000",
    controlFill: "#e8e4d9",
    controlOnFill: "#0c0c0e",
    shadowRaised: "0 1px 2px rgba(0, 0, 0, 0.32)",
    shadowOverlay: "0 28px 72px rgba(0, 0, 0, 0.48)",
  },
} as const;

export type ThemeScheme = keyof typeof themeTokens;
export type ThemeTokenName = keyof (typeof themeTokens)[ThemeScheme];
export type ThemeTokens = Record<ThemeTokenName, string>;

export const themeTokenCssVariables = {
  surfaceCanvas: "--surface-canvas",
  surfacePanel: "--surface-panel",
  surfaceRaised: "--surface-raised",
  surfaceSunken: "--surface-sunken",
  surfaceOverlay: "--surface-overlay",
  borderSubtle: "--border-subtle",
  borderMedium: "--border-medium",
  borderStrong: "--border-strong",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  textFaint: "--text-faint",
  accentPrimary: "--accent-primary",
  accentOnPrimary: "--accent-on-primary",
  controlFill: "--control-fill",
  controlOnFill: "--control-on-fill",
  shadowRaised: "--shadow-raised",
  shadowOverlay: "--shadow-overlay",
} as const satisfies Record<ThemeTokenName, `--${string}`>;
