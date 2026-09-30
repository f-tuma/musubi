> **Superseded (2026-09-30):** the web UI moved to Tailwind v4 + shadcn components enforced by `@shadcn/lint`. See `design-system.md` and `.agents/skills/musubi-ui/SKILL.md`. This plan describes the CSS-module era and is kept for history.

# Web UI consolidation plan

- Status: **worked through. Two items stay open on their own conditions:
  `RowGroup` still has one consumer, and the `Dialog` size rule only applies to
  whoever adds the next variant.**
- Scope: `apps/web`
- Follow-up, 2026-09-12: the comprehensive screen refinement reused this system
  for management, settings, accounts, tasks, search and public routes. The earlier
  P1.3 conclusion below is historical: PR #285 introduced a real Field/DatePicker/
  TimePicker consumer in the task editor and completed that missing contract.
  Current composition rules, including responsive row actions and async Select
  focus return, live in `design-system.md` section 11.
- Previous restructure:
  [`ui-restructure-handoff.md`](./ui-restructure-handoff.md) is complete; do not
  reopen it as a redesign.

Read before implementation:

1. [`../../AGENTS.md`](../../AGENTS.md)
2. [`../../.agents/skills/musubi-ui/SKILL.md`](../../.agents/skills/musubi-ui/SKILL.md)
3. [`design-system.md`](./design-system.md)
4. Relevant behavior rules in [`calendar-ui.md`](./calendar-ui.md)

## Goal

Remove proven duplication around existing web primitives without changing
Musubi's visual direction. Prefer composition, standard DOM props, stable
`data-slot` hooks, and CSS custom properties over screen-specific variants or
one prop per visual adjustment.

This is consolidation, not a component rewrite. No external UI dependency, new
component package, generic card system, or broad restyle is needed.

## Working rules

- Reuse `apps/web/src/ui` before adding markup or CSS.
- Keep domain controls domain-owned. Calendar events, recurrence choices,
  palette choices, cover choices, and calendar geometry are not generic rows or
  buttons merely because they use `<button>`.
- A shared component API describes role or state, not pixels.
- Use semantic variants for meaning, slots for structure, `data-slot` for
  targeted styling, and CSS custom properties for genuine geometry exceptions.
- Do not add a screen-named variant such as `size="shareDialog"`.
- Preserve current appearance unless a visual change is explicitly approved.
- For a new public pattern or substantial visual change, prepare its Storybook
  state first and obtain approval before production migration.
- Migrate at least two real consumers when extracting a new shared pattern. An
  exception is a missing accessibility or shell-ownership contract.
- Keep each work item independently reviewable and green.

## Execution order

### P0 — Use primitives that already exist

No new shared API should be needed for these changes.

- [x] Replace hand-built search result buttons in
  `calendar/components/SearchDialog.tsx` with `RowAction`; use `SectionLabel`
  for result groups. Preserve command-search keyboard behavior and focus.

  `SectionLabel` replaced the group headings and `.results h2` went with it —
  the two rules were identical. **`RowAction` did not happen**, and the result
  button stays domain-owned. Measured against `RowAction size="compact"`:

  | | `.result` | `RowAction` compact |
  | --- | --- | --- |
  | padding | 8px / 12px | 4px / 8px |
  | label | 16px, `--text-primary` | 13px, `--text-secondary` |
  | trailing `small` | 11px | unstyled, 13.3px |
  | icon | full opacity | `--text-muted` |
  | hover | `--surface-raised` | 55% of it |

  Six properties, so it is a restyle rather than a swap. It also has a
  functional edge: `.result` draws its focus ring inward at
  `outline-offset: -2px` because the results list scrolls, and `.rowAction` has
  no focus rule of its own — the inward ring exists only as
  `.settingsSectionRows .rowAction:focus-visible`. Under the global
  `:focus-visible` at `+3px` the first and last result could clip their ring.
  Give `.rowAction` its own inward ring before reopening this; it belongs with
  the row anatomy work in P1.2.

Done when obsolete feature CSS is removed and existing interaction tests still
cover the same behavior.

### P1 — Complete missing primitive contracts

#### 1. Inline errors

Current error callout anatomy is repeated in account, calendar, connection,
event-detail, recurrence, settings, and sharing styles. A near-equivalent
`DialogError` already lives inside `ConfirmationDialog`.

- [x] Move or expose the existing alert shell as a general `InlineError` in
  `apps/web/src/ui`.
