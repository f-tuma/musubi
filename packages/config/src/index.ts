import dotenv from "dotenv";
import path from "path";
import { env } from "process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

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

type Config = {
  api: APIConfig,
  db: DBConfig,
  smtp: SMTPConfig,
}

const dbConfig: DBConfig = {
  databaseUrl: envOrThrow("DATABASE_URL"),
}

const apiConfig: APIConfig = {
  port: Number(envOrThrow("API_SERVER_PORT")),
  environment: envOrThrow("ENVIRONMENT"),
  url: envOrThrow("BETTER_AUTH_URL"),
}

const smtpConfig: SMTPConfig = {
  host: envOrThrow("SMTP_HOST"),
  port: Number(envOrThrow("SMTP_PORT")),
  user: envOrThrow("SMTP_USER"),
  pass: envOrThrow("SMTP_PASS"),
  from: envOrThrow("FROM_EMAIL"),
}

export const config: Config = {
  api: apiConfig,
  db: dbConfig,
  smtp: smtpConfig,
}

