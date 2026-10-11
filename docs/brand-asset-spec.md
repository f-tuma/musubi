# What the DAM has to hold

Every asset Musubi needs, with the numbers to produce it at. Safe areas are
given in pixels at the export size — no fractions to convert.

Three answers appear in the safe-area column:

- **`626 × 626 centred`** and the like — a real reserved area. Anything outside
  it will be cut off or masked away, so nothing that matters may sit there.
- **`Cover the canvas`** — the artwork must reach all four edges. A transparent
  gap here is a defect: there is nothing behind it.
- **`No reserved area`** — nothing is cut. Reach the edge or don't, as the design
  wants.

Sources are linked per section. Where a platform publishes no safe area, the row
says so rather than inventing one.

## Masters — vector

SVG, square canvas, artwork converted to outlines, no embedded rasters.

| Master | Canvas | Safe area | Notes |
| --- | --- | --- | --- |
| `mark` | 1:1 | No reserved area | The knot alone, transparent |
| `mark-on-dark` / `mark-on-light` | 1:1 | No reserved area | Colour-adjusted per ground |
| `mark-plated-dark` / `mark-plated-light` | 1:1 | No reserved area | With an opaque background plate |
| `mark-mono` | 1:1 | No reserved area | **One flat colour, shape carried by alpha.** Android tints it |
| `lockup-wide-dark` / `-light` | ~2:1 | No reserved area | Mark + "Musubi" wordmark |

## Mobile app — the files `app.config.ts` reads

[Expo](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/) ·
[Android adaptive icons](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive)

| File | Size | Format | Alpha | Safe area at that size |
| --- | --- | --- | --- | --- |
| `icon.png` | 1024 × 1024 | PNG | No | **Cover the canvas** — Expo rejects transparent pixels. Do not round the corners, the system masks them |
| `icon-light.png` | 1024 × 1024 | PNG | No | **Cover the canvas** |
| `android-icon-foreground.png` | 1024 × 1024 | PNG | Yes | **626 × 626 centred.** 171 px cut on every side. Mark 455–626 px |
| `android-icon-background.png` | 1024 × 1024 | PNG | No | **Cover the canvas.** No shadow around the mark |
| `android-icon-monochrome.png` | 1024 × 1024 | PNG | Yes | **626 × 626 centred.** 171 px cut on every side. Flat silhouette only |
| `splash-icon.png` | 1024 × 1024 | PNG | Yes | Centred; scaled by `imageWidth`, so leave margin |
| `splash-icon-light.png` | 1024 × 1024 | PNG | Yes | Same. **Currently 1024 × 512** — normalise it |
| `favicon.png` (Expo web) | 48 × 48 | PNG | Yes | No reserved area |

The 626/171 figures are Android's 66 dp visible area inside a 108 dp canvas,
scaled to 1024. Supply layers unmasked, clean-edged, no drop shadow.

## iOS icon

