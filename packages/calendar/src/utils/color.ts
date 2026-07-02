/**
 * Pick a readable text color for a given background: dark text on light
 * backgrounds, light text on dark ones. Uses the YIQ perceived-brightness
 * formula. Handles `#RGB` / `#RRGGBB`; falls back to `light` for anything it
 * can't parse (rgba(), named colors, undefined).
 *
 * ponytail: threshold 128 is the standard YIQ midpoint — nudge up to bias toward
 * light text on mid-tone colors, down to bias toward dark text.
 */
export function getContrastColor(
  background?: string,
  dark = '#1a1a1a',
  light = '#ffffff',
): string {
  if (!background || background[0] !== '#') return light
  let hex = background.slice(1)
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  if (hex.length !== 6) return light
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return light
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 128 ? dark : light
}
