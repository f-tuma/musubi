# Independent sync reference host

C05 / MUSU-37 runs the bounded Google personal event UPDATE profile with its own
PostgreSQL ledger. It uses the C04 native provider ports and the published v1
schema/plan validator, with no dependency on Musubi DB, auth, app config or API.
Its content model is `ReferenceContent`, not a Musubi Event or Task.

This is an extraction fixture and CLI. It is not the future Calendar Relay
service. It has no account onboarding, OAuth refresh, scheduler, public API,
meeting/recurrence/task support, CREATE or DELETE. Only `name`, `notes` and
`place` can be changed on an existing personal nonrecurring timed event. The
accepted time endpoints use canonical UTC instants and remain unchanged.

## Configuration and commands

The executable reads only `REFERENCE_DATABASE_URL` and
`REFERENCE_CREDENTIAL_KEY` (64 hexadecimal characters). Use its own database;
`migrate` applies only the five reference tables, never Musubi migrations.
The key protects stored access tokens with AES-256-GCM and connection identity
as authenticated data. Changing the key requires an explicit credential migration.
Credentials are never written into operation envelopes or delivery receipts.

Run from the workspace with `pnpm --filter @musubi/sync-reference start <command>`
or build `docker build -f apps/sync-reference/Dockerfile -t sync-reference .`.
The image command is, for example, `docker run --rm --env-file <reference-env>
sync-reference migrate`. Commands other than `migrate` read one JSON object from
stdin, bounded to eight million bytes. Provide credentials through a private
input stream to `seed`, rather than shell arguments. Output is JSON, with bounded
HTTP outcome metrics on stderr during delivery. Invalid commands and interrupted
stdin return a safe error code.

| Command | JSON input | Meaning |
| --- | --- | --- |
| `migrate` | none | Install the standalone schema |
| `seed` | `ReferenceSeed` | Create a new connection/object/binding with an exact known native calendar/event ID, strong ETag, baseline, scoped token and expiry |
| `admit` | `{bindingId, expectedRevision, commandId, operationId, patch}` | Atomically commit canonical CAS and immutable accepted operation |
| `deliver` | `{operationId}` | Claim and run one bounded attempt |
| `show` | `{operationId}` | Inspect operation, capture, receipt and binding without credentials |

`seed` is an explicit fixture/bootstrap input, not provider discovery or proof
that an arbitrary baseline is current. Delivery performs fresh native preflight
and exact readback. Use physical calendar IDs, never Google's `primary` alias.
Expired or refused credentials remain HOLD; this host does not refresh them.
Use opaque IDs of at most 2,048 characters. Content and native plans are subject
to the v1 strict JSON bounds. See [model.ts](src/model.ts) for seed/content shapes.

## Durable behavior

Admission records the accepted projection and sparse native plan once, together
with connection/source/privacy generations and canonical revision. SQL prevents
later changes to operation identity, payload or captured metadata. A command ID
is idempotent only for the same input fingerprint. One unacknowledged operation
per binding is a causal barrier; conflict resolution is outside this fixture.

The database owns the 120-second lease. Each delivery has a 45-second deadline
and a 20-second heartbeat. Credentials and authority are checked before dispatch;
possible dispatch is persisted before PATCH. ACK updates the ETag/baseline and
operation atomically under the current attempt and all authority fences. HTTP
never runs inside a database transaction.

After possible dispatch, recovery begins with exact GET. A full accepted target
and strong ETag can confirm the binding without another PATCH. Otherwise only an
unchanged original ETag permits another fresh preflight and conditional PATCH;
a changed validator or incomplete observation cannot authorize a resend.
Successful PATCH is followed by an exact GET before ACK. This extra confirmation
is an intentional difference from the current Musubi success path.

Receipts keep local commit, native provider acceptance, remote confirmation and
notification outcome separate. Lost reply plus matching readback remains
`provider=uncertain`, `remote=confirmed`. A prior rejected 429 can likewise be
ACKed by a later exact target match, with `provider=rejected` preserved, only in
a recorded recovery attempt after possible dispatch. ACK means the accepted
binding target is confirmed; it does not fabricate native HTTP acceptance.
412 stays terminal conflict, 429 honors Retry-After, and 401/403 require reconnect.
Unknown, malformed and legacy payloads are immutable HOLD before HTTP.

## Verification

`pnpm --filter @musubi/sync-reference test` runs pure admission and injected-port
runner fixtures. `pnpm --filter @musubi/sync-reference run test:db` uses an
explicit disposable `REFERENCE_DATABASE_URL`. In CI only, `ENVIRONMENT=test`
plus `DATABASE_URL` permits the test bootstrap to create and drop a nonce-owned
independent database; the runtime CLI does not accept those aliases.

The process corpus kills real child processes, including inside admission before
COMMIT, then restarts from the same database. It covers lost reply, exact readback
failures, connection/source/privacy ABA, lease takeover and unknown payloads.
Provider metrics count requests whose dispatch reaches the telemetry boundary.
They are not a durable exactly-once audit across a process kill inside HTTP.

[Milestone evidence and next gate](../../docs/planning/MUSU-37-independent-host.md)
