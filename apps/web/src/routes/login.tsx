import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { getServerOrigin } from "~/api/query-keys";
import type { ServerCapabilities } from "~/api/contracts";
import { getServerCapabilities } from "~/api/resources";
import { authClient } from "~/auth/auth-client";
import { ThemeToggle } from "~/calendar/components/ThemeToggle";
import {
  AuthForm,
  AuthHint,
  AuthMessage,
  AuthProviders,
  AuthShell,
  AuthSubmit,
  AuthSwitch,
} from "~/components/auth-shell";
import { ProviderGlyph } from "~/components/provider-glyph";
import { RouteState } from "~/components/route-state";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";

const loginSearchSchema = z.object({
  // Better Auth sends the browser back here when a provider round trip fails —
  // the person is on the login page again and deserves to know why.
  error: z.string().optional().catch(undefined),
  redirect: z.string().optional().catch(undefined),
});

const WEB_PROVIDERS = [
  { id: "google", label: "Continue with Google" },
  { id: "microsoft", label: "Continue with Microsoft" },
  { id: "apple", label: "Continue with Apple" },
] as const;

/**
 * Which of them this server can finish in a browser.
 *
 * `socialsWeb` is the answer when the server is new enough to give one. An older
 * API only says which providers it accepts at all, and the phone's flows are in
 * there too — Apple especially, which needs a separate browser registration — so
 * the fallback drops it rather than offering a button that cannot come back.
 */
function browserProviders(capabilities: ServerCapabilities | undefined) {
  const offered =
    capabilities?.socialsWeb ??
    capabilities?.socials.filter((social) => social !== "apple") ??
    [];
  return WEB_PROVIDERS.filter((provider) => offered.includes(provider.id));
}

export const Route = createFileRoute("/login")({
  validateSearch: loginSearchSchema,
  component: LoginRoute,
});

function safeRedirect(value: string | undefined) {
  // Same-origin app paths only — an attacker-supplied absolute URL here would
  // turn the login page into an open redirect. `/invite/` is allowed alongside
  // the workspace so an invitation survives the sign-in it just asked for.
  return value?.startsWith("/app/") || value?.startsWith("/invite/")
    ? value
    : "/app/p/default/month";
}

function errorMessage(error: { message?: string } | null | undefined) {
  return error?.message ?? "We could not sign you in. Check your details and try again.";
}

// The server refuses a sign-in until the address is confirmed, when the operator
// has asked for that. Better Auth answers with a code rather than only prose, so
// this one case can be explained instead of read as a wrong passphrase.
const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";

