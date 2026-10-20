# Where the logo lives

Every place the Musubi mark or wordmark appears, so that changing it is a
checklist rather than an archaeology exercise — and so a DAM has something to
take ownership of.

Covers two repositories: **Musubi** (this one) and **musubi-website** (the
marketing site at musubi.pro). Paths in the second are marked `website:`.

Web app adoption updated: 2026-10-20. Other inventories below retain their
2026-08-16 audit date unless a newer note says otherwise.

The format, pixel size and safe area each of these has to be produced at is in
[`brand-asset-spec.md`](./brand-asset-spec.md).

## The mark itself

Three hand-authored files. Everything else is either derived from one of these,
generated from one of these, or draws the shape in code.

| File | Shape | Used for |
| --- | --- | --- |
| `apps/web/public/favicon.svg` | Two interlocking rings on a rounded square, cream `#e8e4d9` + shu `#c8553d` on `#0c0c0e` | Web app favicon, and the source the email logo is rendered from |
| `website: public/musubi-mark.svg` | Square mark, 512×512 | Site favicon (SVG), and the `logo` in the site's JSON-LD |
| `website: public/musubi-mark-wide.svg` + `-wide-light.svg` | Wide lockup, dark and light variants | Nav, footer, hero |

Three files, two drawings: the web app's rounded-square rings and the site's
mark are separate artwork, not one asset in two places.

## Marketing site — musubi.pro

| Where | Asset | Notes |
| --- | --- | --- |
| `website: src/components/Nav.astro:11,12,48,49` | `musubi-mark-wide.svg`, `-wide-light.svg` | Twice each: desktop bar and mobile overlay |
| `website: src/components/Footer.astro:12,13` | same pair | |
| `website: src/pages/index.astro:485,486` | same pair | Hero |
| `website: src/components/BaseHead.astro:97,98` | `favicon.ico`, `musubi-mark.svg` | The `.ico` is the only raster favicon anywhere |
| `website: src/components/BaseHead.astro:55` | `musubi-mark.svg` | **Published URL** inside JSON-LD `Organization.logo`. Google caches it; renaming the file breaks a structured-data field, not just an image |
| `website: src/components/BaseHead.astro:33` | `og.png` | Default social preview. Also cached by every platform that has ever unfurled a musubi.pro link |
| `website: src/pages/blog/[slug].astro:85` | `og.png` | Fallback when a post has no cover |

The dark/light pairing is done with CSS classes (`mark-dark` / `mark-light`), so
each themed variant is a separate file and both must exist.

## Web app — musubi.pro/app

The app uses public stable Vardum URLs from `apps/web/src/brand.ts`, under
`https://vardum.com/w/musubi/brand/web-app/`. The favicon is an Original linked
use of the public `brand/website/logo` source, also used by marketing's
navigation and footer. It has its own library item and path, but shares the
source's ready version, history and visibility. The private, frozen mobile
pilot remains separate.

| Key | Consumer | Current source |
| --- | --- | --- |
| `favicon-linked` | Root favicon link | Original linked use of `brand/website/logo`, transparent cream/red SVG, 48×48 viewBox |
| `apple-touch-icon` | Root Apple icon and push notification icon | Existing opaque 180×180 PNG |
| `og` | Root `og:image` | Shared app/marketing default, composed 1200×630 PNG |
| `logo-ink` | BrandMark's foreground arm | Exact original first path, transparent 48×48 SVG |
| `logo-accent` | BrandMark's accent arm | Exact original second path, transparent 48×48 SVG |

`BrandMark.tsx` loads the two silhouettes as native SVG images inside alpha
masks. The app still supplies `currentColor` and `var(--accent-primary)`, so
light/dark themes and monochrome calendar pigments retain their current look.
Callers in the sidebar, auth shell, route states and provider marks keep the
same SVG props and sizes. No remote SVG markup is injected.

SSR and no-JavaScript pages use the original paths. Live images mount after
hydration, avoiding missed cached-image load events. Both must load before
switching; an error in either restores the complete original mark. This local
fallback intentionally remains the old artwork until a later app release.

To update artwork:

1. For the shared mark, open **Assets → brand → website → logo** in Musubi's
   Vardum workspace. Upload a compatible transparent cream/red SVG with a
   `0 0 48 48` viewBox. This updates marketing's mark and the app's linked
   favicon together. Keep the source public and SVG; an incompatible MIME
   change can make the Original use unavailable. Check both consumers.
2. Other app artwork remains under **Assets → brand → web-app**. Upload a new
   version to the existing source, preserving its key and public visibility.
   The old standalone `brand/web-app/favicon` and its historical versions are
   retained for rollback; it is no longer the app favicon's update target.
3. For logo arms, upload/restore matching revisions together. Each SVG must
   have a `0 0 48 48` viewBox, a transparent canvas and only the appropriate
   silhouette. Opaque plates, empty images and mismatched canvases break masks.
   Two stable pointers are independent; publication is not atomic.
4. Check the app in both themes and a coloured calendar. The app does not need
   a build for compatible artwork updates; an open page needs a reload.

