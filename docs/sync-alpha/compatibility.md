# Compatibility and recovery

Operation compatibility follows the normative
[v1 envelope](../protocol/sync-operation-v1.md) and
[sync profile](../protocol/sync-profile-v1.md). The schema/profile/serializer IDs
and exact serializer versions are separate from the candidate artifact identity.
Retries use the original accepted projection and pinned native plan. They do not
re-encode retained intents with a newer mapper.

A present malformed or unknown envelope/profile/serializer holds before
credentials or HTTP. It must not select a legacy fallback, clear uncertainty,
grant a new send permission or block unrelated eligible work. A missing envelope
is the explicit retained-v0 host profile, not an invitation to rewrite old rows.
Adding a codec name alone does not establish endpoint, authority or retry support.

The reference migrations are forward and repeatable. Populated upgrade fixtures
preserve table identities, payloads, native identities, captures and history.
This is forward-upgrade evidence. It does not prove that an older binary can
read or safely execute a newer ledger. Keep the original database and credential
key, retain pending rows, and use a compatible reader to inspect holds.

Claims, current source/connection/privacy generations, lease ownership and
post-lock cancellation checks remain host authority. Candidate metadata and a
provider readback cannot manufacture an ACK. Native acceptance, remote
confirmation, canonical commit and notification outcome remain separate facts.
An accepted response followed by a failed readback or cooldown write retains its
acceptance/address evidence and uncertainty; a retry must not erase those facts.

The Musubi host retains its singleton boundary. C09 is not a distributed-worker
or mixed-version deployment guarantee. Background recovery disabled is a
scheduling choice, not a universal write kill switch: authorized direct request
wakeups can still execute. Provider budgets are local operator limits rather
than discovered official quotas; no tenant is inferred when none is verified.

The C08 Google RSVP possible-send barrier is private retained-v0 host metadata.
Pre-barrier binaries do not inspect it and can resend a notification-producing
mutation. The minimum barrier-aware host source is the C08 implementation
published by PR #387 (`e75d5c7`); portable reference profiles do not support RSVP.
Do not claim unrestricted binary rollback or mixed-worker safety for marked
intents. No safe old-image execution path is certified by this candidate. A
downgrade needs a separately tested policy that prevents affected writes and
preserves all pending markers; never clear a marker to permit a downgrade.

Production activation remains a later joint deployment step. Record the actual
deployed image, schema, flags, drain/restart procedure and live checks separately
from source review, local fixtures and successful PR CI.