[Apple HIG](https://developer.apple.com/design/human-interface-guidelines/app-icons)

| Asset | Size | Format | Alpha | Safe area |
| --- | --- | --- | --- | --- |
| App icon layers | 1024 × 1024 | SVG or PDF preferred, PNG for raster | Foreground yes, background no | Foreground: no reserved area. Background: **cover the canvas**. Apple publishes no safe-zone figure; the mask is a rounded rectangle, so keep fine detail out of the corners |

Six appearances: default, dark, clear light, clear dark, tinted light, tinted
dark. Foreground layers come **without** a background — that is defined in Icon
Composer. An imported background must cover the canvas and be opaque. No soft or
feathered edges, or the system's highlights sit badly on them.

## Google Play listing

[Play Console](https://support.google.com/googleplay/android-developer/answer/9866151) ·
[asset guidance](https://support.google.com/googleplay/android-developer/answer/16386748)

| Asset | Size | Format | Alpha | Safe area at that size |
| --- | --- | --- | --- | --- |
| Store icon | 512 × 512 | 32-bit PNG | Yes | No reserved area. Max file 1024 KB |
| Feature graphic | 1024 × 500 | JPEG or 24-bit PNG | **No** | **819 × 325 centred** — 102 px left, 102 px right, 75 px top, 100 px bottom. No text or logo in the image at all |
| Phone screenshots | 1080 × 1920 | JPEG or 24-bit PNG | **No** | None published. Min side 320 px, max 3840 px, long side ≤ 2× short side. Two minimum to publish |

## App Store listing

[App Store Connect](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/) —
**none of these exist today**; the repo's screenshots are Play-sized.

| Asset | Size | Format | Alpha | Safe area |
| --- | --- | --- | --- | --- |
| iPhone 6.9" screenshots | 1320 × 2868 | PNG or JPEG | **No** | None published. 1–10 shots. Required if the app runs on iPhone |
| iPhone 6.5" screenshots | 1284 × 2778 | PNG or JPEG | **No** | Only needed if 6.9" is absent |
| iPad 13" screenshots | 2064 × 2752 | PNG or JPEG | **No** | None published. Required if the app runs on iPad |
| App Store icon | 1024 × 1024 | PNG | No | Same file as the app icon above |

Smaller device sizes are optional — Apple scales them from the largest given.

## Web

[W3C manifest](https://w3c.github.io/manifest/) ·
[web.dev](https://web.dev/articles/icons-and-browser-colors)

| Asset | Size | Format | Alpha | Safe area at that size |
| --- | --- | --- | --- | --- |
| `favicon.svg` | square viewBox, any | SVG | Yes | No reserved area |
| `favicon.ico` | 32 × 32 | ICO | Yes | No reserved area |
| `apple-touch-icon.png` | 180 × 180 | PNG | **No** | **Cover the canvas** — it must be opaque. Square, no rounded corners. One size only, not several |
| Manifest icon | 192 × 192 | PNG | Yes | No reserved area |
| Manifest icon | 512 × 512 | PNG | Yes | No reserved area |
| Manifest maskable | 512 × 512 | PNG | Yes | **410 px circle, centred.** 51 px band on every side is background only |
| `og.png` | 1200 × 630 | PNG or JPEG | No | None published. Keep near 1.91:1 or feeds crop it. Under 8 MB ([Meta](https://developers.facebook.com/docs/sharing/webmasters/images)) |

Web app update (2026-10-11): the existing production 180×180 opaque Apple PNG
is adopted at `brand/web-app/apple-touch-icon`, also used for notifications.
The app's existing 1200×630 OG remains separate from marketing. Theme-aware
logo silhouettes live at `brand/web-app/logo-ink` and `logo-accent`: each is a
transparent 48×48 SVG with viewBox `0 0 48 48`, carrying one arm only. Matching
canvases and alpha are required; the app applies colours locally. See
[update and fallback behavior](./brand-assets.md#web-app--musubiproapp).
A web manifest remains outside this migration.

## Email

| Asset | Size | Format | Alpha | Safe area |
| --- | --- | --- | --- | --- |
| `logo.png` | 128 × 128 | PNG | Yes | No reserved area. Shown at 44 px, so ~3× for retina |

PNG and not SVG because Gmail drops SVG. Derived — re-render on every change:

```sh
rsvg-convert -w 128 -h 128 <mark-plated-dark>.svg -o packages/emails/assets/logo.png
```

## README and GitHub

| Asset | Size | Format | Alpha | Safe area |
| --- | --- | --- | --- | --- |
| `icon.png` | 1024 × 1024 | PNG | Yes | No reserved area |
| `banner.svg` | 1200 × 320 | SVG | — | No reserved area. Currently drawn as SVG primitives with live text; needs redrawing as an asset if the DAM is to own it |

---

## Historical DAM gaps (2026-08-16; web Apple icon resolved above)

| # | Asset | Size | Safe area |
| --- | --- | --- | --- |
| 1 | `mark-mono` | vector | No reserved area, one flat colour |
| 2 | Wide lockup, dark + light | vector ~2:1 | No reserved area |
| 3 | `android-icon-foreground` | 1024 × 1024 | 626 × 626 centred |
| 4 | `android-icon-background` | 1024 × 1024 | Cover the canvas |
| 5 | `android-icon-monochrome` | 1024 × 1024 | 626 × 626 centred |
| 6 | `splash-icon-light` | 1024 × 1024 | Centred |
| 7 | `apple-touch-icon` — now in Vardum for the app | 180 × 180 | Cover the canvas, opaque |
| 8 | Manifest icon | 192 × 192 | No reserved area |
| 9 | Manifest maskable | 512 × 512 | 410 px circle |
| 10 | Play feature graphic | 1024 × 500 | 819 × 325 centred |
| 11 | App Store screenshots | 1320 × 2868 and 2064 × 2752 | None published |
