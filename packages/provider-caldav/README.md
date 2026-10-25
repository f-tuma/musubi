# CalDAV personal conditional DELETE

This private, storage-free package supplies native reads, fresh privilege and
organizer preflight, and one logical conditional DELETE invocation. Guarded
redirects can add HTTP hops preserving DELETE and If-Match. Hosts supply account
sessions, network policy, DNS lookup, pinned leaf fetch, clocks, telemetry and
the final authority/lease fence. No database, auth implementation, app config,
ambient fetch or ambient DNS resolver is imported.

The caller supplies the exact saved resource URL, calendar URL, provider UID and
accepted strong ETag. Native ICS bytes are read completely with fatal UTF-8
decoding, unique accepted-UID master selection and physical structure validation.
Raw parser/transport failures remain distinct from known native refusals in the
existing profile, preserving the host's retry classification.

| Fixed native profile | Boundary |
| --- | --- |
| `existing-caldav` | Preserve generic guarded redirects, accepted-UID master selection, additional native masters/overrides and orphan attendees; Musubi's admitted family gates remain host owned. |
| `strict-reference` | Direct child of the exact calendar URL, no redirects, one timed nonrecurring VEVENT without attendees; valid VTIMEZONE, VALARM and unknown properties remain untouched. |

The strict profile checks every component-tree branch: VEVENT contains only
VALARM, alarms have no children and require ACTION/TRIGGER, and VTIMEZONE has a
TZID and only childless STANDARD/DAYLIGHT observances with their core properties.
Nested events/tasks, misplaced components and scheduling METHOD are refused.
Unknown properties remain untouched. These stricter checks do not change the
existing generic Musubi profile.

Preflight requires fresh collection `all`, `write` or `unbind` evidence. An
ORGANIZER requires the current principal's address evidence; own organizer
meetings are unsupported and an unproven/shared organizer is unknown. Missing
ACL never grants DELETE. Existing iCloud content UPDATE compatibility remains
outside this provider.

Initial/recovery GET 404 is absence. Preflight GET 404 is an error; 410 is not
absence, and cancelled read evidence conflicts. Raw DELETE accepts only the
existing 200/201/204/404 statuses and never retries or reads internally. Its
native acceptance is independent of scoped absence and host ACK. Musubi may ACK
the provider response; reference requires a later exact 404. Conditional recovery
can only repeat the same saved URL/UID/accepted validator after fresh guards.

The shared transport preserves DNS checks and pinning on every hop, a five-hop
redirect limit, cross-origin Authorization stripping, and refusal to turn a
conditional mutation into GET success. `existing-caldav` does not claim an exact
final response URL across allowed aliases. Metrics count each actual leaf once
and include no resource, UID, account, credential or native content.

`network.allowPrivate` is explicit host policy; public-only is the normal host
default. Local fixtures do not certify live iCloud or arbitrary DAV servers.
The account generation is opaque: Musubi currently supplies its captured account
timestamp revision, which is not a new monotonic ABA guarantee.

Run native/port checks with `pnpm --filter @musubi/provider-caldav test` and the
actual codec/runtime JSON loop with `pnpm test:behavior --suite caldav-delete`.
