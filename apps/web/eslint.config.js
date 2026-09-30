import eslint from "@eslint/js";
import { plugin as shadcn } from "@shadcn/lint";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".output/**", "src/routeTree.gen.ts", "storybook-static/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: [".storybook/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off",
      // The client needs no configuration — it calls /api on its own origin — and
      // a `VITE_`-prefixed variable is a value Vite inlines into a file the whole
      // internet can read. `scripts/scan-client-bundle.mjs` catches a leak after
      // the fact; this is the same rule where it is cheap to obey. A genuine need
      // for one is a code review, not a config edit.
      "no-restricted-syntax": [
        "error",
        {
          message:
            "VITE_ variables are inlined into the browser bundle. Serve the value from the API instead.",
          selector:
            'MemberExpression[object.object.type="MetaProperty"][property.name=/^VITE_/]',
        },
      ],
    },
  },
  {
    files: [".storybook/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: "~/components/ui",
        note: "Musubi's design rules: .agents/skills/musubi-ui/SKILL.md. Tokens: packages/design-system (src/tailwind.ts).",
      },
    },
    rules: {
      // A component owns its look. Callers place it; they never restyle it.
      "shadcn/no-restyle": [
        "error",
        {
          allow: ["layout"],
          deny: ["h-*", "min-h-*", "max-h-*", "size-*", "z-*"],
          message: {
            spacing: "<{{component}}> owns its spacing. Use a size ({{sizes}}) or gap on the parent.",
          },
        },
      ],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/no-unknown-classes": "error",
      "shadcn/require-static-classes": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["*.module.css"],
              message: "Style with Tailwind utilities from Musubi's theme. CSS modules are being retired.",
            },
            {
              group: ["radix-ui", "@radix-ui/*"],
              message: "Radix belongs inside src/components/ui. Import the Musubi component instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // The design system itself: the one place that styles and wraps Radix.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "shadcn/no-restyle": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    // Not yet on Tailwind. Each file leaves this list when it is migrated;
    // nothing is ever added to it. The old src/ui primitives go with it.
    files: [
      "src/ui/**",
      "src/calendar/components/AccountDialog.tsx",
      "src/calendar/components/AdminSettings.tsx",
      "src/calendar/components/AgendaProposal.stories.tsx",
      "src/calendar/components/AgendaView.tsx",
      "src/calendar/components/AnnouncementDialog.tsx",
      "src/calendar/components/AvailabilitySection.tsx",
      "src/calendar/components/CalendarCoverageInfo.tsx",
      "src/calendar/components/CalendarDot.tsx",
      "src/calendar/components/CalendarTaskDetails.tsx",
      "src/calendar/components/CalendarTransferDialog.tsx",
      "src/calendar/components/CalendarVisibilityPill.tsx",
      "src/calendar/components/ConnectionsDialog.tsx",
      "src/calendar/components/DayAxisProposal.stories.tsx",
      "src/calendar/components/DiagnosticsSection.tsx",
      "src/calendar/components/EventDeliveryDialog.tsx",
      "src/calendar/components/EventDeliveryInboxDialog.tsx",
      "src/calendar/components/EventDetailsPopover.tsx",
      "src/calendar/components/EventEditorForm.tsx",
      "src/calendar/components/EventMarks.tsx",
      "src/calendar/components/EventPanelProposal.stories.tsx",
      "src/calendar/components/EventPopover.tsx",
      "src/calendar/components/MiniCalendar.tsx",
      "src/calendar/components/MonthCalendar.tsx",
      "src/calendar/components/MultiWeekCalendar.tsx",
      "src/calendar/components/OutlookMoveDialog.tsx",
      "src/calendar/components/PageSettingsDialog.tsx",
      "src/calendar/components/ProviderEventDetails.tsx",
      "src/calendar/components/ProviderIcon.tsx",
      "src/calendar/components/ProviderMeetingCreateDialog.tsx",
      "src/calendar/components/ProviderOrganizerEditor.tsx",
      "src/calendar/components/ProviderReminderEditor.tsx",
      "src/calendar/components/ProviderRsvpEditor.tsx",
      "src/calendar/components/QuickCreate.tsx",
      "src/calendar/components/RecurrenceEditor.tsx",
      "src/calendar/components/RecurrenceScopeDialog.tsx",
      "src/calendar/components/SearchDialog.tsx",
      "src/calendar/components/SettingsDialog.tsx",
      "src/calendar/components/ShareCalendarDialog.tsx",
      "src/calendar/components/ShortcutsDialog.tsx",
      "src/calendar/components/Sidebar.tsx",
      "src/calendar/components/TaskLayoutSwitch.tsx",
      "src/calendar/components/TaskList.tsx",
      "src/calendar/components/TimeGridView.tsx",
      "src/calendar/components/Toolbar.stories.tsx",
      "src/calendar/components/Toolbar.tsx",
      "src/calendar/components/Workspace.tsx",
      "src/design/Foundations.stories.tsx",
      "src/routes/app/admin.tsx",
      "src/routes/app/p.$pageId.$view.event.$eventId.tsx",
      "src/routes/app/p.$pageId.$view.event.new.tsx",
      "src/routes/app.tsx",
    ],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-raw-colors": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/no-inline-styles": "off",
      "shadcn/no-unknown-classes": "off",
      "shadcn/require-static-classes": "off",
      "no-restricted-imports": "off",
    },
  },
);
