import * as React from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";
import { useElevatedLayer } from "~/components/ui/layer";

const DropdownMenuContext = React.createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
} | null>(null);
const NARROW_QUERY = "(max-width: 599px)";
const subscribeNarrow = (callback: () => void) => {
  const query = matchMedia(NARROW_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};

/** For a short list of commands. Persistent choices belong in a Select or ToggleGroup. */
function DropdownMenu({ open, defaultOpen = false, onOpenChange, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const controlled = open !== undefined;
  const currentOpen = controlled ? open : localOpen;
  const changeOpen = (next: boolean) => {
    if (!controlled) setLocalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <DropdownMenuContext.Provider value={{ open: currentOpen, onOpenChange: changeOpen }}>
      <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} open={currentOpen} onOpenChange={changeOpen} />
    </DropdownMenuContext.Provider>
  );
}

function DropdownMenuTrigger({ onPointerDown, onPointerCancel, onKeyDown, onClick, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const menu = React.useContext(DropdownMenuContext);
  const narrow = React.useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW_QUERY).matches, () => false);
  const openAtPress = React.useRef<boolean | undefined>(undefined);
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
      onPointerDown={(event) => {
        openAtPress.current = undefined;
        onPointerDown?.(event);
        if (event.defaultPrevented || !narrow || event.button !== 0 || event.ctrlKey || props.disabled) return;
        // Opening on press can move a command sheet under the same pointer.
        // Wait for release so the opening gesture cannot also run a command.
        openAtPress.current = menu?.open;
        event.preventDefault();
      }}
      onPointerCancel={(event) => {
        openAtPress.current = undefined;
        onPointerCancel?.(event);
      }}
      onKeyDown={(event) => {
        openAtPress.current = undefined;
        onKeyDown?.(event);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && narrow && menu && !event.ctrlKey && !props.disabled) {
          // Accessibility activation has no pointer press to capture.
          menu.onOpenChange(!(event.detail === 0 ? menu.open : (openAtPress.current ?? menu.open)));
        }
        openAtPress.current = undefined;
      }}
    />
  );
}

function DropdownMenuGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuSub(props: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuRadioGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

const surface =
  "min-w-48 overflow-x-hidden overflow-y-auto rounded-card border border-border bg-panel p-1 text-foreground shadow-overlay duration-fast data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95";

function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 12,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const elevated = useElevatedLayer();
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          surface,
          "max-h-(--radix-dropdown-menu-content-available-height) origin-(--radix-dropdown-menu-content-transform-origin)",
          elevated ? "z-popover-elevated" : "z-popover",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

const item =
  "relative flex min-h-control-compact cursor-pointer items-center gap-3 rounded-md px-3 text-14 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-raised [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4";

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        item,
        "data-[inset]:pl-10 data-[variant=destructive]:text-shu data-[variant=destructive]:[&_svg]:text-shu",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(item, "pr-10", className)}
      checked={checked}
      {...props}
    >
      {children}
      <span className="pointer-events-none absolute right-3 flex items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="text-foreground" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(item, "pr-10", className)}
      {...props}
    >
      {children}
      <span className="pointer-events-none absolute right-3 flex items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="text-foreground" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn("px-3 pt-2 pb-1 text-11 font-medium tracking-label text-muted-foreground uppercase data-[inset]:pl-10", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border-subtle", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="dropdown-menu-shortcut" className={cn("ml-auto text-12 text-muted-foreground", className)} {...props} />
  );
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(item, "data-[inset]:pl-10 data-[state=open]:bg-raised", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const elevated = useElevatedLayer();
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        className={cn(
          surface,
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          elevated ? "z-popover-elevated" : "z-popover",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
