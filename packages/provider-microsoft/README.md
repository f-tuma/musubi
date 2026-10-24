# Microsoft personal event DELETE provider

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
