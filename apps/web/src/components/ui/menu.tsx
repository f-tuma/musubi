import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

const DEFAULT_COLLISION_PADDING = 12;
const DEFAULT_SIDE_OFFSET = 6;

export const MenuGroup = DropdownMenuGroup;
export const MenuTrigger = DropdownMenuTrigger;

/**
 * A menu button that leaves the page interactive by default: a command list
 * is a quick detour, not a modal decision.
 */
export function Menu({ modal = false, ...rootProps }: React.ComponentProps<typeof DropdownMenu>) {
  return <DropdownMenu {...rootProps} modal={modal} />;
}

export type MenuContentProps = Omit<React.ComponentProps<typeof DropdownMenuContent>, "aria-label" | "aria-labelledby"> & {
  /** Accessible name and narrow-sheet title for this command set. */
  label: string;
  /** Keep the menu anchored on narrow viewports instead of using a sheet. */
  mobileSurface?: "anchored" | "sheet";
  /** Decorative pointer back to the trigger on anchored viewports. */
  showArrow?: boolean;
};

/**
 * A short command list with Radix-owned focus, typeahead and dismissal. Below
 * 600 px it becomes a bottom sheet titled with its label.
 */
export function MenuContent({
  align = "start",
  children,
  className,
  collisionPadding = DEFAULT_COLLISION_PADDING,
  label,
  loop = true,
  mobileSurface = "sheet",
  showArrow = false,
  sideOffset = DEFAULT_SIDE_OFFSET,
  ...contentProps
}: MenuContentProps) {
  const titleId = React.useId();

  return (
    <DropdownMenuContent
      {...contentProps}
      align={align}
      aria-labelledby={titleId}
      className={cn(
        "flex w-64 max-w-(--radix-dropdown-menu-content-available-width) min-w-(--radix-dropdown-menu-trigger-width) flex-col overflow-hidden p-0",
        "max-sm:data-[mobile-surface=sheet]:w-full max-sm:data-[mobile-surface=sheet]:max-w-full max-sm:data-[mobile-surface=sheet]:rounded-t-sheet max-sm:data-[mobile-surface=sheet]:rounded-b-none max-sm:data-[mobile-surface=sheet]:border-x-0 max-sm:data-[mobile-surface=sheet]:border-b-0 max-sm:data-[mobile-surface=sheet]:pb-safe-bottom",
        className,
      )}
      collisionPadding={collisionPadding}
      data-mobile-surface={mobileSurface}
      data-ui="menu-content"
      loop={loop}
      sideOffset={sideOffset}
    >
      <DropdownMenuLabel
        className="sr-only max-sm:in-data-[mobile-surface=sheet]:not-sr-only max-sm:in-data-[mobile-surface=sheet]:border-b max-sm:in-data-[mobile-surface=sheet]:border-border-subtle max-sm:in-data-[mobile-surface=sheet]:px-5 max-sm:in-data-[mobile-surface=sheet]:pt-6 max-sm:in-data-[mobile-surface=sheet]:pb-3 max-sm:in-data-[mobile-surface=sheet]:font-serif max-sm:in-data-[mobile-surface=sheet]:text-19 max-sm:in-data-[mobile-surface=sheet]:leading-tight max-sm:in-data-[mobile-surface=sheet]:font-normal max-sm:in-data-[mobile-surface=sheet]:tracking-normal max-sm:in-data-[mobile-surface=sheet]:text-foreground max-sm:in-data-[mobile-surface=sheet]:normal-case"
        id={titleId}
      >
        {label}
      </DropdownMenuLabel>
      <div className="grid min-h-0 gap-0.5 overflow-y-auto overscroll-contain p-1 max-sm:p-2">{children}</div>
      {showArrow ? (
        <DropdownMenuPrimitive.Arrow aria-hidden="true" className="fill-panel stroke-border max-sm:in-data-[mobile-surface=sheet]:hidden" />
      ) : null}
    </DropdownMenuContent>
  );
}

export type MenuItemProps = Omit<React.ComponentProps<typeof DropdownMenuItem>, "asChild" | "children" | "inset" | "variant"> & {
  children: React.ReactNode;
  icon?: React.ReactNode;
  shortcut?: React.ReactNode;
  tone?: "default" | "destructive";
};

/** One command. The icon column is always there, so labels align down the list. */
export function MenuItem({ children, className, icon, shortcut, tone = "default", ...itemProps }: MenuItemProps) {
  return (
    <DropdownMenuItem
      {...itemProps}
      className={cn("gap-2 data-[variant=destructive]:data-[highlighted]:bg-shu/10 max-sm:min-h-12", className)}
      data-tone={tone}
      variant={tone}
    >
      <span aria-hidden="true" className="grid w-5 flex-none place-content-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <DropdownMenuShortcut aria-hidden="true">{shortcut}</DropdownMenuShortcut> : null}
    </DropdownMenuItem>
  );
}

export function MenuSeparator({ className, ...separatorProps }: React.ComponentProps<typeof DropdownMenuSeparator>) {
  return <DropdownMenuSeparator {...separatorProps} className={className} />;
}
