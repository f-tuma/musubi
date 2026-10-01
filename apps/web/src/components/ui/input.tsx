import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const inputVariants = cva(
  "w-full min-w-0 text-foreground transition-colors duration-fast placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-shu file:mr-3 file:border-0 file:bg-transparent file:text-13 file:font-medium file:text-foreground",
  {
    variants: {
      variant: {
        default: "h-control rounded-control border border-border bg-raised px-3 text-14 hover:border-border-strong focus-visible:border-border-strong",
        title: "h-auto rounded-sm border-0 bg-transparent px-0 py-1 font-serif text-22 leading-snug",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
const inputClassName = inputVariants();

function Input({ className, type, variant = "default", ...props }: React.ComponentProps<"input"> & VariantProps<typeof inputVariants>) {
  return <input type={type} data-slot="input" data-variant={variant} className={cn(inputVariants({ variant }), className)} {...props} />;
}

export { Input, inputClassName };
