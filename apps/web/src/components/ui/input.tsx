import * as React from "react";
import { cn } from "~/lib/utils";

const inputClassName =
  "h-control w-full min-w-0 rounded-control border border-border bg-raised px-3 text-14 text-foreground transition-colors duration-fast placeholder:text-muted-foreground hover:border-border-strong focus-visible:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-shu file:mr-3 file:border-0 file:bg-transparent file:text-13 file:font-medium file:text-foreground";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClassName, className)} {...props} />;
}

export { Input, inputClassName };
