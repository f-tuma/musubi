# Populated Graph read upgrade witness

[`populated-upgrade.json`](./populated-upgrade.json) records a real same-database upgrade from baseline commit `be267b2a960c768c60bd0f91de1106f8878e7999` to migration `0085_graph_read_coverage`. This is implementation and migration evidence from an isolated PostgreSQL container and a localhost Graph fixture. It does not attest publication, production deployment or live-provider behavior.

The database first receives the baseline checkout's actual runtime migrations `0000`–`0084`. The historical schema has no source/checkpoint/configuration/coverage metadata and no account read generation. Only then does the fixture insert two source calendars, one Microsoft connection, two source-origin canonical events, owner/viewer memberships, a local shared calendar, one Google destination, four native bindings, six event links and four durable accepted update intents. Both Microsoft intents are unconfirmed and uncertain with an attempt already recorded; both Google intents are pending. The sources have different old cursor shapes: a plain delta URL and a v1 JSON cursor. Their permission revisions are seven.

The fixture captures complete historical rows and payloads before calling the current runtime migrator on that same populated database. It verifies every pre-existing column, timestamp, UUID, binding and outbox payload is unchanged. New source/checkpoint generations default to zero, read configuration/coverage default to null, and account read generation defaults to zero. Old and current range/delta readers return identical wire rows. The migration journal grows from 85 entries to 86.

The first actual current `microsoftAdapter` + `syncProvider` read starts fresh bounded windows. The old events are before each lower bound and the completed views are empty. Separate tagged native-fixture GET probes still return both events. Canonical rows, mapping identities, local links, memberships, accepted pending/unconfirmed payloads and retained address tombstones remain exactly unchanged; no deletion intent appears. The source metadata advances to generation one/checkpoint revision two and a v2 cursor, while the permission revisions remain seven. Range and delta reads still expose the historical shared events with identical wire contents.

The machine witness retains the complete pre-migration rows once and stores matching SHA-256 pairs for migration column parity, retained tables and wire reads. Both fixture users and their event/outbox rows are verified removed before the evidence file is written. Provider requests are classified as engine reads or explicit native-fixture probes; every request is GET, and zero outbox delivery executions occur.

To rerun, use a fresh database named exactly `musubi_c03_upgrade` in a disposable localhost PostgreSQL instance. Do not reuse a database whose new migration has already run. Create an isolated checkout at the pinned baseline and install its frozen dependencies. Run the following from that baseline checkout, substituting only the disposable port/credentials:

```sh
DATABASE_URL=postgres://postgres:fixture@127.0.0.1:32849/musubi_c03_upgrade ENVIRONMENT=test BETTER_AUTH_URL=http://localhost:7531 node --import tsx packages/db/src/migrate.ts
```

Then run from the current checkout, passing the absolute baseline checkout path:

```sh
DATABASE_URL=postgres://postgres:fixture@127.0.0.1:32849/musubi_c03_upgrade ENVIRONMENT=test BETTER_AUTH_URL=http://localhost:7531 node --import tsx docs/planning/evidence/MUSU-34/populated-upgrade.fixture.ts /absolute/path/to/pinned/baseline/Musubi
```

[`populated-upgrade.fixture.ts`](./populated-upgrade.fixture.ts) guards `ENVIRONMENT=test`, localhost, the exact database name, the baseline commit and the absence of new columns before seeding. It prevents both checkouts' `.env` file loaders from running before importing application modules and supplies a fixture authentication secret. It uses a dedicated PostgreSQL client for the seed transaction and parameterized SQL naming only old-schema columns. All OAuth values and calendar contents are synthetic. `UPGRADE_EVIDENCE_PATH` can select another output file. This two-checkout witness is separate from routine single-version CI; the normal Graph coverage and source-read DB tests run in CI without a historical checkout.
