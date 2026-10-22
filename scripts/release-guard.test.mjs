import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runReleaseGuard } from "./release-guard.mjs";

const script = fileURLToPath(new URL("./release-guard.mjs", import.meta.url));
const missing = () => new Response(JSON.stringify({ message: "Not Found" }), {
  status: 404, headers: { "content-type": "application/json; charset=utf-8" },
});
const mainRef = () => new Response(JSON.stringify({
  ref: "refs/heads/main", object: { type: "commit", sha: "b".repeat(40) },
}), { status: 200, headers: { "content-type": "application/json" } });
const pageResponse = (releases = []) => new Response(JSON.stringify(releases), {
  status: 200, headers: { "content-type": "application/json" },
});
const createdResponse = (sha, overrides = {}) => new Response(JSON.stringify({
  tag_name: "v0.2.3", draft: false, target_commitish: sha, ...overrides,
}), { status: 201, headers: { "content-type": "application/json" } });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "musubi-release-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout");
  const origin = join(root, "origin.git");
  mkdirSync(cwd);
  const gitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args, directory = cwd) => spawnSync("git", args, {
    cwd: directory, env: gitEnv, encoding: "utf8", timeout: 10_000,
  });
  const ok = (args, directory = cwd) => {
    const result = git(args, directory);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  ok(["init", "--initial-branch=main"]);
  ok(["config", "user.name", "Release Fixture"]);
  ok(["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(cwd, "fixture.txt"), "before\n");
  ok(["add", "fixture.txt"]);
  ok(["commit", "-m", "owned release fixture"]);
  ok(["init", "--bare", origin], root);
  ok(["remote", "add", "origin", origin]);
  const sourceSha = ok(["rev-parse", "HEAD"]);
  const env = {
    RELEASE_VERSION: "0.2.3", EXPECTED_SOURCE_SHA: sourceSha, GITHUB_SHA: sourceSha,
    GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "fixture/release",
    GH_TOKEN: "fake-fixture-token",
  };
  const guard = ({ fetchImpl = missing, mainFetchImpl = mainRef, releaseFetchImpl = missing,
    pageFetchImpl = () => pageResponse(), createFetchImpl, ...overrides } = {}) => runReleaseGuard({
    mode: "check", cwd, env, git, qualityCheck: async () => {}, ...overrides,
    fetchImpl: (url, options) => options.method === "POST"
      ? (createFetchImpl ?? (() => assert.fail("unexpected HTTP mutation")))(url, options)
      : url.includes("/releases?") ? pageFetchImpl(url, options) : url.endsWith("/heads/main")
      ? mainFetchImpl(url, options) : url.includes("/releases/tags/")
        ? releaseFetchImpl(url, options) : fetchImpl(url, options),
  });
  const refs = () => ok(["for-each-ref", "--format=%(refname)"], origin);
  const createRemote = (sha = sourceSha, name = "refs/tags/v0.2.3") => {
    ok(["push", "origin", `${sha}:${name}`]);
  };
  return { root, cwd, origin, sourceSha, env, gitEnv, git, ok, guard, refs, createRemote };
}

test("authenticated check accepts only the exact approved checkout and a valid 404", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const result = await f.guard({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/fixture/release/git/ref/tags/v0.2.3");
    assert.equal(options.headers.Authorization, "Bearer fake-fixture-token");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return missing();
  } });
  assert.equal(result.sourceSha, f.sourceSha);
  assert.equal(calls, 1);
  assert.equal(f.refs(), "");
});

test("visible drafts absent from get-by-tag are found on later release-list pages before push", async (t) => {
  const f = fixture(t);
  const pages = [];
  const result = f.guard({ mode: "tag", pageFetchImpl: (url) => {
    pages.push(url);
    return pages.length === 1 ? pageResponse(Array.from({ length: 100 }, (_, index) => ({
      tag_name: `unrelated-${index}`, draft: false,
    }))) : pageResponse([{ tag_name: "v0.2.3", draft: true }]);
  } });
  await assert.rejects(result, /draft or published release already owns/);
  assert.equal(pages.length, 2);
  assert.equal(pages[1], "https://api.github.com/repos/fixture/release/releases?per_page=100&page=2");
  assert.equal(f.refs(), "");
});

