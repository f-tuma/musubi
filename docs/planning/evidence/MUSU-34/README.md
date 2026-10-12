# Graph window-reset regression evidence

The [pre-refactor JSON witness](../MUSU-34-pre-refactor.json) records successful execution against baseline commit `be267b2a960c768c60bd0f91de1106f8878e7999`. It is implementation evidence from a disposable PostgreSQL database and a synthetic provider. It contains no publication or production deployment claim.

The [historical fixture](./legacy-window-repro.fixture.ts) intentionally asserts the unsafe old behavior and guards that exact Git commit. It is stored outside the API TypeScript project. Copy it to `apps/api/src/sync/graph_baseline_reset_repro.fixture.ts` in an isolated checkout pinned to the baseline before running it; its relative imports refer to that checkout's adapters and engine. Install the frozen lockfile, and apply `packages/db/src/migrate.ts` to a disposable localhost database named `musubi_c03`. The fixture checks `ENVIRONMENT=test`, localhost and the database name before touching data. Its default evidence output is `/tmp/musubi-graph-baseline-reset-evidence.json`.

The actual baseline execution used:

```sh
DATABASE_URL=postgres://postgres:fixture@127.0.0.1:32849/musubi_c03 ENVIRONMENT=test BETTER_AUTH_URL=http://localhost:7531 node --import tsx apps/api/src/sync/graph_baseline_reset_repro.fixture.ts
```

The port and credentials are disposable fixture configuration. Substitute the port of the disposable database used for reproduction. Never use a production database for this witness.

The real `microsoftAdapter` and `syncProvider` run against a local synthetic Graph server. Every provider request is intercepted. Discovery explicitly grants `canEdit` and `canViewPrivateItems`. The Microsoft OAuth values are fixture strings. No delivery worker runs. A Google destination link and mapping are synthetic database setup sufficient to exercise fanout admission; they do not prove a deliverable Google grant.

At t0, the first provider window is t0 minus 180 days through t0 plus 730 days and imports an event at t0 plus one day. The next read advances `Date.now()` to t0 plus 641 days, leaving 89 days before the old future edge. The adapter renews the window. The native event still exists in the synthetic provider but is before the new lower edge, so the renewed view is empty. The source has an owner and a second viewer; the event also has a Google destination mapping.

The baseline changes canonical revision 1 to 2 and sets `deletedAt`, while retaining the two mapping identities, two calendar links and two memberships. It admits one pending Google `delete` intent with zero attempts, `uncertain=false` and no result reference. All four HTTP requests are Graph GET. No Google HTTP request or foreign provider DELETE was executed. This proves `fetchMicrosoftChanges(reset=true) → syncProvider → reconcileExternalChanges → sweepExternalEvents → deleteExternalEvent → appendInboundEventFanout`; it does not prove foreign deletion delivery.

The historical script removes its two fixture users and verifies their user, event and outbox rows are gone. It restores `Date.now()` and fetch during cleanup. Tombstone timestamps use `new Date()` and show execution wall-clock time even though `Date.now()` advances to exercise window renewal.

The current regression counterpart is [`graph_read_coverage.integration.test.ts`](../../../../apps/api/src/sync/graph_read_coverage.integration.test.ts). It asserts safe behavior through the real adapter and engine:

- Empty renewed windows and 410 replacement snapshots retain canonical identity, revision, mappings, native addresses, links, memberships and accepted pending/unconfirmed payloads.
- A known `@removed` whose exact native GET succeeds is applied as a present event even outside coverage. A moved exception retains its original slot and binding UUID; rendering does not regenerate that original slot.
- A synthetic native DELETE followed by two exact `ErrorItemNotFound` 404 reads surrounding a successful exact-calendar read may tombstone its source-origin home. Absence of a derived Graph copy only unlinks that copy, without globally deleting the home or admitting a foreign deletion.
- Discovery permission is checked again by that native calendar read. A lost `canViewPrivateItems` grant rejects the entire proof and leaves canonical state and checkpoint unchanged.
- Unknown `@removed` addresses produce no retained native tombstone.
- Failed later pages, malformed pages, partial responses and failed dependency hydration preserve rows and checkpoint.
- A fixture-scoped PostgreSQL trigger rejecting the second item proves the first applied observation, its fanout, bindings and checkpoint roll back together.

The fixture's native DELETE is an explicit localhost test-control endpoint that changes fake provider state. Sync itself performs only provider GETs. Admitted outbox intents remain undispatched, so read acceptance and provider delivery remain separate evidence.
