# Musubi agent instructions

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
  pass. Fix the cause; do not disable a rule or grow the legacy list.
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
- `ui-catalog`