test("malformed, unavailable, or unterminated release-list pagination fails closed", async (t) => {
  const f = fixture(t);
  for (const response of [new Response("{}", { status: 403 }), pageResponse({}),
    pageResponse([{ tag_name: "v0.2.0" }]), pageResponse(Array(101).fill({ tag_name: "other", draft: true }))]) {
    await assert.rejects(f.guard({ mode: "tag", pageFetchImpl: () => response }));
  }
  let calls = 0;
  await assert.rejects(f.guard({ mode: "tag", pageFetchImpl: () => {
    calls++;
    return pageResponse(Array(100).fill({ tag_name: "other", draft: false }));
  } }), /pagination limit/);
  assert.equal(calls, 100);
  assert.equal(f.refs(), "");
});

test("all input mismatches fail before any HTTP request or write", async (t) => {
  const f = fixture(t);
  const cases = [
    ["RELEASE_VERSION", "v0.2.3"], ["RELEASE_VERSION", "0.2.3\n"],
    ["RELEASE_VERSION", "0.2.3;echo fail"], ["EXPECTED_SOURCE_SHA", f.sourceSha.slice(0, 7)],
    ["EXPECTED_SOURCE_SHA", f.sourceSha.toUpperCase()], ["EXPECTED_SOURCE_SHA", `${f.sourceSha}\n`],
    ["EXPECTED_SOURCE_SHA", "a".repeat(40)],
    ["GITHUB_SHA", "a".repeat(40)], ["GITHUB_REF", "refs/tags/main"],
    ["GITHUB_REF", "main"], ["GITHUB_REPOSITORY", "../release"], ["GITHUB_REPOSITORY", "fixture/.."],
    ["GITHUB_REPOSITORY", "fixture/release/extra"],
    ["GH_TOKEN", ""], ["GH_TOKEN", "fake\nAuthorization: unsafe"],
  ];
  for (const [key, value] of cases) {
    await assert.rejects(f.guard({ mode: "tag", env: { ...f.env, [key]: value },
      fetchImpl: () => { assert.fail("invalid inputs reached HTTP"); },
    }));
  }
  await assert.rejects(f.guard({ mode: "unknown" }));
  assert.equal(f.refs(), "");
});

test("a draft or published release without a Git tag is refused before any push", async (t) => {
  const f = fixture(t);
  for (const draft of [true, false]) {
    await assert.rejects(f.guard({ mode: "tag", releaseFetchImpl: () =>
      new Response(JSON.stringify({ tag_name: "v0.2.3", draft }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    }), /GitHub release already exists/);
  }
  assert.equal(f.refs(), "");
});

test("forbidden or malformed release lookup cannot be mistaken for release absence", async (t) => {
  const f = fixture(t);
  for (const response of [new Response("opaque", { status: 403 }),
    new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
    new Response("invalid json", { status: 404, headers: { "content-type": "application/json" } })]) {
    await assert.rejects(f.guard({ mode: "tag", releaseFetchImpl: () => response }));
  }
  assert.equal(f.refs(), "");
});

test("a tag 404 is accepted only after authenticated Git contents access is established", async (t) => {
  const f = fixture(t);
  const invalidMain = [
    missing(), new Response("{}", { status: 403 }),
    new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "tag", sha: f.sourceSha } }),
      { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ ref: "refs/heads/other", object: { type: "commit", sha: f.sourceSha } }),
      { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "short" } }),
      { status: 200, headers: { "content-type": "application/json" } }),
  ];
  for (const response of invalidMain) {
    await assert.rejects(f.guard({ mode: "tag", mainFetchImpl: () => response,
      fetchImpl: () => assert.fail("unproven Git access reached tag lookup"),
    }));
  }
  // A later main commit is valid: it must not change the frozen publication SHA.
  assert.equal((await f.guard()).sourceSha, f.sourceSha);
  assert.equal(f.refs(), "");
});

test("different checkout HEAD and Git inspection errors fail before HTTP", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "fixture.txt"), "after\n");
  f.ok(["commit", "-am", "different head"]);
  await assert.rejects(f.guard({ mode: "tag", fetchImpl: () => assert.fail("HEAD mismatch reached HTTP") }), /Checkout HEAD/);
  await assert.rejects(f.guard({ git: () => ({ status: 1, stderr: "secret remote" }) }), /checked-out source/);
  assert.equal(f.refs(), "");
});

