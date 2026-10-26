# MUSU-42 bounded exact-source review

Review outcome: SOURCE APPROVED, with no blocking findings in the finite four-file delta from the previously approved 4c32 source. This is not final PR approval, artifact acceptance, publication, or production/deployment evidence.

- Exact clean HEAD: `8e5e202c4912748e97c02646a8969a4a02543c3c`
- Exact tree: `dd2c9c7684533f98e898dc3278331c011c313e52`
- Prior approval: `/tmp/musu42-exact-source-4c32-review.md`, building on `/tmp/musu42-exact-source-d3a886-review.md`.
- Finite delta against `4c32d8bb9652598efb4fb4f0308862a8d5bb70dc`: four files, 82 insertions and 15 deletions. Working tree was clean when bound.

## Reviewed file hashes

| File | SHA-256 |
| --- | --- |
| scripts/sync-alpha-common.mjs | 45302857d110e6d48c01dd14b7808496534d683e1f8d9a9f710b80925b582a6a |
| scripts/sync-alpha.test.mjs | eb385b7a0f4a069b2fe7246d737e348c8dfb7f4bc5e4e294e6520c302afed90b |
| apps/sync-reference/conformance/manifest.v1.json | 2a7e4e0c1353767818dff2a5083036f0ececb991decedec090ff30ff9e9e6abf |
| apps/sync-reference/conformance/runner.test.mjs | d769ab2a8ee1c6a7c2c89d5d51b35adee677ba87d6a364558833b8d88eeb27ee |

## Bounded assessment

The import audit now uses Node's `isBuiltin` predicate, recognizing scheme-only builtins such as `node:test` while leaving unknown `node:*` names to the failing dependency resolver.

The embedded README fallback requires the same package's explicit `MIT` declaration, a Markdown license heading, a copyright statement, and complete standard grant, inclusion condition, warranty and liability paragraphs. It retains the whole original README bytes and records the source kind, rationale and hash. Notice-only files do not satisfy the primary-license requirement. The exact `ThirdPartyNoticeText.txt` filename is included. The existing same-version esbuild project-license exception remains explicit; this delta adds no other cross-package borrowing.

The two new focused cases cover complete README retention and rejection of partial/undeclared/non-MIT/no-heading/no-copyright/missing-clause text. The conformance manifest and parser fixture require both names, bringing the packaging case inventory to 12. No legal compatibility conclusion is made.

## Provided evidence read; not re-executed by reviewer

- `/tmp/musu42-packaging-focused-v5.log`: 12 passed, zero failures/skips/todos.
- `/tmp/musu42-license-parser-v1.log`: 11 passed, zero failures/skips/todos.
- `/tmp/musu42-import-audit-4c32-diagnostic-v2.json`: read-only actual installed import audit, including scheme-only builtin positives and unknown-builtin rejection; not a full build.
- `/tmp/musu42-license-discovery-4c32-v2.json`: 70 package entries, 34 unique packages and 21 collected text hashes; whole pg-types and pgpass README sources and TypeScript's notice recorded. Receipt identifies the older failed 4c32 candidate, `sourceFilesUnchanged: true`, and `fullBuild: false`.
- `/tmp/musu42-exact-consumer-preflight-4c32-v1.json`: three exact installed consumer/import/typecheck/CLI ports passed on the unchanged older failed candidate, with owned temporary directory removed. Receipt explicitly sets `fullBuild: false` and `artifactAcceptance: false`.

The fresh full artifact, source conformance, host compatibility, application/browser evidence and CI results for this exact new HEAD remain separate acceptance work. This review did not execute tests, collectors, servers, browsers, database operations, Docker, or network operations and changed no repository files.
