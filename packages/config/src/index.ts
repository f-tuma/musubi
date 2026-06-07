import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import path from "path";
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

type Config = {
  api: APIConfig,
  db: DBConfig,
  smtp: SMTPConfig,
}

const dbConfig: DBConfig = {
  databaseUrl: envOrThrow("DATABASE_URL"),
}

const apiConfig: APIConfig = {
  port: 7531,
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

