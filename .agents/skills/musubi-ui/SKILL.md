---
name: musubi-ui
description: >-
  Build, change, or review Musubi web UI with Tailwind v4, the shadcn-based
  components in apps/web/src/components/ui, and the tokens generated from
  packages/design-system, enforced by @shadcn/lint. Use for React UI, styling,
  responsive behavior, accessibility, Storybook, dialogs, forms, settings,
  calendar views, and visual polish under apps/web.
---

# Musubi web UI

Musubi is styled with **Tailwind v4 utilities from Musubi's own theme** and
built from **shadcn/ui components restyled to Musubi** in
`apps/web/src/components/ui`. `@shadcn/lint` enforces the system: when it
reports something, the fix is in the component or the theme, never a
workaround.

## The one rule behind the others

**The UI guides by design, not by text.** Layout, grouping, alignment, state
and one clear primary action tell people what to do. Copy names things; it
does not explain them.

- A dialog has a title. A description only when the title cannot say it, and
  then one line.
- A settings group has a heading and rows. No paragraph under the heading.
  Background explanation goes behind a `help` "?" (`HelpTooltip`).
- A row is one label and at most one short detail line.
- An empty state is a title, at most one sentence, and the one action.
- One primary button per surface, trailing. Everything else is secondary,
  ghost or link.
- No eyebrows ("STEP 1 OF 3", "WELCOME BACK"). Progress is `StepDots`.

## Where things live

