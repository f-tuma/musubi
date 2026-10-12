import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import path from "path";
import { fileURLToPath } from "url";
import { parseLogLevel, StructuredLogger, type LogLevel } from "./logger";

export {
  LOG_LEVELS,
  StructuredLogger,
  type LogFields,
  type LogLevel,
} from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Keep stdout/stderr machine-readable: newer dotenv versions print banners by
// default, which would otherwise break the logger's one-JSON-object-per-line format.
const parsed = dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
  quiet: true,
});
expand(parsed);

function envOrThrow(key: string) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing value from ENV on KEY: ${key}`);
  }
  return value;
}

export const ENVIRONMENTS = ["dev", "test", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function parseEnvironment(value: string | undefined): Environment {
  if (!ENVIRONMENTS.includes(value as Environment)) {
    throw new Error(
      `Invalid ENVIRONMENT "${value ?? ""}". Expected dev, test, or prod.`,
    );
  }
  return value as Environment;
}

const PLACEHOLDER_AUTH_SECRETS = new Set([
  "your_secret_here",
  "change_me",
  "changeme",
  "replace_me",
  "secret",
]);

export function validateAuthSecret(
  environment: Environment,
  value: string | undefined,
) {
  if (environment === "dev" || environment === "test") return;
  const normalized = value?.trim() ?? "";
  if (
    normalized.length < 32 ||
    PLACEHOLDER_AUTH_SECRETS.has(normalized.toLowerCase())
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET must be a non-placeholder value of at least 32 characters outside dev.",
    );
  }
}

export function parseDevAuthCookiePrefix(
  environment: Environment,
  value: string | undefined,
): string | undefined {
  const prefix = value?.trim();
  if (!prefix) return undefined;
  if (environment !== "dev") {
    throw new Error("DEV_AUTH_COOKIE_PREFIX is only supported in dev for browser QA.");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(prefix)) {
    throw new Error("DEV_AUTH_COOKIE_PREFIX must contain 1–64 letters, digits, underscores, or hyphens.");
  }
  return prefix;
}

function parseMetricsPort(value: string | undefined) {
  if (value === undefined) return 9464;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `Invalid METRICS_PORT "${value}". Expected an integer from 0 to 65535.`,
    );
  }
  return port;
}

export const EXTERNAL_DELIVERY_RECOVERY_MODES = [
  "independent",
  "legacy",
  "disabled",
] as const;
export type ExternalDeliveryRecoveryMode =
  (typeof EXTERNAL_DELIVERY_RECOVERY_MODES)[number];

export function parseExternalDeliveryRecoveryMode(
  value: string | undefined,
): ExternalDeliveryRecoveryMode {
  if (value === undefined) return "independent";
  if (!EXTERNAL_DELIVERY_RECOVERY_MODES.includes(value as ExternalDeliveryRecoveryMode)) {
    throw new Error(
      "Invalid EXTERNAL_DELIVERY_RECOVERY_MODE. Expected independent, legacy, or disabled.",
    );
  }
  return value as ExternalDeliveryRecoveryMode;
}

type APIConfig = {
  // Opt-in until both editors and the release compatibility gate are ready.
  syncOperationV1EncoderEnabled: boolean;
  eventTimeEditsEnabled: boolean;
  icloudPersonalContentWritesEnabled: boolean;
  providerReminderEditsEnabled: boolean;
  caldavAlarmEditsEnabled: boolean;
  googleAvailabilityEnabled: boolean;
  providerRsvpEditsEnabled: boolean;
  icloudRsvpEditsEnabled: boolean;
  icloudOrganizerCreateEnabled: boolean;
  providerOrganizerEditsEnabled: boolean;
    caldavOrganizerEditsEnabled: boolean;
  port: number;
  environment: Environment;
  url: string;
  // Minutes between scheduled external-provider syncs (Google/CalDAV polling
  // → SSE broadcast). 0 disables scheduled pulls.
  externalSyncIntervalMin: number;
  // Recovery of already accepted event/task/move intents runs independently by
  // default. legacy retains the historical pull-interval-controlled switch.
  externalDeliveryRecoveryMode: ExternalDeliveryRecoveryMode;
  logLevel: LogLevel;
  // Separate internal listener; 0 disables Prometheus metrics.
  metricsPort: number;
};

type DBConfig = {
  databaseUrl: string;
};

type S3Config = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
};

type MediaConfig = {
  localDir: string;
  s3: S3Config | null;
};

type SMTPConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

type SocialConfig = {
  googleWebClientID: string;
  googleIOSClientID: string;
  googleClientSecret: string;
  appleClientID: string;
  // Apple Developer Team ID (10 chars) — used to build the apple-app-site-
  // association file for iOS universal links (seamless invite opening), and as
  // the issuer of the signed secret the browser flow needs.
  appleTeamID: string;
  // Sign in with Apple in a BROWSER is a different registration from the app's:
  // a Services ID plus a .p8 key, from which the server signs a short-lived
  // secret (see packages/auth apple_secret.ts). Empty → no Apple button on the
  // web, which is the state every install starts in.
  appleServicesID: string;
  appleKeyID: string;
  applePrivateKey: string;
  microsoftClientID: string;
  microsoftClientSecret: string;
  // Entra tenant: "common" (any account incl. personal) unless self-hosting
  // inside a single organization.
  microsoftTenantID: string;
};

// Web Push (VAPID). OPTIONAL, like SMTP: a server without keys simply never
// pushes, and every client keeps its own in-tab reminders. Generate a pair with
// `npx web-push generate-vapid-keys` — they identify THIS server to the browser
// vendors' push services, so they are per-install and the private one is a
// secret.
type PushConfig = {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  // "mailto:you@example.com" or an https URL. Push services require a way to
  // contact whoever is sending, and reject a subject that is neither.
  vapidSubject: string;
};

type SecurityConfig = {
  // Browser QA isolation only: Expo clients still expect Better Auth's default.
  devAuthCookiePrefix: string | undefined;
  caldavEncKey: string;
  // Refuse sign-in until the address is confirmed. Off by default: a private
  // instance among people who know each other gains nothing from it, and a
  // server with no SMTP would lock every new account out. On for anything with
  // open registration, where an unconfirmed address is a stranger's typo at
  // best and someone else's inbox at worst.
  requireEmailVerification: boolean;
  // Federation gateway SSRF guard: private/loopback targets are refused by
  // default. Self-hosters federating two servers on a LAN (or one box) must
  // opt in explicitly. Auto-enabled only for the two-server dev setup.
  federationAllowPrivateHosts: boolean;
  // Kdo smí psát zprávy o novinkách. Seznam e-mailů, ne role v databázi:
  // majitel serveru už svůj .env vlastní, takže tohle se bootstrapuje samo a
  // nestojí to migraci ani UI na udělování práv. Prázdné = server bez admina,
  // a admin endpointy pak neuznají nikoho.
  adminEmails: string[];
};

type Config = {
  api: APIConfig;
  db: DBConfig;
  media: MediaConfig;
  push: PushConfig;
  smtp: SMTPConfig;
  social: SocialConfig;
  security: SecurityConfig;
};

const environment = parseEnvironment(process.env.ENVIRONMENT);
validateAuthSecret(environment, process.env.BETTER_AUTH_SECRET);

const dbConfig: DBConfig = {
  databaseUrl: envOrThrow("DATABASE_URL"),
};

export function parseMediaConfig(
  env: Record<string, string | undefined>,
): MediaConfig {
  const bucket = env.S3_BUCKET?.trim() ?? "";
  const region = env.S3_REGION?.trim() ?? "";
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() || undefined;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() || undefined;

  if (!bucket) {
    if (region || endpoint || accessKeyId || secretAccessKey) {
      throw new Error(
        "S3_BUCKET is required when any S3 setting is configured.",
      );
    }
    return {
      localDir:
        env.MEDIA_DIR?.trim() || path.resolve(process.cwd(), "data/media"),
      s3: null,
    };
  }
  if (!region) throw new Error("S3_REGION is required when S3_BUCKET is set.");
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together.",
    );
  }

  return {
    localDir:
      env.MEDIA_DIR?.trim() || path.resolve(process.cwd(), "data/media"),
    s3: {
      bucket,
      region,
      endpoint,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    },
  };
}

const mediaConfig = parseMediaConfig(process.env);

const apiConfig: APIConfig = {
  // Enable only after all consumers have the decoder-first HOLD floor.
  syncOperationV1EncoderEnabled: process.env.SYNC_OPERATION_V1_ENCODER_ENABLED === "true",
  eventTimeEditsEnabled: process.env.EVENT_TIME_EDITS_ENABLED === "true",
  icloudPersonalContentWritesEnabled: process.env.ICLOUD_PERSONAL_CONTENT_WRITES_ENABLED === "true",
  providerReminderEditsEnabled: process.env.PROVIDER_REMINDER_EDITS_ENABLED === "true",
  caldavAlarmEditsEnabled: process.env.CALDAV_ALARM_EDITS_ENABLED === "true",
  googleAvailabilityEnabled: process.env.GOOGLE_AVAILABILITY_ENABLED === "true",
  providerRsvpEditsEnabled: process.env.PROVIDER_RSVP_EDITS_ENABLED === "true",
  icloudRsvpEditsEnabled: process.env.ICLOUD_RSVP_EDITS_ENABLED === "true",
  icloudOrganizerCreateEnabled: process.env.ICLOUD_ORGANIZER_CREATE_ENABLED === "true",
  providerOrganizerEditsEnabled: process.env.PROVIDER_ORGANIZER_EDITS_ENABLED === "true",
    caldavOrganizerEditsEnabled: process.env.CALDAV_ORGANIZER_EDITS_ENABLED === "true",
  port: Number(process.env.API_SERVER_PORT) || 7531,
  environment,
  url: envOrThrow("BETTER_AUTH_URL"),
  externalSyncIntervalMin:
    process.env.EXTERNAL_SYNC_INTERVAL_MIN === undefined
      ? 5
      : Number(process.env.EXTERNAL_SYNC_INTERVAL_MIN) || 0, // unparsable/0 → disabled
  externalDeliveryRecoveryMode: parseExternalDeliveryRecoveryMode(
    process.env.EXTERNAL_DELIVERY_RECOVERY_MODE,
  ),
  logLevel: parseLogLevel(process.env.LOG_LEVEL ?? "info"),
  metricsPort: parseMetricsPort(process.env.METRICS_PORT),
};

// A half-configured key pair is worse than none: the server would advertise a
// public key the browser subscribes with, then fail every send with a signature
// error nobody sees. Both or neither.
function readPushConfig(): PushConfig {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? "";
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  const vapidSubject = process.env.VAPID_SUBJECT ?? "";

  if (Boolean(vapidPublicKey) !== Boolean(vapidPrivateKey)) {
    throw new Error(
      "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together — one without the other advertises push this server cannot send.",
    );
  }
  if (vapidPublicKey && !/^(mailto:|https:\/\/)/.test(vapidSubject)) {
    throw new Error(
      "VAPID_SUBJECT must be a mailto: address or an https URL — push services reject anything else.",
    );
  }

  return { vapidPrivateKey, vapidPublicKey, vapidSubject };
}

const pushConfig = readPushConfig();

// SMTP + Google are OPTIONAL — the API boots without them so local dev doesn't
// need mail or OAuth set up. The features that use them fail/verify at call time
// (password-reset send, Google sign-in & Calendar sync) rather than at boot.
const smtpConfig: SMTPConfig = {
  host: process.env.SMTP_HOST ?? "",
  port: Number(process.env.SMTP_PORT) || 0,
  user: process.env.SMTP_USER ?? "",
  pass: process.env.SMTP_PASS ?? "",
  from: process.env.FROM_EMAIL ?? "",
};

const socialConfig: SocialConfig = {
  googleIOSClientID: process.env.GOOGLE_IOS_CLIENT_ID ?? "",
  googleWebClientID: process.env.GOOGLE_WEB_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  appleClientID: process.env.APPLE_CLIENT_ID ?? "",
  appleTeamID: process.env.APPLE_TEAM_ID ?? "",
  appleServicesID: process.env.APPLE_SERVICES_ID ?? "",
  appleKeyID: process.env.APPLE_KEY_ID ?? "",
  applePrivateKey: process.env.APPLE_PRIVATE_KEY ?? "",
  microsoftClientID: process.env.MICROSOFT_CLIENT_ID ?? "",
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
  microsoftTenantID: process.env.MICROSOFT_TENANT_ID ?? "common",
};

function parseRequireEmailVerification() {
  const required = process.env.REQUIRE_EMAIL_VERIFICATION === "true";
  // Fail at boot rather than at the first sign-up. This combination cannot serve
  // anyone: the account is created, the confirmation never arrives, and the
  // person can never sign in — a state no error message at the door explains.
  if (required && !smtpConfig.host) {
    throw new Error(
      "REQUIRE_EMAIL_VERIFICATION=true needs SMTP_HOST — without mail nobody could ever confirm an address.",
    );
  }
  return required;
}

export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

const securityConfig: SecurityConfig = {
  devAuthCookiePrefix: parseDevAuthCookiePrefix(environment, process.env.DEV_AUTH_COOKIE_PREFIX),
  caldavEncKey: process.env.CALDAV_ENC_KEY ?? "", // validated at use in the crypto helper
  requireEmailVerification: parseRequireEmailVerification(),
  federationAllowPrivateHosts:
    process.env.FEDERATION_ALLOW_PRIVATE_HOSTS === "true" ||
    environment === "dev",
  adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
};

export const config: Config = {
  api: apiConfig,
  db: dbConfig,
  media: mediaConfig,
  push: pushConfig,
  smtp: smtpConfig,
  social: socialConfig,
  security: securityConfig,
};

// One process-wide logger shared by the API and its server-side packages.
// AsyncLocalStorage lets request middleware attach correlation fields once and
// have them appear in deeper auth/sync logs without threading ids everywhere.
export const logger = new StructuredLogger(apiConfig.logLevel);
