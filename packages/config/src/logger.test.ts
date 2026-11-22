// Logs are the tool you reach for during an incident, so the properties that
// make them usable have to hold when nobody is looking.
//
// Three of them, and each fails silently:
//
//   Redaction. `logger.error("auth.failed", { error })` is the natural thing to
//   write, and whether the object underneath carries a session cookie is not
//   visible at the call site. The redaction is what makes that call safe; if it
//   regresses, the credential is in the log aggregator before anyone notices,
//   and no test failed on the way there.
//
//   One JSON object per line. Every downstream reader — Loki, jq, grep — assumes
//   it. A stray newline splits one event into two malformed ones.
//
//   The stream split. Warnings and errors go to stderr so a container runtime
//   can separate them; put them on stdout and the distinction is gone.
import assert from "node:assert/strict";
import { StructuredLogger, parseLogLevel, redactLogFields } from "./logger";

/** Everything written to each stream while `run` executes. */
function captured(run: () => void) {
  const streams = { stdout: [] as string[], stderr: [] as string[] };
  const original = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  for (const name of ["stdout", "stderr"] as const) {
    process[name].write = ((chunk: string) => {
      streams[name].push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  }
  try {
    run();
  } finally {
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
  }
  return streams;
}

/** The single line a logger call produced, parsed. */
function loggedTo(
  stream: "stdout" | "stderr",
  run: (logger: StructuredLogger) => void,
  level = "debug" as const,
) {
  const logger = new StructuredLogger(level);
  const streams = captured(() => run(logger));
  assert.equal(
    streams[stream].length,
    1,
    `expected exactly one write to ${stream}, got ${JSON.stringify(streams)}`,
  );
  const written = streams[stream][0];
  assert.ok(written.endsWith("\n"), "every log line must be newline-terminated");
  assert.equal(
    written.trimEnd().includes("\n"),
    false,
    "a log line must be one line — a downstream reader splits on newlines",
  );
  return JSON.parse(written) as Record<string, unknown>;
}

const logged = (run: (logger: StructuredLogger) => void) =>
  loggedTo("stdout", run);

// --- Shape ------------------------------------------------------------------

const line = logged((logger) => logger.info("http.request.completed", { status: 200 }));
assert.equal(line.message, "http.request.completed");
assert.equal(line.level, "info");
assert.equal(line.status, 200);
assert.match(String(line.timestamp), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

// --- Redaction --------------------------------------------------------------
//
// The value is the thing that leaks, so every assertion below checks that the
// secret string is absent, not merely that some key was rewritten.

const SECRET = "s3cr3t-value-that-must-not-appear";

for (const field of [
  "authorization",
  "Authorization",
  "cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "refreshToken",
  "BETTER_AUTH_SECRET",
]) {
  const written = captured(() => {
    new StructuredLogger("debug").info("probe", { [field]: SECRET });
  }).stdout.join("");
  assert.equal(
    written.includes(SECRET),
    false,
    `a field named ${field} leaked its value into the log line`,
  );
  assert.ok(
    written.includes("[REDACTED]"),
    `a field named ${field} was not redacted`,
  );
}

// Nested, because credentials arrive inside the object somebody logged rather
// than as a top-level field they chose to write down.
const nested = logged((logger) =>
  logger.info("sync.failed", {
    account: { id: "acc-1", provider: "google", refreshToken: SECRET },
    headers: [{ cookie: SECRET }],
  }),
);
assert.equal(JSON.stringify(nested).includes(SECRET), false);
assert.equal((nested.account as Record<string, unknown>).id, "acc-1");

// A field whose *name* is innocent keeps its value — over-redaction would make
// the logs useless in the other direction.
const kept = logged((logger) => logger.info("probe", { calendarId: "cal-1" }));
assert.equal(kept.calendarId, "cal-1");

// --- Values JSON cannot carry on its own ------------------------------------

const failure = loggedTo("stderr", (logger) =>
  logger.error("job.failed", {
    error: Object.assign(new Error("upstream refused"), {
      cause: "connect ECONNREFUSED",
    }),
  }),
);
const error = failure.error as Record<string, unknown>;
assert.equal(error.name, "Error");
assert.equal(error.message, "upstream refused");
assert.equal(error.cause, "connect ECONNREFUSED");
assert.ok(String(error.stack).includes("upstream refused"), "the stack is kept");

// `JSON.stringify` throws on a bigint rather than dropping it, which would take
// the whole log line with it.
assert.equal(
  logged((logger) => logger.info("probe", { nanos: 42n })).nanos,
  "42",
);

// --- Levels and streams -----------------------------------------------------

const filtered = captured(() => {
  const logger = new StructuredLogger("warn");
  logger.debug("dropped");
  logger.info("dropped");
  logger.warn("kept");
  logger.error("kept");
});
assert.deepEqual(
  filtered.stdout,
  [],
  "a level filters everything below it, and nothing at warn or above is stdout",
);
assert.deepEqual(
  filtered.stderr.map((written) => JSON.parse(written).message),
  ["kept", "kept"],
  "warn and error survive the level and both go to stderr",
);

assert.deepEqual(
  captured(() => {
    const logger = new StructuredLogger("silent");
    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");
  }),
  { stdout: [], stderr: [] },
  "silent writes nothing at all",
);

assert.equal(loggedTo("stderr", (logger) => logger.warn("probe")).level, "warn");
assert.equal(
  loggedTo("stderr", (logger) => logger.error("probe")).level,
  "error",
);

assert.equal(parseLogLevel(" INFO "), "info");
assert.throws(() => parseLogLevel("verbose"), /Invalid LOG_LEVEL/);

// --- Request context --------------------------------------------------------
//
// This is what makes a log searchable during an incident: one request id on
// every line the request produced, without threading it through every call.

const contextual = logged((logger) =>
  logger.runWithContext({ requestId: "req-1" }, () => {
    logger.addContext({ userId: "user-1" });
    logger.info("http.request.completed");
  }),
);
assert.equal(contextual.requestId, "req-1");
assert.equal(contextual.userId, "user-1");

// Explicit fields win over context, and neither leaks out of the scope.
const outside = logged((logger) => {
  logger.runWithContext({ requestId: "req-1" }, () => {});
  logger.info("later");
});
assert.equal(outside.requestId, undefined);

// --- Sink -------------------------------------------------------------------
//
// Error tracking reads records through the sink. It gets the original Error
// (for a real stack trace) and must redact through the same rules as stdout.

const sunk: unknown[][] = [];
const sinkLogger = new StructuredLogger("info");
sinkLogger.sink = (...record) => sunk.push(record);
const sinkError = new Error("boom");
captured(() => {
  sinkLogger.debug("below level");
  sinkLogger.runWithContext({ requestId: "req-2" }, () => {
    sinkLogger.error("job.failed", { error: sinkError, sessionToken: "secret-value" });
  });
});
assert.equal(sunk.length, 1, "the sink honours the log level");
const [level, message, fields] = sunk[0] as [string, string, Record<string, unknown>];
assert.deepEqual([level, message, fields.requestId, fields.error], ["error", "job.failed", "req-2", sinkError]);
const redacted = redactLogFields(fields);
assert.equal(redacted.sessionToken, "[REDACTED]");
assert.deepEqual(Object.keys(redacted.error as object), ["name", "message", "stack"]);

console.log("logger self-check: OK");
