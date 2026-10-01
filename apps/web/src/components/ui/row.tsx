import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, ItemValue } from "~/components/ui/item";
import { Segmented, type SegmentedOption } from "~/components/ui/segmented";

type RowSize = "compact" | "default";
type RowTone = "default" | "destructive";

type RowContentProps = {
  detail?: React.ReactNode;
  icon?: React.ReactNode;
  label: React.ReactNode;
  trailing?: React.ReactNode;
  value?: React.ReactNode;
};

function RowContent({ detail, icon, label, trailing, value }: RowContentProps) {
  return (
    <>
      {icon ? <ItemMedia>{icon}</ItemMedia> : null}
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        {detail ? <ItemDescription>{detail}</ItemDescription> : null}
      </ItemContent>
      {value ? <ItemValue>{value}</ItemValue> : null}
      {trailing ? <ItemActions>{trailing}</ItemActions> : null}
    </>
  );
}

type RowProps = Omit<React.ComponentProps<"div">, "children"> &
  RowContentProps & {
    size?: RowSize;
    /** Move trailing actions under the copy below 600 px. */
    layout?: "default" | "responsive-actions";
  };

/** A static row: something shown, with optional trailing controls. */
function Row({ detail, icon, label, trailing, value, size = "default", layout = "default", className, ...props }: RowProps) {
  return (
    <Item
      size={size}
      className={cn(layout === "responsive-actions" && "max-sm:flex-wrap max-sm:[&>[data-slot=item-actions]]:basis-full max-sm:[&>[data-slot=item-actions]]:pl-8", className)}
      {...props}
    >
      <RowContent detail={detail} icon={icon} label={label} trailing={trailing} value={value} />
    </Item>
  );
}

type RowActionProps = Omit<React.ComponentProps<"button">, "children"> &
  RowContentProps & {
    selected?: boolean;
    showChevron?: boolean;
    size?: RowSize;
    tone?: RowTone;
  };

/** A row that does one thing when pressed: opens a detail, starts a flow. */
function RowAction({
  detail,
  icon,
  label,
  trailing,
  value,
  selected = false,
  showChevron = true,
  size = "default",
  tone = "default",
  type = "button",
  className,
  ...props
}: RowActionProps) {
  return (
    <Item asChild interactive size={size} tone={tone} className={className}>
      <button type={type} data-selected={selected ? "" : undefined} {...props}>
        <RowContent
          detail={detail}
          icon={icon}
          label={label}
          value={value}
          trailing={trailing ?? (showChevron ? <ChevronRight aria-hidden="true" className="size-4 text-faint" /> : null)}
        />
      </button>
    </Item>
  );
}

type RowToggleProps = Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "children"> &
  Omit<RowContentProps, "trailing" | "value"> & {
    size?: RowSize;
  };

/** The whole row is the switch, so the target is the row, not a 24 px track. */
function RowToggle({ detail, icon, label, size = "default", className, ...props }: RowToggleProps) {
  return (
    <Item asChild interactive size={size} className={className}>
      <SwitchPrimitive.Root data-slot="row-toggle" {...props}>
        <RowContent
          detail={detail}
          icon={icon}
          label={label}
          trailing={
            <span
              aria-hidden="true"
              className="relative inline-flex h-6 w-10 items-center rounded-full border border-border-strong bg-raised transition-colors duration-fast group-data-[state=checked]/item:border-primary group-data-[state=checked]/item:bg-primary"
            >
              <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-muted-foreground transition-transform duration-fast data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground" />
            </span>
          }
        />
      </SwitchPrimitive.Root>
    </Item>
  );
}

type RowOptionsProps<Value extends string> = Omit<React.ComponentProps<"div">, "onChange" | "children"> &
  Omit<RowContentProps, "trailing" | "value"> & {
    disabled?: boolean;
    onChange: (value: Value) => void;
    options: ReadonlyArray<SegmentedOption<Value>>;
    size?: RowSize;
    /** Label above the choices, for a narrow surface or options that are words. */
    stacked?: boolean;
    value: Value;
  };

/** A setting with two to four visible choices. */
function RowOptions<Value extends string>({
  detail,
  icon,
  label,
  disabled = false,
  onChange,
  options,
  size = "default",
  stacked = false,
  value,
  className,
  ...props
}: RowOptionsProps<Value>) {
  const accessibleLabel = typeof label === "string" ? label : "Options";
  return (
    <Item
      size={size}
      aria-disabled={disabled || undefined}
      className={cn(stacked ? "flex-col items-stretch gap-2 py-3" : "max-sm:flex-col max-sm:items-stretch max-sm:gap-2 max-sm:py-3", className)}
      {...props}
    >
      <RowContent detail={detail} icon={icon} label={label} />
      <Segmented
        className={cn(stacked ? "w-full" : "max-sm:w-full")}
        disabled={disabled}
        label={accessibleLabel}
        options={options}
        value={value}
        onChange={onChange}
      />
    </Item>
  );
}

export { Row, RowAction, RowOptions, RowToggle, type RowActionProps, type RowOptionsProps, type RowProps, type RowSize, type RowToggleProps, type RowTone };