test("existing tags, HTTP errors, redirects, network errors, and malformed 404s fail closed", async (t) => {
  const f = fixture(t);
  for (const status of [200, 401, 403, 409, 429, 500, 502]) {
    await assert.rejects(f.guard({ mode: "tag", fetchImpl: () => new Response("opaque response", { status }) }));
  }
  const badResponses = [
    new Response("Not Found", { status: 404 }),
    new Response("not json", { status: 404, headers: { "content-type": "application/json" } }),
    new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
    new Response("[]", { status: 404, headers: { "content-type": "application/json" } }),
    { status: 404, redirected: true, headers: new Headers({ "content-type": "application/json" }) },
  ];
  for (const response of badResponses) {
    await assert.rejects(f.guard({ mode: "tag", fetchImpl: () => response }));
  }
  for (const message of ["network error includes fake-fixture-token", "request timeout"]) {
    await assert.rejects(f.guard({ mode: "tag", fetchImpl: () => { throw new Error(message); } }),
      (error) => !error.message.includes("fake-fixture-token"));
  }
  assert.equal(f.refs(), "");
});

test("tag mode makes a real non-force fresh push to an owned bare origin", async (t) => {
  const f = fixture(t);
  const gitCalls = [];
  const result = await f.guard({ mode: "tag", git: (args, cwd) => {
    gitCalls.push(args);
    return f.git(args, cwd);
  } });
  assert.equal(result.sourceSha, f.sourceSha);
  assert.deepEqual(gitCalls[1], ["push", "--porcelain", "origin", `${f.sourceSha}:refs/tags/v0.2.3`]);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
  assert.equal(f.refs(), "refs/tags/v0.2.3");
});

test("a same-SHA race produces up-to-date and is refused without adopting or changing the tag", async (t) => {
  const f = fixture(t);
  // Another publisher creates the ref immediately after our absence response.
  await assert.rejects(f.guard({ mode: "tag", fetchImpl: () => {
    f.createRemote();
    return missing();
  } }), /HOLD.*reconciliation/);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
});

test("a different-SHA race is rejected by Git and never overwrites the tag", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "fixture.txt"), "other publisher\n");
  f.ok(["commit", "-am", "other publisher"]);
  const otherSha = f.ok(["rev-parse", "HEAD"]);
  f.ok(["checkout", "--detach", f.sourceSha]);
  await assert.rejects(f.guard({ mode: "tag", fetchImpl: () => {
    f.createRemote(otherSha);
    return missing();
  } }), /HOLD.*reconciliation/);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), otherSha);
});

test("preexisting annotated tags are not adopted even when they peel to the approved commit", async (t) => {
  const f = fixture(t);
  f.ok(["tag", "-a", "v0.2.3", "-m", "owned existing annotated tag"]);
  f.ok(["push", "origin", "refs/tags/v0.2.3"]);
  const tagObject = f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin);
  await assert.rejects(f.guard({ mode: "tag" }), /HOLD.*reconciliation/);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), tagObject);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3^{commit}"], f.origin), f.sourceSha);
});

test("remote verification failure after fresh push reports possible deployment and leaves the tag intact", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.guard({ mode: "tag", git: (args, cwd) => args[0] === "ls-remote"
    ? { status: 1, stderr: "sensitive transport failure" } : f.git(args, cwd),
  }), /HOLD.*do not retry, delete, recreate, or adopt/);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
});

test("wrong remote ref proof and malformed push success fail without cleanup or extra writes", async (t) => {
  const f = fixture(t);
  const calls = [];
  await assert.rejects(f.guard({ mode: "tag", git: (args, cwd) => {
    calls.push(args);
    if (args[0] === "ls-remote") return { status: 0, stdout: `${"a".repeat(40)}\trefs/tags/v0.2.3\n` };
    return f.git(args, cwd);
  } }), /HOLD/);
  assert.equal(calls.filter((args) => args[0] === "push").length, 1);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
  for (const stdout of ["Done\n", `+\t${f.sourceSha}:refs/tags/v0.2.3\t[forced update]\n`]) {
    await assert.rejects(f.guard({ mode: "tag", git: (args, cwd) => args[0] === "push"
      ? { status: 0, stdout } : f.git(args, cwd),
    }), /HOLD/);
  }
});

test("CLI validation emits sanitized errors and has no fixture remote side effects", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [script, "tag"], {
    cwd: f.cwd, env: { ...f.gitEnv, ...f.env, EXPECTED_SOURCE_SHA: "short" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /full lowercase 40-character hashes/);
  assert.ok(!result.stderr.includes(f.env.GH_TOKEN));
  assert.equal(f.refs(), "");
  assert.equal(readFileSync(join(f.cwd, "fixture.txt"), "utf8"), "before\n");
});

