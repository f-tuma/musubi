# Standalone sync alpha candidate

This is a private, reviewable technical candidate for the extracted sync core
and independent reference host. It does not publish a registry package or deploy
a service. Candidate acceptance and source publication have separate receipts.

The supported artifact is Node.js 22 on the tested Linux platform, ESM TypeScript
source executed by the exact resolved `tsx` in its frozen production closure.
The workspace packages remain private. Plain Node JavaScript, browser, Deno,
Bun, arbitrary npm consumers and a public semver support window are outside this
candidate contract. The candidate report records actual Node/tsx versions,
source commit/tree, archive/image digests and installed file/dependency manifests.
The current candidate builder uses host Node 22, not a container base image;
its manifest records that fact separately from the convenience Docker images.

The independent host uses its own PostgreSQL ledger and encrypted credential
store. Its runtime configuration is `REFERENCE_DATABASE_URL`,
`REFERENCE_CREDENTIAL_KEY` and optional `REFERENCE_ALLOW_PRIVATE_NETWORK`.
It imports no Musubi database, authentication, session or app configuration.
Use a separate database and a private input stream for credential bootstrap.
Its CLI is an explicit bootstrap/admission/delivery fixture, with no account
onboarding, token refresh, public API or general pull/import implementation.

See [supported profiles](supported-profiles.md),
[compatibility and recovery](compatibility.md),
[provenance](provenance.md) and
[security and support proposals](security-and-support.md).
The checked-in conformance manifest is the executable inventory. Its deterministic,
independent PostgreSQL/process and pure Musubi host lanes have distinct requirements
and evidence. The separate [host database gate](host-database.md) covers actual
coverage/echo/home storage. Those tests do not turn the CLI into a pull engine.

The candidate tooling freezes tracked source, performs a frozen isolated
production deployment, inventories the actual closure and includes original
license material. Its verifier must exercise imports and CLI from outside the
checkout, with an empty home/cwd and no source bind mounts or Musubi settings.
PostgreSQL tests use explicit disposable resources and sanitized loopback HTTP
fixtures. A report with missing or skipped required cases cannot pass.

Public naming/distribution/version, license review, vulnerability contact and
maintenance commitments remain concrete owner decisions in the review packet.
Technical readiness does not imply live-provider or production certification.

For the edit loop, start with one production-kernel scenario:

```sh
pnpm test:behavior --suite google-update --scenario fresh-reference-title-update --json
```

Whole conformance and packaging require clean committed source. From the
repository root, choose a new output/report path on each run:

```sh
pnpm test:sync-conformance --mode deterministic --json --report /tmp/alpha-source-deterministic.json
node scripts/package-sync-alpha.mjs --ref "$(git rev-parse HEAD)" --output /tmp/alpha-candidate
node /tmp/alpha-candidate/candidate/scripts/verify-sync-alpha.mjs --candidate /tmp/alpha-candidate/candidate --mode deterministic --report /tmp/alpha-installed-deterministic.json
ENVIRONMENT=test REFERENCE_DATABASE_URL="$SYNC_ALPHA_OWN_ADMIN_URL" REFERENCE_CREDENTIAL_KEY="$SYNC_ALPHA_OWN_KEY" node /tmp/alpha-candidate/candidate/scripts/verify-sync-alpha.mjs --candidate /tmp/alpha-candidate/candidate --mode reference-db --report /tmp/alpha-installed-reference-db.json
```

The last command needs an explicitly disposable PostgreSQL 17 service with
CREATEDB capability and a synthetic 64-hex key; it does not use `DATABASE_URL`
or Musubi application settings. The dedicated allocation-crash/descendant
cleanup probe is `pnpm test:sync-alpha:cleanup-db` with those same test variables.
The pure `host-compat` lane and actual host DB gate remain separate full-checkout
commands. No archive or registry publication is part of these commands.
