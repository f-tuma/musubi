import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "~/lib/utils";

/**
 * Views of one object that share a frame. Vertical tabs are the navigation
 * of the settings window; horizontal ones switch a panel's content.
 */
function Tabs({ className, orientation = "horizontal", ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn("group/tabs flex min-h-0 gap-4 data-[orientation=horizontal]:flex-col", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex gap-1 group-data-[orientation=horizontal]/tabs:border-b group-data-[orientation=horizontal]/tabs:border-border-subtle group-data-[orientation=vertical]/tabs:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-control-compact cursor-pointer items-center gap-3 rounded-md px-3 text-14 whitespace-nowrap text-foreground-secondary transition-colors duration-fast hover:enabled:text-foreground disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        "group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:hover:enabled:bg-raised/60 group-data-[orientation=vertical]/tabs:data-[state=active]:bg-raised group-data-[orientation=vertical]/tabs:data-[state=active]:text-foreground",
        "group-data-[orientation=horizontal]/tabs:rounded-none group-data-[orientation=horizontal]/tabs:px-1 group-data-[orientation=horizontal]/tabs:data-[state=active]:text-foreground group-data-[orientation=horizontal]/tabs:data-[state=active]:after:absolute group-data-[orientation=horizontal]/tabs:data-[state=active]:after:inset-x-0 group-data-[orientation=horizontal]/tabs:data-[state=active]:after:-bottom-px group-data-[orientation=horizontal]/tabs:data-[state=active]:after:h-0.5 group-data-[orientation=horizontal]/tabs:data-[state=active]:after:bg-foreground",
        "data-[state=active]:[&_svg]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("min-h-0 min-w-0 flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
