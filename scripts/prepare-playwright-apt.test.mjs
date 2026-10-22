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

test("known runner mirrorlist in a legacy URI position becomes the direct canonical archive", () => {
  const before = [
    "# deb mirror+file:/etc/apt/apt-mirrors.txt noble main",
    "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:/etc/apt/apt-mirrors.txt noble main restricted",
    "deb-src mirror+file:/etc/apt/apt-mirrors.txt noble-updates main universe",
    "deb mirror+file:/etc/apt/other-mirrors.txt noble main",
    "",
  ].join("\n");
  const expected = before.replace(
    "signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:/etc/apt/apt-mirrors.txt",
    "signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu",
  ).replace("deb-src mirror+file:/etc/apt/apt-mirrors.txt", "deb-src https://archive.ubuntu.com/ubuntu");
  assert.equal(rewriteUbuntuArchive(before, "list"), expected);
});

test("known runner mirrorlist fixture rewrites the active deb822 route, not just timeout config", (t) => {
  const root = mkdtempSync(join(tmpdir(), "musubi-playwright-mirrorlist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sources.list.d"));
  const sourcePath = join(root, "sources.list.d", "ubuntu.sources");
  // The primary runner-image script selects this mirror file in both Ubuntu
  // formats. Its first priority is Azure; the timeout receipt observed that
  // mirrorlist plus Azure acquisition, not a complete runtime source file.
  const mirrorPath = join(root, "apt-mirrors.txt");
  const mirrors = "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n" +
    "https://archive.ubuntu.com/ubuntu/\tpriority:2\n" +
    "https://security.ubuntu.com/ubuntu/\tpriority:3\n";
  writeFileSync(mirrorPath, mirrors);
  const before = [
    "Types: deb deb-src",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "Suites: noble noble-updates noble-backports noble-security",
    "Components: main restricted universe multiverse",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "Architectures: amd64",
    "",
    "Types: deb",
    "URIs: https://security.ubuntu.com/ubuntu",
    "Suites: noble-security",
    "Components: main",
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "",
    "Types: deb",
    "URIs: https://packages.microsoft.com/ubuntu/24.04/prod",
    "Suites: noble",
    "Components: main",
    "Signed-By: /usr/share/keyrings/microsoft-prod.gpg",
    "",
  ].join("\n");
  writeFileSync(sourcePath, before);
  const expected = before.replace("URIs: mirror+file:/etc/apt/apt-mirrors.txt",
    "URIs: https://archive.ubuntu.com/ubuntu");
  assert.deepEqual(preparePlaywrightApt({ aptDirectory: root }),
    { checkedFiles: 1, changedFiles: 1, configChanged: true });
  const after = readFileSync(sourcePath, "utf8");
  assert.equal(after, expected);
  assert.match(after, /^URIs: https:\/\/archive\.ubuntu\.com\/ubuntu$/m);
  assert.doesNotMatch(after, /^URIs: mirror\+file:\/etc\/apt\/apt-mirrors\.txt$/m);
  assert.equal(readFileSync(mirrorPath, "utf8"), mirrors);
  assert.deepEqual(preparePlaywrightApt({ aptDirectory: root }),
    { checkedFiles: 1, changedFiles: 0, configChanged: false });
});

test("unknown hosts, path/query suffixes and URI-looking non-URI fields are untouched", () => {
  const cases = [
    "URIs: http://azure.archive.ubuntu.com/ubuntu/pool\n",
    "URIs: http://azure.archive.ubuntu.com/ubuntu?repo=noble\n",
    "URIs: https://azure.archive.ubuntu.com.evil.example/ubuntu\n",
    "URIs: https://mirror.example/ubuntu\n",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt.extra\n",
    "URIs: mirror+file:/etc/apt/security-mirrors.txt\n",
    "URIs: mirror+file:/etc/apt/apt-mirrors.txt?query=1\n",
    "Signed-By: mirror+file:/etc/apt/apt-mirrors.txt\n",
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
