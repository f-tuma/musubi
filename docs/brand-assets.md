# Shared logo masters and consumers

Musubi's logo artwork lives in three public SVG masters in the
[Musubi Vardum workspace](https://vardum.com/workspaces/90473c38-68d7-407a-b7f1-41fcd7fdd2f2/assets?prefix=brand%2Flogo%2F).
The web app, marketing site and native asset recipes use these masters instead
of maintaining independent drawings.

| Master key | Artwork | Intended background |
| --- | --- | --- |
| `brand/logo/dark` | Ink `#050507` and red | Light |
| `brand/logo/light` | Cream and red | Dark |
| `brand/logo/mono` | Original phone greys: left `#070707`, right `#929292` | Platform monochrome/themed uses |

Each master retains the original `0 0 48 48` viewBox and geometry, with stable
`neutral-arm` and `accent-arm` groups. The mono master preserves its two greys;
it is not a flat black replacement.

## Live web roles

`apps/web/src/brand.ts` and `website: src/brand.ts` contain the public stable
role URLs. `website:` means the separate `musubi-website` repository.

| Role key | Consumer | Delivery |
| --- | --- | --- |
| `brand/web-app/tab-icon` | App favicon | Adaptive SVG for browser light/dark preference |
| `brand/website/tab-icon` | Marketing favicon | Adaptive SVG for browser light/dark preference |
| `brand/website/mark` | Marketing navigation and footer | Original linked use of `brand/logo/light` |
| `brand/web-app/mark-neutral` | `BrandMark` neutral arm | SVG selection of `neutral-arm`, full 48×48 canvas |
| `brand/web-app/mark-accent` | `BrandMark` accent arm | SVG selection of `accent-arm`, full 48×48 canvas |
| `brand/web-app/touch-icon` | Apple touch icon and web push notification icon | Opaque 180×180 PNG |
| `brand/web-app/og` | Shared default app/marketing social image | Existing 1200×630 PNG composition |

The app's two arm images are alpha masks. The app still supplies theme and
calendar colours through `currentColor` and `var(--accent-primary)`. Both
images must load before the component switches from its local original paths;
an image failure restores the complete local mark. SSR, loading and offline
fallbacks remain bundled artwork until a later app release. Native SVG image
elements omit `crossOrigin`, because the stable redirect does not provide CORS
headers.

Adaptive tab icons retain an internal `prefers-color-scheme` stylesheet. They
follow the browser/OS preference, independently of the page's theme. Serve them
as SVG; rasterization loses the adaptation. Marketing also retains its static
local `public/favicon.ico` fallback. The app upstream's `/favicon.ico` returns
204. The push worker receives the centralized touch PNG URL; its notification
payload, click behavior, scope and no-cache response stay the same.

The shared OG image is a composition, not a resized logo. It keeps its existing
source and URL; blog covers can still override it.

## Native app: public derivatives, frozen bundles

`apps/client/assets/vardum.json` identifies the mobile Vard. Its outputs retain
the existing `images/*.png` paths used by `apps/client/app.config.ts`:

| PNG path | Master or source | Role |
| --- | --- | --- |
| `images/icon.png` | `brand/logo/light` | Base and iOS dark icon, opaque dark background |
| `images/icon-light.png` | `brand/logo/dark` | iOS light icon, opaque cream background |
| `images/android-icon-foreground.png` | `brand/logo/dark` | Transparent adaptive foreground with its own safe area |
| `images/android-icon-monochrome.png` | `brand/logo/mono` | Transparent themed icon with its own safe area |
| `images/android-icon-background.png` | Existing private solid cream source | Separate adaptive background layer |
| `images/favicon.png` | `brand/logo/light` | Expo web favicon |
| `images/splash-icon.png` | `brand/logo/light` | Dark splash mark |
| `images/splash-icon-light.png` | `brand/logo/dark` | Light splash mark |

The new logo derivatives are intentionally public. Their Vard outputs directly
follow the current master versions and carry copied role recipes, including
size, background and padding. Library-use settings do not live-inherit into
those Vard recipes; recipe changes must be copied explicitly. Shared recipe
inheritance is future work tracked by VARD-102.

The app bundles local PNGs, never fetches these URLs at runtime. A deliberate
asset refresh updates the checked-in images and `apps/client/assets/.vardum.lock`;
`pnpm --filter @musubi/client assets:frozen` reproduces the locked versions.
Master updates alone do not change a released native app. Expo prebuild
generates the ignored Android/iOS resources from these bundled inputs.

## Email: frozen bundled PNG

`packages/emails/assets/vardum.json` identifies the private Musubi Email Vard.
It derives `logo.png` from the public `brand/logo/light` master as a 128×128 PNG
with 3.91% padding and an alpha background. The Vard recipe copies these
settings; changes to a library use's recipe do not update it automatically.
The checked-in `.vardum.lock` pins the exact output version and checksum.

Email keeps loading the bundled `packages/emails/assets/logo.png` and attaching
it as `cid:musubi-logo`, displayed at 44×44. Delivery needs no Vardum credentials
or public image request, including on a self-hosted server. A missing bundled
file still logs a warning and leaves the Musubi alt text; it does not stop mail.
Master updates take effect in mail only after an explicit asset refresh and
consumer release.

Resolve the CLI already pinned to `0.8.0` by `apps/client`, then run it in the
email asset directory. From the repository root, with a read-only workspace
key available through the CLI's supported credential mechanism:

```sh
cli_package="$(cd apps/client && node -p 'require.resolve("@vardum/cli/package.json")')"
cli_entry="$(node -e 'const path = require("node:path"); const file = process.argv[1]; console.log(path.resolve(path.dirname(file), require(file).bin.vardum));' "$cli_package")"
(cd packages/emails/assets && node "$cli_entry" pull --frozen)
```

`pull --frozen` restores the committed snapshot without advancing its lock.
For a deliberate refresh, use `pull` without `--frozen`, then review and commit
the PNG and lock together. Run `pnpm --filter @musubi/emails test` to check that
the CID attachment remains available as PNG.

The manual **Vardum private assets** workflow restores both
`apps/client/assets` and `packages/emails/assets` into empty temporary
directories with the locked client CLI. It runs only on `main` and uses the
`vardum-private-ci` environment's read-only Musubi workspace key only for the
frozen pull step. Configuration and committed checksums are validated before
that step; afterward it verifies unchanged config/lock files, every output's
SHA-256 and exact equality with the committed bytes. Each pull has an isolated,
initially empty credential directory. Ordinary builds and PR checks need no
private Vardum credentials.

## Updating and recovering artwork

1. Upload a new version of the appropriate existing `brand/logo/*` master.
   Keep it public, SVG, and compatible with the 48×48 canvas and named groups.
   Live role URLs follow the new master version after processing and caches.
2. Change each role's recipe when its delivery requirements change. For the
   arm masks, retain the full canvas, transparency and ancestor transforms.
   Update matching arms together, then check both themes and calendar colours.
3. Refresh and review frozen mobile outputs and their lockfile before a native
   release. A recipe change is separate from a master version change.
4. Restore a prior master version to roll back compatible live artwork. Use an
   explicit frozen version and recipe when exact bytes must be reproducible.

The first source URL switch needs the normal consumer release. Later compatible
master versions need no web build; an open page needs a reload. Stable redirects
cache for 60 seconds with stale-while-revalidate up to 300 seconds, while version
URLs are immutable. Browsers cache favicons separately and social services
refresh previews on their own schedules.

Previous independent artwork is archived for recovery. Archive organization
preserves its records, keys, versions and existing URLs; it is not evidence of
a byte freeze. Historical private sources and old frozen mobile URLs remain
private. Do not expose them to migrate consumers or delete/recreate their keys.
New public masters and uses contain only approved public artwork.

## Other bundled and composed surfaces

- The Android solid background and shared OG composition remain distinct
  assets because they are not logo-only transformations.
- The README icon/banner and generated store artwork are local snapshots or
  compositions and need an explicit refresh when their artwork changes.
- `packages/docs/public/favicon.svg` remains Astro Starlight's stock favicon;
  the docs header has no configured logo.

See [`brand-asset-spec.md`](./brand-asset-spec.md) for platform format and safe
area requirements. The Vard stores output recipes; the frozen lock pins selected
versions, fingerprints, download URLs and checksums.
