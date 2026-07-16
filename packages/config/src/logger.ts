import { AsyncLocalStorage } from "node:async_hooks";

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export type LogFields = Record<string, unknown>;

const PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const SENSITIVE_FIELD = /(authorization|cookie|password|passwd|passphrase|secret|token)/i;

export function parseLogLevel(value: string): LogLevel {
  const normalized = value.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) return normalized as LogLevel;
  throw new Error(`Invalid LOG_LEVEL "${value}". Expected one of: ${LOG_LEVELS.join(", ")}`);
}

function jsonReplacer(key: string, value: unknown) {
  // Protect future call sites too: structured fields with credential-like keys
  // are redacted even if a developer accidentally passes them to the logger.
  if (key && SENSITIVE_FIELD.test(key)) return "[REDACTED]";

  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;

    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(cause === undefined ? {} : { cause }),
    };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export class StructuredLogger {
  private readonly contexts = new AsyncLocalStorage<LogFields>();

  constructor(readonly level: LogLevel) {}

  isEnabled(level: Exclude<LogLevel, "silent">) {
    return PRIORITY[level] >= PRIORITY[this.level];
  }

  runWithContext<T>(fields: LogFields, callback: () => T): T {
    return this.contexts.run({ ...fields }, callback);
  }

  addContext(fields: LogFields) {
    const context = this.contexts.getStore();
    if (context) Object.assign(context, fields);
  }

  debug(message: string, fields?: LogFields) { this.write("debug", message, fields); }
  info(message: string, fields?: LogFields) { this.write("info", message, fields); }
  warn(message: string, fields?: LogFields) { this.write("warn", message, fields); }
  error(message: string, fields?: LogFields) { this.write("error", message, fields); }

  private write(level: Exclude<LogLevel, "silent">, message: string, fields: LogFields = {}) {
    if (!this.isEnabled(level)) return;

    const payload = {
      ...this.contexts.getStore(),
      ...fields,
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    const line = JSON.stringify(payload, jsonReplacer);
    const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }
}
