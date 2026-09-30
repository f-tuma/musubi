import { parseInviteLink, providerDisplayName, providerFlavor, type Calendar, type ParsedInvite } from "@musubi/types";
import { Globe, Link2, RefreshCw, Unlink } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import type { InvitePreview as InvitePreviewData } from "~/api/contracts";
import { getFederatedInvitePreview, getInvitePreview } from "~/api/resources";
import { authClient } from "~/auth/auth-client";
import { providerConnectionScopes, rememberProviderLink, useConnections } from "~/calendar/connections";
import { useFederatedWorkspace } from "~/calendar/federated-workspace";
import { ProviderGlyph } from "~/components/provider-glyph";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { HelpTooltip } from "~/components/ui/help-tooltip";
import { InlineError } from "~/components/ui/inline-error";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ItemGroup } from "~/components/ui/item";
import { Row, RowAction } from "~/components/ui/row";
import { SectionLabel } from "~/components/ui/section-label";
import { SettingsSection } from "~/components/ui/settings-section";
import { useAsyncAction } from "~/lib/use-async-action";
import { AvailabilitySection } from "../AvailabilitySection";
import { CalendarDot } from "../CalendarDot";
import { EventDeliveryInboxDialog } from "../EventDeliveryInboxDialog";
import { AccountMark, ProviderIcon } from "../ProviderIcon";
import { APPLE_CALDAV_URL, CaldavDialog, type CaldavDraft } from "./CaldavDialog";
import { Hint } from "./hint";

export type ConnectionsPanelProps = {
  calendars: Calendar[];
  /** Why the import of a just-linked account failed, if it did. */
  importFailed?: string;
  /** A provider link is still importing its calendars, started before this opened. */
  importing?: boolean;
  onNotice: (message: string) => void;
  userId: string;
};

type ConnectedAccount = {
  accountId: string;
  flavor: string | null;
  label: string;
  provider: string;
  providerName: string;
  reconnect: boolean;
  serverUrl?: string | null;
};

function connectedAccounts(calendars: Calendar[]): ConnectedAccount[] {
  const map = new Map<string, ConnectedAccount>();
  for (const calendar of calendars) {
    // Federated servers have their own status source below, which remains
    // available even when a remote server cannot return its calendars.
    if (calendar.provider === "musubi") continue;
    if (!calendar.provider || !calendar.accountId) continue;
    const key = `${calendar.provider}:${calendar.accountId}`;
    const reconnect = calendar.syncStatus === "reconnect_required";
    const existing = map.get(key);
    if (existing) {
      existing.reconnect = existing.reconnect || reconnect;
      continue;
    }
    map.set(key, {
      accountId: calendar.accountId,
      flavor: providerFlavor(calendar),
      label: calendar.accountLabel ?? providerDisplayName(calendar),
      provider: calendar.provider,
      providerName: providerDisplayName(calendar),
      reconnect,
      serverUrl: calendar.serverUrl,
    });
  }
  return [...map.values()];
}

