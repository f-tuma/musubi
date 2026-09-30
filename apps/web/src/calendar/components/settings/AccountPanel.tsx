import { Camera, KeyRound, Mail, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, type RefObject, useCallback, useId, useRef, useState } from "react";
import { deleteAccount, uploadAvatar } from "~/api/resources";
import { authClient } from "~/auth/auth-client";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { RowAction } from "~/components/ui/row";
import { SettingsSection } from "~/components/ui/settings-section";
import { useAsyncAction } from "~/lib/use-async-action";

export type AccountPanelProps = {
  onNotice: (message: string) => void;
  /** The account is on its way out; the window has nothing left to show. */
  onClose: () => void;
};

type AccountUser = {
  email: string;
  // Decides who is asked to approve a change of address, so the copy can say
  // which inbox to look in rather than guessing.
  emailVerified?: boolean;
  image?: null | string;
  name: string;
};

const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Strip the `data:<mime>;base64,` prefix — the API wants raw base64.
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.readAsDataURL(file);
  });
}

/** Who you are to the people you share with, and how to leave. */
export function AccountPanel({ onClose, onNotice }: AccountPanelProps) {
  const session = authClient.useSession();
  const user = session.data?.user;
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const avatarActionRef = useRef<HTMLButtonElement>(null);
  const setAvatarInput = useCallback((input: HTMLInputElement | null) => {
    avatarInputRef.current = input;
    if (!input) return;
    const restoreFocus = () => avatarActionRef.current?.focus();
    input.addEventListener("cancel", restoreFocus);
    return () => {
      input.removeEventListener("cancel", restoreFocus);
      avatarInputRef.current = null;
    };
  }, []);
  const nameActionRef = useRef<HTMLButtonElement>(null);
  const emailActionRef = useRef<HTMLButtonElement>(null);
  const deleteActionRef = useRef<HTMLButtonElement>(null);
  const [editor, setEditor] = useState<"name" | "email" | "delete">();
  const { busy, error, run, setError } = useAsyncAction();

  async function changeAvatar(file: File) {
    if (!AVATAR_TYPES.has(file.type)) {
      setError("Choose a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError("Choose an image up to 256 KB.");
      return;
    }
    await run(async () => {
      const { url } = await uploadAvatar(await toBase64(file));
      const result = await authClient.updateUser({ image: url });
      if (result.error) throw new Error(result.error.message);
      await session.refetch();
      onNotice("Photo updated.");
    }, "Could not update your photo.");
  }

  async function resetPassword() {
    if (!user?.email) return;
    await run(async () => {
      const result = await authClient.requestPasswordReset({
        email: user.email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error) throw new Error(result.error.message);
      onNotice("Check your email for a link to set a new passphrase.");
    }, "Could not start a passphrase reset.");
  }

  function openEditor(next: "name" | "email" | "delete") {
    setError("");
    setEditor(next);
  }

  const closeEditor = (open: boolean) => {
    if (!open) setEditor(undefined);
  };

  return (
    <>
      <div aria-busy={busy || undefined} className="flex items-center gap-4">
        <input
          accept="image/png,image/jpeg,image/webp"
          aria-label="Change profile photo"
          className="sr-only"
          disabled={busy}
          ref={setAvatarInput}
          tabIndex={-1}
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void changeAvatar(file);
          }}
        />
        <button
          aria-label="Change photo"
          className="group/avatar relative flex-none cursor-pointer rounded-full disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!user || busy}
          ref={avatarActionRef}
          title="Change photo"
          type="button"
          onClick={() => avatarInputRef.current?.click()}
        >
          <Avatar image={user?.image} name={user?.name ?? "Musubi"} size="profile" />
          <span
            aria-hidden="true"
            className="absolute -right-1 -bottom-1 grid size-7 place-content-center rounded-full border border-border bg-panel text-foreground-secondary transition-colors duration-fast group-hover/avatar:text-foreground"
          >
            <Camera className="size-3.5" strokeWidth={1.7} />
          </span>
        </button>
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate font-serif text-19 text-foreground">{user?.name ?? "Your profile"}</span>
          <span className="truncate text-13 text-muted-foreground">{user?.email ?? "Loading account…"}</span>
        </div>
      </div>

      {error ? <InlineError>{error}</InlineError> : null}

      <SettingsSection title="Profile" help="People you share calendars with see your name and photo.">
        <RowAction
          detail={user?.name}
          disabled={!user || busy}
          icon={<Pencil />}
          label="Display name"
          ref={nameActionRef}
          onClick={() => openEditor("name")}
        />
        <RowAction
          detail={user?.email}
          disabled={!user || busy}
          icon={<Mail />}
          label="Email"
          ref={emailActionRef}
          onClick={() => openEditor("email")}
        />
      </SettingsSection>

      <SettingsSection title="Security">
        <RowAction
          detail="Sends a link by email"
          disabled={!user?.email || busy}
          icon={<KeyRound />}
          label="Reset passphrase"
          showChevron={false}
          onClick={() => void resetPassword()}
        />
        <RowAction
          detail="Needs email confirmation"
          disabled={!user || busy}
          icon={<Trash2 />}
          label="Delete account"
          ref={deleteActionRef}
          tone="destructive"
          onClick={() => openEditor("delete")}
        />
      </SettingsSection>

      {user && editor === "name" ? (
        <EditNameDialog
          key={user.name}
          onNotice={onNotice}
          onOpenChange={closeEditor}
          onRefetch={() => session.refetch()}
          returnFocus={nameActionRef}
          user={user}
        />
      ) : null}

      {user && editor === "email" ? (
        <EditEmailDialog
          key={user.email}
          onNotice={onNotice}
          onOpenChange={closeEditor}
          returnFocus={emailActionRef}
          user={user}
        />
      ) : null}

      {user && editor === "delete" ? (
        <DeleteAccountDialog
          onDeleted={() => {
            setEditor(undefined);
            onNotice("Check your email — open the link we sent to permanently delete your account.");
            onClose();
          }}
          onOpenChange={closeEditor}
          returnFocus={deleteActionRef}
          userName={user.name}
        />
      ) : null}
    </>
  );
}

