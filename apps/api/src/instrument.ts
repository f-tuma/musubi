// Imported first by index.ts: the Sentry SDK instruments http, Express and pg
// only when it is initialized before they are loaded. Rustrak, or any server
// that speaks the Sentry protocol, receives errors, traces, logs and cron
// check-ins. Without SENTRY_DSN nothing here runs and nothing leaves the process.
import * as Sentry from "@sentry/node";
import { config, logger, redactLogFields, type LogSink } from "@musubi/config";
import { PRODUCT_VERSION, scrubTelemetry, TELEMETRY_DATA_COLLECTION } from "@musubi/types";

const { dsn, environment, tracesSampleRate } = config.sentry;

// Structured logs become Sentry logs; every error-level record also becomes an
// issue, so a failed scheduler run is as visible as a 5xx. Fields go through
// the logger's own redaction first.
const forwardLog: LogSink = (level, message, fields) => {
  const attributes = redactLogFields(fields);
  Sentry.logger[level](message, attributes);
  if (level !== "error") return;
  const context = {
    extra: attributes,
    tags: {
      log: message,
      ...(typeof fields.requestId === "string" ? { request_id: fields.requestId } : {}),
    },
    ...(typeof fields.userId === "string" ? { user: { id: fields.userId } } : {}),
  };
  if ("error" in fields) Sentry.captureException(fields.error, context);
  else Sentry.captureMessage(message, { ...context, level: "error" });
};

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release: `musubi@${PRODUCT_VERSION}`,
    tracesSampleRate,
    dataCollection: TELEMETRY_DATA_COLLECTION,
    // middlewareErrorHandler decides the status and logs 5xx once, which the
    // sink above reports. Express's own capture would also report 4xx
    // NotFoundError & co. as 500s, and every real 500 twice.
    integrations: [Sentry.expressIntegration({ shouldHandleError: false })],
    beforeSend: scrubTelemetry,
    beforeSendSpan: scrubTelemetry,
    beforeSendLog: scrubTelemetry,
    beforeBreadcrumb: scrubTelemetry,
  });
  logger.sink = forwardLog;
}