/** Outside calendars: accounts, how to add one, and shared calendars by link. */
export function ConnectionsPanel({ calendars, importFailed, importing, onNotice, userId }: ConnectionsPanelProps) {
  const [deliveryTrigger, setDeliveryTrigger] = useState<HTMLElement | null>(null);
  const connections = useConnections(userId);
  const federated = useFederatedWorkspace(userId);
  const { busy: actionBusy, error, run, setError } = useAsyncAction();
  // One error at a time, shown beside the part of the panel that raised it.
  const [errorArea, setErrorArea] = useState<"accounts" | "add" | "invite">("accounts");
  const busy = actionBusy || connections.refreshing;
  const inviteInputRef = useRef<HTMLInputElement>(null);
  const [caldav, setCaldav] = useState<{ draft: CaldavDraft; trigger: HTMLElement }>();
  // Preserve the existing full-consent default; calendar-only is an explicit choice.
  const [includeTasks, setIncludeTasks] = useState(true);
  const [inviteValue, setInviteValue] = useState("");
  const [invite, setInvite] = useState<{ parsed: ParsedInvite; preview: InvitePreviewData }>();

  const providers = connections.capabilities.data?.syncProviders ?? [];
  const social = providers.includes("google") || providers.includes("microsoft");
  const accounts = connectedAccounts(calendars);
  const federatedServers = federated.data?.servers ?? [];

  async function connectSocial(provider: "google" | "microsoft") {
    // Better Auth redirects the page to the provider. Only an early error
    // returns to this panel.
    setErrorArea("add");
    await run(async () => {
      // Before the page leaves, so the version of the app that comes back knows
      // to import the calendars instead of showing an empty list.
      rememberProviderLink(provider);
      const result = await authClient.linkSocial({
        callbackURL: window.location.href,
        provider,
        scopes: providerConnectionScopes(provider, includeTasks, connections.capabilities.data?.googleAvailability),
      });
      if (result?.error) throw new Error(result.error.message);
    }, "Could not start the connection.");
  }

  function openCaldav(draft: CaldavDraft, trigger: HTMLElement) {
    setError("");
    setCaldav({ draft, trigger });
  }

  function reconnect(account: ConnectedAccount, trigger: HTMLElement) {
    if (account.provider === "google" || account.provider === "microsoft") {
      void connectSocial(account.provider);
      return;
    }
    openCaldav(
      {
        apple: account.flavor === "apple",
        password: "",
        serverUrl: account.flavor === "apple" ? APPLE_CALDAV_URL : (account.serverUrl ?? ""),
        username: "",
      },
      trigger,
    );
  }

  async function disconnectAccount(account: ConnectedAccount) {
    setErrorArea("accounts");
    const disconnected = await run(async () => {
      await connections.disconnectAccount({ accountId: account.accountId, provider: account.provider });
      return true;
    }, "Could not disconnect the account.");
    if (disconnected) onNotice(`${account.label} disconnected.`);
  }

  async function previewInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorArea("invite");
    const parsed = parseInviteLink(inviteValue, window.location.origin);
    if (!parsed) {
      setInvite(undefined);
      setError("Paste a Musubi invite link.");
      return;
    }
    await run(async () => {
      const preview = parsed.server
        ? await getFederatedInvitePreview(parsed.server, parsed.token)
        : await getInvitePreview(parsed.token);
      setInvite({ parsed, preview });
    }, "That invite could not be opened — it may have expired. Nothing was joined; ask for a fresh link.");
  }

  function focusInviteInput() {
    requestAnimationFrame(() => inviteInputRef.current?.focus());
  }

  async function acceptInvite() {
    if (!invite) return;
    setErrorArea("invite");
    const joined = await run(async () => {
      await connections.acceptInvite(invite.parsed);
      return true;
    }, "Could not join that calendar.");
    if (joined) {
      onNotice(`Joined ${invite.preview.name}.`);
      setInvite(undefined);
      setInviteValue("");
      focusInviteInput();
    }
  }

  const refreshAction = (
    <Hint label="Refresh">
      <Button
        aria-label="Refresh connected calendars"
        className="-my-2"
        disabled={busy || importing}
        loading={connections.refreshing}
        size="icon-compact"
        variant="ghost"
        onClick={() => {
          setErrorArea("accounts");
          void run(async () => {
            await connections.refreshConnectedCalendars();
            onNotice("Connected calendars refreshed.");
          }, "Could not refresh connected calendars.");
        }}
      >
        <RefreshCw aria-hidden="true" strokeWidth={1.7} />
      </Button>
    </Hint>
  );

  return (
    <>
      <section aria-busy={busy || undefined} aria-labelledby="connections-accounts-title" className="flex min-w-0 flex-col gap-3">
        <div className="flex min-h-5 items-center justify-between gap-2">
          <SectionLabel id="connections-accounts-title" level={3}>
            Connected accounts
          </SectionLabel>
          {refreshAction}
        </div>
        {accounts.length > 0 ? (
          <ItemGroup aria-label="Connected accounts" role="list">
            {accounts.map((account) => (
              <Row
                detail={account.providerName}
                icon={<AccountMark flavor={account.flavor} />}
                key={`${account.provider}:${account.accountId}`}
                label={
                  <>
                    <span className="truncate" title={account.label}>
                      {account.label}
                    </span>
                    {account.reconnect ? <Badge variant="warning">Needs attention</Badge> : null}
                  </>
                }
                layout={account.reconnect ? "responsive-actions" : "default"}
                role="listitem"
                trailing={
                  <>
                    {account.reconnect ? (
                      <Button
                        disabled={busy}
                        size="compact"
                        variant="secondary"
                        onClick={(event) => reconnect(account, event.currentTarget)}
                      >
                        <RefreshCw aria-hidden="true" />
                        Reconnect
                      </Button>
                    ) : null}
                    <Hint label="Disconnect">
                      <Button
                        aria-label={`Disconnect ${account.label}`}
                        disabled={busy}
                        size="icon-compact"
                        variant="ghost"
                        onClick={() => void disconnectAccount(account)}
                      >
                        <Unlink aria-hidden="true" strokeWidth={1.7} />
                      </Button>
                    </Hint>
                  </>
                }
              />
            ))}
          </ItemGroup>
        ) : (
          <ItemGroup>
            {/* An account whose calendars are still being fetched is not a
                missing account, and saying "none" while one is arriving is how
                someone concludes the connection failed and does it again. */}
            <Row
              detail={importing ? "Fetching its calendars" : importFailed ? undefined : "Add one below"}
              icon={<Link2 />}
              label={importing ? "Importing…" : importFailed ? "Nothing imported yet" : "No connected accounts"}
              role={importing ? "status" : undefined}
            />
          </ItemGroup>
        )}
        {importFailed && accounts.length === 0 ? (
          <InlineError>The account is linked, but its calendars could not be fetched. {importFailed}</InlineError>
        ) : null}
        {error && errorArea === "accounts" ? <InlineError>{error}</InlineError> : null}
      </section>

      {connections.capabilities.data?.googleAvailability ? (
        <AvailabilitySection
          connectionBusy={busy || importing}
          key={userId}
          userId={userId}
          onReconnect={() => void connectSocial("google")}
          onRefresh={async () => {
            await connections.refreshConnectedCalendars();
            onNotice("Connected calendars refreshed.");
          }}
        />
      ) : null}

      {federatedServers.length > 0 ? (
        <section aria-labelledby="connections-servers-title" className="flex min-w-0 flex-col gap-3">
          <SectionLabel id="connections-servers-title" level={3}>
            Musubi servers
          </SectionLabel>
          <ItemGroup aria-label="Connected Musubi servers" role="list">
          {federatedServers.map((server) => {
            const status =
              server.state === "active" ? null : server.state === "unauthorized" ? "Needs a new invite" : "Unreachable";
            return (
              <Row
                // The version because federation is the one clock nobody here
                // winds: that server updates when its owner decides to.
                detail={server.version ? `Musubi ${server.version}` : "Musubi server"}
                icon={<ProviderIcon flavor={null} />}
                key={server.connectionId}
                label={
                  <>
                    <span className="truncate">{server.label}</span>
                    {status ? <Badge variant="warning">{status}</Badge> : null}
                  </>
                }
                role="listitem"
                trailing={
                  <>
                    {server.state === "unreachable" ? (
                      <Button
                        aria-label={`Retry ${server.label}`}
                        disabled={busy}
                        size="compact"
                        variant="secondary"
                        onClick={() => void federated.refetch()}
                      >
                        <RefreshCw aria-hidden="true" />
                        Retry
                      </Button>
                    ) : null}
                    <Hint label="Disconnect">
                      <Button
                        aria-label={`Disconnect ${server.label}`}
                        disabled={busy}
                        size="icon-compact"
                        variant="ghost"
                        onClick={() => {
                          setErrorArea("accounts");
                          void run(async () => {
                            await connections.disconnectFederatedServer(server.server);
                            onNotice(`${server.label} disconnected.`);
                          }, "Could not disconnect the server.");
                        }}
                      >
                        <Unlink aria-hidden="true" strokeWidth={1.7} />
                      </Button>
                    </Hint>
                  </>
                }
              />
            );
          })}
          </ItemGroup>
        </section>
      ) : null}

      <SettingsSection title="Add a connection" variant="plain">
        {connections.capabilities.isPending ? (
          <p aria-live="polite" className="text-13 text-muted-foreground">
            Loading connection options…
          </p>
        ) : connections.capabilities.isError ? (
          <InlineError>Connection options could not be loaded.</InlineError>
        ) : providers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {providers.includes("google") ? (
                <Button aria-label="Google Calendar" disabled={busy} variant="secondary" onClick={() => void connectSocial("google")}>
                  <ProviderGlyph provider="google" />
                  Google
                </Button>
              ) : null}
              {providers.includes("microsoft") ? (
                <Button disabled={busy} variant="secondary" onClick={() => void connectSocial("microsoft")}>
                  <ProviderGlyph provider="microsoft" />
                  Outlook
                </Button>
              ) : null}
              {providers.includes("caldav") ? (
                <>
                  <Button
                    aria-label="Apple / iCloud"
                    disabled={busy}
                    variant="secondary"
                    onClick={(event) =>
                      openCaldav({ apple: true, password: "", serverUrl: APPLE_CALDAV_URL, username: "" }, event.currentTarget)
                    }
                  >
                    <ProviderGlyph provider="apple" />
                    iCloud
                  </Button>
                  <Button
                    disabled={busy}
                    variant="secondary"
                    onClick={(event) =>
                      openCaldav({ apple: false, password: "", serverUrl: "", username: "" }, event.currentTarget)
                    }
                  >
                    <Globe aria-hidden="true" strokeWidth={1.7} />
                    CalDAV
                  </Button>
                </>
              ) : null}
            </div>
            {social ? (
              <div className="flex items-center gap-1">
                <Checkbox
                  checked={includeTasks}
                  disabled={busy}
                  label="Include Tasks"
                  onChange={(event) => setIncludeTasks(event.target.checked)}
                />
                <HelpTooltip label="About Tasks access">
                  For Google and Outlook. When off, no Tasks permission is requested; access granted earlier stays.
                </HelpTooltip>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-13 text-muted-foreground">This server offers no outside connections.</p>
        )}
        {error && errorArea === "add" ? <InlineError>{error}</InlineError> : null}
      </SettingsSection>

      <SettingsSection title="Join a shared calendar" variant="plain">
        {invite ? (
          <InvitePreview
            busy={busy}
            invite={invite}
            onCancel={() => {
              setInvite(undefined);
              setError("");
              focusInviteInput();
            }}
            onJoin={() => void acceptInvite()}
          />
        ) : (
          <form onSubmit={(event) => void previewInvite(event)}>
            <InputGroup>
              <InputGroupInput
                aria-label="Invite link"
                disabled={busy}
                placeholder="https://server/invite/…"
                ref={inviteInputRef}
                value={inviteValue}
                onChange={(event) => setInviteValue(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Button disabled={!inviteValue.trim()} loading={busy} size="compact" type="submit">
                  Open invite
                </Button>
              </InputGroupAddon>
            </InputGroup>
          </form>
        )}
        {error && errorArea === "invite" ? <InlineError>{error}</InlineError> : null}
      </SettingsSection>

      <SettingsSection title="Sync activity">
        <RowAction label="Unfinished deliveries" onClick={(event) => setDeliveryTrigger(event.currentTarget)} />
      </SettingsSection>

      {deliveryTrigger ? (
        <EventDeliveryInboxDialog
          key={userId}
          returnFocus={deliveryTrigger}
          userId={userId}
          onClose={() => setDeliveryTrigger(null)}
        />
      ) : null}

      {caldav ? (
        <CaldavDialog
          initial={caldav.draft}
          returnFocus={caldav.trigger}
          onConnect={async (input) => {
            await connections.connectCaldav(input);
            onNotice("Calendar connected.");
            return true;
          }}
          onOpenChange={(next) => {
            if (!next) setCaldav(undefined);
          }}
        />
      ) : null}
    </>
  );
}

function InvitePreview({
  busy,
  invite,
  onCancel,
  onJoin,
}: {
  busy: boolean;
  invite: { parsed: ParsedInvite; preview: InvitePreviewData };
  onCancel: () => void;
  onJoin: () => void;
}) {
  const memberCount = invite.preview.members.length;
  const eventCount = invite.preview.events.length;
  const source = invite.parsed.server ? new URL(invite.parsed.server).host : "This server";

  return (
    <div aria-label="Invite preview" className="flex flex-col gap-3" role="region">
      <ItemGroup>
        <Row
          detail={`${memberCount} member${memberCount === 1 ? "" : "s"} · ${eventCount} event${eventCount === 1 ? "" : "s"} this month`}
          icon={<CalendarDot color={invite.preview.color} />}
          label={
            <>
              <span className="truncate">{invite.preview.name}</span>
              <Badge variant="muted">View only</Badge>
            </>
          }
          value={source}
        />
      </ItemGroup>
      <div className="flex justify-end gap-2">
        <Button autoFocus disabled={busy} variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={busy} onClick={onJoin}>
          Join calendar
        </Button>
      </div>
    </div>
  );
}
