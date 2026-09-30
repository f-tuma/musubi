import * as React from "react";
import { cn } from "~/lib/utils";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { ItemGroup } from "~/components/ui/item";
import { SectionLabel } from "~/components/ui/section-label";

type SettingsSectionProps = Omit<React.ComponentProps<"section">, "title"> & {
  /**
   * Background help behind a "?" beside the heading. This is where an
   * explanation of the whole group goes, so the rows can stay one line each.
   */
  help?: React.ReactNode;
  /** Use 2 directly under a page title; dialogs normally use 3. */
  headingLevel?: 2 | 3;
  /** Rows on the shared panel (default), or free content such as a form. */
  variant?: "rows" | "plain";
  title: React.ReactNode;
};

/**
 * One named group: a small-caps heading and a panel of rows beneath it.
 * No descriptions: a group whose rows need a paragraph above them to be
 * understood needs better rows.
 */
function SettingsSection({
  children,
  className,
  help,
  headingLevel = 3,
  title,
  variant = "rows",
  ...props
}: SettingsSectionProps) {
  const headingId = React.useId();
  return (
    <section data-slot="settings-section" aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      <div className="flex min-h-5 items-center gap-1">
        <SectionLabel id={headingId} level={headingLevel}>
          {title}
        </SectionLabel>
        {help ? (
          <HelpTooltip label={typeof title === "string" ? `About ${title}` : "About this section"}>{help}</HelpTooltip>
        ) : null}
      </div>
      {variant === "rows" ? <ItemGroup>{children}</ItemGroup> : children}
    </section>
  );
}

export { SettingsSection, type SettingsSectionProps };
