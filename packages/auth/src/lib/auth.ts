import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { refreshAccessToken } from "better-auth/oauth2";
import { bearer, emailOTP } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { calendarAwareAdapter } from "./calendar-aware-adapter";
import {
  createCalendar,
  ensureDefaultPage,
  getUserSettings,
  hasProviderSyncScopes,
  markOAuthAccountActive,
} from "@musubi/db";
import { config, isSignUpAllowed, logger } from "@musubi/config";
import { defaultPageConfig } from "@musubi/types";
import {
  sendEmail,
  getPasswordResetHtml,
  getDeleteAccountHtml,
  getVerifyEmailHtml,
  getChangeEmailHtml,
  getSignInCodeHtml,
} from "@musubi/emails";
import { withVerifiedLanding } from "./verified_landing";
import {
  appleClientSecret,
  appleWebConfigured,
  type AppleWebCredentials,
} from "./apple_secret";

const appleWeb: AppleWebCredentials = {
  keyId: config.social.appleKeyID,
  privateKey: config.social.applePrivateKey,
  servicesId: config.social.appleServicesID,
  teamId: config.social.appleTeamID,
};
export const appleWebSignInEnabled = appleWebConfigured(appleWeb);

export const auth = betterAuth({
  database: calendarAwareAdapter,
  baseURL: config.api.url,
  advanced: {
    cookiePrefix: config.security.devAuthCookiePrefix,
  },
  trustedOrigins: [
    "musubi://",
    // Apple returns the browser flow as a cross-site POST from its own domain
    // (`response_mode=form_post`), so the origin check has to know it.
    "https://appleid.apple.com",
    "https://musubi.pro",
    "https://dev.musubi.pro",
    ...(config.api.environment === "dev"
      ? [
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          "exp://", // Trust all Expo URLs (prefix matching)
          "exp://**", // Trust all Expo URLs (wildcard matching)
          "exp://192.168.*.*:*/**", // Trust 192.168.x.x IP range with any port and path
          "exp://10.0.2.2:*/**",
        ]
      : []),
  ],
  emailAndPassword: {
    enabled: true,
    // Off unless the operator asks for it (REQUIRE_EMAIL_VERIFICATION), because
    // a server with no SMTP would create accounts nobody could ever sign into.
    // The config layer refuses that combination at boot.
    requireEmailVerification: config.security.requireEmailVerification,
    sendResetPassword: async ({ user, token }, _) => {
      // Served by this API on its own origin (apps/api handlers/pages.ts), so
      // self-hosters don't depend on the central website.
      const customUrl = `${config.api.url}/reset-password?token=${token}`;
      await sendEmail(
        user.email,
        "Reset your password",
        getPasswordResetHtml(user.name, customUrl, "1 hour"),
      );
    },
  },
  emailVerification: {
    // Send on both events, so nobody is stuck: on sign-up because that is when
    // the address is claimed, and on a refused sign-in because that is when the
    // person notices — including every account that predates the flag being
    // turned on, whose `emailVerified` is false through no fault of its own.
    sendOnSignUp: config.security.requireEmailVerification,
    sendOnSignIn: config.security.requireEmailVerification,
    // The click both verifies and signs in. Sending someone to a login form to
    // retype what they just proved is a step that only loses people.
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60, // 1 hour, same as password reset and account deletion
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail(
        user.email,
        "Confirm your email",
        getVerifyEmailHtml(user.name, withVerifiedLanding(url), "1 hour"),
      );
    },
  },
  socialProviders: {
    google: {
      clientId: [config.social.googleWebClientID],
      clientSecret: config.social.googleClientSecret,
      accessType: "offline",
      prompt: "select_account consent",
    },
    microsoft: {
      clientId: config.social.microsoftClientID,
      clientSecret: config.social.microsoftClientSecret,
      tenantId: config.social.microsoftTenantID,
      prompt: "select_account",
      // Better Auth's default Microsoft refresh requests identity scopes only.
      // Omit scope to retain the actual calendar/optional Tasks grant instead.
      refreshAccessToken: (refreshToken) => refreshAccessToken({
        refreshToken,
        options: {
          clientId: config.social.microsoftClientID,
          clientSecret: config.social.microsoftClientSecret,
        },
        tokenEndpoint: `https://login.microsoftonline.com/${config.social.microsoftTenantID}/oauth2/v2.0/token`,
      }),
    },
    apple: {
      // Two registrations for one provider. The Services ID goes first because
      // Better Auth takes the primary client id for the browser redirect; the
      // bundle id stays in the list, and in `audience`, so the phone's identity
      // token still verifies. With no Services ID this is exactly what it was
      // before: the bundle id, native flow only.
      clientId: appleWebSignInEnabled
        ? [config.social.appleServicesID, config.social.appleClientID]
        : config.social.appleClientID,
      audience: [
        config.social.appleServicesID,
        config.social.appleClientID,
      ].filter(Boolean),
      appBundleIdentifier: "dev.frgtn.musubi",
      // A getter, not a value: Apple wants a JWT signed with the .p8 key, and a
      // fresh one per exchange is what keeps a server that has been up for six
      // months from waking up unable to sign anyone in. Empty when the browser
      // flow is not set up — then no client ever offers the button.
      get clientSecret() {
        return appleWebSignInEnabled ? appleClientSecret(appleWeb) : "";
      },
    },
  },
  account: {
    // Encrypt OAuth access/refresh tokens at rest, keyed by the auth secret
    // (outside the DB). Our sync layer reads these columns directly, so it
    // decrypts with the same key via apps/api's tokenCrypto helpers.
    encryptOAuthTokens: true,
    additionalFields: {
      syncStatus: {
        type: "string",
        required: false,
        defaultValue: "active",
        input: false,
        returned: false,
      },
      syncErrorCode: {
        type: "string",
        required: false,
        input: false,
        returned: false,
      },
      syncErrorSubtype: {
        type: "string",
        required: false,
        input: false,
        returned: false,
      },
      syncDisabledAt: {
        type: "date",
        required: false,
        input: false,
        returned: false,
      },
    },
    accountLinking: {
      enabled: true,
      // Let a signed-in user connect additional accounts (e.g. a 2nd Google
      // account) whose email differs from their Musubi login. Safe here because
      // linking is always an explicit, authenticated linkSocial action.
      allowDifferentEmails: true,
      // Microsoft doesn't send the email_verified claim by default, and
      // better-auth refuses to link unverified-email accounts from providers
      // outside this list. Same explicit-linkSocial justification as above.
      trustedProviders: ["microsoft"],
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      // Who gets asked depends on where the trust is. A verified address is the
      // one the account already proved, so the approval goes THERE — otherwise a
      // stolen session could quietly move the account somewhere the owner cannot
      // reach. An unverified address proves nothing, so Better Auth falls
      // through to verifying the new one instead, which at least proves that.
      sendChangeEmailConfirmation: async ({ newEmail, url, user }) => {
        await sendEmail(
          user.email,
          "Approve your new email address",
          getChangeEmailHtml(
            user.name,
            newEmail,
            withVerifiedLanding(url),
            "1 hour",
          ),
        );
      },
    },
    deleteUser: {
      enabled: true,
      // Email-confirmed deletion. When this is set, the initial request only
      // sends the email (and returns before the "fresh session" check), so the
      // stale-session 500 no longer applies. The emailed link lands on the
      // website, which completes deletion token-only via /users/delete/confirm.
      deleteTokenExpiresIn: 60 * 60, // 1 hour, same as password reset
      sendDeleteAccountVerification: async ({ user, token }) => {
        // Served by this API on its own origin (apps/api handlers/pages.ts).
        const url = `${config.api.url}/delete-account?token=${token}`;
        await sendEmail(
          user.email,
          "Confirm account deletion",
          getDeleteAccountHtml(user.name, url, "1 hour"),
        );
      },
    },
  },
  databaseHooks: {
    account: {
      update: {
        after: async (account) => {
          // A successful OAuth relink writes a fresh refresh token to the
          // existing Better Auth account. Re-enable provider sync without
          // requiring the user to delete their mirrored calendars.
          if (
            account.refreshToken &&
            hasProviderSyncScopes(account.providerId, account.scope ?? "") &&
            account.syncStatus === "reconnect_required"
          ) {
            await markOAuthAccountActive(
              account.userId,
              account.providerId,
              account.accountId,
            );
          }
        },
      },
    },
    user: {
      create: {
        // The one door every new account passes: password sign-up, email code
        // and social sign-in all create the user here. Federated shadow users
        // are made outside Better Auth and stay gated by their calendar invite.
        before: async (user) => {
          if (!isSignUpAllowed(config.security.signUpAllowlist, user.email)) {
            throw new APIError("FORBIDDEN", {
              code: "SIGN_UP_DISABLED",
              message: "This server does not accept new accounts.",
            });
          }
        },
        // Every new user (email OR social sign-in) gets a personal calendar —
        // undeletable, non-transferable, the default home for future features.
        after: async (user) => {
          try {
            await createCalendar({
              name: user.name?.trim() || "Personal",
              color: "#C8553D",
              creatorID: user.id,
              isDefault: true,
            });
          } catch (e) {
            // Never block registration on this; onboarding self-heals a miss.
            logger.error("auth.signup.personal_calendar_failed", {
              userId: user.id,
              error: e,
            });
          }
          try {
            // Materialize the settings row now (onboarded=false) so the client's
            // first GET returns it and the onboarding gate fires — relying on a
            // lazy create left new users with no row (and PUT settings 404s).
            await getUserSettings(user.id);
          } catch (e) {
            logger.error("auth.signup.settings_failed", {
              userId: user.id,
              error: e,
            });
          }
          try {
            // Give the user their default "My calendar" Page up front. Existing
            // users self-heal lazily on their first GET /pages instead.
            await ensureDefaultPage(user.id, {
              name: "My calendar",
              config: defaultPageConfig("month"),
            });
          } catch (e) {
            logger.error("auth.signup.default_page_failed", {
              userId: user.id,
              error: e,
            });
          }
        },
      },
    },
  },
  plugins: [
    bearer(),
    expo(),
    // Passwordless sign-in by emailed code. The code proves the address without
    // asking the user to create another password.
    emailOTP({
      // Ten minutes: long enough to switch to a phone and read the mail, short
      // enough that a code left in an inbox is not a standing key.
      expiresIn: 10 * 60,
      sendVerificationOTP: async ({ email, otp }) => {
        await sendEmail(
          email,
          `${otp} is your Musubi code`,
          getSignInCodeHtml(otp, "10 minutes"),
        );
      },
    }),
  ],
});