test("strict release creation preserves source notes and has no existing-release update path", async (t) => {
  const f = fixture(t);
  f.createRemote();
  const notes = "# Musubi 0.2.3\n\nReviewed notes with literal `code` and $text.\n";
  mkdirSync(join(f.cwd, "docs", "releases"), { recursive: true });
  writeFileSync(join(f.cwd, "docs", "releases", "0.2.3-notes.md"), notes);
  const requests = [];
  const gitCalls = [];
  await f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
    git: (args, cwd) => { gitCalls.push(args); return f.git(args, cwd); },
    createFetchImpl: (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer fake-fixture-token");
      return createdResponse(f.sourceSha, { target_commitish: "main" });
    },
  });
  assert.deepEqual(requests, [{ url: "https://api.github.com/repos/fixture/release/releases", method: "POST",
    body: { tag_name: "v0.2.3", target_commitish: f.sourceSha, name: "Musubi v0.2.3",
      draft: false, generate_release_notes: true, body: notes } }]);
  assert.equal(gitCalls.filter((args) => args[0] === "ls-remote").length, 2);
  assert.ok(gitCalls.every((args) => ["rev-parse", "ls-remote"].includes(args[0])));
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
});

test("strict creation without local notes retains generated release notes", async (t) => {
  const f = fixture(t);
  f.createRemote();
  await f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
    createFetchImpl: (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body, "body"), false);
      assert.equal(body.generate_release_notes, true);
      return createdResponse(f.sourceSha);
    },
  });
});

test("release mode requires a matching source claim from the successful tag step before any HTTP", async (t) => {
  const f = fixture(t);
  for (const claim of [undefined, "short", "a".repeat(40), `${f.sourceSha}\n`]) {
    await assert.rejects(f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: claim },
      createFetchImpl: () => assert.fail("invalid owned-tag claim reached HTTP write"),
    }), /successful owned tag step/);
  }
  assert.equal(f.refs(), "");
});

test("missing or changed remote tag blocks release POST even with the matching step claim", async (t) => {
  const f = fixture(t);
  const release = { mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
    createFetchImpl: () => assert.fail("unproven remote tag reached HTTP write"),
  };
  await assert.rejects(f.guard(release), /HOLD/);
  // Simulate another writer replacing the tag in this owned bare fixture.
  writeFileSync(join(f.cwd, "fixture.txt"), "replacement\n");
  f.ok(["commit", "-am", "replacement"]);
  const other = f.ok(["rev-parse", "HEAD"]);
  f.createRemote(other);
  f.ok(["checkout", "--detach", f.sourceSha]);
  await assert.rejects(f.guard(release), /HOLD/);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), other);
});

test("hidden or raced drafts causing strict-create conflict never trigger an update or a retry", async (t) => {
  const f = fixture(t);
  f.createRemote();
  for (const status of [409, 422, 403, 500]) {
    const requests = [];
    await assert.rejects(f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
      createFetchImpl: (_url, options) => {
        requests.push(options.method);
        return new Response(JSON.stringify({ message: "opaque conflict including fake-fixture-token" }), {
          status, headers: { "content-type": "application/json" },
        });
      },
    }), (error) => /HOLD/.test(error.message) && !error.message.includes("fake-fixture-token"));
    assert.deepEqual(requests, ["POST"]);
    assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
  }
});

test("lost or malformed creation replies require reconciliation without retrying", async (t) => {
  const f = fixture(t);
  f.createRemote();
  for (const respond of [
    () => { throw new Error("response lost with fake-fixture-token"); },
    () => new Response("not JSON", { status: 201, headers: { "content-type": "application/json" } }),
    () => new Response("{}", { status: 201 }),
    () => createdResponse(f.sourceSha, { tag_name: "v0.2.4" }),
    () => createdResponse(f.sourceSha, { draft: true }),
  ]) {
    let calls = 0;
    await assert.rejects(f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
      createFetchImpl: () => { calls++; return respond(); },
    }), (error) => /HOLD/.test(error.message) && !error.message.includes("fake-fixture-token"));
    assert.equal(calls, 1);
    assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
  }
});

test("remote proof failing after release creation leaves publication for operator reconciliation", async (t) => {
  const f = fixture(t);
  f.createRemote();
  let created = false;
  let writes = 0;
  await assert.rejects(f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
    git: (args, cwd) => args[0] === "ls-remote" && created
      ? { status: 1, stderr: "lost remote transport" } : f.git(args, cwd),
    createFetchImpl: () => { created = true; writes++; return createdResponse(f.sourceSha); },
  }), /HOLD/);
  assert.equal(writes, 1);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
});