function LoginRoute() {
  const session = authClient.useSession();
  const { error, redirect } = Route.useSearch();
  // Which buttons this server can honour. A self-hosted Musubi with no OAuth
  // credentials shows none of them rather than a button that dead-ends.
  const capabilities = useQuery({
    queryFn: ({ signal }) => getServerCapabilities(signal),
    queryKey: ["server-capabilities", getServerOrigin()],
    staleTime: 5 * 60_000,
  });
  const providers = browserProviders(capabilities.data);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState(
    error ? "That sign-in did not come back. Try again, or use your passphrase." : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // The address a confirmation link went to, which is also the sign that the
  // form has nothing left to do: there is no password to retry, only an inbox.
  const [awaitingConfirmation, setAwaitingConfirmation] = useState("");
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (session.data) {
      window.location.replace(safeRedirect(redirect));
    }
  }, [redirect, session.data]);

  /**
   * A way back in for somebody who has forgotten their passphrase.
   *
   * There was none: resetting lived inside the account dialog, which is behind the
   * sign-in this person cannot get through. The server holds the reset page, so
   * this only has to ask for the mail.
   */
  async function requestReset() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setMessage("Type your email address first, then ask for a new passphrase.");
      return;
    }

    setSubmitting(true);
    try {
      await authClient.requestPasswordReset({
        email: normalizedEmail,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      // Said the same way whether or not the address has an account: a sign-in
      // page that reveals which addresses are registered is a list of them.
      setResetSent(true);
      setMessage("");
    } catch {
      setMessage("That could not be sent. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setMessage("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setMessage("Your passphrase needs at least 8 characters.");
      return;
    }
    if (mode === "sign-up" && name.trim().length < 2) {
      setMessage("Enter at least two characters for your name.");
      return;
    }
    if (mode === "sign-up" && password !== confirmPassword) {
      setMessage("The passphrases do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({
              email: normalizedEmail,
              password,
            })
          : await authClient.signUp.email({
              email: normalizedEmail,
              name: name.trim(),
              password,
            });

      if (result.error) {
        if (
          (result.error as { code?: string }).code === EMAIL_NOT_VERIFIED
        ) {
          // The server sends a fresh link on every refused sign-in, so this is a
          // statement of fact rather than an instruction to do something.
          setAwaitingConfirmation(normalizedEmail);
          return;
        }
        setMessage(errorMessage(result.error));
        return;
      }

      // Signing up on a server that requires confirmation creates the account but
      // no session — `token` is null. Redirecting would bounce straight back to
      // this page with nothing said, which reads as a failure rather than a step.
      if (!result.data?.token) {
        setAwaitingConfirmation(normalizedEmail);
        return;
      }

      window.location.assign(safeRedirect(redirect));
    } catch {
      setMessage("The server could not be reached. Check the connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function continueWith(provider: string) {
    setMessage("");
    setSubmitting(true);
    // A full-page redirect to the provider and back; nothing after this runs on
    // success. `callbackURL` is where the browser lands afterwards, so the
    // redirect someone was interrupted for survives the round trip.
    // Relative callbacks resolve against the API, which may be on another origin.
    void authClient
      .signIn.social({
        callbackURL: new URL(safeRedirect(redirect), window.location.origin).href,
        errorCallbackURL: new URL("/login?error=oauth", window.location.origin).href,
        provider,
      })
      .catch(() => {
        setSubmitting(false);
        setMessage("That sign-in could not be started. Try again in a moment.");
      });
  }

  async function resendConfirmation() {
    setResent(true);
    // Nothing branches on the outcome on purpose: whether the address exists is
    // not this page's to reveal, and the person is told to check the inbox either
    // way. A failure to send is the server's to log.
    await authClient
      .sendVerificationEmail({
        callbackURL: "/",
        email: awaitingConfirmation,
      })
      .catch(() => undefined);
  }

  function switchMode() {
    setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
    setMessage("");
    setAwaitingConfirmation("");
    setResent(false);
    setPassword("");
    setConfirmPassword("");
  }

  const signingUp = mode === "sign-up";

  if (session.data) {
    return (
      <RouteState busy title="Opening your calendar…" />
    );
  }

  // Nothing on the form can move this forward — the next step is in an inbox —
  // so the form goes away rather than inviting a retry that cannot work.
  if (awaitingConfirmation) {
    return (
      <AuthShell
        footer={
          <AuthSwitch action="Back to sign in" onAction={switchMode}>
            Confirmed it already?
          </AuthSwitch>
        }
        introduction={`We sent a link to ${awaitingConfirmation}. It expires in an hour.`}
        title="Check your email"
        utility={<ThemeToggle />}
      >
        <AuthSubmit
          disabled={resent}
          onClick={() => void resendConfirmation()}
          type="button"
          variant="secondary"
        >
          {resent ? "Link sent again" : "Send the link again"}
        </AuthSubmit>
        {resent ? <AuthHint>Give it a minute, then look in spam.</AuthHint> : null}
      </AuthShell>
    );
  }

  return (
    <AuthShell
      aside={
        providers.length > 0 ? (
          <AuthProviders>
            {providers.map((provider) => (
              <Button
                disabled={submitting}
                key={provider.id}
                onClick={() => continueWith(provider.id)}
                type="button"
                variant="secondary"
              >
                <ProviderGlyph provider={provider.id} />
                {provider.label}
              </Button>
            ))}
          </AuthProviders>
        ) : undefined
      }
      footer={
        <AuthSwitch
          action={signingUp ? "Sign in" : "Create one"}
          onAction={switchMode}
        >
          {signingUp ? "Already have an account?" : "New to this server?"}
        </AuthSwitch>
      }
      title={signingUp ? "Create your account" : "Sign in"}
      utility={<ThemeToggle />}
    >
      <AuthForm onSubmit={handleSubmit} noValidate>
        {signingUp ? (
          <Field label="Name">
            <Input
              autoComplete="name"
              autoFocus
              name="name"
              placeholder="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Email">
          <Input
            autoCapitalize="none"
            autoComplete="email"
            autoFocus={!signingUp}
            inputMode="email"
            name="email"
            placeholder="you@example.com"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Passphrase">
          <Input
            autoComplete={signingUp ? "new-password" : "current-password"}
            minLength={8}
            name="password"
            placeholder="At least 8 characters"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {signingUp ? null : resetSent ? (
          <AuthHint>
            If that address has an account, a reset link is on its way.
          </AuthHint>
        ) : (
          <AuthHint>
            <Button
              disabled={submitting}
              variant="link"
              onClick={() => void requestReset()}
            >
              Forgot passphrase?
            </Button>
          </AuthHint>
        )}
        {signingUp ? (
          <Field label="Confirm passphrase">
            <Input
              autoComplete="new-password"
              minLength={8}
              name="confirm-password"
              placeholder="Repeat your passphrase"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
        ) : null}

        <AuthMessage>{message}</AuthMessage>
        <AuthSubmit loading={submitting} type="submit">
          {submitting
            ? signingUp
              ? "Creating account…"
              : "Signing in…"
            : signingUp
              ? "Create account"
              : "Continue"}
        </AuthSubmit>
      </AuthForm>
    </AuthShell>
  );
}
