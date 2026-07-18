import { z } from "zod";
import { UserSchema } from "./user";
import { EventSchema } from "./event";

export const CalendarSchema = z.object({
  id: z.string(),
  creatorID: z.string(),
  name: z.string(),
  color: z.string(),
  members: z.array(UserSchema),
  role: z.string().nullish(), // requesting user's role: owner | editor | viewer
  isDefault: z.boolean().nullish(), // auto-created personal calendar — no delete/transfer
  // external sync origin — null/absent for native Musubi calendars
  provider: z.string().nullish(),
  accountId: z.string().nullish(),
  accountLabel: z.string().nullish(),
  serverUrl: z.string().nullish(), // caldav only — icloud.com host = Apple Calendar
  syncStatus: z.enum(["active", "reconnect_required"]).nullish(),
  syncErrorCode: z.string().nullish(),
});

// Which icon/name to show for a calendar's sync origin ("apple" is caldav
// pointed at iCloud — same protocol, different branding).
export function providerFlavor(cal: Pick<Calendar, "provider" | "serverUrl">): string | null {
  if (cal.provider === "caldav" && cal.serverUrl?.includes("icloud.com")) return "apple";
  return cal.provider ?? null;
}

// Outlook calendars only accept 9 preset colors (Graph's `color` enum;
// `hexColor` is read-only, and Microsoft doesn't document the presets' hex
// values). These hexes are close visual matches used for the client swatches;
// the sync adapter maps ANY stored hex to the nearest preset, so exactness
// only affects looks, never correctness.
export const MICROSOFT_CALENDAR_COLORS: { name: string; hex: string }[] = [
  { name: "lightBlue", hex: "#71B2E7" },
  { name: "lightGreen", hex: "#6BB55C" },
  { name: "lightOrange", hex: "#F1975A" },
  { name: "lightGray", hex: "#9EA3A8" },
  { name: "lightYellow", hex: "#F3D654" },
  { name: "lightTeal", hex: "#4BB4B7" },
  { name: "lightPink", hex: "#E77FB1" },
  { name: "lightBrown", hex: "#A47762" },
  { name: "lightRed", hex: "#E06A6A" },
];

// Nearest preset by RGB distance — malformed input falls back to the first.
export function nearestMicrosoftCalendarColor(hex: string): { name: string; hex: string } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return MICROSOFT_CALENDAR_COLORS[0];
  const v = parseInt(m[1], 16);
  const r = v >> 16, g = (v >> 8) & 0xff, b = v & 0xff;
  let best = MICROSOFT_CALENDAR_COLORS[0];
  let bestD = Infinity;
  for (const c of MICROSOFT_CALENDAR_COLORS) {
    const cv = parseInt(c.hex.slice(1), 16);
    const d = (r - (cv >> 16)) ** 2 + (g - ((cv >> 8) & 0xff)) ** 2 + (b - (cv & 0xff)) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

export type Calendar = z.infer<typeof CalendarSchema>;

export const CalendarWithEventsSchema = CalendarSchema.extend({
  events: z.array(EventSchema),
});

export type CalendarWithEvents = z.infer<typeof CalendarWithEventsSchema>;
