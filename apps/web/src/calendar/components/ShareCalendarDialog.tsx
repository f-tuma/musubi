import { can, type Calendar } from "@musubi/types";
import {
  Copy,
  Link2,
  MoreHorizontal,
  Send,
  ShieldCheck,
  Trash2,
  UserRoundMinus,
} from "lucide-react";
import { type RefObject, useRef, useState } from "react";
import type { CalendarMember } from "~/api/contracts";
import { useCalendarSharing } from "~/calendar/calendar-sharing";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { InlineError } from "~/components/ui/inline-error";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ItemGroup } from "~/components/ui/item";
import { Row } from "~/components/ui/row";
import { Select } from "~/components/ui/select";
import { SettingsSection } from "~/components/ui/settings-section";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "~/ui/Menu";
import { useAsyncAction } from "~/ui/useAsyncAction";

type ShareCalendarDialogProps = {
  calendar: Calendar | null;
  onNotice: (message: string) => void;
  onOpenChange: (open: boolean) => void;
  userId: string;
};

type MemberAccess = "editor" | "viewer";

const MEMBER_ACCESS_OPTIONS = [
  { label: "Viewer", value: "viewer" },
  { label: "Editor", value: "editor" },
] as const;

function inviteLink(inviteId: string) {
  const origin =
    typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/invite/${inviteId}`;
}

export function ShareCalendarDialog({
  calendar,
  onNotice,
  onOpenChange,
  userId,
}: ShareCalendarDialogProps) {
  const sharing = useCalendarSharing(userId, calendar);
  const { busy, error, run, setError } = useAsyncAction();
  const [transferMember, setTransferMember] = useState<CalendarMember>();
  const [inviteEmail, setInviteEmail] = useState("");
  // What the next link will allow. It expires by default; the people cap stays
  // empty until the organizer needs one.
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [maxUses, setMaxUses] = useState("");
  const validLimits = [expiresInDays, maxUses].every(
    (value) => value === "" || (Number.isInteger(Number(value)) && Number(value) > 0),
  );
  const transferReturnFocusRef = useRef<HTMLButtonElement>(null);
  const memberActionTriggers = useRef(new Map<string, HTMLButtonElement>());

  const open = Boolean(calendar);
  const canManage = can(calendar?.role, "manageMembers");
  const isOwner = calendar?.role === "owner";
  const members = sharing.members.data ?? [];
  const invites = sharing.invites.data ?? [];
  const canTransfer = Boolean(
    calendar && isOwner && !calendar.isDefault && !calendar.provider,
  );

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setError("");
      setTransferMember(undefined);
    }
    onOpenChange(nextOpen);
  }

  /**
   * Email an invitation, making a link first if there is not one already.
   *
   * The API sends an EXISTING invite, so revoking still kills every copy of a
   * link however it travelled. Whether one existed already is not something the
   * person typing an address should have to think about.
   */
  async function emailInvite() {
    const address = inviteEmail.trim();
    if (!address) return;

    const sent = await run(async () => {
      const existing = invites[0];
      const target =
        existing ??
        (await sharing.createInvite({
          expiresAt: expiresInDays
            ? new Date(Date.now() + Number(expiresInDays) * 86_400_000)
            : null,
          maxUses: maxUses ? Number(maxUses) : null,
        }));
      await sharing.sendInvite({ email: address, inviteId: target.id });
      return true;
    }, "Could not send that invitation.");

    if (sent) {
      setInviteEmail("");
      onNotice(`Invitation sent to ${address}.`);
    }
  }

  async function copyLink(inviteId: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(inviteId));
      onNotice("Invite link copied.");
    } catch {
      setError("Could not copy the link. Select and copy it instead.");
    }
  }

  async function changeRole(member: CalendarMember, role: MemberAccess) {
    const changed = await run(async () => {
      await sharing.setMemberRole({ role, userId: member.id });
      return true;
    }, "Could not change the role.");

    if (changed) {
      onNotice(
        `${member.name} is now ${
          role === "editor" ? "an editor" : "a viewer"
        }.`,
      );
    }
  }

  async function removeMember(member: CalendarMember) {
    const removed = await run(async () => {
      await sharing.removeMember(member.id);
      return true;
    }, "Could not remove the member.");

    if (removed) onNotice(`${member.name} no longer has access.`);
  }

  async function createInvite() {
    const days = Number(expiresInDays);
    const created = await run(async () => {
      await sharing.createInvite({
        // A relative day count keeps this compact while allowing any expiry.
        expiresAt:
          days > 0 ? new Date(Date.now() + days * 24 * 60 * 60_000) : null,
        maxUses: maxUses === "" ? null : Number(maxUses),
      });
      return true;
    }, "Could not create an invite link.");

    if (created) onNotice("Invite link created.");
  }

  async function revokeInvite(inviteId: string) {
    const revoked = await run(async () => {
      await sharing.revokeInvite(inviteId);
      return true;
    }, "Could not revoke the link.");

    if (revoked) onNotice("Invite link revoked.");
  }

  async function leaveCalendar() {
    if (!calendar) return;
    const left = await run(async () => {
      await sharing.leaveCalendar();
      return true;
    }, "Could not leave the calendar.");

    if (left) {
      onNotice(`You left ${calendar.name}.`);
      onOpenChange(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent aria-describedby={undefined} closeLabel="Close sharing" size="form" tall>
          <DialogHeader>
            <DialogTitle>{`Share ${calendar?.name ?? "calendar"}`}</DialogTitle>
          </DialogHeader>
          <DialogBody aria-busy={busy || undefined}>
            <SettingsSection title="Members" variant="plain">
              {sharing.members.isPending ? (
                <p aria-live="polite" className="text-13 text-muted-foreground">
                  Loading members…
                </p>
              ) : sharing.members.isError ? (
                <InlineError>
                  Members could not be loaded. Close the dialog and try again.
                </InlineError>
              ) : (
                <ItemGroup aria-label="Calendar members" role="list">
                  {members.map((member) => {
                    const memberIsOwner = member.role === "owner";
                    const removable =
                      canManage && !memberIsOwner && member.id !== userId;
                    const access: MemberAccess =
                      member.role === "editor" ? "editor" : "viewer";

                    return (
                      <Row
                        icon={
                          <Avatar
                            image={member.image}
                            name={member.name}
                            size="default"
                          />
                        }
                        key={member.id}
                        label={`${member.name}${
                          member.id === userId ? " (you)" : ""
                        }`}
                        layout={canManage && !memberIsOwner ? "responsive-actions" : "default"}
                        role="listitem"
                        trailing={
                          canManage && !memberIsOwner ? (
                            <>
                              <Select
                                disabled={busy}
                                label={`${member.name} role`}
                                options={MEMBER_ACCESS_OPTIONS}
                                size="compact"
                                value={access}
                                onChange={(role) => void changeRole(member, role as MemberAccess)}
                              />
                              {canTransfer && removable ? (
                                <Menu>
                                  <MenuTrigger asChild>
                                    <Button
                                      aria-label={`Actions for ${member.name}`}
                                      disabled={busy}
                                      size="icon-compact"
                                      title={`Actions for ${member.name}`}
                                      variant="ghost"
                                      ref={(button) => {
                                        if (button) memberActionTriggers.current.set(member.id, button);
                                        else memberActionTriggers.current.delete(member.id);
                                      }}
                                    >
                                      <MoreHorizontal aria-hidden="true" strokeWidth={1.7} />
                                    </Button>
                                  </MenuTrigger>
                                  <MenuContent
                                    align="end"
                                    label={`${member.name} access`}
                                    onCloseAutoFocus={(event) => {
                                      if (transferMember) event.preventDefault();
                                    }}
                                  >
                                    <MenuItem
                                      icon={<ShieldCheck size={16} strokeWidth={1.7} />}
                                      onSelect={() => {
                                        transferReturnFocusRef.current = memberActionTriggers.current.get(member.id) ?? null;
                                        setError("");
                                        setTransferMember(member);
                                      }}
                                    >
                                      Make owner
                                    </MenuItem>
                                    <MenuItem
                                      icon={<UserRoundMinus size={16} strokeWidth={1.7} />}
                                      tone="destructive"
                                      onSelect={() => void removeMember(member)}
                                    >
                                      Remove {member.name}
                                    </MenuItem>
                                  </MenuContent>
                                </Menu>
                              ) : removable ? (
                                <Button
                                  aria-label={`Remove ${member.name}`}
                                  disabled={busy}
                                  size="icon-compact"
                                  title={`Remove ${member.name}`}
                                  variant="ghost"
                                  onClick={() => void removeMember(member)}
                                >
                                  <UserRoundMinus aria-hidden="true" strokeWidth={1.7} />
                                </Button>
                              ) : null}
                            </>
                          ) : (
                            <Badge variant="muted">
                              {memberIsOwner ? "Owner" : access === "editor" ? "Editor" : "Viewer"}
                            </Badge>
                          )
                        }
                      />
                    );
                  })}
                </ItemGroup>
              )}
              {!isOwner && calendar ? (
                <Button
                  className="self-start"
                  disabled={busy}
                  variant="secondary"
                  onClick={() => void leaveCalendar()}
                >
                  <UserRoundMinus aria-hidden="true" strokeWidth={1.7} />
                  Leave calendar
                </Button>
              ) : null}
            </SettingsSection>

            {sharing.canInvite ? (
              <SettingsSection title="Invite people" variant="plain">
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (validLimits && !busy) void emailInvite();
                  }}
                >
                  <Field className="flex-1" label="Invite by email">
                    <Input
                      aria-label="Email an invitation"
                      autoComplete="email"
                      disabled={busy}
                      placeholder="name@example.com"
                      required
                      type="email"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                  </Field>
                  <Button
                    disabled={!validLimits || !inviteEmail.trim()}
                    loading={busy}
                    type="submit"
                  >
                    <Send aria-hidden="true" strokeWidth={1.7} />
                    Send
                  </Button>
                </form>
                {/* Empty means no limit; positive whole numbers are sent as-is. */}
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Expires after (days)">
                    <Input
                      aria-label="Expires after days"
                      disabled={busy}
                      inputMode="numeric"
                      min="1"
                      placeholder="Never"
                      step="1"
                      type="number"
                      value={expiresInDays}
                      onChange={(event) => setExpiresInDays(event.target.value)}
                    />
                  </Field>
                  <Field label="People limit">
                    <Input
                      aria-label="How many people"
                      disabled={busy}
                      inputMode="numeric"
                      min="1"
                      placeholder="No limit"
                      step="1"
                      type="number"
                      value={maxUses}
                      onChange={(event) => setMaxUses(event.target.value)}
                    />
                  </Field>
                </div>
                <Button
                  className="self-start"
                  disabled={!validLimits}
                  loading={busy}
                  variant="secondary"
                  onClick={() => void createInvite()}
                >
                  <Link2 aria-hidden="true" strokeWidth={1.7} />
                  Create invite link
                </Button>

                {sharing.invites.isPending ? (
                  <p aria-live="polite" className="text-13 text-muted-foreground">
                    Loading invite links…
                  </p>
                ) : sharing.invites.isError ? (
                  <InlineError>Invite links could not be loaded.</InlineError>
                ) : invites.length > 0 ? (
                  <ul aria-label="Active invite links" className="flex flex-col gap-2">
                    {invites.map((invite) => (
                      <li key={invite.id}>
                        <InputGroup>
                          <InputGroupAddon>
                            <Link2 aria-hidden="true" strokeWidth={1.7} />
                          </InputGroupAddon>
                          <InputGroupInput
                            aria-label="Invite link"
                            readOnly
                            value={inviteLink(invite.id)}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <InputGroupAddon align="inline-end">
                            <Button
                              aria-label="Copy invite link"
                              size="icon-compact"
                              title="Copy invite link"
                              variant="ghost"
                              onClick={() => void copyLink(invite.id)}
                            >
                              <Copy aria-hidden="true" strokeWidth={1.7} />
                            </Button>
                            <Button
                              aria-label="Revoke invite link"
                              disabled={busy}
                              size="icon-compact"
                              title="Revoke invite link"
                              variant="ghost"
                              onClick={() => void revokeInvite(invite.id)}
                            >
                              <Trash2 aria-hidden="true" strokeWidth={1.7} />
                            </Button>
                          </InputGroupAddon>
                        </InputGroup>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-13 text-muted-foreground">No active invite links</p>
                )}
              </SettingsSection>
            ) : null}

            {error ? <InlineError>{error}</InlineError> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {calendar && transferMember ? (
        <TransferOwnershipDialog
          calendar={calendar}
          member={transferMember}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setTransferMember(undefined);
          }}
          onTransferred={() => {
            setTransferMember(undefined);
            onNotice(
              `${transferMember.name} is now the owner of ${calendar.name}.`,
            );
            onOpenChange(false);
          }}
          returnFocus={transferReturnFocusRef}
          setOwner={sharing.setMemberRole}
        />
      ) : null}
    </>
  );
}

function TransferOwnershipDialog({
  calendar,
  member,
  onOpenChange,
  onTransferred,
  returnFocus,
  setOwner,
}: {
  calendar: Calendar;
  member: CalendarMember;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  setOwner: (input: { role: string; userId: string }) => Promise<unknown>;
}) {
  const { busy, error, run } = useAsyncAction();

  async function transferOwnership() {
    const transferred = await run(async () => {
      await setOwner({ role: "owner", userId: member.id });
      return true;
    }, "Ownership could not be transferred. You are still the owner — try again.");

    if (transferred) onTransferred();
  }

  return (
    <ConfirmationDialog
      closeLabel="Close ownership transfer"
      confirmLabel="Transfer ownership"
      description={`${member.name} takes over members, invite links and settings of ${calendar.name}. You become an editor.`}
      loading={busy}
      onConfirm={() => void transferOwnership()}
      onOpenChange={onOpenChange}
      open
      returnFocus={returnFocus}
      title={`Make ${member.name} the owner?`}
    >
      {error ? <InlineError>{error}</InlineError> : null}
    </ConfirmationDialog>
  );
}
