import dayjs from "dayjs";
import type { Settings } from "@musubi/types";

// One place that turns the user's time/date-format settings into strings, so
// every screen shows dates and times the same way. Backed by dayjs (English
// month/day names).
export type TimeFormat = Settings["timeFormat"]; // "12h" | "24h"
export type DateFormat = Settings["dateFormat"]; // "dmy" | "mdy" | "ymd"

/** "14:30" (24h) or "2:30 PM" (12h). */
export const formatTime = (d: Date, tf: TimeFormat) =>
  dayjs(d).format(tf === "12h" ? "h:mm A" : "H:mm");

// Medium form for chips/rows, e.g. "31 Dec 2026" / "Dec 31, 2026" / "2026 Dec 31".
const MEDIUM: Record<DateFormat, string> = { dmy: "D MMM YYYY", mdy: "MMM D, YYYY", ymd: "YYYY MMM D" };
export const formatDateMedium = (d: Date, df: DateFormat) => dayjs(d).format(MEDIUM[df]);

// Long descriptive form with weekday, ordered to match the preference.
const LONG: Record<DateFormat, string> = { dmy: "dddd, D MMMM", mdy: "dddd, MMMM D", ymd: "dddd, D MMMM" };
export const formatDateLong = (d: Date, df: DateFormat) => dayjs(d).format(LONG[df]);
