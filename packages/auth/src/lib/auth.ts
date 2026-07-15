import { betterAuth } from 'better-auth';
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createCalendar, db, getUserSettings, schema } from '@musubi/db';
import { config } from '@musubi/config';
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
    "https://musubi.frgtn.dev",
    "https://dev-musubi.frgtn.dev",
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
      const customUrl = `https://musubi.frgtn.dev/reset-password/?token=${token}&callback=${config.api.url}`
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
    apple: {
      clientId: config.social.appleClientID,
      // Native Sign in with Apple only: the identity token's `aud` claim is the
      // app's bundle id, so Better Auth verifies the token against this (clientId
      // + clientSecret are for the web redirect flow, which we don't use).
      appBundleIdentifier: "dev.frgtn.musubi",
    }
  },
  account: {
    accountLinking: {
      enabled: true,
      // Let a signed-in user connect additional accounts (e.g. a 2nd Google
      // account) whose email differs from their Musubi login. Safe here because
      // linking is always an explicit, authenticated linkSocial action.
      allowDifferentEmails: true,
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    }
  },
  databaseHooks: {
    user: {
      create: {
        // Every new user (email OR social sign-in) gets a personal calendar —
        // undeletable, non-transferable, the default home for future features.
        after: async (user) => {
          try {
            await createCalendar({ name: user.name?.trim() || "Personal", color: "#C8553D", creatorID: user.id, isDefault: true });
          } catch (e) {
            // Never block registration on this; onboarding self-heals a miss.
            console.error("Failed to create personal calendar for", user.id, e);
          }
          try {
            // Materialize the settings row now (onboarded=false) so the client's
            // first GET returns it and the onboarding gate fires — relying on a
            // lazy create left new users with no row (and PUT settings 404s).
            await getUserSettings(user.id);
          } catch (e) {
            console.error("Failed to create settings for", user.id, e);
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
