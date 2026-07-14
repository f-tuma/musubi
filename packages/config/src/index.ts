import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import path from "path";
import { env } from "process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parsed = dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
expand(parsed);

function envOrThrow(key: string) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing value from ENV on KEY: ${key}`);
  }
  return value;
}

type APIConfig = {
  port: number,
  environment: string,
  url: string,
  // Minutes between scheduled external-provider syncs (Google/CalDAV polling
  // → SSE broadcast). 0 disables the scheduler.
  externalSyncIntervalMin: number,
}

type DBConfig = {
  databaseUrl: string,
}

type SMTPConfig = {
  host: string,
  port: number,
  user: string,
  pass: string,
  from: string,
}

type SocialConfig = {
  googleWebClientID: string,
  googleIOSClientID: string,
  googleClientSecret: string,
  appleClientID: string,
}

type SecurityConfig = {
  caldavEncKey: string,
}

type Config = {
  api: APIConfig,
  db: DBConfig,
  smtp: SMTPConfig,
  social: SocialConfig,
  security: SecurityConfig,
}

const dbConfig: DBConfig = {
  databaseUrl: envOrThrow("DATABASE_URL"),
}

const apiConfig: APIConfig = {
  port: Number(process.env.API_SERVER_PORT) || 7531,
  environment: envOrThrow("ENVIRONMENT"),
  url: envOrThrow("BETTER_AUTH_URL"),
  externalSyncIntervalMin: process.env.EXTERNAL_SYNC_INTERVAL_MIN === undefined
    ? 5
    : Number(process.env.EXTERNAL_SYNC_INTERVAL_MIN) || 0, // unparsable/0 → disabled
}

console.log(`USING PORT: ${apiConfig.port}`)

// SMTP + Google are OPTIONAL — the API boots without them so local dev doesn't
// need mail or OAuth set up. The features that use them fail/verify at call time
// (password-reset send, Google sign-in & Calendar sync) rather than at boot.
const smtpConfig: SMTPConfig = {
  host: process.env.SMTP_HOST ?? "",
  port: Number(process.env.SMTP_PORT) || 0,
  user: process.env.SMTP_USER ?? "",
  pass: process.env.SMTP_PASS ?? "",
  from: process.env.FROM_EMAIL ?? "",
}

const socialConfig: SocialConfig = {
  googleIOSClientID: process.env.GOOGLE_IOS_CLIENT_ID ?? "",
  googleWebClientID: process.env.GOOGLE_WEB_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  appleClientID: process.env.APPLE_CLIENT_ID ?? "",
}

const securityConfig: SecurityConfig = {
  caldavEncKey: process.env.CALDAV_ENC_KEY ?? "", // validated at use in the crypto helper
}

export const config: Config = {
  api: apiConfig,
  db: dbConfig,
  smtp: smtpConfig,
  social: socialConfig,
  security: securityConfig,
}

