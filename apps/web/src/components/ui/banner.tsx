import { CloudOff, Info, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

/** "3 minutes ago": enough to judge the data, without a clock's precision. */
export function describeAge(savedAt: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

type BannerTone = "offline" | "refreshing" | "update";

/**
 * One thin bar above the calendar for one kind of fact: what you are looking
 * at is not what the server has. Shu only when nothing fresher is coming.
 */
function Banner({ tone, icon, children, action }: { tone: BannerTone; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      data-slot="banner"
      data-tone={tone}
      role="status"
      className={cn(
        "flex min-h-8 items-center justify-center gap-2 px-4 py-1 text-center text-12 [&>svg]:size-3.5 [&>svg]:flex-none",
        tone === "offline" ? "bg-shu text-shu-foreground" : "bg-raised text-foreground-secondary",
      )}
    >
      {icon}
      <span>{children}</span>
      {action}
    </div>
  );
}

/**
 * The calendar on screen came out of a snapshot rather than from the server.
 * Narrow viewports only, and only while offline: elsewhere the sidebar's sync
 * status says it without moving the grid.
 */
export function StaleBanner({
  savedAt,
  suffix,
  tone = "offline",
}: {
  savedAt: number | undefined;
  /** Extra sentence for a case the banner cannot infer, e.g. writes refused. */
  suffix?: string;
  tone?: "offline" | "refreshing";
}) {
  const age = savedAt ? describeAge(savedAt) : undefined;
  const text =
    tone === "offline"
      ? age
        ? `Offline — showing the calendar as it was ${age}.`
        : "Offline — the server cannot be reached."
      : age
        ? `Showing saved data from ${age} — refreshing.`
        : "Showing saved data — refreshing.";
  return (
    <Banner tone={tone} icon={tone === "offline" ? <CloudOff aria-hidden="true" strokeWidth={1.8} /> : <RefreshCw aria-hidden="true" strokeWidth={1.8} />}>
      {text}
      {suffix ? ` ${suffix}` : ""}
    </Banner>
  );
}

/** A newer Musubi is on the server. It offers a reload rather than forcing one. */
export function UpdateBanner({ onReload }: { onReload: () => void }) {
  return (
    <Banner
      tone="update"
      icon={<Sparkles aria-hidden="true" strokeWidth={1.8} />}
      action={
        <Button size="compact" variant="secondary" className="ml-1" onClick={onReload}>
          Reload
        </Button>
      }
    >
      A newer Musubi is ready.
    </Banner>
  );
}

/** Persistent information about the completeness of a displayed calendar. */
export function CoverageBanner({ message }: { message: string }) {
  return (
    <Banner tone="refreshing" icon={<Info aria-hidden="true" strokeWidth={1.8} />}>
      {message}
    </Banner>
  );
}