test("prepare checks the pinned Quality only after authenticated tag and draft absence", async (t) => {
  const f = fixture(t);
  const order = [];
  await f.guard({
    mainFetchImpl: () => { order.push("main"); return mainRef(); },
    fetchImpl: () => { order.push("tag"); return missing(); },
    releaseFetchImpl: () => { order.push("release"); return missing(); },
    pageFetchImpl: () => { order.push("drafts"); return pageResponse(); },
    qualityCheck: async ({ env, cwd, git, fetchImpl }) => {
      order.push("quality");
      assert.equal(env.EXPECTED_SOURCE_SHA, f.sourceSha);
      assert.equal(cwd, f.cwd);
      assert.equal(git(["rev-parse", "HEAD"], cwd).stdout.trim(), f.sourceSha);
      assert.equal(typeof fetchImpl, "function");
    },
  });
  assert.deepEqual(order, ["main", "tag", "release", "drafts", "quality"]);
  assert.equal(f.refs(), "");
});

test("a failed fresh Quality check prevents the deployment push without retry or fallback", async (t) => {
  const f = fixture(t);
  let qualityReads = 0;
  const gitCalls = [];
  await assert.rejects(f.guard({ mode: "tag",
    git: (args, cwd) => { gitCalls.push(args); return f.git(args, cwd); },
    qualityCheck: async () => { qualityReads++; throw new Error("Quality attempt changed"); },
  }), /Quality attempt changed/);
  assert.equal(qualityReads, 1);
  assert.ok(gitCalls.every((args) => args[0] !== "push"));
  assert.equal(f.refs(), "");
});

test("the production default cannot tag with only the old release inputs and no Quality proof", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.guard({ mode: "tag", qualityCheck: undefined }), /Quality proof:/);
  assert.equal(f.refs(), "");
});

test("the final sampled receipt is exclusive and exists before the non-force deployment push", async (t) => {
  const f = fixture(t);
  const path = join(f.root, "quality-recheck.json");
  let checked = false;
  let pushed = false;
  const env = { ...f.env, GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1",
    QUALITY_RUN_ID: "800", QUALITY_RUN_ATTEMPT: "2", QUALITY_PROOF_SHA256: "c".repeat(64),
    QUALITY_RECHECK_PATH: path };
  await f.guard({ mode: "tag", env,
    qualityCheck: async () => { checked = true; },
    git: (args, cwd) => {
      if (args[0] === "push") {
        pushed = true;
        assert.equal(checked, true);
        const record = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(record.kind, "pre-deployment-tag-quality-revalidation");
        assert.equal(record.sourceSha, f.sourceSha);
        assert.equal(record.publicationRunId, "900");
        assert.equal(record.publicationAttempt, "1");
        assert.equal(record.qualityRunId, "800");
        assert.equal(record.qualityAttempt, "2");
        assert.equal(record.proofSha256, "c".repeat(64));
        assert.equal(record.validated, true);
        assert.ok(Number.isFinite(Date.parse(record.sampledAtUtc)));
        assert.match(record.limit, /cannot atomically lock/);
        assert.ok(args.every((arg) => !["--force", "-f", "--delete"].includes(arg)));
      }
      return f.git(args, cwd);
    },
  });
  assert.equal(pushed, true);
  assert.equal(f.ok(["rev-parse", "refs/tags/v0.2.3"], f.origin), f.sourceSha);
});

test("a retained revalidation receipt is never overwritten and blocks any deployment push", async (t) => {
  const f = fixture(t);
  const path = join(f.root, "quality-recheck.json");
  writeFileSync(path, "retained prior evidence\n");
  await assert.rejects(f.guard({ mode: "tag", env: { ...f.env, QUALITY_RECHECK_PATH: path },
    qualityCheck: async () => {},
  }), /Cannot retain the final Quality revalidation/);
  assert.equal(readFileSync(path, "utf8"), "retained prior evidence\n");
  assert.equal(f.refs(), "");
});

test("an already-owned deployment tag uses strict release reconciliation without a new Quality claim", async (t) => {
  const f = fixture(t);
  f.createRemote();
  await f.guard({ mode: "release", env: { ...f.env, OWNED_TAG_SOURCE_SHA: f.sourceSha },
    qualityCheck: async () => assert.fail("owned tag release was reinterpreted as a new deployment"),
    createFetchImpl: () => createdResponse(f.sourceSha),
  });
});