function EditNameDialog({
  onNotice,
  onOpenChange,
  onRefetch,
  returnFocus,
  user,
}: {
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  onRefetch: () => Promise<unknown>;
  returnFocus: RefObject<HTMLElement | null>;
  user: AccountUser;
}) {
  const formId = useId();
  const [name, setName] = useState(user.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAsyncAction();
  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && trimmedName !== user.name;

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    const saved = await run(async () => {
      const result = await authClient.updateUser({ name: trimmedName });
      if (result.error) throw new Error(result.error.message);
      await onRefetch();
      return true;
    }, "Could not update your name.");
    if (saved) {
      onNotice("Name updated.");
      onOpenChange(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        closeLabel="Close display name"
        initialFocus={inputRef}
        returnFocus={returnFocus}
        size="compact"
      >
        <DialogHeader>
          <DialogTitle>Display name</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form id={formId} onSubmit={(event) => void saveName(event)}>
            <FieldGroup>
              <Field help="How people recognize you in shared calendars." label="Display name">
                <Input
                  autoComplete="name"
                  disabled={busy}
                  maxLength={80}
                  ref={inputRef}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
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
          <Button disabled={!canSave} form={formId} loading={busy} type="submit">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccountDialog({
  onDeleted,
  onOpenChange,
  returnFocus,
  userName,
}: {
  onDeleted: () => void;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
  userName: string;
}) {
  const formId = useId();
  const [confirmation, setConfirmation] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAsyncAction();
  const matches = confirmation === userName;

  async function removeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches) return;
    const deleted = await run(async () => {
      await deleteAccount();
      return true;
    }, "Your account could not be deleted. It is still active — try again.");
    if (deleted) onDeleted();
  }

  return (
    <ConfirmationDialog
      closeLabel="Close account deletion"
      confirmDisabled={!matches}
      confirmForm={formId}
      confirmLabel="Delete account"
      description="Everything is removed once you open the link we email you."
      initialFocus={inputRef}
      loading={busy}
      open
      returnFocus={returnFocus}
      title="Delete account?"
      onOpenChange={onOpenChange}
    >
      <form id={formId} onSubmit={(event) => void removeAccount(event)}>
        <FieldGroup>
          <Field label={`Type ${userName} to confirm`}>
            <Input
              autoComplete="off"
              disabled={busy}
              placeholder={userName}
              ref={inputRef}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
          {error ? <InlineError>{error}</InlineError> : null}
        </FieldGroup>
      </form>
    </ConfirmationDialog>
  );
}

function EditEmailDialog({
  onNotice,
  onOpenChange,
  returnFocus,
  user,
}: {
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
  user: AccountUser;
}) {
  const formId = useId();
  const [email, setEmail] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAsyncAction();
  const next = email.trim().toLowerCase();
  const canSave = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next) && next !== user.email.toLowerCase();

  async function saveEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    const sent = await run(async () => {
      const result = await authClient.changeEmail({ callbackURL: "/", newEmail: next });
      if (result.error) throw new Error(result.error.message);
      return true;
    }, "Could not start the email change.");

    if (sent) {
      // Deliberately the same sentence whether or not the address is already
      // taken: the server answers identically for that reason, and saying more
      // here would turn this form into a way to test who has an account.
      onNotice(
        user.emailVerified
          ? `Check ${user.email} — approve the change from there.`
          : `Check ${next} for a link to confirm the new address.`,
      );
      onOpenChange(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent closeLabel="Close email" initialFocus={inputRef} returnFocus={returnFocus} size="compact">
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            {user.emailVerified ? "Your current address approves it." : "The new address confirms it by link."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form id={formId} onSubmit={(event) => void saveEmail(event)}>
            <FieldGroup>
              <Field description={`Currently ${user.email}`} label="New email">
                <Input
                  autoComplete="email"
                  disabled={busy}
                  inputMode="email"
                  placeholder="you@example.com"
                  ref={inputRef}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
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
          <Button disabled={!canSave} form={formId} loading={busy} type="submit">
            Send the link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
