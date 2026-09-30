import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

/** A name in a dense list, a name in a row or a stack, and the account photo. */
const avatarVariants = cva(
  "relative inline-grid flex-none place-items-center overflow-hidden rounded-full bg-raised font-medium text-foreground-secondary select-none *:col-start-1 *:row-start-1",
  {
    variants: {
      size: {
        compact: "size-6 text-11",
        default: "size-8 text-12",
        profile: "size-16 text-22",
      },
    },
    defaultVariants: { size: "default" },
  },
);

type AvatarProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof avatarVariants> & {
    image?: null | string;
    name: string;
  };

/** Decorative: the name beside it stays the accessible label. */
function Avatar({ className, image, name, size, ...props }: AvatarProps) {
  const initial = name.trim().charAt(0).toLocaleUpperCase() || "M";
  return (
    <span data-slot="avatar" aria-hidden="true" className={cn(avatarVariants({ size }), className)} {...props}>
      <span>{initial}</span>
      {image ? <img alt="" className="size-full object-cover" src={image} onError={(event) => event.currentTarget.remove()} /> : null}
    </span>
  );
}

type AvatarStackPerson = { id: string; image?: null | string; name: string };

type AvatarStackProps = Omit<React.ComponentProps<"button">, "children"> & {
  /** The stack opens the full list; this names that action. */
  label: string;
  limit?: number;
  people: readonly AvatarStackPerson[];
};

const DEFAULT_LIMIT = 7;
const stack = "inline-flex items-center *:ring-2 *:ring-canvas [&>*+*]:-ml-2";

function AvatarStackFaces({ people, limit }: { people: readonly AvatarStackPerson[]; limit: number }) {
  const shown = people.slice(0, Math.max(0, limit));
  const hidden = people.length - shown.length;
  return (
    <>
      {shown.map((person) => (
        <Avatar image={person.image} key={person.id} name={person.name} />
      ))}
      {hidden > 0 ? (
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-sunken text-11 font-medium text-foreground-secondary">
          +{hidden}
        </span>
      ) : null}
    </>
  );
}

/** Overlapping faces that open the full list. */
function AvatarStack({ className, label, limit = DEFAULT_LIMIT, people, type = "button", ...props }: AvatarStackProps) {
  return (
    <button
      data-slot="avatar-stack"
      aria-label={label}
      className={cn(stack, "cursor-pointer rounded-full border-0 bg-transparent p-0", className)}
      type={type}
      {...props}
    >
      <AvatarStackFaces people={people} limit={limit} />
    </button>
  );
}

/** The same faces inside an existing trigger, so buttons never nest. */
function AvatarStackPreview({ people, limit = DEFAULT_LIMIT }: Pick<AvatarStackProps, "people" | "limit">) {
  return (
    <span aria-hidden="true" className={stack}>
      <AvatarStackFaces people={people} limit={limit} />
    </span>
  );
}

export { Avatar, AvatarStack, AvatarStackPreview, avatarVariants, type AvatarProps, type AvatarStackPerson, type AvatarStackProps };
