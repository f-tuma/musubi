# Google OAuth Verification Tracker

This document tracks the public, non-sensitive work required to verify Musubi's Google OAuth integration.

For implementation and troubleshooting details, use the maintained
[Google provider guide](../packages/docs/src/content/docs/providers/google.mdx).
This file remains separate because it is a release/compliance checklist, not
general product documentation.

> Public repository rule: do not add credentials, tokens, private email addresses, unpublished infrastructure details, reviewer credentials, internal account IDs, security keys, or screenshots containing user data.

## Verification target

Musubi requests the following Google Calendar scopes — the narrowest set its sync and calendar-management features need, rather than the broad `https://www.googleapis.com/auth/calendar`:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist
https://www.googleapis.com/auth/calendar.calendars
```

Musubi provides event synchronization and management of the user's own calendar resources and calendar-list entries. It does not request access to sharing/ACL rules or account settings.

Google verification should only be submitted when the review build, public website, privacy policy, Play Store listing, scope justification, and demonstration video all describe the same implemented functionality.

## Current public status

- [x] The mobile client requests the three granular Google Calendar scopes.
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

### P0 — Calendar client functionality

- [x] Create a secondary Google calendar from Musubi.
- [~] Edit an owned Google calendar — name and color are implemented; description and time zone are not.
- [~] Delete an owned secondary Google calendar — backend implemented; verify the destructive-action confirmation in the review build.
- [x] Implement at least one meaningful write operation for the user's Google calendar list (per-user calendar color).
- [~] Distinguish access roles — only a binary editable/read-only flag today (owner/writer vs everything else); full primary/owner/writer/reader/free-busy taxonomy not implemented.
- [~] Disable operations that the connected Google account is not authorized to perform — driven by the binary read-only flag; verify coverage in the review build.
- [x] Clearly distinguish these actions in the UI:
  - disconnect from Musubi — confirm reads "its calendars and events will be removed from Musubi" (`calendars.tsx` handleDisconnect);
  - permanently delete a Google calendar — two-step confirm that explicitly says "deleting it here also deletes it in Google Calendar" (`CalendarSettingsModal` handleDelete).
  - Note: Musubi does not expose a separate "remove from the Google calendar list" (calendarList unsubscribe) action — `calendarlist` scope is used only for reads and per-user color — so there is no third action to confuse with delete.
- [ ] Test calendar and event operations against owned, shared, and read-only calendars.
- [ ] Handle Google API authorization errors and expired synchronization cursors safely.

### Optional — Sharing and ACL management

These items are not required for the first submission unless they are used in the scope justification or shown as current product functionality.

- [ ] Display calendar access rules.
- [ ] Add a calendar member.
- [ ] Change a member's access role.
- [ ] Remove a member's access.
- [ ] Enforce ownership and permission checks for every ACL operation.

Do not mention ACL management as an implemented feature until all relevant controls are available in the review build.

### P0 — OAuth and Google Cloud configuration

- [ ] The application, OAuth consent screen, and verification request use exactly the same three scopes.
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
- [x] Destructive calendar operations require explicit user confirmation. (Delete calendar, disconnect account, delete event, leave calendar, and account deletion all confirm; external delete is a two-step confirm.)
- [ ] The Privacy Policy accurately describes stored calendar metadata, events, synchronization cursors, and OAuth credentials.
- [ ] Account deletion, retention, backup handling, and export statements match the actual implementation.

## Public website checklist

- [ ] The homepage has a dedicated Google Calendar integration section.
- [ ] The homepage describes only features available in the current public or review build.
- [ ] Future calendar-management features are clearly marked as roadmap items until released.
- [ ] The Privacy Policy identifies the three granular Google Calendar scopes and explains each one's purpose.
- [ ] The Privacy Policy distinguishes currently used functionality from technically possible but unreleased functionality.
- [ ] The Privacy Policy explains that Google Calendar data is used only for user-requested calendar functionality.
- [ ] The public website consistently identifies Musubi and its operator.
- [ ] The Google Play listing describes the Google Calendar integration available in the published build.
- [ ] A public account-deletion page explains both in-app deletion and the fallback request process.
- [ ] Repository links use the canonical `frgtn-dot-dev/musubi` location.

## Safe homepage copy before full calendar management is released

> Musubi can connect to one or more Google Calendar accounts and provide two-way event synchronization.
>
> With your permission, Musubi can display your Google calendars and their events, and create, update, or delete events when you perform those actions in Musubi. Synchronized data is processed by your Musubi server so that your calendars remain available across your devices and shared Musubi spaces.
>
> Musubi is being developed into a full calendar client. Management of Google calendar properties, calendar-list settings, and sharing permissions will be documented when those features become available.
>
> You can disconnect a Google account at any time. Disconnecting removes its stored credentials and synchronized copies of calendars and events from Musubi.

## Safe Privacy Policy copy before full calendar management is released

> Rather than one broad permission, Musubi requests only the narrowest Google Calendar OAuth scopes it needs: `calendar.events` (read, create, update, and delete events), `calendar.calendarlist` (see the calendars in your account and their properties, such as color), and `calendar.calendars` (create, rename, recolor, and delete calendars you own).
>
> Musubi uses these to list calendars, provide two-way synchronization of events, and manage the user's own calendars. Musubi reads, creates, updates, and deletes events and calendars only when requested by the user or when synchronization explicitly enabled by the user requires it.
>
> Musubi uses Google Calendar data only to provide user-requested calendar functionality. It does not use the data for advertising, profiling, or unrelated purposes.

## Final scope justification draft

Use this only after the corresponding calendar-management features exist in the review build.

> Musubi uses three granular Google Calendar scopes to provide calendar management and synchronization:
>
> - `calendar.events` — Musubi reads events for two-way synchronization and creates, updates, and deletes events when the user acts in Musubi.
> - `calendar.calendarlist` — Musubi lists the user's calendars and writes per-user calendar-list properties such as color; read-only access is not sufficient because users recolor calendars from Musubi.
> - `calendar.calendars` — Musubi creates, renames, recolors, and deletes calendars the user owns.
>
> Users can connect one or more Google accounts, view their calendar list, create and manage their own Google calendars, and read, create, update, or delete events. Musubi respects the permissions reported by Google and disables actions that the user is not authorized to perform. It does not request the broad `https://www.googleapis.com/auth/calendar` scope, nor any sharing/ACL or account-settings access.
>
> All actions are initiated by the user through the Musubi interface or are part of synchronization explicitly enabled by the user. Google Calendar data is not used for advertising, profiling, or unrelated purposes.

