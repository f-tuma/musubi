# Core activation in 0.2.0

> **Historical activation decision; annotated 2026-10-05.** This records the
> owner's selected rollout on 2026-09-14 and the acceptance available then. It
> is not the current capability backlog or proof of private production settings.
> See the [maintained v0.2.2 capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx)
> ([published page](https://musubi.pro/docs/operations/capabilities/)) for later
> Outlook content, occurrence/series time, all-day, global-zone, selected-move,
> cancellation and finite-series RSVP implementations and their exact evidence.
> Those later paths supersede the earlier broad unsupported notes below; no new
> runtime gate activation is implied. Public production health reporting 0.2.2
> does not establish the values in this historical selection table.

Owner decision: 2026-09-14. The coordinated Core and UI release is **0.2.0**.
The unpublished 0.1.8 candidate is superseded, without an intermediate tag.
Historical 0.1.8 QA records retain their original identifiers; they are evidence
for tested paths, not final 0.2.0 release-build acceptance.

## Selected configuration

Use `ops/release/core-0.2.0.env.example` as the explicit candidate API settings.
The standard `.env.example` and runtime defaults remain off, so upgrades do not
silently opt every installation into new provider writes. Existing `.env` false
values must be deliberately replaced when activating; the example file is not
automatically loaded by Compose or the API.

| Setting | Selected | Scope |
| --- | --- | --- |
| EVENT_TIME_EDITS_ENABLED | true | Explicit local time create/copy/edit and supported provider time operations/import |
| PROVIDER_ORGANIZER_EDITS_ENABLED | true | Supported Google organizer operations and Microsoft one-off create |
| CALDAV_ORGANIZER_EDITS_ENABLED | true | Strictly proven CalDAV one-off organizer operations |
| ICLOUD_ORGANIZER_CREATE_ENABLED | true | Read-only confirmation of iCloud-created meetings; no update/delete/reschedule fallback |
| PROVIDER_RSVP_EDITS_ENABLED | true | Supported Google, Microsoft and CalDAV attendee replies |
| ICLOUD_RSVP_EDITS_ENABLED | false | Deferred pending a native iCloud attendee invitation and end-to-end reply verification |
| ICLOUD_PERSONAL_CONTENT_WRITES_ENABLED | true | Narrow personal iCloud master-content writes; requires explicit time |
| PROVIDER_REMINDER_EDITS_ENABLED | false | Excluded from this activation |
| CALDAV_ALARM_EDITS_ENABLED | false | Excluded from this activation |
| GOOGLE_AVAILABILITY_ENABLED | false | Excluded from this activation |

A true flag permits capability evaluation, not every operation on every account.
Missing native identity/permission proof and unsupported recurrence, organizer
or attendee forms still refuse before a write. In particular, the iCloud
personal-content fallback does not authorize meeting changes, and the attendee
compatibility path does not authorize organizer operations.

The owner deferred iCloud attendee compatibility on 2026-09-14. Google and
Microsoft QA invitations reached iCloud Mail (initially Junk), but neither
appeared in iCloud Calendar or its CalDAV scheduling inbox. Email delivery is
confirmed; it does not establish a supported native attendee RSVP flow. Keep
this separate flag off until a suitable invitation and reply are verified.
The selected organizer and personal-content paths remain unchanged.

## Compatibility and rollout

- Build API, web and native from the same accepted release revision. Replace
  preliminary development builds labelled 0.1.8: they are below the enforced
  0.2.0 compatibility floor.
- Product must satisfy enforced client and peer floors; both floors must be at
  least 0.2.0. Missing, malformed and older callers continue to receive 426.
  Compatible connected servers must be available before activation.
- Preserve the version gate and time-preserving create/fork path. Do not bypass
  it with legacy copy payloads. A fork resolves source ID/revision on the server
  and preserves exact stored time metadata, including ambiguous DST instants.
- Before production migration/activation, create and verify a database backup,
  record current image versions, apply migrations, and verify health/identity,
  client compatibility and provider queue/receipt state. Rollback after known
  time writes requires the matching backup or a compatible application build;
  disabling a flag does not undo stored metadata or external invitations.
- This change prepares activation; it does not publish a tag, deploy a server
  or send invitations. Production activation follows the acceptance below.

## Acceptance matrix

| Path | Existing evidence | Remaining activation check |
| --- | --- | --- |
| Local explicit time | Shared time/DST, create/fork, revision conflict, API/DB and web/native regressions | Final release builds: create/edit/copy timed and all-day, DST ambiguity, conflict preserves draft, reconnect/restart |
| Google organizer / RSVP | Live one-off and stored zoned/all-day occurrence operations through Musubi; second-account checks | Final native flow and guest-visible invite/update/cancel/response delivery |
| Microsoft organizer / RSVP | Live one-off create, Accept/Tentative and read-only recovery | Decline delivery and final native flow; organizer update/delete and recurring replies remain unsupported |
| iCloud personal content | Live zoned/floating/all-day personal-series content writes with exceptions preserved | Current web/native editor path; time/recurrence/shared-calendar expansion is not included |
| iCloud attendee | Local HTTP/DB contracts; Google and Microsoft invitation email delivery verified | Deferred and disabled; native iCloud invitation, Musubi reply/readback and recipient-side proof remain required before enabling |
| CalDAV organizer | Live iCloud create/readback and recipient copy imported into Outlook | Final native flow and supported operation acceptance; no relaxed update/delete/reschedule fallback |

Historical live evidence and exact exclusions remain in
[remaining Core work](../audits/calendar-core-remaining-work.md). A Google test
is not an iCloud test; a completed local receipt alone is not proof of guest
notification. Imported `SCHEDULE-AGENT=CLIENT` email invitations remain outside
scope under the owner's earlier decision.

Physical native acceptance still needs a real device; an emulator is useful for
UI and transport testing but does not establish OS notification delivery.
Provider reminder writes and Google availability are intentionally excluded and
do not add new acceptance requirements to this selected activation.
