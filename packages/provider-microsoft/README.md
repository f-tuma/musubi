# Microsoft personal event provider

This storage-free package implements one bounded Graph v1.0 personal timed,
non-recurring event DELETE transport. Hosts supply credentials, HTTP, clocks,
telemetry and the final authority fence. It imports no database, authentication
implementation or application configuration.

`readForDelete` retains complete native evidence at the exact calendar-scoped
address; only 404 means absence. `preflightDelete` requires the current OAuth
write grant, matching connected identity and owned writable calendar, exact
accepted native weak `@odata.etag`, and a complete personal event shape.

`delete` sends one normal DELETE with the native `If-Match` as best effort. Graph
DELETE is a guarded preflight with a read/write gap, not compare-and-swap. Its
204/404 result is acceptance only: the caller must record it independently and separately
verify exact 404 before acknowledging completion. This transport never retries,
permanently deletes, cancels a meeting or converts a failed verification into
permission to resend. An unresolved or ambiguous possible acceptance requires
observe-only recovery until verified absence or a fresh explicitly authorized
operation. Musubi preserves its existing retry after a conclusive not-written
rejection, such as HTTP 429, with Retry-After and fresh guards. The reference
host has a stricter monotonic one-shot marker, including known rejections.
Host storage determines durability: reference retains the acceptance status
across restart; Musubi's existing outbox conservatively resumes with uncertainty.

Run the injected-port tests with `pnpm --filter @musubi/provider-microsoft test`.

## Timed personal CREATE

`createMicrosoftPersonalEventCreateProvider(ports, { nativeProfile })` also accepts
the exact frozen `microsoft-personal-event@1` timed, nonrecurring CREATE body.
Its canonical operation UUID must equal `transactionId`; Graph assigns the event
ID. Each mutation opens a fresh attested session, verifies the refreshed write
grant, then invokes the host fence before one POST. Native 200/201/204 acceptance
requires a nonempty returned ID and retains any string ETag, including an empty
string. A lost response never triggers an internal retry.

The `existing-microsoft` profile preserves Musubi's original calendar `canEdit`
preflight, including its default-follow redirect and successful-status semantics.
Recovery consumes the complete original calendar-scoped listing with the UTC
Prefer header and bounded, same-path pagination. The selected native JSON reaches
the host's actual normalizer before content comparison. A missing marker, failed
page, duplicate candidate, cancelled event or recurring candidate cannot authorize
a second POST. `transactionId` correlation does not promise unlimited provider
deduplication or retention.

The `strict-reference` profile separately requires an owned writable calendar,
complete personal native flags and exact read response identity. This profile
requests the Graph body explicitly as text; the ETag remains a nullable response
annotation rather than an entity property in `$select`. The runtime records raw
POST acceptance before independent correlated readback and requires a
native weak or null readback validator before ACK. Neither profile claims CAS or
an exact POST response-URL guarantee. These injected-port tests do not prove live
Microsoft service behavior.