- [x] Keep `role="alert"`, optional request ID, standard HTML props, and
  `className` support.
- [x] Migrate matching dialog errors, then delete duplicate border, background,
  type, and spacing rules.
- [x] Add Storybook coverage for plain message, request ID, long message, and
  narrow layout.

Twelve call sites now compose `InlineError`; the four surviving feature classes
carry margin only. Two of them were not a restyle: `settings.module.css` and
`event-details.module.css` painted their text with the raw accent, which axe
measured at 3.82:1 on the tinted background against the 4.5:1 WCAG AA
threshold. `recurrence-scope.module.css` had dropped the shared background with
no reason recorded in the code or reachable through history, and its `error`
prop made callers assemble the alert markup; it now takes the message and
request ID that every other call site already had.

`page-settings.module.css` keeps `.conflict` local. It is a notice with an icon
and a `strong` line, closer to `ConfirmationNotice` than to this callout, and
one instance does not prove a pattern.

Do not add size or screen variants. Consumer layout belongs in `className`;
alert anatomy belongs to the shared component.

#### 2. Row anatomy and row groups

`Row` already owns useful content slots, but consumers cannot target its
internal anatomy without brittle descendant selectors.

- [x] Add stable `data-slot` hooks for icon, copy, label, detail, value, and
  trailing content. Do not add styling props for each slot.
- [x] Migrate `ShareCalendarDialog` member rows to `Row` once its current
  identity/actions layout can be expressed through those hooks.
- [ ] Extract a small `RowGroup` only while migrating at least two identical
  bordered list shells. It may own surface, border, radius, clipping, and row
  dividers; it must not own feature headings or business state.

  Still one consumer. `.settingsSectionRows` is the only bordered list shell —
  the member list draws its dividers from each row's own `border-bottom`, so
  there is nothing to share yet.

- [x] Keep `SettingsSection` as the canonical titled settings composition; do
  not duplicate it with another settings-specific wrapper.

The migration was blocked on two defects in `Row` rather than on the hooks, and
both were worth fixing on their own:

- `.rowIcon` was a fixed `width: 22px`, and `Sidebar` already handed it a 32px
  avatar. Measured, the avatar spilled 5px into the row's padding and left 7px
  before the label instead of 14px. The slot now treats 22px as a floor, which
  also let the member row keep its 34px avatar.
- The inward focus ring existed only as
  `.settingsSectionRows .rowAction:focus-visible`, so a row in the sidebar or a
  dialog body took the global outward ring at `+3px` and had it clipped by the
  container that scrolls it. `.rowAction` owns the ring now.

The member list itself was worse than the plan assumed. `.memberList` shared a
rule with `.inviteOptions` that made it `display: flex; flex-wrap: wrap`, so
rows were content-width flex items: two members with short names and no manage
controls sat side by side, each under its own divider. Measured at a 462px
content box, two 187px rows shared a line. It is a grid list now, and the rows
are full width.

The hooks earn their place at exactly one point: the member label and detail
must stay on one line, which `.rowLabel` and `.rowDetail` do not do — and
should not, since a settings detail wraps by design. The narrow stacked layout
travels through `className` on `Row`, not through new props.

#### 3. Field and picker wiring

**Closed: the premise does not hold.** No consumer wants `Field` around a
picker, and the two pickers would not survive it looking alike.

Measured by putting both inside a `Field` and reading computed style:

| Control                     | Border | Background        | Font | Height |
| --------------------------- | ------ | ----------------- | ---- | ------ |
| plain `<input>`             | 1px    | `--surface-raised`| 14px | 44px   |
| `DatePicker` trigger        | 1px    | `--surface-raised`| 14px | 44px   |
| `TimePicker` input          | 0      | transparent       | 12px | auto   |

