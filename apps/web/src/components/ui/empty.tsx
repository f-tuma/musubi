import * as React from "react";
import { cn } from "~/lib/utils";

type EmptyProps = Omit<React.ComponentProps<"section">, "title"> & {
  action?: React.ReactNode;
  /** One sentence, if the title and action do not already say it. */
  description?: React.ReactNode;
  headingLevel?: 2 | 3;
  icon?: React.ReactNode;
  title: React.ReactNode;
};

/** Nothing here yet, and the one thing to do about it. */
function Empty({ action, className, description, headingLevel = 3, icon, title, ...props }: EmptyProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      data-slot="empty"
      className={cn("grid min-h-48 place-items-center content-center gap-2 p-6 text-center", className)}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="mb-1 grid size-control place-content-center rounded-full bg-raised text-muted-foreground [&_svg:not([class*='size-'])]:size-5">
          {icon}
        </span>
      ) : null}
      <Heading className="font-serif text-19 font-normal text-foreground">{title}</Heading>
      {description ? <p className="max-w-80 text-13 leading-normal text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}

export { Empty, type EmptyProps };
