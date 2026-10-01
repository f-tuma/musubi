import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "~/lib/utils";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, ItemValue } from "~/components/ui/item";

type DisclosureProps = {
  children: React.ReactNode;
  className?: string;
  /** The row's second line: what is folded away. */
  detail?: React.ReactNode;
  label: React.ReactNode;
  icon?: React.ReactNode;
  value?: React.ReactNode;
  density?: "default" | "compact";
  /** Leave both out to let the browser own the state. */
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
};

/**
 * A row that unfolds. Native `<details>`, so keyboard and screen-reader
 * behaviour come for free and the bulky part stays out of the way until wanted.
 */
function Disclosure({ children, className, detail, label, icon, value, density = "default", onOpenChange, open }: DisclosureProps) {
  const chevron = <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform duration-fast group-open/disclosure:rotate-90" strokeWidth={1.6} />;
  return (
    <details
      data-slot="disclosure"
      className={cn("group/disclosure", className)}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
      open={open}
    >
      <Item
        asChild
        interactive
        size={density === "compact" ? "compact" : "default"}
        className={cn("list-none [&::-webkit-details-marker]:hidden", density === "compact" && "rounded-chip px-0")}
      >
        <summary>
          <ItemMedia>{icon ?? chevron}</ItemMedia>
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
            {detail ? <ItemDescription>{detail}</ItemDescription> : null}
          </ItemContent>
          {value ? <ItemValue>{value}</ItemValue> : null}
          {icon ? <ItemActions>{chevron}</ItemActions> : null}
        </summary>
      </Item>
      <div className={cn("grid justify-items-start gap-3", density === "compact" ? "justify-items-stretch py-2" : "px-4 pb-4 pl-12")}>{children}</div>
    </details>
  );
}

export { Disclosure, type DisclosureProps };
