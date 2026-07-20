import { betterAuth } from 'better-auth';
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { CALENDAR_SCOPE, createCalendar, db, getUserSettings, markOAuthAccountActive, schema } from '@musubi/db';
import { config, logger } from '@musubi/config';
import { sendEmail } from '../../../../apps/api/src/emails';
import { getPasswordResetHtml } from '../../../../apps/api/src/emails/password_reset';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
  baseURL: config.api.url,
  trustedOrigins: [
    "musubi://",
    "https://musubi.pro",
    "https://dev.musubi.pro",
    ...(config.api.environment === "dev" ? [
      "exp://",                      // Trust all Expo URLs (prefix matching)
      "exp://**",                    // Trust all Expo URLs (wildcard matching)
      "exp://192.168.*.*:*/**",      // Trust 192.168.x.x IP range with any port and path
      "exp://10.0.2.2:*/**",
    ] : [])
  ],
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, token }, _) => {
      const customUrl = `https://musubi.pro/reset-password/?token=${token}&callback=${config.api.url}`
      await sendEmail(user.email, "Reset your password", getPasswordResetHtml(user.name, customUrl, "1 hour"));
    },
  },
  socialProviders: {
    google: {
      clientId: [
        config.social.googleWebClientID,
      ],
      clientSecret: config.social.googleClientSecret,
      accessType: "offline",
      prompt: "select_account consent",
    },
    microsoft: {
      clientId: config.social.microsoftClientID,
      clientSecret: config.social.microsoftClientSecret,
      tenantId: config.social.microsoftTenantID,
      prompt: "select_account",
    },
    apple: {
      clientId: config.social.appleClientID,
      // Native Sign in with Apple only: the identity token's `aud` claim is the
      // app's bundle id, so Better Auth verifies the token against this (clientId
      // + clientSecret are for the web redirect flow, which we don't use).
      appBundleIdentifier: "dev.frgtn.musubi",
    }
  },
  account: {
    // Encrypt OAuth access/refresh tokens at rest, keyed by the auth secret
    // (outside the DB). Our sync layer reads these columns directly, so it
    // decrypts with the same key via apps/api's tokenCrypto helpers.
    encryptOAuthTokens: true,
    additionalFields: {
      syncStatus: { type: "string", required: false, defaultValue: "active", input: false, returned: false },
      syncErrorCode: { type: "string", required: false, input: false, returned: false },
      syncErrorSubtype: { type: "string", required: false, input: false, returned: false },
      syncDisabledAt: { type: "date", required: false, input: false, returned: false },
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
  session: {
    // Disable the "fresh session" requirement for sensitive actions (delete
    // account, change email/password). Musubi is a mobile app with long-lived
    // sessions and no re-authentication UI, so the default 1-day freshness makes
    // account deletion fail for anyone signed in longer than a day. Deletion
    // stays gated by a valid authenticated session and a client-side confirm.
    freshAge: 0,
  },
  user: {
    deleteUser: {
      enabled: true,
    }
  },
  databaseHooks: {
    account: {
      update: {
        after: async (account) => {
          // A successful OAuth relink writes a fresh refresh token to the
          // existing Better Auth account. Re-enable provider sync without
          // requiring the user to delete their mirrored calendars.
          const calendarScope = CALENDAR_SCOPE[account.providerId];
          if (
            calendarScope &&
            account.refreshToken &&
            (account.scope ?? "").includes(calendarScope) &&
            account.syncStatus === "reconnect_required"
          ) {
            await markOAuthAccountActive(account.userId, account.providerId, account.accountId);
          }
        },
      },
    },
    user: {
      create: {
        // Every new user (email OR social sign-in) gets a personal calendar —
        // undeletable, non-transferable, the default home for future features.
        after: async (user) => {
          try {
            await createCalendar({ name: user.name?.trim() || "Personal", color: "#C8553D", creatorID: user.id, isDefault: true });
          } catch (e) {
            // Never block registration on this; onboarding self-heals a miss.
            logger.error("auth.signup.personal_calendar_failed", { userId: user.id, error: e });
          }
          try {
            // Materialize the settings row now (onboarded=false) so the client's
            // first GET returns it and the onboarding gate fires — relying on a
            // lazy create left new users with no row (and PUT settings 404s).
            await getUserSettings(user.id);
          } catch (e) {
            logger.error("auth.signup.settings_failed", { userId: user.id, error: e });
          }
        },
      },
    },
  },
  plugins: [
    bearer(),
    expo(),
  ],
});
