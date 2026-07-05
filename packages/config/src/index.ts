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
}

console.log(`USING PORT: ${apiConfig.port}`)

const smtpConfig: SMTPConfig = {
  host: envOrThrow("SMTP_HOST"),
  port: Number(envOrThrow("SMTP_PORT")),
  user: envOrThrow("SMTP_USER"),
  pass: envOrThrow("SMTP_PASS"),
  from: envOrThrow("FROM_EMAIL"),
}

const socialConfig: SocialConfig = {
  googleIOSClientID: "", // envOrThrow("GOOGLE_IOS_CLIENT_ID"),
  googleWebClientID: envOrThrow("GOOGLE_WEB_CLIENT_ID"),
  googleClientSecret: envOrThrow("GOOGLE_CLIENT_SECRET"),
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

