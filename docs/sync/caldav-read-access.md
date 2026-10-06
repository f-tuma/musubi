# CalDAV collection read access

Collection discovery keeps DAV `read`, CalDAV `read-free-busy`, and write
privileges separate. A write privilege loss does not retire readable details.
Only an explicit successful `current-user-privilege-set` for the exact requested
href proves that `read` is absent. Failed/missing propstats, ambiguous XML,
wrong namespaces, partial responses and incomplete discovery remain unknown;
they cannot authorize removal or restoration from cached private content.

The guarded client validates complete collection discovery, listings, sync
responses and each requested multiget href before tsdav filters convenience
results. Complete discovery can remove an absent source. This does not prove
that every child resource has the same ACL as its collection.

The existing source access role stores a namespaced tri-state read/free-busy
observation, independently of Musubi's write-role projection. Its generation
advances on changed evidence. Confirmed collection read loss retires imported
VEVENT families and mapped VTODO fields before any further native read. Event
identity, recurrence/time, task status/SEQUENCE and privately saved event intents
remain intact. Local tasks without a provider mapping are retained. Source
removal also retires linked event tombstones before the source is deleted.

All imported writes, family replacements, deletions, sweeps and cursor commits
check the captured source identity/generation and current membership/account.
A late response across loss/regain cannot restore content. A later complete
resource read may restore the content actually returned, including with the
same ETag. Unknown collection privilege evidence alone never restores content;
a fresh complete authorized resource response is required. This differs from
Graph's private-item capability, which distinguishes detail within one resource.
No Google personal-read recovery exception is reused.

Public delivery titles and queued event-change notifications check current
CalDAV account/source/membership and retirement state. A regained collection
role alone cannot reveal a retained title. Native write permission continues to
require each writer's existing resource proof and strict CAS; collection read
or write discovery does not grant iCloud child-resource write permission.

## Tasks and client compatibility

Migration 0076 adds nullable `tasks.provider_read_retired_generation`. It is a
monotonic server-owned counter, separate from native `SEQUENCE`. It survives
fresh imports so an editor can observe a retirement even if it missed the
intermediate placeholder. Create/update input never controls that counter.

A task update carries `expectedProviderReadRetiredGeneration` as an admission
precondition. A missing value means zero for existing clients: never-retired
rows remain compatible, while an older client cannot submit a stale full DTO
after retirement. Such a request gets a conflict and must refresh using an
updated client. The counter is not a general task version/CAS feature.

Immediate task delivery checks the captured source, retirement counter and
local sequence before native mutation, again after preparatory native reads,
and atomically with mapping acknowledgement. A late ACK cannot reinstate the
retired ETag. This does not introduce a task outbox or claim remote confirmation
for an uncertain task write.

Web tasks refresh on external sync, collection changes and reconnect. Open
editors clear copied fields on confirmed retirement/removal while retaining
explicitly authored fields, including clears. Event compact/full/generated
editors and native event state use the existing numeric retirement provenance.
An offline or older client cannot erase data it already independently retained;
there is no remote deletion guarantee for exported copies. Native has no task
editor in the current client, so this work adds no native task UI.

Fake HTTP, disposable DB, mounted client and browser cases cover these local
contracts. Live CalDAV/iCloud ACL variations, account consent and physical-device
acceptance remain human validation; no writer flags or release versions change.

Protocol basis: [RFC 3744 §5.4](https://www.rfc-editor.org/rfc/rfc3744.html#section-5.4)
and [RFC 4791 §6.1.1](https://www.rfc-editor.org/rfc/rfc4791.html#section-6.1.1).

Discovery authority includes the exact successful principal and calendar-home property chain. A failed chain is latched for the client lifetime so convenience-client root fallback cannot authorize absence. Wrong-namespace privileges remain unknown. Task retirement follows the source mapping even when another local editor authored the task.

After retirement, delivery receipts project freshly authorized canonical titles rather than historical immutable outbox text. Queued CalDAV change notifications carry the captured event revision (the older snapshot revision for moves); historical or legacy payloads cannot become eligible merely because a fresh mapping restores access. Private saved intents remain unchanged.

Before passing validated XML to tsdav, the parser also rejects collisions under its namespace-stripping and hyphen/underscore camel-case projection, across propstats and within nested elements. A second namespace or spelling cannot overwrite the exact property whose authority was checked.

The convenience-client boundary requires an XML media type, rejects mixed text/element content and wrong-namespace fields consumed by discovery, and serializes validated XML with single concatenated text nodes, absolute hrefs and canonical status lines. This prevents CDATA/comment splitting, numeric identity coercion, relative-base disagreement, or missing status reason phrases from changing the validated meaning. Component attributes are preserved; malformed/partial evidence never proves absence.

Every calendar collection needs an explicit successful supported-component set with nonempty unqualified component names before discovery can be complete. The production adapter classification rejects unknown/empty component evidence; proven VTODO-only collections remain task sources and proven unsupported types can be excluded. Both strict parsing and canonical serialization retain whitespace-only text between CDATA segments.

The supported structural boundary is explicit:

| Field | Ordinary accepted form | Unknown/rejected form |
| --- | --- | --- |
| XML document | Declaration, comments, leading/trailing formatting whitespace | Additional roots or non-whitespace document text |
| Resource type | Empty structure or empty typed child markers | Scalar text, mixed content, nested/text-bearing markers |
| Calendar classification | Successful nonempty component set with unqualified names; VEVENT+VTODO or VTODO-only | Missing/failed set, nameless/qualified-name components |
| Native resource | Nonempty scalar ETag and calendar-data, including split text/CDATA | Nested fields, absent body/validator, ambiguous aliases |

`fetchCalendarObjects` returns calendar-data from the strict namespace-preserving parse, through a per-call async context, instead of tsdav's trimmed scalar. Leading/trailing CRLF and spaces are retained exactly; concurrent reads cannot share resource values. Production reads use validated multiget; alternate unvalidated query bodies are refused.

Complete property evidence requires exactly HTTP 200 within propstat, including scheduling proof; inner 206 is partial/unknown. Multiget resource reads reject redirects before following them, preventing a final response origin from rebinding the original path-only request identities.

The convenience projection rejects every non-200 successful propstat globally, including optional sync tokens and display metadata; it never forwards partial-success properties to tsdav. Ordinary failed optional properties (for example 404 sync-token) remain allowed and omitted by its projection.

Discovery resource mismatches include fixed diagnostic categories for the
provider and request/response resource shapes. An optional boolean says whether
the home target's numeric account segment matches the requested principal's
segment. No host, path, account identifier or XML is recorded. These fields
help distinguish an iCloud principal alias from another mismatch; they are
never identity or ACL evidence and do not relax any rejection. See the
[October 2026 diagnostic checkpoint](../audits/caldav-discovery-diagnostic-2026-10-06.md).