| Need | Source |
| --- | --- |
| Tokens (colour, type, spacing, radii, heights, motion) | `packages/design-system/src/*.ts` → `pnpm --filter @musubi/design-system generate` |
| Tailwind theme (generated) | `packages/design-system/src/tailwind.css` from `src/tailwind.ts` |
| Stylesheet entry, base and layer mechanics | `apps/web/src/design/app.css`, `global.css`, `layers.css` |
| Design-system components (the only place with `cva` variants and Radix) | `apps/web/src/components/ui/*.tsx` |
| App-level compositions (auth card, route states) | `apps/web/src/components/*.tsx` |
| Feature compositions | `apps/web/src/calendar/components`, `routes`, `onboarding` |
| Class merging | `cn` from `~/lib/utils` (shadcn `cn`, taught Musubi's theme) |
| Component catalog | colocated `*.stories.tsx` |
| Screen and layer review | colocated Storybook stories, light and dark themes |

Never edit generated files in `packages/design-system`; edit the TypeScript
and regenerate.

## The theme

Tailwind's defaults are cleared. Only Musubi's values exist, so a wrong class
is an unknown class, not quiet drift.

- **Colour:** surfaces `bg-canvas`, `bg-panel`, `bg-raised`, `bg-sunken`,
  `bg-overlay`; ink `text-foreground`, `text-foreground-secondary`,
  `text-muted-foreground`, `text-faint` (never for words); rules `border-border`,
  `border-border-subtle`, `border-border-strong`; action `bg-primary`
  (sumi) / `text-primary-foreground`; accent `shu` (vermilion) for emphasis,
  destructive and focus only; `success`, `warning` (+ `-fill`); a calendar
  colour is `bg-pigment` / `text-pigment` with `style={{ "--pigment": color }}`.
  The shadcn names (`background`, `card`, `popover`, `muted`, `accent`,
  `destructive`, `ring`, `input`) map onto the same values.
- **Type:** `text-10`…`text-32` (pixel names), `text-display` for the auth and
  route-state title, `font-sans` (Inter Tight, working UI), `font-serif`
  (Noto Serif, titles and orientation), `font-medium` / `font-normal` only,
  `tracking-label` for small caps.
- **Spacing:** `1`…`8` = 4…32 px; half steps `0.5 1.5 2.5 3.5 4.5 5.5` for
  component anatomy; layout steps `9 10 12 14 16 20 24 32 40 48 64 80 96`.
  Named sizes: `h-control`, `h-control-compact`, `min-h-row`, `w-sidebar`,
  `max-w-inspector`, `w-popover`, `h-dialog`, `pb-safe-bottom`.
- **Radii:** `rounded-sm md lg chip control card sheet full`.
- **Widths:** `max-w-compact` 440, `max-w-form` 560, `max-w-default` 720,
  `max-w-wide` 960.
- **Breakpoints:** `sm:` ≥ 600, `md:` ≥ 1024, `lg:` ≥ 1440 (mobile first;
  `max-sm:` is ≤ 599).
- **Motion / layers:** `duration-panel fast standard slow`,
  `z-dialog z-popover` (+ `-overlay`, `-elevated`), `focus-inset` for rows in
  scrolling surfaces.

Missing a value? Add it to `packages/design-system` by role, regenerate, and
teach `cn` in `~/lib/utils.ts` if it is a new name in an existing group.

## Components

Reuse before writing markup. Import from `~/components/ui/<name>`.

- Actions: `Button` (`variant` primary | secondary | ghost | destructive |
  link; `size` default | compact | icon | icon-compact; `loading`; `asChild`
  for links). Icon-only buttons need `aria-label`.
- Layers: `Dialog` + `DialogContent` (`size` compact | form | default | wide,
  `tall` for standing windows, `side="right"` for the inspector, `elevated`
  above popovers, `returnFocus`, `initialFocus`) with `DialogHeader`,
  `DialogTitle`, `DialogDescription`, `DialogBody`, `DialogFooter`;
  `ConfirmationDialog`; `Popover`; `DropdownMenu` (short command lists only);
  `Tooltip` (names icons); `HelpTooltip` (background help); `Toast` (one
  action at most, usually Undo).
- Forms: `Field` (wires label, help, description, error to its one control),
  `FieldGroup`, `FieldSet`, `Input`, `Textarea`, `InputGroup`, `Select`,
  `Segmented` (2–4 visible choices), `Switch`, `Checkbox`, pickers.
- Lists and settings: `SettingsSection` (heading + `ItemGroup` panel),
  `Row`, `RowAction`, `RowToggle`, `RowOptions`, `Disclosure`, and the `Item*`
  anatomy for anything custom.
- Feedback: `InlineError`, `Empty`, `Badge`, `Spinner`, banners.
- Pages: `AuthShell` (every pre-calendar screen), `RouteState` (full-page
  states), `StepDots`.

A component's `className` from a caller is for **layout only**: margin,
position, flex/grid placement, width. Height, padding, colour, type, radius
and shadow belong to the component's variants. If the variant you need does
not exist, add it to the component (with a story) when the role is general;
otherwise compose a feature component from plain elements and utilities.

Only files in `src/components/ui` import Radix. Only they define `cva`
variants for shared roles.

## Screens hold still

- Every pre-calendar screen is `AuthShell`: one card, `max-w-compact`, same
  position, same title style, actions at the foot.
- Standing dialogs (settings and its sections) are `tall` at a shared size so
  switching sections never resizes the window.
- Multi-step flows reserve the height of their tallest step (`min-h-*`) and
  pin actions to the bottom: Back (ghost) leading, primary trailing.
- Align to the same inset: `px-6` in dialogs and cards, `px-4` inside rows.

## Lint is the contract

`pnpm --filter @musubi/web lint` runs `@shadcn/lint` with every rule at
`error`: `no-restyle`, `no-raw-colors`, `no-arbitrary-values`,
`no-inline-styles`, `no-unknown-classes`, `require-static-classes`, plus bans
on `*.module.css` and Radix imports outside `src/components/ui`.

- Arbitrary values (`p-[13px]`, `grid-cols-[…]`) are not allowed. CSS
  variable shorthand for runtime values from Radix or the calendar
  (`max-h-(--radix-popover-content-available-height)`) is.
- Inline `style` is for dynamic custom properties only
  (`style={{ "--pigment": color, "--event-top": `${top}px` }}`), read by a
  utility.
- There are no CSS modules and no lint exceptions. Keep it that way: no
  `eslint-disable`, no per-file overrides.

## Visual language

- Warm washi surfaces, sumi ink, restrained shu, muted calendar pigments.
- Quiet geometry, low-contrast grid, dominant event content.
- No gradients, glassmorphism, floating card mosaics, oversized headings or
  generic blue SaaS chrome.

## Interaction contracts

- Correctness, accessibility, context continuity and reversibility outrank
  polish.
- Preserve date, view, scroll, focus, draft and active object unless the task
  changes them.
- Every interaction needs an accessible name, a keyboard path, visible focus
  (the global keyboard focus ring; do not add `outline-none` without a
  replacement) and correct focus return.
- Colour is never the only signal.
- Support light/dark and ≤ 599, 600–1023, 1024–1439, ≥ 1440.

## Approval and dependencies

The Tailwind + shadcn system was approved on 2026-09-30. Composition from it
goes straight to production. A new visual pattern gets a Storybook story
first. Adding any other UI, styling, icon, animation or form dependency still
needs explicit human approval.

## Verification

```bash
pnpm --filter @musubi/web typecheck
pnpm --filter @musubi/web lint
pnpm --filter @musubi/web test
pnpm storybook:web:test   # when a component or story changed
```

Run the relevant Playwright scenario for a changed flow. Review components,
screens and layers in Storybook; approve substantial visual changes before
production use.
