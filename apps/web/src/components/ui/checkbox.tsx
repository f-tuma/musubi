import * as React from "react";
import { cn } from "~/lib/utils";

type CheckboxProps = Omit<React.ComponentProps<"input">, "children" | "type"> & {
  description?: React.ReactNode;
  label: React.ReactNode;
  labelHidden?: boolean;
};

/**
 * A real checkbox input, drawn in Musubi's ink. Native form submission,
 * validation and assistive-technology behaviour stay intact.
 */
function Checkbox({ className, description, disabled = false, label, labelHidden = false, ...props }: CheckboxProps) {
  return (
    <label
      data-slot="checkbox"
      className={cn(
        "relative inline-flex min-h-control cursor-pointer items-center gap-3 text-14 text-foreground-secondary",
        disabled && "cursor-not-allowed opacity-50",
        labelHidden && "min-w-control justify-center",
        className,
      )}
    >
      {/* The real input lies transparent over the drawn box, so the pointer hits
          the input there and the label everywhere else. */}
      <span className="relative grid size-4.5 flex-none">
      <input {...props} className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed" disabled={disabled} type="checkbox" />
      <span
        aria-hidden="true"
        className="relative block size-4.5 rounded-sm border border-border-strong transition-colors duration-fast peer-checked:border-primary peer-checked:bg-primary peer-checked:after:absolute peer-checked:after:top-0.5 peer-checked:after:left-1.5 peer-checked:after:h-2 peer-checked:after:w-1 peer-checked:after:rotate-45 peer-checked:after:border-r-2 peer-checked:after:border-b-2 peer-checked:after:border-primary-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-shu"
      />
      </span>
      <span className={cn("grid gap-0.5", labelHidden && "sr-only")}>
        <span>{label}</span>
        {description ? <small className="text-11 text-muted-foreground">{description}</small> : null}
      </span>
    </label>
  );
}

export { Checkbox, type CheckboxProps };
