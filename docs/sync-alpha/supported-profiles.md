# Supported executable profiles

These ten bounded profiles run through the independent reference host. They are
experimental executable profiles, not a promise that every native capability or
server supports the same guarantees. Exact registrations, case IDs and evidence
lanes belong to the checked-in conformance manifest. Detailed native restrictions
remain in the provider packages and [reference host guide](../../apps/sync-reference/README.md).
The [machine-readable matrix](supported-matrix.v1.json) pins these ten rows,
their API/role/grant/retry boundaries and required deterministic/DB entries.
Validator descriptions state the profile's checks and emitted requests; live
conditional enforcement and notification delivery require separate evidence.

| Provider / native API | Operation | Reference role and object | Validator and recovery |
| --- | --- | --- | --- |
| Google Calendar v3 | Personal event UPDATE | Concrete writable calendar; personal nonrecurring timed event; name/notes/place only, original UTC endpoints | Original strong ETag, conditional PATCH, exact full-target readback; uncertain recovery cannot adopt a changed validator |
| Google Calendar v3 | Personal event DELETE | Exact concrete native address and eligible action-specific attendee/organizer rules | Strong original validator and conditional DELETE; scoped absence ACK, not a global tombstone |
| Google Calendar v3 | Personal event CREATE | New personal nonrecurring timed event, exact UTC endpoints and writable concrete calendar | Stable operation-derived native ID and owned marker; bounded exact-content adoption; conservative portable capability descriptor still refuses unsafe uncertain CREATE |
| Microsoft Graph v1.0 | Personal event DELETE | Owned writable calendar, exact Calendars.ReadWrite grant, eligible timed singleInstance | Original native weak ETag guarded preflight; not CAS; observe-only uncertain recovery |
| Microsoft Graph v1.0 | Personal event CREATE | Owned writable calendar, explicit create profile, eligible personal event | Persisted one-shot dispatch and transaction correlation; native-assigned ID adopted only with complete owned proof |
| CalDAV protocol profile | Personal VEVENT DELETE | Exact HTTPS collection/resource/UID and fresh required privileges; eligible personal resource | Strong original ETag and conditional deletion; complete scoped absence, no redirect-derived authority |
| CalDAV protocol profile | Personal VEVENT CREATE | Exact eligible HTTPS collection and fresh bind/write proof; one direct-child personal resource | Operation-derived URL/UID, If-None-Match creation, strong exact-resource readback and bounded owned adoption |
| Google Tasks v1 | Task UPDATE | Exact physical task list/task, explicit Tasks write grant; supported flat nonrecurring native fields | Original strong ETag and baseline, pinned target/field mask; rich canonical values retained independently |
| Google Tasks v1 | Task DELETE | Exact original list/task and captured lifecycle | Conditional original-address deletion or scoped absence ACK; no fabricated validator |
| Google Tasks v1 | Task CREATE | Explicit task profile/list grant, unaddressed admitted CREATE and provider-assigned task ID | Persist possible send and native-assigned address separately; full-target adoption; lost POST never grants blind repeat |

The queued Google Task causal-intent path is an extension of those task profiles,
not another native endpoint. It retains the predecessor's real ID/tag/baseline
and materializes richer canonical content only under the current host fences.
No task hierarchy, reorder, move or new recurring task write profile is implied.

No portable generic Microsoft or CalDAV event UPDATE is declared. VTODO,
Microsoft To Do, specialized RSVP/reminder/organizer/occurrence/series families,
Outlook move coordination and retained-v0 event/task lifecycle remain Musubi
HOSTCOMPAT profiles. Shared runner lifecycle does not turn them portable or
strengthen their native validators. Reference success/readback policy may differ
from the Musubi host's accepted-response completion policy.

| Evidence lane | What it establishes | What it leaves open |
| --- | --- | --- |
| Deterministic production-kernel corpus | Pinned projection, native requests, control/receipt decisions and bounded clock/port behavior | Real SQL, authentication, live quotas or provider availability |
| Independent reference PostgreSQL/process | Own ledger, leases/locks, crash/restart, forward migration, retirement, adoption and cross-account boundaries | General pull/import or Musubi host lifecycle |
| Musubi HOSTCOMPAT pure lifecycle | Existing host-only event/task runner decisions with explicit fake ports | Real host SQL, pull coverage or echo convergence |
| Separate Musubi host DB/native gate | Actual host coverage/deletion, echo, home authority and retained specialized behavior | Portable reference pull or new endpoint support |
| Clean installed candidate | Frozen actual production closure, external imports, own CLI/config and installed conformance | Unrun architectures or runtime families |
| Live provider/server | Not run for this candidate unless an exact dated receipt says otherwise | Google/Graph production certification, all DAV servers or iCloud |
| Deployed production | Not established by local or CI gates | Actual flags, credentials, rollout and end-user behavior |

Synthetic DAV fixtures identify a protocol profile. A named Radicale or other
server claim requires its exact tested version and separate receipt. Historical
provider research and host tests do not certify this candidate on a live server.

The `host-compat` conformance mode is the pure lifecycle lane. The separately
reproducible [host database gate](host-database.md) supplies actual SQL coverage,
echo and home-authority evidence; its results must not be attributed to the pure
mode or the standalone CLI.
