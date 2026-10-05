# Google OAuth Verification Tracker

This document tracks the public, non-sensitive work required to verify Musubi's Google OAuth integration.

For implementation and troubleshooting details, use the maintained
[Google provider guide](../packages/docs/src/content/docs/providers/google.mdx).
This file remains separate because it is a release/compliance checklist, not
general product documentation.

> Public repository rule: do not add credentials, tokens, private email addresses, unpublished infrastructure details, reviewer credentials, internal account IDs, security keys, or screenshots containing user data.

## Verification target

The v0.2.2 web connection flow requests three granular Calendar scopes and the
Tasks scope. The native flow requests the same Calendar scopes and defaults its
optional **Include tasks** setting to enabled. These provider-data scopes are
additional to the identity scopes used for sign-in:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist
https://www.googleapis.com/auth/calendar.calendars
https://www.googleapis.com/auth/tasks
```

When Google availability is enabled on the server, the connection also requests
`https://www.googleapis.com/auth/calendar.events.freebusy`. Include it in the
consent-screen, disclosure, justification and review-build audit when that
capability is enabled; do not describe the four-scope connection as the universal
grant set. Sign-in is a distinct identity flow.

Musubi synchronizes events, manages the user's own calendar resources and
calendar-list entries, and reads/writes Google Tasks lists. The Calendar scopes
avoid the broad `https://www.googleapis.com/auth/calendar`; Musubi does not request
sharing/ACL administration or account-settings access. Musubi sharing does not
change Google-native ACLs. Tasks project two states and a scheduled day, rather
than exact deadline time or all Musubi fields.

Google verification should only be submitted when the review build, public website, privacy policy, Play Store listing, scope justification, and demonstration video all describe the same implemented functionality.

## Current public status

- [x] Source-defined connection scopes match the three Calendar scopes, Tasks
  when included, and availability when enabled (`apps/web/src/calendar/connections.ts`
  and `apps/client/components/calendar/SyncCalendarModal.tsx`).
- [x] Task-list discovery, complete paginated task reads, task creation, updates
  and deletion are implemented in the Google adapter.
- [ ] Demonstrate the Tasks grant and a task round trip in the exact review build.
- [x] Musubi can list connected Google calendars.
- [x] Musubi supports two-way event synchronization.
- [x] Musubi can create, update, and delete events.
- [x] Users can disconnect a connected calendar account.
- [x] Users can delete their Musubi account in the application.
- [x] Musubi can create a Google calendar resource.
- [x] Musubi can update Google calendar properties (name and color only — not description or time zone).
- [x] Musubi can delete an owned secondary Google calendar.
- [x] Musubi can modify a supported `calendarList` setting (per-user calendar color).
- [x] The normal disconnect flow revokes the Google token before deleting local credentials.
- [x] Google OAuth refresh tokens have verified encryption at rest appropriate for long-lived credentials.

## Submission gate

Do not submit the OAuth verification request until all required P0 items are complete.

Checkbox legend: `[x]` done, `[ ]` not started, `[~]` partial (implemented in the backend but incomplete, or needs demo confirmation in the review build).

### P0 — Calendar and task client functionality

- [x] Create a secondary Google calendar from Musubi.
- [~] Edit an owned Google calendar — name and color are implemented; description and time zone are not.
- [~] Delete an owned secondary Google calendar — backend implemented; verify the destructive-action confirmation in the review build.
- [x] Implement at least one meaningful write operation for the user's Google calendar list (per-user calendar color).
- [~] Verify access-role presentation in the review build. Discovery records
  supported Google roles and separates free/busy-only sources; the `readOnly`
  compatibility flag is not the full authorization contract.
- [~] Verify disabled/denied actions for current read-only, private-event,
  organizer, revoked-source and task capabilities in the review build.
