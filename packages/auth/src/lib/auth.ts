import { betterAuth } from 'better-auth';
import { bearer } from "better-auth/plugins";
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db, schema } from '@musubi/db';
import { config, envOrThrow } from '@musubi/config';
import { sendEmail } from '../../../../apps/api/src/emails';
import { getPasswordResetHtml } from '../../../../apps/api/src/emails/password_reset';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
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
    sendResetPassword: async ({ user, token }, request) => {
      const customUrl = `https://musubi.frgtn.dev/reset-password/?token=${token}&callback=${envOrThrow("BETTER_AUTH_URL")}`
      sendEmail(user.email, "Reset your password", getPasswordResetHtml(user.name, customUrl, "1 hour"));
    },
  },
  user: {
    deleteUser: {
      enabled: true,
    }
  },
  plugins: [
    bearer()
  ],
});
