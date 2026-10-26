# Storage-free sync runtime

`fair-work.ts` selects work for one process-wide bounded pool. It limits each
account to one active job, rotates account/lane/family choices, gives recovery a
bounded preference, and supports explicit inherited child permits. The host
still owns actual claims, source authority, predecessor/family fences, durable
generations and settlement. Candidate SQL must expose fair scopes before LIMIT.
Budget waiting parks the same native continuation and releases the worker,
account and advisory collision holds, then reacquires fairly. There are at most
`capacity` regular logical jobs and `capacity` auxiliary logical jobs; auxiliary
headroom remains available for refresh dependencies. New regular overload is an
explicit typed deferral. One regular account cannot fill the parked set or the
bounded pending queue. Only one child can borrow a parent permit at a time.

`provider-budget.ts` accepts private host-issued physical-account scope keys and
explicit operator limits. Unknown tenant identity supplies no tenant scope.
Buckets start empty; stable physical-row account keys retain cooldown across
credential changes. Mutation reservations additionally bind the full authorization
incarnation, operation, attempt, method and target. Durable cooldown hydration
and extension use host ports. Failed persistence returns the actual HTTP response,
closes dispatch health, and retries through an out-of-pool timer.
Malformed external Retry-After is unusable provider data, not a global storage
fault. Unsupported syntactically valid delays hold only the known physical
account unavailable over the supported timestamp domain; no earlier certified
retry is claimed. Unknown preconnection identity never creates a guessed tenant.

The API gives shared OAuth refresh an independent 30-second deadline including
queue time, combines coordinator shutdown, and releases every waiting parent
permit. Waiter cancellation does not cancel a sibling's refresh. The API retains
a continuation for a single budget wait of at most 15 seconds; a longer wait
returns the original deferral and exact due time for durable settlement. This
releases logical slots under long server cooldowns. Its operator parser requires
local refill of at least one token per 15 seconds. The generic runtime imposes
no host-specific minimum. Managed pulls bound periods without progress rather
than total paging duration; write deadlines remain unchanged.

Native providers declare the structural optional `http.dispatch` decorator
without importing this package. Shared kernels forward it through
`guardHttpDispatch`. Native raw callbacks are one-shot and attempt/signal guarded;
admission runs before the raw timer. Each actual send produces one metric and
each DAV redirect hop has its own guarded span. Body parsing, admission and
cooldown SQL are excluded from provider HTTP duration.

C09 intentionally refines one historical telemetry detail: if raw fetch returns
HTTP 204 and cancellation is detected afterward, the HTTP metric retains 204.
The operation still rejects cancellation under its existing policy. Transport
rejection during an aborted raw request is still labelled `aborted`. This is a
new explicit raw-span contract; C08 historical metric parity is not claimed for
that post-header race. Native acceptance, observation and host ACK remain
separate facts.

Run `pnpm test:behavior --suite fair-work --scenario account-a-429-b-ready --json`
first, then the full `fair-work` suite. These scenarios invoke the production
coordinator/budget, actual provider transports and the existing Task CREATE
kernel while replacing host persistence/clock/HTTP ports. They do not prove SQL,
live quota behavior, authentication, application wiring or deployment.
