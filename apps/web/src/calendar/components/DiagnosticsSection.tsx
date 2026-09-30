import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Disclosure } from "~/components/ui/disclosure";
import { InlineError } from "~/components/ui/inline-error";
import { Row } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { useAsyncAction } from "~/lib/use-async-action";
import { summarise, worstStatus, type CheckStatus } from "~/diagnostics/checks";
import {
  buildReport,
  collectSnapshot,
  type Snapshot,
} from "~/diagnostics/collect";

/**
 * Shape, not colour.
 *
 * The icon carries the verdict; colour only repeats it, and the accent is
 * spent on the thing that is actually wrong.
 */
const STATUS_ICON = {
  fail: XCircle,
  pass: CheckCircle2,
  warn: AlertTriangle,
} satisfies Record<CheckStatus, typeof CheckCircle2>;

function StatusIcon({ status }: { status: CheckStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cn(
        "inline-flex",
        status === "pass" && "text-success",
        status === "warn" && "text-warning",
        status === "fail" && "text-shu",
      )}
      data-status={status}
    >
      <Icon size={16} strokeWidth={1.6} />
    </span>
  );
}

/**
 * A notification raised the way a real reminder is.
 *
 * Through the service worker when one is registered, because that is the path a
 * pushed reminder takes and the point is to test the path rather than the API.
 * A tab with no worker falls back to the in-tab constructor, which is what its
 * reminders would use anyway.
 */
async function showTestNotification() {
  if (Notification.permission !== "granted") {
    const granted = await Notification.requestPermission();
    if (granted !== "granted") {
      throw new Error(
        "This browser has not granted notification permission, so nothing can be shown.",
      );
    }
  }

  const body = `If this appeared, delivery works. Sent ${new Date().toLocaleTimeString()}.`;
  const registration =
    "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistration("/app/")
      : undefined;

  if (registration) {
    await registration.showNotification("Musubi test reminder", { body });
    return;
  }
  new Notification("Musubi test reminder", { body });
}

export type DiagnosticsSectionProps = {
  /** Whether the reminder rules the resolver needs have arrived. */
  remindersLoaded: boolean;
};

/**
 * What this browser can tell you about why a reminder never arrived.
 *
 * Every failure in that chain is quiet: a permission nothing ever asked for, a
 * service worker that 404s behind a misrouted gateway, a subscription the
 * server dropped, a clock two minutes out, or a tab still running last week's
 * bundle. They are indistinguishable from outside, so the checks run on open
 * and each one ends in a verdict with its reason attached.
 */
export function DiagnosticsSection({
  remindersLoaded,
}: DiagnosticsSectionProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [running, setRunning] = useState(true);
  const [copied, setCopied] = useState(false);
  const action = useAsyncAction();

  const collect = useCallback(async () => {
    try {
      setSnapshot(await collectSnapshot({ remindersLoaded }));
    } finally {
      setRunning(false);
    }
  }, [remindersLoaded]);

  useEffect(() => {
    void collect();
  }, [collect]);

  /** Re-check on demand, which is the one path that has to raise the flag. */
  const rerun = () => {
    setRunning(true);
    setCopied(false);
    void collect();
  };

  /** Every action here changes what the checks say, so re-check after it. */
  const act = (label: string, run: () => Promise<void>) =>
    void action.run(async () => {
      await run();
      setRunning(true);
      await collect();
    }, label);

  const checks = snapshot?.checks ?? [];
  const overall = worstStatus(checks);

  return (
    <>
      <SettingsSection title="Diagnostics">
        <Row
          detail={
            running ? "Checking this browser and server…" : summarise(checks)
          }
          icon={running ? undefined : <StatusIcon status={overall} />}
          label="System status"
          layout="responsive-actions"
          trailing={
            <Button
              disabled={running || action.busy}
              loading={running}
              onClick={rerun}
              size="compact"
              variant="secondary"
            >
              Run checks
            </Button>
          }
        />

        <Row
          detail="Can this browser show reminders?"
          label="Test notification"
          layout="responsive-actions"
          trailing={
            <Button
              disabled={
                action.busy || running || typeof Notification === "undefined"
              }
              onClick={() =>
                act(
                  "The test notification could not be shown.",
                  showTestNotification,
                )
              }
              size="compact"
              variant="secondary"
            >
              Show notification
            </Button>
          }
        />
      </SettingsSection>
      {action.error ? <InlineError>{action.error}</InlineError> : null}

      {checks.length > 0 ? (
        <SettingsSection title="Checks">
          {checks.map((check) => (
            <Row
              detail={check.detail}
              icon={<StatusIcon status={check.status} />}
              key={check.id}
              label={check.label}
            />
          ))}
        </SettingsSection>
      ) : null}

      {/* Its own group: the evidence is a different kind of thing from the
          verdicts above it, and the checks read as one list only while nothing
          else shares their card. */}
      <SettingsSection title="Full report" help="Nothing here leaves the page until you copy it.">
        <Disclosure
          label={
            snapshot ? "Server, browser, and notification state" : "Gathering…"
          }
        >
          <pre className="max-h-64 w-full overflow-auto rounded-md bg-panel p-3 font-mono text-11 leading-normal whitespace-pre text-muted-foreground">
            {snapshot ? buildReport(snapshot) : ""}
          </pre>
          <Button
            disabled={!snapshot}
            onClick={() => {
              if (!snapshot) return;
              void navigator.clipboard
                .writeText(buildReport(snapshot))
                .then(() => setCopied(true))
                // A refused clipboard is not worth an error: the report is on
                // the page and selectable, which is the way out anyway.
                .catch(() => setCopied(false));
            }}
            size="compact"
            variant="secondary"
          >
            {copied ? "Copied" : "Copy report"}
          </Button>
        </Disclosure>
      </SettingsSection>
    </>
  );
}