The first favicon URL switch requires the normal app release. The linked use
was verified against the master's current immutable SVG, not by publishing a
test version of the production logo. The old app SVG differs only in an
unrendered group attribute; rendered RGBA pixels match at 16, 32, 48 and 180 px.
Marketing's adaptive `brand/website/favicon`, the two app logo-arm masks,
Apple icon and mobile icons retain their own artwork. Resizing or adding a
solid background alone does not preserve their adaptive colours, separate
silhouettes or safe areas. The default marketing and app OG already share
`brand/web-app/og`; it is a composition, not a resized logo.

Stable redirects currently cache for 60 seconds with stale-while-revalidate up
to 300 seconds. Original version URLs are immutable. Browser favicons and social
platforms have separate caches, so changes are not promised to appear instantly.
Native SVG image elements deliberately omit `crossOrigin`: the stable redirect
currently lacks CORS headers, so CSS masks or anonymous-CORS images would fail.

The worker source is still served as a tiny raw script. `push/source.ts` prepends
the centralized PNG URL, and `/app/sw.js` retains its no-cache header, scope,
payload handling and click behavior. OS/browser notification presentation and
resource-fetch timing vary; this migration does not add a separate icon fetch
to the handler. `/favicon.ico` still deliberately returns
204 on the app upstream.

## Docs site

**The docs site is not branded at all.** `packages/docs/public/favicon.svg` is
still Astro Starlight's stock favicon — a sparkle glyph that fills black or white
by `prefers-color-scheme`, with no relation to Musubi. And there is no `logo`
configured in `packages/docs/astro.config.mjs`, so the header shows the site
title as text.

So the docs need the mark *added*, not swapped. Two things, both new:

- replace `packages/docs/public/favicon.svg` with the Musubi mark
- set `logo` in the Starlight config if the header should carry it

## Mobile app

Sources, all referenced from `apps/client/app.config.ts`:

| Line | Asset | Role |
| --- | --- | --- |
| 33 | `assets/images/icon.png` | Base app icon |
| 51, 52 | `icon-light.png`, `icon.png` | iOS 18 light/dark app icon |
| 89–91 | `android-icon-foreground.png`, `-background.png`, `-monochrome.png` | Android adaptive icon, three layers |
| 133 | `assets/images/favicon.png` | Expo web build favicon |
| 144, 149 | `splash-icon-light.png`, `splash-icon.png` | Splash screen, light and dark |

Everything under `apps/client/android/` and `apps/client/ios/` is **generated by
`expo prebuild`** from those sources and is gitignored — `AppIcon.appiconset`,
`SplashScreenLogo.imageset`, every `mipmap-*` and `drawable-*` density. A DAM
feeds the five sources above; the rest regenerates.

## Emails

`packages/emails/assets/logo.png` — 128×128, **rendered from
`apps/web/public/favicon.svg`**:

```sh
rsvg-convert -w 128 -h 128 apps/web/public/favicon.svg -o packages/emails/assets/logo.png
```

Referenced by `packages/emails/src/brand.ts` and attached to every outgoing mail
as a `cid:` inline attachment. PNG rather than SVG because Gmail drops SVG. This
is a **derived artefact**: change the source and this must be re-rendered, or
every email keeps the old mark.

## GitHub and README

| Where | Asset |
| --- | --- |
| `README.md` | `.github/assets/icon.svg` — copy of the current web favicon |
| `README.md` | `.github/assets/banner.svg` — current mark and text lockup |

The README icon is copied from `apps/web/public/favicon.svg`. The banner embeds
that file's two mark paths directly so GitHub can render a self-contained SVG.
When the source mark changes, update both assets. The old phone illustration is
no longer displayed in the README.

## Store listings

`store/out/` (gitignored, generated): `icon_512.png`, `feature_graphic.png`,
`01_hero.png` … `08_brand.png`. Play and App Store artwork. Not in version
control, so a DAM is strictly better than what exists now.

## Drawn in code, not stored as a file

A DAM cannot own these as-is. Either they become files it manages, or they stay
a manual step on every logo change.

- `apps/web/src/components/BrandMark.tsx` — original paths remain the frozen
  loading/offline fallback; the live silhouettes now belong to Vardum, while
  theme and calendar colours remain controlled by the app
- `apps/web/public/favicon.svg` — literal coordinates and colours
- `.github/assets/banner.svg` — mark, 結 and wordmark, all as SVG primitives

## Unused, and safe to delete

Left over from the Expo template, referenced nowhere:

- `apps/client/assets/images/react-logo.png`, `@2x`, `@3x`
- `apps/client/assets/images/partial-react-logo.png`

## Historical gaps (2026-08-16)

- **Apple touch icon resolved for the app:** the existing 180×180 production
  bucket PNG was verified and adopted under `brand/web-app/apple-touch-icon`
  on 2026-10-11. The old apex-404 observation is no longer an app gap.
- **No web manifest.** `/site.webmanifest` and `/manifest.json` are both 404, so
  neither site is installable and neither declares icons to the OS.
- **Historical deployment observation, not current status:** `curl https://musubi.pro/login` returns a
  head with no icon at all. That is not a code fault: a local production build
  of the current tree server-renders the icon links correctly, so the running
  image simply predates them. It fixes itself on the next web deploy.
- **The docs site still ships Astro's stock favicon** (see above). Whoever looks
  at a Musubi docs tab today sees a generic sparkle.
