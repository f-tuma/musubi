# @musubi/design-system

The values every Musubi client shares: the two colour schemes, the spacing and
type scales, radii, control heights and motion durations. Renderer-free — web
turns them into CSS custom properties, native consumes the same numbers as
density-independent points.

Theme and foundation tokens name purposes (`textMuted`, `surfaceSunken`) rather
than renderers. `widget-tokens.ts` composes those values into the home-screen
widget appearance contract, shared by Agenda, Calendar and Tasks.

## Generated files

`pnpm generate` writes the following files from the TypeScript sources. They are
committed, and the test suite fails if they are stale:

| File | For |
| --- | --- |
| `src/colors.css` | The two schemes as CSS custom properties |
| `src/foundations.css` | Spacing, type, radii, control heights, motion |
| `src/tailwind.css` | The web utility theme over the same values |
| `design-tokens.json` | The same values in the W3C design-tokens shape |
| `apps/client/modules/musubi-agenda-widget/android/src/main/res/values/musubi_widget_tokens.xml` | Widget colours, dp geometry and sp type |
| `apps/client/modules/musubi-agenda-widget/android/src/main/res/values-night/musubi_widget_tokens.xml` | Widget dark colours; shared dimensions inherit from the default set |
| `apps/client/widgets/ios/WidgetTokens.swift` | SwiftUI widget colours, point geometry and type roles |

The native paths are relative to the repository root. Never edit generated
files by hand. Edit `theme-tokens.ts`, `foundation-tokens.ts` or `widget-tokens.ts`
and regenerate. The Android adapter preserves alpha as `#AARRGGBB`; design tools
receive `#RRGGBBAA`. Widget tests check generated-file staleness and contrast
after Android's alpha rounding. User-calendar pigment text chooses between the
generated black/white candidates independently of the current widget theme.

RemoteViews can use the native system serif/sans fallback when Musubi's runtime
font assets are unavailable. Scalable type keeps titles at 14sp, metadata at
12sp and calendar pills at 11sp; resize changes visible content rather than
shrinking that type. Named control glyphs use a 24dp visual size inside 44dp
touch targets, so enlarged text cannot clip the refresh/settings symbols.
Native device checks must verify font scale and the optical
result of that fallback.

## Editing tokens in a design tool

`design-tokens.json` is the one layer of the design that can be edited outside
the repository without either copy drifting. Import it, change colours or
spacing, export it back, and the values map onto the code one-for-one — leaf keys
are the token names exactly as the code spells them (`light.surfaceCanvas`, not
`light.surface.canvas`), so nothing needs a translation table on the way home.

Colours are 8-digit hex when translucent (`#1c1b1814`) and 6-digit when not.
Dimensions and durations carry their unit (`16px`, `220ms`).

Check an export before applying it:

```
pnpm check-tokens ~/Downloads/musubi-tokens.json
```

It prints what changed, in the form the source is written in (`#1c1b1814` comes
back as `rgba(28, 27, 24, 0.08)`, so it can be pasted straight in), and then runs
the palette's own contrast rules over the result. Exit 1 means a text colour
stopped clearing 4.5:1 somewhere — those lines must not be applied. Tokens the
file omits are left alone; keys that are not Musubi tokens are listed and ignored.

Exit 1 also means a colour lost its alpha. That check runs before the contrast
one, because contrast cannot catch it: `#1c1b18a3` flattened to `#1c1b18` is
near-black on cream and passes 4.5:1 comfortably while the border it draws has
gone from a hairline to a solid rule.

It never writes `theme-tokens.ts`. That file carries the reasoning for each value
— why `textMuted` is exactly 0.64, which surface is its worst case — and a
generator would replace all of it with a hex code.

### What Penpot can hold

Measured against Penpot 2.x through its plugin API, not assumed:

- **Colour tokens are opaque.** `#1c1b1814`, `rgba(28, 27, 24, 0.64)` and
  `#1c1b18a3` all resolve to 6-digit hex; `rgba(… 64%)` and `hsla()` are rejected
  outright. So the seven translucent tokens — `surfaceOverlay`, the three
  `border*` and `textSecondary`/`textMuted`/`textFaint` — are **not** pushed into
  Penpot. They are alpha over a surface, which is the whole reason they work on
  all four surfaces, and a solid stand-in would be a trap that looks editable.
  The nine opaque ones are there, and the file says which are missing and why.
- **`tokens.addTheme()` is broken** — it rejects every argument shape with
  `Value not valid`. So there is no Light/Dark theme switch; the scheme is changed
  by activating the `light` or `dark` token set directly, which is the API's
  documented manual path.
- Spacing, type sizes, radii and control heights all travel intact as
  `spacing`/`fontSizes`/`borderRadius`/`dimension` tokens. Motion durations do
  not: Penpot has no duration or number token type.

Two things deliberately do not travel:

- **`shadowRaised` and `shadowOverlay`** combine offsets, blur and colour;
  they stay here because they cannot be exported as colour tokens.
- **Components and screens.** A design tool can redraw a dialog, but nothing
  keeps the drawing and the code in step afterwards. Storybook shows the
  implemented components, screens and layers in both themes; the stories use
  production components.

## Contrast is checked, not asserted

`contrast.ts` computes WCAG relative luminance, and `theme-tokens.test.ts` uses
it to prove that every token carrying words clears 4.5:1 on every surface it can
land on. A token edited in a design tool has to pass the same check before it
comes back in — which is the reason the check lives beside the values rather than
in an audit somewhere.
