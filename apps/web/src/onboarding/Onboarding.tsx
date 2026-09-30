import type { Calendar, SettingsDocument } from "@musubi/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getServerCapabilities } from "~/api/resources";
import { getServerOrigin } from "~/api/query-keys";
import { authClient } from "~/auth/auth-client";
import {
  providerConnectionScopes,
  rememberProviderLink,
} from "~/calendar/connections";
import { ThemeToggle } from "~/calendar/components/ThemeToggle";
import { AuthMessage, AuthShell, StepDots } from "~/components/auth-shell";
import { ProviderGlyph } from "~/components/provider-glyph";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Field } from "~/components/ui/field";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { Input } from "~/components/ui/input";
import { ColorPicker } from "~/components/ui/color-picker";

const STEPS = 3;

/**
 * First run in the browser.
 *
 * The same three questions the phone asks (`apps/client/app/onboarding`), gated
 * on the same server flag — somebody who set themselves up on the phone must not
 * be asked again here, and the flag is the only thing both clients can agree on.
 *
 * Nothing here creates anything. The personal calendar already exists: the
 * server makes one for every account the moment it is registered
 * (`packages/auth/src/lib/auth.ts`), so this only renames it. A step that
 * created one would have to cope with being run twice.
 */
export function Onboarding({
  calendars,
  onDone,
  onGetSettingsDocument,
  onPatchSettings,
  onUpdateCalendar,
  userName,
}: {
  calendars: Calendar[];
  onDone: () => void;
  onGetSettingsDocument: () => Promise<SettingsDocument>;
  onPatchSettings: (input: {
    baseRevision: number;
    patch: { onboarded: true };
  }) => Promise<unknown>;
  onUpdateCalendar: (calendar: Calendar) => Promise<unknown>;
  userName: string;
}) {
  const personal = calendars.find((calendar) => calendar.isDefault);

  const [step, setStep] = useState(1);
  const [name, setName] = useState(userName);
  const [calendarName, setCalendarName] = useState(personal?.name ?? "Personal");
  const [color, setColor] = useState(personal?.color ?? "#C8553D");
  const [includeTasks, setIncludeTasks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const capabilities = useQuery({
    queryFn: ({ signal }) => getServerCapabilities(signal),
    queryKey: ["server-capabilities", getServerOrigin()],
    staleTime: 5 * 60_000,
  });
  const providers = capabilities.data?.syncProviders ?? [];

  /**
   * Marks the account set up.
   *
   * Read the revision first: the patch is a compare-and-set, and the settings
   * this screen was rendered from may be a snapshot older than the server's.
   */
  async function finish() {
    const document = await onGetSettingsDocument();
    await onPatchSettings({
      baseRevision: document.revision,
      patch: { onboarded: true },
    });
    onDone();
  }

  /** Never strand somebody in a flow they cannot leave. */
  async function attempt(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function connect(provider: "google" | "microsoft") {
    await attempt(async () => {
      // Finish first, then leave: the trip to the provider comes back to this
      // page, and an account still marked unfinished would ask all over again.
      await finish();
      rememberProviderLink(provider);
      const result = await authClient.linkSocial({
        callbackURL: window.location.href,
        provider,
        scopes: providerConnectionScopes(provider, includeTasks, capabilities.data?.googleAvailability),
      });
      if (result?.error) throw new Error(result.error.message);
    }, "Could not start the connection.");
  }

  function next() {
    void attempt(async () => {
      if (step === 1) {
        const trimmed = name.trim();
        if (trimmed && trimmed !== userName) {
          const result = await authClient.updateUser({ name: trimmed });
          if (result?.error) throw new Error(result.error.message);
        }
      }
      if (step === 2 && personal) {
        const trimmed = calendarName.trim() || "Personal";
        if (trimmed !== personal.name || color !== personal.color) {
          await onUpdateCalendar({ ...personal, color, name: trimmed });
        }
      }
      setStep(step + 1);
    }, "That could not be saved. Try again.");
  }

  const canConnect = providers.includes("google") || providers.includes("microsoft");

  return (
    <AuthShell
      progress={<StepDots step={step} total={STEPS} />}
      title={
        step === 1
          ? "Welcome to Musubi"
          : step === 2
            ? "Your calendar"
            : "Bring your calendars"
      }
      utility={<ThemeToggle />}
    >
      <form
        className="flex min-h-64 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (step < STEPS) next();
          else void attempt(finish, "Could not finish setting up. Try again.");
        }}
      >
        {step === 1 ? (
          <Field label="Your name">
            <Input
              autoComplete="name"
              autoFocus
              name="name"
              placeholder="How other people see you"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        ) : null}

        {step === 2 ? (
          <div className="flex items-end gap-3">
            <Field className="flex-1" label="Calendar name">
              <Input
                autoFocus
                name="calendar"
                placeholder="Personal"
                value={calendarName}
                onChange={(event) => setCalendarName(event.target.value)}
              />
            </Field>
            <ColorPicker label="Colour" value={color} onChange={setColor} />
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-2">
            {providers.includes("google") ? (
              <Button disabled={busy} variant="secondary" className="w-full" onClick={() => void connect("google")}>
                <ProviderGlyph provider="google" />
                Connect Google Calendar
              </Button>
            ) : null}
            {providers.includes("microsoft") ? (
              <Button disabled={busy} variant="secondary" className="w-full" onClick={() => void connect("microsoft")}>
                <ProviderGlyph provider="microsoft" />
                Connect Outlook
              </Button>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              {canConnect ? (
                <div className="flex items-center gap-1">
                  <Checkbox
                    checked={includeTasks}
                    disabled={busy}
                    label="Include Tasks"
                    onChange={(event) => setIncludeTasks(event.target.checked)}
                  />
                  <HelpTooltip label="About Tasks access">
                    When off, no Tasks permission is requested. Access granted earlier is not revoked.
                  </HelpTooltip>
                </div>
              ) : null}
              <div className="ml-auto flex items-center gap-1 text-12 text-muted-foreground">
                More providers
                <HelpTooltip label="About other calendar providers">
                  CalDAV, iCloud and other Musubi servers are in Settings → Connections.
                </HelpTooltip>
              </div>
            </div>
          </div>
        ) : null}

        <AuthMessage>{message}</AuthMessage>

        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          {step > 1 ? (
            <Button disabled={busy} variant="ghost" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : (
            <span />
          )}
          <Button loading={busy} type="submit">
            {step < STEPS ? "Continue" : canConnect ? "Skip for now" : "Open my calendar"}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
