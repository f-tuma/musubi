import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLAYWRIGHT_APT_CONFIG, preparePlaywrightApt, rewriteUbuntuArchive } from "./prepare-playwright-apt.mjs";

test("legacy list rewrite changes only the exact active Azure Ubuntu URI", () => {
  const before = [
    "# deb http://azure.archive.ubuntu.com/ubuntu noble main",
    "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/ noble main restricted",
    "deb-src https://azure.archive.ubuntu.com/ubuntu noble-updates main universe",
    "deb http://security.ubuntu.com/ubuntu noble-security main",
    "deb https://packages.microsoft.com/ubuntu/24.04/prod noble main",
    "deb http://azure.archive.ubuntu.com/ubuntu-extra noble main",
    "deb http://azure.archive.ubuntu.com.evil.example/ubuntu noble main",
    "deb https://user@azure.archive.ubuntu.com/ubuntu noble main",
    "",
  ].join("\n");
  const expected = before.replace(
    "signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/",
    "signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu",
  ).replace("deb-src https://azure.archive.ubuntu.com/ubuntu", "deb-src https://archive.ubuntu.com/ubuntu");
  assert.equal(rewriteUbuntuArchive(before, "list"), expected);
});

test("deb822 preserves suites/components/Signed-By/options and unrelated stanzas/URI tokens", () => {
  const before = [
    "Types: deb deb-src",
    "URIs: http://azure.archive.ubuntu.com/ubuntu/ https://security.ubuntu.com/ubuntu",
    " https://azure.archive.ubuntu.com/ubuntu",
    "Suites: noble noble-updates noble-backports",
    "Components: main restricted universe multiverse",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "Architectures: amd64",
    "",
    "Types: deb",
    "URIs: https://packages.microsoft.com/ubuntu/24.04/prod",
    "Suites: noble",
    "Components: main",
    "# URIs: http://azure.archive.ubuntu.com/ubuntu",
    "",
  ].join("\n");
  const expected = before.replace(
    "URIs: http://azure.archive.ubuntu.com/ubuntu/ https://security.ubuntu.com/ubuntu",
    "URIs: https://archive.ubuntu.com/ubuntu https://security.ubuntu.com/ubuntu",
  ).replace("\n https://azure.archive.ubuntu.com/ubuntu\n", "\n https://archive.ubuntu.com/ubuntu\n");
  assert.equal(rewriteUbuntuArchive(before, "sources"), expected);
});

test("unknown hosts, path/query suffixes and URI-looking non-URI fields are untouched", () => {
  const cases = [
    "URIs: http://azure.archive.ubuntu.com/ubuntu/pool\n",
    "URIs: http://azure.archive.ubuntu.com/ubuntu?repo=noble\n",
    "URIs: https://azure.archive.ubuntu.com.evil.example/ubuntu\n",
    "URIs: https://mirror.example/ubuntu\n",
    "Signed-By: http://azure.archive.ubuntu.com/ubuntu\n",
    "# URIs: http://azure.archive.ubuntu.com/ubuntu\n",
  ];
  for (const before of cases) assert.equal(rewriteUbuntuArchive(before, "sources"), before);
});

test("line endings, no terminal newline and already-canonical archives are preserved", () => {
  const before = "Types: deb\r\nURIs: http://azure.archive.ubuntu.com/ubuntu/\r\nSuites: noble";
  const after = "Types: deb\r\nURIs: https://archive.ubuntu.com/ubuntu\r\nSuites: noble";
  assert.equal(rewriteUbuntuArchive(before, "sources"), after);
  assert.equal(rewriteUbuntuArchive(after, "sources"), after);
  assert.equal(rewriteUbuntuArchive("deb https://archive.ubuntu.com/ubuntu noble main", "list"),
    "deb https://archive.ubuntu.com/ubuntu noble main");
});

test("owned fixture preparation is idempotent and leaves every other source/config unchanged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "musubi-playwright-apt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sources.list.d"));
  mkdirSync(join(root, "apt.conf.d"));
  const list = join(root, "sources.list");
  const deb822 = join(root, "sources.list.d", "ubuntu.sources");
  const other = join(root, "sources.list.d", "vendor.sources");
  const trust = join(root, "apt.conf.d", "50existing-trust");
  writeFileSync(list, "deb http://azure.archive.ubuntu.com/ubuntu noble main\n");
  writeFileSync(deb822, "Types: deb\nURIs: https://azure.archive.ubuntu.com/ubuntu\nSuites: noble-updates\nSigned-By: /original/keyring\n");
  const otherBefore = "Types: deb\nURIs: https://vendor.example/ubuntu\nSigned-By: /vendor/keyring\n";
  const trustBefore = 'Acquire::https::Verify-Peer "true";\n';
  writeFileSync(other, otherBefore); writeFileSync(trust, trustBefore);
  assert.deepEqual(preparePlaywrightApt({ aptDirectory: root }),
    { checkedFiles: 2, changedFiles: 2, configChanged: true });
  assert.equal(readFileSync(list, "utf8"), "deb https://archive.ubuntu.com/ubuntu noble main\n");
  assert.match(readFileSync(deb822, "utf8"), /Signed-By: \/original\/keyring\n$/);
  assert.equal(readFileSync(other, "utf8"), otherBefore);
  assert.equal(readFileSync(trust, "utf8"), trustBefore);
  assert.equal(readFileSync(join(root, "apt.conf.d", "99musubi-playwright-network"), "utf8"), PLAYWRIGHT_APT_CONFIG);
  assert.deepEqual(preparePlaywrightApt({ aptDirectory: root }),
    { checkedFiles: 2, changedFiles: 0, configChanged: false });
});

test("acquisition config has only finite retry/http/https limits and no security or cache overrides", () => {
  assert.equal(PLAYWRIGHT_APT_CONFIG,
    'Acquire::Retries "2";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n');
  assert.doesNotMatch(PLAYWRIGHT_APT_CONFIG, /Allow|Unauth|Trusted|Verify|Check|Cache|Proxy|ForceIPv/);
});

test("missing known source files, unsupported formats and symlinks fail without host access", (t) => {
  const root = mkdtempSync(join(tmpdir(), "musubi-playwright-apt-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => preparePlaywrightApt({ aptDirectory: root }), /No supported/);
  assert.throws(() => rewriteUbuntuArchive("", "unsupported"), /Unsupported/);
  const original = join(root, "original"); writeFileSync(original, "unchanged");
  symlinkSync(original, join(root, "sources.list"));
  assert.throws(() => preparePlaywrightApt({ aptDirectory: root }), /regular/);
  assert.equal(readFileSync(original, "utf8"), "unchanged");
});
