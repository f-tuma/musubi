import { CalendarDays, Cloud, CloudCog, Grid2X2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { BrandMark } from "~/components/BrandMark";
import { ProviderGlyph } from "~/components/provider-glyph";
import { cn } from "~/lib/utils";

type ProviderIconProps = {
  flavor: string | null;
  /** Compact rows have a 20px icon slot; omit the account tile frame there. */
  size?: "default" | "compact";
  /** One pigment for calendar identity; account marks retain their brand colours. */
  color?: string;
};

function MarkFrame({ children, color, flavor, size }: ProviderIconProps & { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid flex-none place-content-center text-foreground-secondary",
        size === "compact" ? "size-5" : "size-7 rounded-md border border-border-subtle bg-raised",
        flavor === "apple" && "text-foreground",
        color && "text-pigment [&_path]:fill-current",
      )}
      data-monochrome={color ? "" : undefined}
      data-provider={flavor ?? "musubi"}
      style={color ? ({ "--pigment": color } as CSSProperties) : undefined}
    >
      {children}
    </span>
  );
}

/**
 * Decorative source marks. The adjacent account heading always carries the
 * readable provider/account name, so these never become the only signal.
 */
export function ProviderIcon({ flavor, size = "default", color }: ProviderIconProps) {
  let mark;
  if (flavor === "google") {
    mark = <CalendarDays size={17} strokeWidth={1.8} />;
  } else if (flavor === "microsoft") {
    mark = <Grid2X2 size={16} strokeWidth={1.7} />;
  } else if (flavor === "apple") {
    mark = <Cloud size={17} strokeWidth={1.7} />;
  } else if (flavor === "caldav") {
    mark = <CloudCog size={17} strokeWidth={1.7} />;
  } else {
    mark = <BrandMark aria-hidden="true" className="size-4" focusable="false" />;
  }

  return (
    <MarkFrame color={color} flavor={flavor} size={size}>
      {mark}
    </MarkFrame>
  );
}

/**
 * The mark for an *account*, rather than for an event's source.
 *
 * A connected account is the provider speaking for itself, the same as on a
 * connect button, so it gets the real brand mark. CalDAV has no brand and a
 * Musubi calendar has ours, so both fall back to the line marks above.
 */
export function AccountMark({ flavor, size = "default", color }: ProviderIconProps) {
  if (flavor === "google" || flavor === "microsoft" || flavor === "apple") {
    return (
      <MarkFrame color={color} flavor={flavor} size={size}>
        <ProviderGlyph provider={flavor} monochrome={!!color} />
      </MarkFrame>
    );
  }

  return <ProviderIcon flavor={flavor} size={size} color={color} />;
}
