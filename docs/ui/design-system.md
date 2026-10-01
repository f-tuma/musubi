# Musubi design system

- Status: living document; web on Tailwind v4 + shadcn since 2026-09-30
- Date: 2026-08-01
- Applies to: `apps/web`, `apps/client`, and new shared design packages
- Domain source of truth: [`calendar-ui.md`](./calendar-ui.md)

This document defines **how we compose and maintain UI**. `calendar-ui.md`
continues to define **how the calendar behaves**. When rules conflict,
correctness, accessibility, and domain behavior take precedence over visual
uniformity.

## 1. Direction

Musubi is not a skin for another calendar application. Its identity is sumi ink
on washi paper, muted pigments, Inter Tight for working UI, Noto Serif for
orientation and meaningful emphasis, and calm geometry without extra decoration.

The design evolves rather than resets: preserve the recognizable character and
make hierarchy, rhythm, states, and consistency more precise. Storybook is the
review surface for variants and the catalog of components that are actually
implemented, including screen and layer compositions.

### Guide by design, not by text

Layout, grouping, alignment, state and one clear primary action tell people
what to do; copy names things rather than explaining them. A dialog is a title
and its controls. A settings group is a heading and one-line rows. Background
explanation sits behind a `help` "?" (`HelpTooltip`). Only what someone must
know to act safely — what a destructive action removes — stays visible, in one
sentence. Screens hold still: every pre-calendar screen is the same `AuthShell`
card, standing dialogs share one size, and multi-step flows reserve the height
of their tallest step with actions pinned to the same place.

## 2. Architecture

Share meaning, not renderers:

```text
packages/design-system/        canonical tokens, names and contracts without React
  src/tailwind.ts → tailwind.css  the web Tailwind v4 theme, generated
apps/web/src/design/app.css    the one stylesheet entry (Tailwind, theme, tokens, base)
apps/web/src/components/ui/    shadcn/ui components restyled to Musubi (Radix inside)
apps/web/src/components/       app compositions: AuthShell, RouteState
apps/web/src/calendar/…        feature compositions
apps/client/components/ui/     React Native implementation and native idioms
```

Web styling is **Tailwind v4 utilities from Musubi's theme**. The components in
`src/components/ui` started from the shadcn/ui CLI and were restyled; they are
Musubi's own code now, and the CLI can add more (`pnpm dlx shadcn add …` from
`apps/web`, then restyle to the theme). Variants are `class-variance-authority`;
class merging is `cn` from `~/lib/utils`, which knows Musubi's scale.

### System layers

1. **Primitive tokens** — raw pigment, dimension, and timing values.
2. **Semantic tokens** — surface, text, border, action, feedback, and motion.
3. **Component contracts** — roles, sizes, states, and anatomy, as `cva` variants.
4. **Patterns** — confirmation, forms, settings lists, selection, and feedback.
5. **Features** — calendar, agenda, Pages, sharing, and accounts.

A feature may own domain content and its layout. It must not own a new generic
button, field, menu, modal, popover, sheet, or toast.

### Enforcement

`@shadcn/lint` runs in `pnpm --filter @musubi/web lint` with every rule at
error:

| Rule | Keeps out |
| --- | --- |
| `no-restyle` | a caller changing a component's height, padding, colour, type, radius or shadow through `className`; callers may place it (layout) |
| `no-raw-colors` | palette colours and hex values; only theme roles exist |
| `no-arbitrary-values` | `p-[13px]`, `grid-cols-[…]`; CSS-variable shorthand `(--x)` for runtime values is allowed |
| `no-inline-styles` | inline styling other than dynamic custom properties |
| `no-unknown-classes` | classes the theme cannot generate (Tailwind's default scale is cleared) |
| `require-static-classes` | class strings the linter cannot read |

ESLint also forbids `*.module.css` imports and Radix imports outside
`src/components/ui`. The whole app is covered; there are no exceptions.

## 3. Tokens

`packages/design-system` is the canonical renderer-free source. `pnpm --filter
@musubi/design-system generate` writes three web files from its TypeScript:
`colors.css` (runtime theme variables for both schemes), `foundations.css`
(type, spacing, radii, control heights, motion) and `tailwind.css` (the Tailwind
theme over the same values). The package test fails when any of them is stale.

The Tailwind theme clears Tailwind's own palette, type ramp, spacing multiplier,
radii, shadows and breakpoints, then declares only Musubi's:

- colours reference the runtime variables (`@theme inline`), so one utility
  serves both schemes; shadcn role names (`background`, `primary`, `muted`,
  `destructive`, …) map onto Musubi's surfaces and inks, and Musubi adds
  `canvas panel raised sunken overlay`, `foreground-secondary`, `faint`,
  `border-subtle/strong`, `shu`, `success`, `warning`, `pigment`, `pigment-ink`;
- type sizes keep their pixel names (`text-13`), plus `text-display` and
  `text-ambient` for orientation;
- spacing is the 4 px scale (`1`–`8`), half steps for component anatomy and
  larger layout steps, plus named sizes (`h-control`, `min-h-row`, `w-sidebar`,
  `h-dialog`, `pb-safe-bottom`) that follow the touch densities;
- breakpoints are `sm` 600, `md` 1024, `lg` 1440 (mobile first);
- dialog widths are `max-w-compact form default wide`;
- motion and layer roles are utilities (`duration-fast`, `z-dialog`).

A missing value is added here by role, never inlined.

- A primitive token does not say where it is used (`shu-600`, `space-4`).
- A semantic token communicates purpose (`text-secondary`, `surface-raised`).
- Responsive values use one ladder: 599 / 1023 / 1439 px.
- Web px and native dp may differ, but the role and optical result should match.

## 4. Geometry and rhythm

Spacing expresses relationships. It is not selected independently for each
screen. Use the existing 4 px ladder through the following roles:

| Relationship | Value | Use |
| --- | ---: | --- |
| Adjacent | 4 px | title to description, label to supporting text |
| Related | 8 px | icon to label, actions in one group |
| Control group | 12 px | tightly related controls or choices |
| Component inset | 16 px | compact cards, menus, and repeated rows |
| Field group | 20 px | one complete field to the next |
| Layer inset | 24 px | dialog header, body, and footer on regular viewports |
| Section break | 32 px | distinct content groups inside one view |

Do not substitute a nearby step because it looks acceptable in isolation. If a
relationship repeatedly needs a different value, name the component exception
and document why it cannot use the shared role.

### Responsive density

Layer interiors have two densities. Calendar breakpoints at 1023 and 1439 px
may change application architecture, but do not silently change the internal
rhythm of a dialog, popover, or menu.

| Contract | Regular, ≥600 px | Touch, ≤599 px |
| --- | ---: | ---: |
| Minimum viewport gutter around a modal | 24 px | sheet is edge-to-edge |
| Dialog/sheet inline inset | 24 px | 20 px |
| Dialog body block inset | 20 px | 20 px |
| Dialog footer block inset | 16 px | 16 px + safe area |
| Default control height | 44 px | 48 px |
| Compact control height | 38 px | 44 px minimum target |

Touch density adapts anatomy rather than shrinking regular UI. Dialogs become
bottom sheets, actions wrap or stack when labels no longer fit, and safe-area
insets belong to the outermost region.

### Layer anatomy

- A layer shell owns its viewport gutter, width, radius, elevation, and region
  insets. Feature content must not compensate with negative margins.
- Header, padded body, and footer share one inline axis. The default dialog body
  is padded; edge-to-edge rows or sections require an explicit `flush` body
  variant, and their readable content still aligns to the same axis.
- Nested components own only their internal rhythm. A `Field` inside a padded
  dialog must not add a second outer inset.
- The shell pays the bottom safe-area inset: the dialog footer where there is
  one, otherwise the dialog body. Feature content neither adds it back nor adds
  it again inside a sheet that has already paid it. `--layer-safe-bottom` stands
  in front of `env(safe-area-inset-bottom)`, which cannot be assigned and so
  cannot otherwise be shown in a story.
- Whitespace establishes regions first. Header and footer separators are used
  only when a scrolling body or repeated rows need a persistent boundary; a
  short dialog must not become three bordered slabs.
- A regular dialog footer keeps actions right-aligned, secondary before primary,
  with an 8 px gap. Touch layouts preserve action order and stack only when the
  labels or minimum targets do not fit.
- Dialog widths are roles: `compact` 440 (one question), `form` 560 (edit one
  thing), `default` 720 (a list or short page), `wide` 960 (a workspace such as
  Settings). Standing windows are `tall` at the shared `h-dialog` height so moving
  between them never resizes the window. Always constrained by the viewport
  gutter. Text measure remains bounded even
  in a wide dialog.

### Form composition

- Label to control uses 8 px; control to help or error text uses 4 px.
- Complete fields are separated by 20 px; distinct field sections by 32 px.
- A field does not receive a divider merely because it is a field. Dividers
  belong to repeated row collections and true region boundaries.
- Validation stays with the field that caused it and must not change the outer
  alignment of the form.
- A form uses one control height per density unless a multiline or domain
  control has an explicit semantic size.

### Settings composition

`SettingsSection` is the canonical scan unit for related preferences. Its title
and group edge follow the layer axis (24 px regular, 20 px touch), the title sits
12 px above the group, and separate sections use the 32 px section break. The
group uses the panel surface, a subtle border, and the 14 px shared radius with
no gradient or shadow. Rows retain their own 16 px component inset inside that
edge; this is nested component rhythm, not a competing layer axis.

The parent `DialogBody` supplies the outer inset; `SettingsSection` adds no
outer padding. Structured settings fill the available body width, and the
parent supplies spacing between sections.

Only repeated rows receive dividers. The group clips its surface and dividers,
while row focus rings draw inward so keyboard focus is never hidden by the
rounded edge. This inset structure was chosen over a fully flush list because
the stronger grouping makes long settings dialogs substantially easier to scan.

### Ownership test

When two edges do not align, fix the component that owns the shared axis. Do
not patch the consumer. In particular, a dialog header at 24 px, a field at
16 px, and a footer at 20 px are three competing systems, not visual nuance.

## 5. Components and layers

A component belongs in the shared layer when it has a stable general role, is
repeated or clearly part of the common language, and can be described without a
feature name. A one-off domain composition remains with its feature.

Dialog, sheet, popover, menu, and toast are not one component:

| Layer | Use | Behavior |
| --- | --- | --- |
| Dialog | consequential editing | modality, focus trap, explicit ending |
| Sheet | narrow viewport or native detail | modality, thumb reachability |
| Popover | local lightweight action or preview | anchored, preserves context |
| Menu | short command list | keyboard navigation, immediate choice |
| Toast | feedback after an action | non-blocking, optionally one Undo action |

They may share surfaces, headers, spacing, and motion, but their interaction
contracts stay distinct. Every portaled layer follows R4b and R4c from
`calendar-ui.md`.

Production modal flows import the shared `Dialog` contract; only that primitive
imports Radix Dialog directly. General anchored layers compose `Popover`,
`PopoverTrigger`, `PopoverAnchor`, `PopoverContent`, and `PopoverClose`; only
that shared primitive owns their portal, collision gutter, surface, arrow,
motion, and narrow bottom-sheet geometry. Consumers retain their role, focus
policy, keyboard model, dimensions, and content anatomy. `Select`,
`DatePicker`, `TimePicker`, and `ColorPicker` use this contract without being
forced into one selection behavior. Month overflow keeps the anchored shell;
event creation and details use the shared Inspector, which reserves space beside
the desktop calendar and becomes modal on narrow screens. Features retain their
focus, draft, and event-bubbling policies. Menus use their own command-navigation
contract rather than turning `Popover` into a universal interaction component.

`Menu` is that non-modal command-navigation contract. Radix Dropdown Menu owns
menu-button semantics, roving focus, arrow navigation, typeahead, Escape
dismissal, and focus return. `MenuContent` requires one accessible label, stays
anchored on regular viewports, and becomes an edge-to-edge command sheet at 599
px and below. `MenuItem` owns icon, label, optional shortcut, disabled state,
and a named destructive tone; `MenuSeparator` divides a genuinely different
command group. Do not use a menu for one action, persistent choices, form
controls, or navigation that should remain visible.

`Dialog` is composed: `DialogContent` (size, `tall`, `side="right"`,
`elevated`, `initialFocus`, `returnFocus`, `closeLabel`) holds `DialogHeader`
(title, at most a one-line description), `DialogBody` (the scrolling middle,
`px-6`) and `DialogFooter` (actions, trailing, primary last). Optional background
help sits in a `HelpTooltip` beside the title.

`ConfirmationDialog` composes the compact `Dialog` contract for one
consequential decision. It owns Cancel-before-confirm action order, loading and
disabled behavior, and safe initial focus on Cancel. A typed confirmation may
move initial focus to its required field. `ConfirmationNotice` owns the
consequence callout and `DialogError` owns alert semantics plus an optional
request ID; features provide only the domain copy, icon, and operation.

`SettingsSection` owns the heading (with optional `help`) and the `ItemGroup`
panel beneath it; it takes no description. `Row` owns item content and interaction;
`RowAction` exposes named `selected` and `tone="destructive"` states rather than
requiring feature-owned data attributes. Features provide only domain copy and
callbacks.

`Button` has four semantic variants. `primary` is the single strongest action
in a region, `secondary` supports or cancels it, `ghost` is a quiet toolbar or
inline action, and `destructive` is reserved for an action whose consequence
needs explicit emphasis. Do not show two primary actions in one action group or
use destructive styling as a generic brand accent. Dialog footers place the
secondary action before the primary or destructive ending.

The default `control` size matches form controls; `compact` belongs to dense
toolbars, toast actions, and other bounded chrome. Both sizes grow to the shared
minimum touch targets at 599 px and below. Labels are concise and remain on one
line; action groups stack rather than wrapping a button label. Loading blocks a
second activation, exposes `aria-busy`, and keeps the button's existing geometry
and accessible name stable.

An icon-only action is `Button size="icon" | "icon-compact"` with an
`aria-label`. Use it only
when the glyph is established in the surrounding product context; the label is
the accessible name and supplies the native tooltip fallback unless a custom
`title` is provided. Toggle icon buttons expose `aria-pressed`, while buttons
that open a layer expose the expanded state supplied by that layer primitive.

`HelpTooltip` is the shared question-mark control for short, non-interactive
background explanations. Use `Field help` or `SettingsSection help` to place it
beside a label or heading; the button remains outside the field label. Existing
`description` and `error` content stays visible and keeps its accessibility
association. Required formats, validation, current status, and action consequences
must remain visible rather than moving into optional help.

Help opens after 400 ms of pointer hover, immediately on keyboard focus, or on a
tap/click. Its content remains hoverable, uses `role="tooltip"` and
`aria-describedby`, and does not move focus. Escape dismisses it until a fresh
hover, focus, or explicit activation. It stays anchored with collision handling
on narrow screens. Inline help uses a 24 px desktop target to preserve label
rhythm and the standard compact touch target on narrow or coarse-pointer screens.

`Toast` is a single transient notice, never a stack or activity log. A new
notice replaces the current one. Neutral feedback uses a polite `status`; an
error uses an assertive `alert`, a visible error icon, and the error border tone
so color is not its only signal. Keep messages concise and self-contained. A
persistent failure, multiple recovery choices, or content that requires reading
belongs inline or in a dialog instead.

The optional action is one object containing its label and callback, so a silent
or inert half-action cannot render. It is reserved for Undo; generic navigation
and multi-step recovery do not belong in a toast. The message owns the live
region and the action is its sibling, keeping interactive content out of the
announcement. Toasts never take focus, and their timer is owned by the feature:
plain acknowledgements remain for 3.5 seconds while Undo remains for 9 seconds.

The region is centered on its owning content area. Message-only toasts keep
symmetrical inline padding; Undo toasts use the compact action inset without
changing the region midpoint. Both use the same maximum width and remain within
a 12 px viewport gutter on touch layouts. Feature code may move the region above
persistent chrome through the documented `--toast-left` and `--toast-bottom`
variables, but must not alter the toast's internal geometry.

`Segmented` is a visible radio choice for two to four short, mutually exclusive
options. It defaults to `size="compact"`; `size="control"` matches a regular
form control. Options share the available width, stay on one line, and may
compress their inline inset on touch viewports, but their labels must remain
readable. If real labels cannot fit at 320 px without truncation, use `Select`
instead of adding horizontal scrolling or wrapping the segmented control.

Selection follows focus: arrows wrap and skip disabled options, while Home and
End choose the first and last enabled option. A disabled group disables every
radio. Choosing the already-selected option only restores focus and does not
emit a duplicate change.

Every public component has:

- named variants instead of screen-specific CSS overrides;
- default, hover, focus-visible, pressed/selected, disabled, and pending/error
  states where they apply;
- an accessible name, keyboard path, and correct focus return;
- an API that describes role (`variant="destructive"`), not appearance
  (`red=true`).

## 6. Storybook contract

Stories are colocated with their components (`Component.stories.tsx`). The
catalog is grouped by role: `Foundations`, `Primitives`, `Patterns`, `Calendar`,
and `Screens`.

Minimum coverage for a public component:

1. `Overview` — recommended use with realistic content;
2. `Variants` — all supported variants side by side;
3. `States` — disabled, pending, error, selected, and long content as relevant;
4. `Narrow` — only when the component changes anatomy or layer;
5. interaction test — only for meaningful behavior, not pixel details.

Light and dark themes use the same stories. The accessibility panel must have no
known critical violation. Add screenshot tests only after the base components
stabilize; Storybook does not replace unit or end-to-end tests for domain
behavior.

The current web catalog uses Storybook 10.5 with the first-party TanStack React
framework. Run it from the repository root with `pnpm storybook:web`; build the
static catalog with `pnpm storybook:web:build`; run all story smoke, interaction,
and accessibility tests in Chromium with `pnpm storybook:web:test`. Storybook
tests use a dedicated Vitest 4 browser project, while the existing web unit suite
remains isolated in its jsdom project. Accessibility violations are test
failures, not an informational baseline. The Chromatic visual testing addon is
registered for reviewed visual baselines; publishing snapshots still requires
an explicitly configured Chromatic project and token.

Chromatic captures one default baseline for every story. Additional modes are
reserved for high-value visual contracts rather than multiplied across the
entire catalog: foundations, button variants, open dialogs and sheets, open
selection layers, and all toast anatomies. The shared modes pin the theme,
color scheme, locale, viewport, and touch capability. Chromatic also requests
reduced motion and pauses remaining animations before capture.

A visual contract for a portaled layer must use a `play` interaction to open
the layer and wait until its entrance state is visibly complete. The same story
therefore verifies interaction and accessibility before Chromatic captures it;
a snapshot of only the closed trigger is not coverage for a dialog, sheet, or
popover. Open-layer testing is required because hidden content is not included
in the normal accessibility pass.

Run a cloud build with `pnpm chromatic:web` and provide
`CHROMATIC_PROJECT_TOKEN` through the environment. Visual regression is a
manual, on-demand build; CI does not publish snapshots. The committed project
ID created by the Visual Tests panel is public metadata, but the project token
must never be written to source, configuration, logs, or documentation.

The baseline catalog visualizes the implemented color, typography, spacing,
shape, motion, and responsive contracts. It also covers Authentication,
Avatar, Button, Checkbox, ColorPicker, ConfirmationDialog, DatePicker, Dialog,
Empty, Field, Menu, Page settings, Popover, RouteState, Row, SectionLabel,
Segmented, Select, SettingsSection, Switch, TimePicker, and Toast without
forking their production implementations. Muted and faint color tokens may be
shown as decorative swatches, but must not be presented as readable text when
they do not satisfy the required contrast ratio.

Page settings composes standard section labels, rows, buttons, fields, and
confirmation dialogs. `Set as default` is an immediate row action with inline
pending/error feedback and a persistent status after success; it does not close
the editor or discard an unrelated draft.

## 7. Workflow

1. Check the existing primitive and the rules in `calendar-ui.md`.
2. If a general contract is missing, design it in Storybook with real content.
3. For a substantial visual change, reproduce the current state in Storybook
   first, then compare variants; production use starts after direction approval.
4. Implement one component or pattern and migrate a bounded set of consumers.
5. Verify typecheck, lint, unit tests, Storybook build, and relevant a11y checks.
6. Update this document when a change introduces a new rule.

## 8. Definition of Done

- No second implementation of existing general-purpose UI was introduced.
- A domain component does not own a generic shell.
- Values read from tokens and the component works in light and dark themes.
- Padded regions share their documented axis; flush content is explicit.
- Spacing describes one of the relationships in section 4 or a named exception.
- The state and responsive matrix is visible in stories.
- The core workflow is keyboard operable; color is not the only signal.
- APIs and stories use realistic Musubi content, not `Lorem ipsum`.
- The change does not violate R1–R12 or the checklist in `calendar-ui.md`.

## 9. Anti-patterns

- copying Radix dialog markup into a feature component;
- naming a general component after one screen;
- adding one prop per CSS property instead of a constrained variant set;
- using different names for the same role on web and mobile;
- a central stories directory detached from component source;
- a universal cross-platform React component full of `isWeb` branches;
- changing production UI before a substantial visual direction is approved;
- adding a token without a role or a magic number without a named constant.
- applying different inline padding to a layer header, body, and footer;
- removing shell padding in a story and rebuilding it inside feature content;
- re-declaring a shared CSS recipe in a feature module instead of composing it;
- using dividers to compensate for weak spacing hierarchy.
- opening a menu for a single command instead of invoking that command directly;

## 10. Adoption order

1. Document the inventory and current system. *(Complete.)*
2. Run Storybook around existing web primitives without moving them. *(Complete.)*
3. Stabilize dialog, row, field, button, segmented control, and toast contracts.
   *(Complete.)*
4. Extract canonical tokens and generate web/native representations. *(Theme
   colors and shared typography, dimension, and motion foundations complete.)*
5. Create platform packages only when dependencies and APIs are clear.
6. Add the React Native Web catalog, then on-device Storybook and composition.

## 11. Composition contracts verified in the browser

A passing unit suite does not validate composition. Inspect the production
consumer, including real combinations of provider actions, long text and expanded
sections, before treating a visual change as complete.

- Compact rows have a 20 px icon slot. Use `AccountMark size="compact"` inside
  them; the default 30 px framed account mark belongs in account lists. Derive
  calendar branding with `providerFlavor(calendar)` so iCloud keeps its identity.
- `Row layout="responsive-actions"` is for recovery rows with multiple actions.
  It keeps their text readable by placing actions below it on narrow screens.
  The icon stays beside the copy in the first row. The same contract supports
  settings controls that need their own line. The default Row layout is unchanged.
  Do not concatenate unspaced buttons.
- A Field owns the input surface and forwards label, help and error association
  to DatePicker and TimePicker. Inline calendar pickers retain their own compact
  appearance; feature CSS must not build another generic input skin.
- `Empty` supports both h2 and h3 with the same visual typography. Its action
  should invoke the existing creation flow only when permissions allow it.
- A layer has one header/body/footer inset. A nested section must not add the
  same inset again. A scroll region must not hide the primary action or stable
  management navigation.
- Color properties use color tokens; geometry uses dimension tokens. The web
  unit pipeline checks this category contract in `css-token-contract.test.ts`.
- Authentication actions use ordinary Button variants and minimum targets;
  consumers must not turn a secondary button into a tiny underlined link with
  descendant CSS. AuthMessage composes InlineError. Empty alerts occupy no space.
- Nested grids that contain long identity text or a button need explicit
  `minmax(0, 1fr)` tracks. A page with no horizontal scrollbar can still clip its
  inner content: inspect the content and action bounds, not only document width.
- A flex heading with a color dot uses a separate shrinking text slot for
  ellipsis. The dot and provider mark remain visible; the accessible name stays
  complete.
- A Select that saves immediately returns focus after its temporary disabled
  state ends. It must not reclaim focus if the person moved elsewhere meanwhile.
- SettingsSection defaults to h3 within a dialog; `headingLevel={2}` is for a
  section directly below a page h1. Heading level does not change typography.

Regression examples live beside Row, Field, Empty and ProviderIcon. Check the
actual feature at desktop and constrained widths, light and dark, with long
labels, incomplete provider data, errors and expanded controls. Wait for opening
animations to finish before judging a screenshot. Record observed issues and
fixes separately from untested assumptions.
