# Intermittent CalDAV discovery failure: 6 October 2026

## Read-only production observations

A bounded Loki query through Grafana inspected the production Musubi API's
account-sync events. Only GET requests were used. No deployment, database
mutation, restart, provider write or `.env` access was performed. Tokens,
user/account identifiers, resource URLs and raw log bodies are omitted.

The public status endpoint reports version `0.2.2`. Dokploy's container metadata
reports running, healthy API and web containers using `frgtndev/musubi:latest`
and `frgtndev/musubi-web:latest`. These mutable tags and the product version do
not identify an immutable image digest or an exact deployed Git revision.

The query found six structured CalDAV failures after the v0.2.2 deployment,
across two accounts. Each had `discovery-response-resource`, `readKind=home`,
`responseCount=1` and `hrefRelation=different-path`. The latest matching failure
was 6 October at 07:54:54 CEST. Both affected accounts also had successful
sync-account events at approximately 16:34 CEST that day. Successful runs do
not prove that the intermittent defect is resolved.

The log query is bounded to three days and 500 records. The observations are
evidence of these specific events, not an exhaustive account-health inventory.
The current diagnostic deliberately excludes the server's XML and the two
resource URLs, so it does not establish the provider or exact mismatch shape.

## Local diagnostic work

The strict parser rejects the same failure category for a synthetic response
using an iCloud-shaped account principal request and a generic principal response.
The upstream [python-caldav source](https://github.com/python-caldav/caldav/blob/master/caldav/davobject.py)
documents that response shape as an iCloud interoperability issue. This is a
candidate explanation, not a captured fixture from the affected accounts.

New diagnostic fields report fixed provider/resource categories and an optional
account-segment-match boolean. Regression checks cover private-value omission,
spoofed/nonstandard iCloud origins and unchanged refusal of unproven responses.
The complete namespace/status/href checks and discovery-failure latch stay intact.

A temporary, bounded live probe accepts hidden terminal credentials and reads
only service/Depth 0 discovery. It saves a sanitized structural report, not XML
or credentials. Its synthetic self-check confirms the expected mismatch and
private-value omission. A live affected-account report has not yet been captured.

Validation passed the complete API unit-test script and the API TypeScript
check used by the repository (`--noEmit --skipLibCheck`). The isolated discovery,
property parser, SSRF and scheduling fixtures passed with synthetic configuration
and dotenv loading disabled. These checks establish diagnostic behavior and
continued rejection; they do not establish live-provider recovery.

## Remaining work

MUSU-4 remains open. Before changing identity acceptance, capture the relevant
response shape and prove the recovery against an authorized iCloud account and
a controlled CalDAV server. A shape or account-segment match alone cannot
authorize another principal, an authoritative empty collection listing, removal
of existing sources or provider writes. A production diagnostic rollout is a
separate action requiring the owner's approval.