## Demonstration video checklist

- [ ] Show the public Musubi homepage and Privacy Policy.
- [ ] Show the in-product disclosure before Google authorization.
- [ ] Record the complete Google consent flow in English.
- [ ] Show the connected calendar list and access roles.
- [ ] Create a secondary Google calendar in Musubi and verify it in Google Calendar.
- [ ] Edit calendar properties and verify the result in Google Calendar.
- [ ] Demonstrate a supported `calendarList` write operation.
- [ ] Import an existing Google event.
- [ ] Create, update, and delete an event from Musubi.
- [ ] Show that write controls are disabled for a read-only calendar.
- [ ] Delete the test secondary calendar.
- [ ] Disconnect the Google account and show removal of synchronized copies from Musubi.
- [ ] Add timestamps in the video description for each scope-dependent feature.

## Evidence tracker

| ID | Evidence | Status | Public reference |
|---|---|---:|---|
| E-01 | Three granular scopes requested by the client | Done | Client calendar connection flow |
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

- **2026-07-12:** Keep the full Google Calendar scope because Musubi is intended to become a full calendar client.
- **2026-07-12:** Do not justify the full scope using roadmap functionality alone.
- **2026-07-20:** Reverse the 2026-07-12 decision. Request the three narrowest scopes actually used (`calendar.events`, `calendar.calendarlist`, `calendar.calendars`) instead of the broad `auth/calendar`, so the request matches implemented functionality and eases verification. Drop the "full calendar client" framing and the ACL/settings ambitions from the justification.
- **2026-07-20:** Encrypt OAuth tokens at rest via Better Auth's built-in `encryptOAuthTokens` rather than a second bespoke crypto path — one maintained mechanism, key outside the DB. The sync layer reads the columns directly, so it decrypts/encrypts with the same key material (`auth.$context.secretConfig`). Chosen over volume-only encryption because it also protects DB dumps and query-level access.
- **2026-07-12:** Treat ACL management as optional for the first submission unless it is implemented and used in the justification.
- **2026-07-12:** Keep public website claims aligned with the review build.
- **2026-07-12:** Keep this tracker English-only and safe for a public repository.
