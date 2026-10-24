# Musubi agent instructions

## Git workflow

- Implement work on a `codex/` branch, commit it, and open a pull request to `main`.
- Before opening each pull request, have an independent subagent skeptically
  review the final changes and explicitly approve them. Fix findings and obtain
  approval again when the reviewed changes materially change.
- Squash merge only after the pull request's checks are green for its current
  head commit. Do not bypass required checks or branch protection.
- Keep implementation, publication, and production deployment evidence separate.

## Behavior testing

- During development, start with the smallest relevant JSON scenario using
  `pnpm test:behavior --suite <suite> --scenario <id>`; `--list` shows the inventory
  and `--json` produces a machine-readable report. See `docs/testing/behavior-scenarios.md`.
- Exercise production functions/components and replace dependencies at their
  existing ports. Add a scenario driver for a new boundary instead of copying
  business logic into a simulated implementation.
- After implementation and fast checks pass, confirm the changed flow through
  the running application. `pnpm test:behavior:browser` replays the task-inspector
  JSON scenarios against the web app. Its API fixtures do not prove real DB,
  authentication or provider behavior; run the relevant integration/live checks
  when those boundaries change.
- Keep all required CI checks and applicable UI verification. Fast scenarios
  shorten the edit loop; they do not replace final checks or deployment evidence.

## Web UI

For any UI, styling, interaction, or accessibility work under `apps/web`, load
and follow `.agents/skills/musubi-ui/SKILL.md` before editing.

Hard rules:

- The UI guides by design, not by text. Titles name, rows are one line, help
  goes behind a "?", one primary action per surface.
- Style with Tailwind utilities from Musubi's theme. The theme is generated
  from `packages/design-system`; add a missing value there, never inline it.
- Build from `apps/web/src/components/ui` (shadcn components restyled to
  Musubi). Feature code composes them; it never creates a second generic
  button, field, dialog, popover, menu, row, picker, or toast.
- A caller's `className` on a component is layout only. Variants own height,
  padding, colour, type, radius and shadow.
- Radix is imported only inside `apps/web/src/components/ui`.
- `pnpm --filter @musubi/web lint` (`@shadcn/lint`, every rule at error) must
  pass. Fix the cause; do not disable a rule or add an exception.
- Do not add a UI or styling dependency beyond Tailwind, shadcn/Radix, `cn`,
  `class-variance-authority`, `tw-animate-css` and `lucide-react` without
  explicit human approval.
- Preserve keyboard behavior, focus return, accessible names, contrast, reduced
  motion, light/dark themes, and narrow layouts.
- Do not edit generated files in `packages/design-system`; edit their TypeScript
  sources and regenerate.

Current sources of truth:

- `.agents/skills/musubi-ui/SKILL.md`
- `docs/ui/design-system.md`
- `docs/ui/calendar-ui.md`
- `packages/design-system`
- `apps/web/src/design`
- `apps/web/src/components/ui`
- colocated Storybook stories (`*.stories.tsx`)