- [~] Clearly distinguish disconnecting an account, deleting a provider calendar
  and removing a Musubi membership. Recheck current `ConnectionsPanel` and
  `calendar-dialogs` flows: older confirmation evidence referenced deleted UI
  files, and the current web disconnect action has no confirmation step.
  Musubi does not expose Google calendar-list unsubscribe; that scope currently
  supports list reads and per-user color.
- [ ] Test calendar and event operations against owned, shared, and read-only calendars.
- [~] Automated checks cover authorization refresh/retry and expired sync cursors;
  confirm those outcomes in the review build and a live test account.
- [ ] Demonstrate Google Tasks list import and create/update/complete/delete.
- [ ] Explain date-only/two-status projection and which richer task fields stay in Musubi.
- [ ] Demonstrate that a Musubi live task link does not modify Google's ACLs.
- [ ] Verify that a missing Tasks grant preserves calendar sync and does not
  sweep task lists on incomplete discovery.

### Optional — Sharing and ACL management

These items are not required for the first submission unless they are used in the scope justification or shown as current product functionality.

- [ ] Display calendar access rules.
- [ ] Add a calendar member.
- [ ] Change a member's access role.
- [ ] Remove a member's access.
- [ ] Enforce ownership and permission checks for every ACL operation.

Do not mention ACL management as an implemented feature until all relevant controls are available in the review build.

### P0 — OAuth and Google Cloud configuration

- [ ] The application, OAuth consent screen, and verification request use the
  same implemented scopes, including Tasks and availability when enabled.
- [ ] The authorized domain is the verified top private domain used by the public Musubi website.
- [ ] The domain is verified in Google Search Console by an account with the required project permissions.
- [ ] OAuth branding uses the production Musubi name and logo.
- [ ] Homepage, Privacy Policy, Terms of Service, and support links are public and accessible without signing in.
- [ ] The application audience and publishing status are appropriate for external production users.
- [ ] The Android OAuth client matches the production package and Google Play App Signing certificate.
- [ ] Backend OAuth redirect URIs are exact, HTTPS-only, and production-safe.
- [ ] Google sign-in and Google Calendar authorization are clearly presented as separate flows.
- [ ] Unused development OAuth clients are removed from the production project.

### P0 — Security and data handling

