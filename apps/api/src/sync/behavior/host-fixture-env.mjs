import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock } from "node:test";
let ready;
export function hostFixtureEnvironment() {
  return Object.freeze({ ENVIRONMENT: "test", DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/unused", BETTER_AUTH_URL: "http://127.0.0.1:7531",
    BETTER_AUTH_SECRET: "musubi-c10-host-fixture-auth-secret-20261026-synthetic", CALDAV_ENC_KEY: "66".repeat(32), EXTERNAL_SYNC_INTERVAL_MIN: "0", LOG_LEVEL: "warn" });
}
export function installHostFixture() {
  return ready ??= (async () => {
    if (typeof mock.module !== "function") throw new Error("Host fixtures require the explicit Node module-mock flag");
    Object.assign(process.env, hostFixtureEnvironment()); delete process.env.REFERENCE_DATABASE_URL;
    const config = () => ({ parsed: {} }), expand = value => value;
    mock.module("dotenv", { defaultExport: { config }, namedExports: { config } });
    mock.module("dotenv-expand", { defaultExport: { expand }, namedExports: { expand } });
    // Verify both actual loader ports before an API module can import config.
    // Identity checks precede invocation, so a broken mock cannot read a file.
    const require = createRequire(import.meta.url), cjs = require("dotenv"), esm = await import("dotenv");
    assert.equal(cjs.config, config); assert.equal(esm.default.config, config);
    assert.deepEqual(cjs.config(), { parsed: {} }); assert.deepEqual(esm.default.config(), { parsed: {} });
    assert.equal(require("dotenv-expand").expand, expand); assert.equal((await import("dotenv-expand")).expand, expand);
    const key = "MUSUBI_C10_DOTENV_READER_PROBE"; delete process.env[key];
    require("dotenv-expand").expand({ parsed: { [key]: "synthetic-do-not-expand" } });
    (await import("dotenv-expand")).expand({ parsed: { [key]: "synthetic-do-not-expand" } });
    assert.equal(process.env[key], undefined);
  })();
}
