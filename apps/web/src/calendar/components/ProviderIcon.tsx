import { CalendarDays, Cloud, CloudCog, Grid2X2 } from "lucide-react";
import type { CSSProperties } from "react";
import { BrandMark } from "~/components/BrandMark";
import { classNames } from "~/ui/class-names";
import { ProviderGlyph } from "~/components/provider-glyph";
import styles from "./styles/provider-icon.module.css";

type ProviderIconProps = {
  flavor: string | null;
  /** Compact rows have a 20px icon slot; omit the account tile frame there. */
  size?: "default" | "compact";
  /** One pigment for calendar identity; account marks retain their brand colours. */
  color?: string;
};

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
    mark = (
      <BrandMark
        aria-hidden="true"
        className={styles.musubiMark}
        focusable="false"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={classNames(styles.icon, size === "compact" && styles.compact)}
      data-provider={flavor ?? "musubi"}
      data-monochrome={color ? "" : undefined}
      style={color ? { "--provider-color": color } as CSSProperties : undefined}
    >
      {mark}
    </span>
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
  const brand = <ProviderGlyph provider={flavor ?? ""} monochrome={!!color} />;
  if (flavor === "google" || flavor === "microsoft" || flavor === "apple") {
    return (
      <span
        aria-hidden="true"
        className={classNames(styles.icon, size === "compact" && styles.compact)}
        data-provider={flavor}
        data-monochrome={color ? "" : undefined}
        style={color ? { "--provider-color": color } as CSSProperties : undefined}
      >
        {brand}
      </span>
    );
  }

  return <ProviderIcon flavor={flavor} size={size} color={color} />;
}
