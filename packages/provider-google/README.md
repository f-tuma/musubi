# Google personal event provider

This package implements one bounded transport profile: Google personal event
content UPDATE (`summary`, `description`, `location`) with a fresh ACL/organizer
preflight, exact conditional PATCH, and exact native event read evidence. The
caller supplies an already admitted sparse native body and serializer identity.
It does not serialize Musubi events, read storage, own OAuth refresh, acknowledge
an outbox, or implement independent-host durability.

`createGooglePersonalEventProvider` receives required account-session, HTTP,
clock, telemetry and authority-fence ports. Every session is compared with the
requested opaque connection incarnation. Write permission is checked after the
host's token refresh. The host fence runs after credentials immediately before
PATCH; it owns source, privacy, lease and lifecycle checks outside network calls.
The host continues to own canonical CAS, immutable admission and atomic mapping
ACK. The returned `written` evidence means native HTTP acceptance only.

The host must preflight the same immutable accepted operation before invoking
`update`; these are separate methods so the host can retain its authority and
lease workflow. Native ETag comparison fences intervening remote changes.

Requests use fixed Google Calendar origins, individually encoded calendar/event
IDs, caller cancellation, refused redirects, and an exact strong `If-Match`.
The preflight calendar response must match the requested concrete native calendar
ID. The `primary` alias is outside this profile; an identity mismatch is held.
A success body naming a different event is `provider-write-failed` with an
unconfirmed outcome and its validator is never adopted; the host can reconcile
through its GET-only recovery path. No mutation or event GET is automatically retried. Empty accepted bodies cause
no dispatch. 412 is a refusal; failed network responses, server errors and
unexpected successful status codes are uncertain. Accepted responses with an
unusable body retain a nullable validator; a subsequent GET cannot authorize a
new mutation using a changed version.

The bounded exact read requires a complete 200 response, matching native ID,
valid native content/endpoints and a strong validator before it can be returned
as present recovery evidence. This strengthens that bounded profile; the host's
explicit legacy routes retain their previous optional-validator semantics.
404/410 and cancellation are native observations, not global deletion proof.
No hidden guest list, guest-notifying copy or recurring family is admitted to
the personal UPDATE profile. Meeting, recurrence, time, task, CREATE and DELETE
operations remain separate routes.

Telemetry records each actual dispatch once with only provider, event family,
method, status and injected monotonic duration. It excludes resource/connection
identities, tokens, headers and content. A pre-aborted request is not dispatched
or counted. Telemetry failure cannot alter provider evidence. Retry-After HTTP
dates use the injected epoch clock. Runtime dependencies are package-local only;
the test checks this boundary and exercises a fake HTTP/account-session host.
This is a provider boundary, not the independent-host gate planned for C05.
