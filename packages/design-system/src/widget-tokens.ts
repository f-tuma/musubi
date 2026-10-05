import { parseColor } from "./contrast";
import {
  controlHeights,
  fineSpacing,
  layoutSpacing,
  radii,
  spacing,
  typeSizes,
} from "./foundation-tokens";
import { themeTokens, type ThemeScheme } from "./theme-tokens";

/**
 * Appearance contract shared by Musubi's home-screen widgets. Values keep the
 * same optical roles as the app; native renderers supply their own units and
 * supported fonts. RemoteViews may use system serif/sans rather than the app's
 * runtime-loaded font assets, so metadata retains the readable 12-point step.
 */
export const widgetTokens = {
  layout: {
    minListWidth: 180,
    minListHeight: 180,
    minCalendarWidth: 250,
    minCalendarHeight: 280,
    inset: spacing[4],
    radius: radii.sheet,
    headerHeight: controlHeights.touch.control,
    controlSize: controlHeights.touch.compact,
    // Named control symbols are icons, so their visual size uses dp while
    // user-facing words keep scalable sp sizing in the type contract below.
    controlGlyphSize: typeSizes[24],
    // Vectors fill their box more fully than font glyphs.
    controlIconSize: typeSizes[18],
    rowHeight: controlHeights.touch.control,
    rowGap: spacing[1],
    contentGap: spacing[2],
    stripeWidth: fineSpacing[0.5],
    timeColumnWidth: controlHeights.touch.control,
    timeColumnWideWidth: layoutSpacing[24],
    calendarWeekdayHeight: spacing[6],
    calendarNumberAreaHeight: spacing[6],
    calendarTodaySize: spacing[6],
    // Larger slots retain full text height; empty all-day lanes use this same
    // geometry so continuation bars do not jump between rows.
    calendarPillHeight: spacing[5],
    calendarPillGap: fineSpacing[0.5],
    calendarPillInset: spacing[1],
    calendarOverflowHeight: spacing[4],
    yearWidth: spacing[8],
    yearHeight: spacing[6],
  },
  type: {
    titleSize: typeSizes[14],
    headerTitleSize: typeSizes[18],
    metaSize: typeSizes[12],
    dateSize: typeSizes[12],
    statusSize: typeSizes[12],
    monthTitleSize: typeSizes[20],
    markSize: typeSizes[24],
    calendarDaySize: typeSizes[13],
    calendarNumberSize: typeSizes[12],
    calendarPillSize: typeSizes[11],
    calendarOverflowSize: typeSizes[11],
    yearSize: typeSizes[16],
  },
  // Feedback is decoration rather than a text-bearing surface.
  pressFeedbackOpacity: 0.25,
} as const;

function palette(scheme: ThemeScheme) {
  const theme = themeTokens[scheme];
  const { rgb } = parseColor(theme.accentPrimary);
  return {
    surface: theme.surfacePanel,
    surfaceRaised: theme.surfaceRaised,
    foreground: theme.textPrimary,
    foregroundSecondary: theme.textSecondary,
    foregroundMuted: theme.textMuted,
    accent: theme.accentPrimary,
    onAccent: theme.accentOnPrimary,
    controlFill: theme.controlFill,
    onControl: theme.controlOnFill,
    line: theme.borderSubtle,
    dayFeedback: `rgba(${rgb.join(", ")}, ${widgetTokens.pressFeedbackOpacity})`,
    // Calendar colours belong to user data. Their text must choose between
    // full black and white independently of the widget's own theme; borrowing
    // onAccent in dark mode would accidentally supply two dark candidates.
    pillInk: themeTokens.dark.accentOnPrimary,
    pillInkLight: themeTokens.light.accentOnPrimary,
  };
}

export const widgetThemeTokens = {
  light: palette("light"),
  dark: palette("dark"),
} as const;
