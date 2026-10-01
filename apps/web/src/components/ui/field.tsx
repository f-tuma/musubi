import * as React from "react";
import { cn } from "~/lib/utils";
import { Label } from "~/components/ui/label";
import { HelpTooltip } from "~/components/ui/help-tooltip";

type FieldControlProps = {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "true";
  id?: string;
};

type FieldProps = Omit<React.ComponentProps<"div">, "children"> & {
  children: React.ReactElement<FieldControlProps>;
  /** Visible hint under the control. Prefer `help`: most fields explain themselves. */
  description?: React.ReactNode;
  error?: React.ReactNode;
  /** Background help behind a "?" next to the label. */
  help?: React.ReactNode;
  label: React.ReactNode;
  labelHidden?: boolean;
  layout?: "stack" | "inline";
};

/**
 * One labelled control with its help and validation. Field wires the ids and
 * aria relationships itself, so what a screen reader hears cannot drift from
 * what the screen shows.
 */
function Field({
  children,
  className,
  description,
  error,
  help,
  label,
  labelHidden = false,
  layout = "stack",
  ...props
}: FieldProps) {
  const generatedId = React.useId();
  const child = React.Children.only(children);
  const controlId = child.props.id ?? `${generatedId}-control`;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [child.props["aria-describedby"], descriptionId, errorId].filter(Boolean).join(" ");

  const control = React.cloneElement(child, {
    "aria-describedby": describedBy || undefined,
    "aria-invalid": error ? true : child.props["aria-invalid"],
    id: controlId,
  });

  const fieldLabel = (
    <Label htmlFor={controlId} className={cn(labelHidden && "sr-only")}>
      {label}
    </Label>
  );

  return (
    <div
      data-slot="field"
      data-invalid={error ? "" : undefined}
      className={cn(
        "grid min-w-0 gap-2",
        layout === "inline" && "sm:grid-cols-5 sm:items-center sm:gap-x-4 sm:*:first:col-span-2 sm:*:nth-2:col-span-3",
        className,
      )}
      {...props}
    >
      {help ? (
        <div className="flex min-h-5 items-center gap-1">
          {fieldLabel}
          <HelpTooltip label={typeof label === "string" ? `Help for ${label}` : "Field help"}>{help}</HelpTooltip>
        </div>
      ) : (
        fieldLabel
      )}
      <div className="min-w-0">{control}</div>
      {description ? (
        <p id={descriptionId} className="col-span-full text-12 leading-normal text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="col-span-full text-12 leading-normal text-shu">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A form's fields, on the shared vertical rhythm. */
function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex w-full flex-col gap-5", className)} {...props} />;
}

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return <fieldset data-slot="field-set" className={cn("m-0 flex min-w-0 flex-col gap-4 border-0 p-0", className)} {...props} />;
}

function FieldLegend({ className, ...props }: React.ComponentProps<"legend">) {
  return (
    <legend
      data-slot="field-legend"
      className={cn("mb-3 p-0 text-11 leading-none font-medium tracking-label text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export { Field, FieldGroup, FieldLegend, FieldSet, type FieldProps };
