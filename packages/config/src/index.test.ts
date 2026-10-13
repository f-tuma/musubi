import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.ENVIRONMENT ??= "dev";
process.env.BETTER_AUTH_URL ??= "http://localhost:7531";

async function main() {
  delete process.env.ICLOUD_RSVP_EDITS_ENABLED;
  process.env.SYNC_OPERATION_V1_ENCODER_ENABLED = "true";
  const {
    config,
    parseAdminEmails,
    parseDevAuthCookiePrefix,
    parseEnvironment,
    parseExternalDeliveryRecoveryMode,
    parseMediaConfig,
    parseSyncOperationV1EncoderEnabled,
    validateAuthSecret,
  } = await import("./index");

  assert.equal(config.api.icloudRsvpEditsEnabled, false);
  assert.equal(config.api.syncOperationV1EncoderEnabled, true, "explicit ON reaches runtime configuration");
  assert.equal(parseSyncOperationV1EncoderEnabled(undefined), true);
  assert.equal(parseSyncOperationV1EncoderEnabled("true"), true);
  assert.equal(parseSyncOperationV1EncoderEnabled("false"), false, "explicit opt-out keeps legacy admission");
  for (const value of ["", "TRUE", "False", "1", "0", " true ", " false ", "private-config-value"]) {
    assert.throws(() => parseSyncOperationV1EncoderEnabled(value), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Invalid SYNC_OPERATION_V1_ENCODER_ENABLED. Expected true or false.");
      return true;
    });
  }
  // Exercise real module initialization as well as the parser. A typo must
  // fail boot, while a previous installation's explicit false remains valid.
  const configURL = new URL("./index.ts", import.meta.url).href;
  for (const value of ["false", "private-config-value"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      try {
        const { config } = await import(${JSON.stringify(configURL)});
        process.stdout.write(JSON.stringify(config.api.syncOperationV1EncoderEnabled));
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : "Configuration rejected");
        process.exitCode = 1;
      }
    `], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4096,
      env: {
        DATABASE_URL: "postgres://user:pass@localhost:5432/test",
        ENVIRONMENT: "test",
        BETTER_AUTH_URL: "http://localhost:7531",
        SYNC_OPERATION_V1_ENCODER_ENABLED: value,
      },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, value === "false" ? 0 : 1);
    assert.equal(child.stdout, value === "false" ? "false" : "");
    assert.equal(child.stderr, value === "false" ? "" : "Invalid SYNC_OPERATION_V1_ENCODER_ENABLED. Expected true or false.");
  }
  assert.equal(parseExternalDeliveryRecoveryMode(undefined), "independent");
  for (const mode of ["independent", "legacy", "disabled"] as const) {
    assert.equal(parseExternalDeliveryRecoveryMode(mode), mode);
  }
  for (const mode of ["", "true", "false", "poll", "Independent", " legacy "]) {
    assert.throws(() => parseExternalDeliveryRecoveryMode(mode), /Expected independent, legacy, or disabled/);
  }
  for (const environment of ["dev", "test", "prod"] as const) {
    assert.equal(parseDevAuthCookiePrefix(environment, undefined), undefined);
    assert.equal(parseDevAuthCookiePrefix(environment, "  "), undefined);
  }
  assert.equal(parseDevAuthCookiePrefix("dev", " musubi-qa_2026 "), "musubi-qa_2026");
  assert.equal(parseDevAuthCookiePrefix("dev", "a".repeat(64)), "a".repeat(64));
  for (const value of ["a".repeat(65), "qa.cookie", "qa;cookie", "qa cookie", "qa\ncookie"]) {
    assert.throws(() => parseDevAuthCookiePrefix("dev", value), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1–64/);
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
  for (const environment of ["test", "prod"] as const) {
    assert.throws(() => parseDevAuthCookiePrefix(environment, "musubi-qa"), /only supported in dev/);
  }
  assert.equal(parseEnvironment("dev"), "dev");
  assert.equal(parseEnvironment("test"), "test");
  assert.equal(parseEnvironment("prod"), "prod");
  assert.throws(
    () => parseEnvironment("production"),
    /Expected dev, test, or prod/,
  );

  assert.doesNotThrow(() => validateAuthSecret("dev", "short"));
  assert.doesNotThrow(() => validateAuthSecret("test", "your_secret_here"));
  assert.throws(() => validateAuthSecret("prod", "short"), /at least 32/);
  assert.doesNotThrow(() =>
    validateAuthSecret("prod", "0123456789abcdef0123456789abcdef"),
  );

  assert.deepEqual(parseMediaConfig({ MEDIA_DIR: "/tmp/media" }), {
    localDir: "/tmp/media",
    s3: null,
  });
  assert.throws(
    () => parseMediaConfig({ S3_REGION: "eu-central-1" }),
    /S3_BUCKET is required/,
  );
  assert.throws(
    () => parseMediaConfig({ S3_BUCKET: "media" }),
    /S3_REGION is required/,
  );
  assert.throws(
    () =>
      parseMediaConfig({
        S3_BUCKET: "media",
        S3_REGION: "eu-central-1",
        S3_ACCESS_KEY_ID: "key",
      }),
    /must be set together/,
  );
  assert.equal(
    parseMediaConfig({
      S3_BUCKET: "media",
      S3_REGION: "eu-central-1",
    }).s3?.bucket,
    "media",
  );

  // Admin serveru je seznam e-mailů v env. Normalizuje se, protože e-mail
  // z Google sign-inu dorazí v jiném psaní než ho admin napsal do .env.
  assert.deepEqual(parseAdminEmails("a@example.com,b@example.com"), [
    "a@example.com",
    "b@example.com",
  ]);
  assert.deepEqual(parseAdminEmails(" A@Example.COM , b@example.com "), [
    "a@example.com",
    "b@example.com",
  ]);
  // Nenastavené nebo prázdné = tenhle server nemá admina.
  assert.deepEqual(parseAdminEmails(undefined), []);
  assert.deepEqual(parseAdminEmails(""), []);
  assert.deepEqual(parseAdminEmails(",  ,"), []);

  console.log("config security self-check: OK");
}

void main();
