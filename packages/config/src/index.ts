import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import path from "path";
import { fileURLToPath } from "url";
import { parseLogLevel, StructuredLogger, type LogLevel } from "./logger";

export { LOG_LEVELS, StructuredLogger, type LogFields, type LogLevel } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Keep stdout/stderr machine-readable: newer dotenv versions print banners by
// default, which would otherwise break the logger's one-JSON-object-per-line format.
const parsed = dotenv.config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
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
  logLevel: LogLevel,
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
  // Apple Developer Team ID (10 chars) — used to build the apple-app-site-
  // association file for iOS universal links (seamless invite opening).
  appleTeamID: string,
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
  logLevel: parseLogLevel(process.env.LOG_LEVEL ?? "info"),
}

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
  appleTeamID: process.env.APPLE_TEAM_ID ?? "",
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

// One process-wide logger shared by the API and its server-side packages.
// AsyncLocalStorage lets request middleware attach correlation fields once and
// have them appear in deeper auth/sync logs without threading ids everywhere.
export const logger = new StructuredLogger(apiConfig.logLevel);