- [x] Access and refresh tokens are never written to logs or returned in error responses.
- [x] Long-lived Google credentials are encrypted at rest using a documented, production-appropriate mechanism.
- [x] Disconnect attempts Google token revocation and always removes local credentials afterward.
- [x] Every server-side Google operation verifies ownership of the Musubi user, connected account, and calendar mapping. (`assertCan` role gate + `pushExternal` checks `link.userID === userID` and operates only on that mapping's accountID/externalCalendarID.)
- [~] Re-audit destructive confirmations in the review build. Do not reuse the
  removed CalendarSettingsModal evidence; current web account disconnect does
  not ask for confirmation.
- [ ] The Privacy Policy accurately describes stored calendar metadata, events,
  tasks, memberships, synchronization cursors, delivery receipts and OAuth credentials.
- [ ] Account deletion, retention, backup handling, and export statements match the actual implementation.

## Public website checklist

- [ ] The homepage describes the Google Calendar and Tasks integration.
- [ ] The homepage describes only features available in the current public or review build.
- [ ] Future calendar-management features are clearly marked as roadmap items until released.
- [ ] The Privacy Policy identifies the three granular Calendar scopes, Tasks,
  and availability when enabled, and explains each scope's purpose.
- [ ] The Privacy Policy distinguishes currently used functionality from technically possible but unreleased functionality.
- [ ] The Privacy Policy explains that Google Calendar and Tasks data are used
  only for user-requested calendar/task functionality.
- [ ] The public website consistently identifies Musubi and its operator.
- [ ] The Google Play listing describes the Calendar and Tasks integration
  available in the published build.
- [ ] A public account-deletion page explains both in-app deletion and the fallback request process.
- [ ] Repository links use the canonical `f-tuma/musubi` location.

## Homepage copy draft for the current feature boundary

This draft is not evidence that the public website or review disclosure has been
updated. Review it together with the actual client build before submission.

> Musubi can connect to one or more Google accounts and synchronize Google Calendar events and Google Tasks lists.
>
> With your permission, Musubi can display your calendars, events and tasks, manage your own Google calendars, and create, update or delete events and tasks. Your Musubi server processes synchronized data for use across devices and shared Musubi spaces. Google Tasks represents a scheduled day and two task states; richer task details remain in Musubi.
>
> Musubi sharing does not administer Google's sharing rules. Google calendar descriptions and time zones are not editable through the current calendar-management flow.
>
> You can disconnect a Google account at any time. Disconnecting removes its stored credentials and imported sources from Musubi; it does not delete the original Google account or its calendars and tasks.

## Privacy Policy scope-purpose draft

This is draft scope wording, not a complete approved Privacy Policy. Retention,
backup and account-deletion claims require a separate implementation review.

> Musubi requests `calendar.events` to read and write events, `calendar.calendarlist` to list calendars and update per-user color, `calendar.calendars` to manage your own calendars, and `tasks` to read and write task lists. Connections with availability enabled also request `calendar.events.freebusy` for availability-only reads. These Calendar scopes replace the broad `auth/calendar` permission.
>
> Musubi uses these permissions for calendar and task synchronization and user-requested writes. Native connections can omit Tasks consent. Existing grants must be reauthorized to add a scope; token refresh does not grant a new permission.
>
> Musubi uses Google Calendar and Tasks data for user-requested calendar and task functionality, not advertising, profiling or unrelated purposes.

## Final scope justification draft

Use this only after the corresponding Calendar and Tasks functionality,
disclosures and enabled availability scope have been demonstrated in the review
build. This file does not record a submitted or approved verification request.

> Musubi uses granular Google Calendar scopes and the Google Tasks scope for calendar and task synchronization:
>
> - `calendar.events` — Musubi reads events for two-way synchronization and creates, updates, and deletes events when the user acts in Musubi.
> - `calendar.calendarlist` — Musubi lists the user's calendars and writes per-user calendar-list properties such as color; read-only access is not sufficient because users recolor calendars from Musubi.
> - `calendar.calendars` — Musubi creates, renames, recolors, and deletes calendars the user owns.
> - `tasks` — Musubi discovers task lists, imports tasks and writes user-requested task creations, edits, completions and deletions.
> - `calendar.events.freebusy` — include this justification only for a review build with availability enabled; Musubi reads availability intervals without importing private event details from availability-only sources.
>
> Users can connect one or more Google accounts, manage supported calendar properties and work with events and tasks. Musubi respects current provider grants and source capabilities. A shared Musubi task retains one home calendar for editing and completion; secondary projections do not change Google's own ACLs. Musubi does not request the broad `https://www.googleapis.com/auth/calendar` scope or sharing/ACL administration and account-settings access.
>
> Writes are initiated through the Musubi interface or maintained by synchronization enabled through the connected account and task memberships. Google Calendar and Tasks data are not used for advertising, profiling or unrelated purposes.

## Demonstration video checklist

- [ ] Show the public Musubi homepage and Privacy Policy.
- [ ] Show the in-product disclosure before Google authorization.
- [ ] Record the complete Google consent flow in English.
- [ ] Show Tasks consent and availability consent if enabled in the review build.
- [ ] Show the connected calendar list and access roles.
- [ ] Create a secondary Google calendar in Musubi and verify it in Google Calendar.
- [ ] Edit calendar properties and verify the result in Google Calendar.
- [ ] Demonstrate a supported `calendarList` write operation.
- [ ] Import an existing Google event.
- [ ] Create, update, and delete an event from Musubi.
- [ ] Import a Google task list, then create, edit, complete and delete a task.
- [ ] Explain the scheduled-day/two-state projection and show a supported Musubi task membership without claiming Google-native ACL changes.
- [ ] Show that write controls are disabled for a read-only calendar.
- [ ] Delete the test secondary calendar.
- [ ] Disconnect the Google account and show removal of synchronized copies from Musubi.
- [ ] Add timestamps in the video description for each scope-dependent feature.

## Evidence tracker

| ID | Evidence | Status | Public reference |
|---|---|---:|---|
| E-01 | Current Calendar/Tasks/optional availability scopes | Source verified; consent/review-build evidence pending | Web `providerConnectionScopes`; native `SyncCalendarModal` |
| E-02 | Event read/create/update/delete | Done | Google synchronization adapter |
| E-03 | Google calendar creation | Implemented (verify in review build) | `adapter.createCalendar` (handlers/calendars.ts) |
| E-04 | Google calendar property update | Partial — name + color only | `adapter.updateCalendar`; no description/time zone |
| E-05 | Google calendar deletion | Implemented (verify in review build) | `adapter.deleteCalendar` (handlers/calendars.ts) |
| E-06 | Calendar-list write operation | Implemented (verify in review build) | Per-user color via `patchCalendarColor` |
| E-07 | Token revocation during disconnect | Done | Per-account revoke before local cleanup (handlers/connections.ts) |
| E-08 | Encryption of long-lived Google credentials | Done | Better Auth `encryptOAuthTokens`; key outside DB; decrypt at sync boundary |
| E-09 | Homepage, Privacy Policy, and Terms alignment | In progress | Public Musubi website |
| E-10 | Google Play listing alignment | In progress | Production store listing |
| E-11 | Public account deletion instructions | Missing | Public website page |
| E-12 | Reviewer build and instructions | Private task | Never commit credentials or private distribution details |
| E-13 | Google Tasks discovery/read/create/update/delete | Implemented; live review-build demonstration pending | `sync/adapters/google.ts` task methods |
| E-14 | Google availability grant and disclosure | Conditional; verify enabled review-build scope set | `GOOGLE_AVAILABILITY_SCOPE` and server capability |

## Private verification material — do not commit

Keep these outside the public repository:

- Google Cloud project identifiers that are not already intentionally public;
- OAuth client secrets;
- access tokens, refresh tokens, authorization codes, and cookies;
- reviewer login credentials;
- test-user personal data;
- private build links or invitation codes;
- screenshots containing real calendars, email addresses, account IDs, or event content;
- internal infrastructure addresses, database details, encryption keys, or operational logs;
- unpublished security findings.

The public tracker may record that a private item is complete, but must not include the sensitive value or artifact.

## Decision log

- **2026-10-05:** Align the tracker with v0.2.2: web requests Tasks on connection,
  native Tasks consent remains optional and enabled by default, and availability
  adds `calendar.events.freebusy` when enabled. Keep external consent-screen,
  website, store and verification approval evidence pending. Retire UI evidence
  tied to deleted components instead of claiming current confirmations are verified.
- **2026-07-12:** Keep the full Google Calendar scope because Musubi is intended to become a full calendar client.
- **2026-07-12:** Do not justify the full scope using roadmap functionality alone.
- **2026-07-20:** Reverse the 2026-07-12 decision. Request the three narrowest scopes actually used (`calendar.events`, `calendar.calendarlist`, `calendar.calendars`) instead of the broad `auth/calendar`, so the request matches implemented functionality and eases verification. Drop the "full calendar client" framing and the ACL/settings ambitions from the justification.
- **2026-07-20:** Encrypt OAuth tokens at rest via Better Auth's built-in `encryptOAuthTokens` rather than a second bespoke crypto path — one maintained mechanism, key outside the DB. The sync layer reads the columns directly, so it decrypts/encrypts with the same key material (`auth.$context.secretConfig`). Chosen over volume-only encryption because it also protects DB dumps and query-level access.
- **2026-07-12:** Treat ACL management as optional for the first submission unless it is implemented and used in the justification.
- **2026-07-12:** Keep public website claims aligned with the review build.
- **2026-07-12:** Keep this tracker English-only and safe for a public repository.
