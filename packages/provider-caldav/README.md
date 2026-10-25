# CalDAV personal conditional event provider

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

## Personal timed CREATE

`createCaldavPersonalEventCreateProvider` validates the original canonical UUID,
its `musubi-UUID` UID, exact raw derived resource URL and saved full VCALENDAR
before opening credentials. Preflight reads collection `all`, `write` or `bind`
privileges; it performs no initial event or organizer discovery. One PUT retains
the saved bytes with `If-None-Match: *`. Only 200/201/204 is native acceptance;
strong ETags remain opaque, including `""`, and weak or malformed ETags become
null. A 412 is a known conflict, not automatic adoption authority.

Recovery reads the original planned resource with no-cache. Only recovery GET
404 permits fresh collection guards and the same conditional write. A 410,
partial response, wrong UID or incomplete parse never grants replay. The existing
profile retains full native bytes and delegates its CREATE normalization order
to the actual host, including normalization before cancelled-event refusal.
The strict reference profile refuses organizers without inventing principal
discovery and records PUT acceptance before exact strong readback. A readback
404 after PUT does not allow another PUT in that attempt.

The portable reference projector uses UTC or a unique resource-owned VTIMEZONE;
an explicit non-UTC TZID needs its resource definition even when an ambient alias
resolves to ICAL's UTC singleton. Floating or ambient registered zones are not
accepted as time evidence. Existing
Musubi normalization remains a host port. JSON cases that replace this port with
declared data report `projectionPort: "fixture"`; they do not claim to execute
Musubi's actual normalizer. Separate API integration checks establish that floor.

The raw native helper preserves optional collection slashes and derived resource
URLs exceeding 2048 characters. The existing v1 envelope still limits its native
resource identity to 2048 characters; its explicit JSON admission case holds
before credentials or network. No type-contract widening or fallback is implied.
Run this loop with `pnpm test:behavior --suite caldav-create`.