`DatePicker`'s trigger is a `<button>`, so `.fieldControl > :is(input, select,
textarea, button)` claims it at specificity 0,1,1 against
`.datePickerTrigger`'s 0,1,0 and it comes out identical to a text field.
`TimePicker`'s root is the `<div>` that `PopoverAnchor` needs, which that
selector never matches. Inside one form they would diverge.

The consumers say the same thing:

- `EventEditorForm` composes pickers into `.pickerRow` — icon, label, control —
  and marks the label `aria-hidden` because the picker's `aria-label` already
  carries the name.
- All four `ColorPicker` call sites render it bare beside a `Field`, as a
  compact swatch with no visible label at all.
Forwarding `id`, `aria-describedby` and `aria-invalid` to the triggers was
written and reverted: with no consumer it is public API nobody calls.

Reopen this only as a deliberate visual pattern — pickers rendered as standard
fields — which needs a stable control-root contract in that `:is()` list and an
answer for 12px against 14px and 38px against 44px. That is a design change
behind the approval gate, not consolidation.

#### 4. Dialog safe-area ownership

Several feature styles add bottom safe-area padding because dialog bodies lack
a footer.

- [x] Make `Dialog` own the final bottom inset whether or not a footer exists.
- [x] Remove feature-level safe-area compensation from migrated dialogs.
- [x] Verify footer/no-footer, padded/flush, regular/touch combinations in
  Storybook before production migration.

The count was wrong in both directions. Of 22 production dialogs, 12 have no
footer: four paid the inset by hand, and seven paid it nowhere, so their content
sat under the home indicator. Two more paid it twice — `PageSettingsDialog`
always renders a footer, yet its form added the inset again on a narrow
viewport, and the `EventDetailsPopover` action bar added it inside an
`AnchoredSurface` sheet that had already paid.

`Dialog` now writes `data-has-footer`, and the shell pays the inset where
nothing else does. A `--layer-safe-bottom` token stands in front of
`env(safe-area-inset-bottom)`, which cannot be assigned: without it no story
can tell a notch from a laptop, and the two new `Dialog` stories would prove
nothing. `routes/app.module.css` keeps its raw `env()` — it is a four-sided
shorthand alongside the other insets.

### P2 — Extract only proven repeated patterns

These are valid candidates, but each extraction must remove duplicate consumer
code in the same change.

- [x] Expose the existing visually-hidden recipe through one tiny shared helper
  or public class and remove identical local copies.

  There were twelve copies, not the handful this item assumed, and
  `primitives.module.css` already held the canonical one. Eleven rules now
  compose it and `.srOnly` is gone as a second name for it. The remaining
  `event-editor.module.css` recipe stays inline because `composes` only works on
  a rule whose selector is a single class and that one is compound.

  The canonical rule sits at the top of its file on purpose — same-file
  `composes` cannot look forward. `Select`'s sheet title composes it and is
  un-hidden again below 600px, which now has a story that fails if the hidden
  recipe ever wins there.
- [x] Consolidate the repeated interactive attendee facepile as `AvatarStack`
  or a calendar feature component. Keep it outside `apps/web/src/ui` if its
  behavior remains attendee-specific.

  It went to `apps/web/src/ui`: the behaviour is a button that opens a list, and
  nothing in it is attendee-specific — the semantics stay with the two
  remaining consumer, `EventDetailsPopover`. The 2px ring and overflow count
  travel through `--avatar-stack-ring` and the two
  `--avatar-stack-more-*` properties.

  The overflow chip was 36px in the popover while its faces were 32px. The ring
  is inside the box, so the chip stood two pixels above and below the row; it is
  32px now.
- [x] Inventory passive status/role/count chips. Add a shared badge only when at
  least two consumers share semantics and anatomy, not merely rounded CSS.

  **No shared badge.** Five outlined pills exist and no two match:

  | Class | Border | Padding | Size | Then |
  | --- | --- | --- | --- | --- |
  | `sharing .count` | `--border-medium` | 4/8 | `--text-10` | panel fill, capitalize |
  | `sharing .roleBadge` | `--border-medium` | 5/9 | `--text-10` | panel fill, capitalize |
  | `calendars .badge` | `--border-subtle` | 2/6 | `0.58rem` | uppercase, 500, `0.04em` |
  | `connections .status` | `--border-subtle` | 2/7 | `--text-10` | a dot child and `data-tone` |
  | `workspace .brandStage` | `--border-subtle` | 1/5 | `0.58rem` | `--text-muted`, `0.08em` |

  Three paddings, two border colours, two font sizes, three letter-spacings. The
  semantics differ as much as the anatomy: a quantity, a role, a calendar kind, a
  connection state with a tone, a release stage. The only pair that shares both
  is `.count` and `.roleBadge`, and they already share one rule in one file, so
  there is nothing to extract.

  Two things the inventory did turn up, neither of them this item's work:

  - `.recurrenceBadge`, `.defaultStatus` and `.homeBadge` are named as badges but
    are plain text-and-icon rows with no border and no radius. The names mislead.
  - `0.58rem` appears seven times as a raw value across `calendars.module.css`
    and `workspace.module.css` — a de-facto step below the smallest token,
    `--text-10` at `0.625rem`. Four of the seven are calendar geometry and stay
    feature-owned, but two are chips inventing the same unnamed size
    independently.
- [x] Remove `routes/login.tsx` imports of private `primitives.module.css` rules
  by exposing the missing semantic composition through `AuthShell`.

  It used exactly two rules, `.authAsideLead` and `.authHint`, which are now
  `AuthAsideLead` and `AuthHint` beside the `AuthForm`/`AuthMessage` family. No
  file outside `apps/web/src/ui` imports the private stylesheet any more. The
  story had been rendering a bare paragraph where production had the styled one,
  so it drifts no longer.

### P3 — API cleanup after migrations

Do not start these as isolated refactors. Perform them only when an earlier
migration proves the need.

- [ ] Before adding another `Dialog` size variant, express exceptional width or
  max-height through documented CSS custom properties while retaining compact,
  default, and wide semantic presets.

  Not triggered: nothing in this pass wanted a seventh size. The condition
  stands for whoever does.

- [x] Review arbitrary numeric `Avatar` sizes after all consumers are visible.
  Prefer a small named scale; retain an escape hatch only for real optical
  exceptions.

  Eight call sites used 26, 32 (four times), 34, 42 and 64, against a `36`
  default no consumer ever took — and the story documented 28/36/52, three sizes
  nothing used. The 32 and the 34 were row avatars sitting two pixels apart for
  no reason.

  `compact` (26), `default` (32) and `profile` (64) cover seven of the eight,
  named by role the way `RowSize` and `DialogSize` are rather than as `sm`/`md`.
- [x] Delete compatibility selectors, dead feature CSS, and obsolete exports
  created by completed migrations.

  Unreachable rules in `workspace.module.css` were removed.

  None of it came from this pass — it was already unreachable. Worth saying
  because the detector had to distinguish real deaths from dynamic keys:
  `dialog_compact`, `field_plain` and friends look unused but are reached
  through `` styles[`dialog_${size}`] ``.

## Found on the way

Three duplications this plan never listed, closed with it.

- **`CalendarDot`.** The 9px colour mark was written out in `calendars`,
  `event-details`, and `event-editor`, with each call site pairing it with the
  same `style={{ backgroundColor }}`. It is a component in
  `calendar/components` rather than a shared primitive: a calendar's colour is
  domain, and the anatomy travels with it.

- **`0.58rem`.** Raw uses had no recorded reason and no token that small —
  `--text-10` is `0.625rem`. Chips moved onto the scale; the remaining calendar
  geometry stays feature-owned.

- **Two names.** `.recurrenceBadge` and `.homeBadge` claim a badge without a
  border, a radius or a fill; both are icon-and-word marks, and they are
  `.recurrenceMark` and `.homeMark` now, matching `.homePillMark` next door.
  `.defaultStatus` was wrongly listed with them earlier: it reports a state and
  never claimed to be a badge.

## Explicitly deferred

- Universal `Card` component. Similar borders and radii do not prove shared
  semantics; current event, invite, and preview cards may remain feature-owned.
- Universal section header beyond `SectionLabel` and `SettingsSection`.
- Prop-per-pixel APIs for padding, radius, gaps, icon width, or control layout.
- Moving web primitives into `packages/ui-web`; extraction waits for stable APIs
  and proven cross-app value.

## Verification per work item

Run the smallest relevant checks, then expand for public primitives:

```bash
pnpm --filter @musubi/web typecheck
pnpm --filter @musubi/web lint
pnpm --filter @musubi/web test
```

When changing a public primitive or story:

```bash
pnpm storybook:web:test
```

Also run the relevant Playwright flow when interaction, focus, dialog behavior,
or form submission changes. Check light/dark and regular/touch layouts. Do not
update `ui-catalog` unless the visual change was approved.

## Completion criteria

- Existing generic controls are reused where they fit; domain controls remain
  domain-owned.
- Repeated error, row-group, field, safe-area, copy-link, and hidden-text CSS is
  either consolidated or explicitly left local with a recorded reason.
- No new UI dependency or parallel component system exists.
- No new screen-specific appearance variant exists.
- Public contract changes have realistic stories and accessibility coverage.
- Keyboard paths, focus return, light/dark themes, and narrow layouts remain
  correct.
- This checklist reflects completed work and any deliberate deferrals.
