import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";

export const APPLE_CALDAV_URL = "https://caldav.icloud.com";

export type CaldavDraft = {
  apple: boolean;
  password: string;
  serverUrl: string;
  username: string;
};

/** Credentials for iCloud or any CalDAV server, over the settings window. */
export function CaldavDialog({
  initial,
  onConnect,
  onOpenChange,
  returnFocus,
}: {
  initial: CaldavDraft;
  /** Resolves true when connected; a false or thrown result keeps the form. */
  onConnect: (input: { password: string; serverUrl: string; username: string }) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  returnFocus?: HTMLElement | null;
}) {
  const formId = useId();
  const serverRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const serverUrl = draft.apple ? APPLE_CALDAV_URL : draft.serverUrl.trim();
    if (!serverUrl || !draft.username.trim() || !draft.password) {
      setError("Fill in the server, username and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const connected = await onConnect({ password: draft.password, serverUrl, username: draft.username.trim() });
      if (connected) onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect. Check the server and credentials.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent aria-describedby={undefined} closeLabel="Close connection form" initialFocus={draft.apple ? usernameRef : serverRef} returnFocus={returnFocus} size="compact">
        <DialogHeader>
          <DialogTitle>{draft.apple ? "Connect iCloud" : "Connect CalDAV"}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form id={formId} noValidate onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              {!draft.apple ? (
                <Field label="Server address">
                  <Input
                    ref={serverRef}
                    disabled={busy}
                    placeholder="https://caldav.example.com"
                    type="url"
                    value={draft.serverUrl}
                    onChange={(event) => setDraft({ ...draft, serverUrl: event.target.value })}
                  />
                </Field>
              ) : null}
              <Field label={draft.apple ? "Apple ID email" : "Username"}>
                <Input
                  autoComplete="username"
                  ref={usernameRef}
                  disabled={busy}
                  placeholder={draft.apple ? "name@icloud.com" : "Username"}
                  value={draft.username}
                  onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                />
              </Field>
              <Field
                help={draft.apple ? "Create one at account.apple.com. Your Apple ID password will not work." : undefined}
                label={draft.apple ? "App-specific password" : "Password"}
              >
                <Input
                  autoComplete="current-password"
                  disabled={busy}
                  placeholder="Password"
                  type="password"
                  value={draft.password}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                />
              </Field>
              {error ? <InlineError>{error}</InlineError> : null}
            </FieldGroup>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy} variant="secondary">
              Cancel
            </Button>
          </DialogClose>
          <Button form={formId} loading={busy} type="submit">
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
