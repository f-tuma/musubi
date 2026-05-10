import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export function envOrThrow(key: string) {
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

type Config = {
  api: APIConfig,
  db: DBConfig,
}

const dbConfig: DBConfig = {
  databaseUrl: envOrThrow("DATABASE_URL"),
}

const apiConfig: APIConfig = {
  port: Number(envOrThrow("API_SERVER_PORT")),
  environment: envOrThrow("ENVIRONMENT"),
  url: envOrThrow("API_URL"),
}

export const config: Config = {
  api: apiConfig,
  db: dbConfig,
}

