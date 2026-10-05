# Android widget rework

Date: 2026-10-05. Status: **implemented on `codex/android-widget-rework`; device acceptance pending**.

Scope: refresh the Android Agenda and Calendar widgets, then add a small,
read-only Tasks widget. Android comes first; iOS is a later platform project.
This document records the audit, implemented design, and remaining acceptance
work. The user guide is [Home screen widgets](../../../packages/docs/src/content/docs/guides/widgets.mdx).
No launcher/device behavior is certified by source tests alone.

Follow the shared [design system](../design-system.md) and
[calendar behavior](../calendar-ui.md). Keep the existing Expo native module and
RemoteViews approach. No new dependencies are proposed for these phases.

## Implemented scope

- A version-2 shared snapshot stores each occurrence once with bounded day
  references. It carries account/server scope, persisted lifecycle and generation,
  readable calendar IDs, coverage, timezone, completeness and independent event/task
  status. Native storage rejects obsolete or malformed writes. Retained sections
  are pruned against current access; sign-out clears snapshots and widget filters.
- Calendar readiness is independent of screen readiness. Failed cache hydration
  cannot publish an authoritative empty widget. A valid calendar cache lets Tasks
  recover independently of events, and foreground reads refresh both endpoints.
  Malformed membership cache is rejected and can be rebuilt from the server.
- One projection handles recurring events and render-only task markers. It keeps
  cancellation/moved-exception context until expansion and ignores wholly
  unreadable families. Explicit consumer zones cover legacy and known recurrence
  paths. Identical foreground data and sync timestamps reuse expanded rows.
- Agenda, Calendar and the new read-only Tasks widget share generated Musubi
  colors, dimensions, accessible controls and state/freshness presentation. Native
  collection IDs use occurrence identity with collision handling. Calendar bars
  preserve empty lanes. Refresh opens the authenticated app; it is not native
  background transport. Its centered vector icon avoids font-baseline offsets;
  versioned shell layouts safely replace the former text glyph in launcher trees.
- Tasks use one account/server-scoped SQLite collection with read/mutation fences,
  canonical revision/retirement reconciliation and membership/auth eviction. Its
  root consumer works without opening Tasks. Widget rows open canonical detail;
  each Tasks widget has its own calendar selection.
  Authoritative disappearance blocks delayed positive receipts. A first current
  calendar read can prune an unsafe cached home even after failed calendar
  hydration; its incomplete result is not persisted as a healthy empty cache.

| Projection budget | Limit |
| --- | --- |
| Expanded recurrence candidates / occurrences | 50,000 / 10,000, shared across families |
| Stored events / active tasks | 4,096 / 2,048 |
| Covered civil dates / event references | 450 / 32,768 |
| UTF-8 serialized snapshot | 1 MiB from JS; 2 MiB native ceiling for independently retained sections |

Coverage runs from the previous month through the next twelve months. Full event
endpoints are retained while date iteration is clamped to coverage. Truncation is
explicit; it never certifies an empty future. These are defensive bounds, not a
device performance guarantee. A desktop profile of 8,000 known daily occurrences
took approximately 862 ms to project and 56 ms to serialize; a dense 4.7 MB payload
was reduced to 839 kB. Five daily series anchored in 2020 fit the 50,000-candidate
budget with approximately 2,130 covered rows; a 10,000-candidate budget rejected
that ordinary history. One desktop run took 173 ms for legacy timed series and
294 ms for known all-day series. Profile low-end hardware before release.

Bounded widget expansion supports daily and less frequent rules on both time
paths. Hourly/minutely/secondly legacy rules are rejected before library
iteration: unreachable subdaily filters can loop without yielding candidates.
Malformed numeric fields and oversized recurrence text also fail explicitly,
retaining usable cached content instead of certifying an empty result.

## Audit baseline and findings

The following describes the source at `84a88f4`, before this rework. Line numbers
refer to that baseline; the linked current files contain the implementation.

The [tab layout][tabs] normally hydrates cached calendars and events before
starting [widget sync][snapshot], then refreshes over the network. Whole-store
subscriptions debounce writes by 120 ms. The snapshot contains at most 64 agenda
rows within a 45-day lookahead and calendar summaries over approximately 14
months. SSE/reconnect refreshes can update the stores while the app runs.
Native widget updates repaint that persisted snapshot; they do not fetch data
or expand new occurrences. Tasks are absent from this snapshot.

The following defects were confirmed by the baseline source. Device checks must
still establish their visual impact and verify the native corrections.

| Finding | Evidence and consequence |
| --- | --- |
| Agenda rows can exhaust prematurely | `agendaWidget.ts:71` truncates before `AgendaWidgetData.kt:104–109` filters expired rows. With 64 events today and another tomorrow, tomorrow's known event is omitted until a JS rebuild. |
| Calendar output exceeds its intended range | `agendaWidget.ts:86–89,110–116` expands overlapping events but iterates their entire run. A decades-long event generates decades of summaries. Clamp iteration while preserving true span endpoints. |
| Failed hydrate can replace useful data with empty data | `[tabs]/_layout.tsx:51–61,73–75` sets `dataReady` in `finally`, even when neither cache loaded. Widget sync then writes an empty signed-in snapshot. Cache time-metadata parsing can throw in `eventsCache.ts:108–111`. |
| Stable agenda item IDs collide | [Agenda service][agenda-service], lines 72–73, declares stable IDs but uses the start timestamp. Simultaneous events and same-day all-day events share an ID. |
| Calendar hides state distinctions | [Calendar provider][calendar-provider], line 397 onward, renders without checking `signedIn`. [Snapshot parsing][native-data], lines 15–18 and 99–101, maps missing/malformed input to the same default. Signed-out, unavailable, and empty states can all resemble an ordinary empty month. |
| Account-specific selections survive sign-out | [Module clear][native-module], lines 19–23, changes only the snapshot. [Calendar preferences][preferences] remain keyed only by widget ID, so another account inherits old calendar IDs and may see an empty selection. |
| Empty lanes collapse | `MusubiCalendarWidgetProvider.kt:583–626` preserves logical bar lanes but uses `GONE` for empty pill slots in a vertical layout. A lane-1 continuation can move upward on a day without lane 0. Reserve space for empty active lanes. |
| Timezone buckets remain fixed | JS computes day keys in its consumer timezone. Native timezone broadcasts repaint the old keys; timed events near midnight can remain on the previous local date. Floating occurrences also need expansion in the new consumer timezone. |

Additional reliability and cost gaps:

- JS writes `version` and `generatedAt`, but the native parser does not retain
  them. It also lacks coverage, completeness, timezone, and sync-status fields.
  Expired coverage must not mean “No events.”
- Either recurrence expansion can reject the whole build; the catch only logs
  and leaves the old widget data. The app's [expansion wrapper][expansion]
  deliberately exposes an error rather than presenting a partial family.
- Every calendar filter or unrelated setting change can trigger two recurrence
  expansions, day bucketing, and serialization on the JS thread. Calendar titles
  and membership IDs are repeated in each covered day. Known-time expansion has
  a candidate limit; legacy expansion needs a corresponding bounded contract.

**Unproven ordering risk:** `agendaWidget.ts:137–174` can dispatch asynchronous
writes while a prior native write is pending. Clear cancels the debounce timer,
not a dispatched write. The native module/storage has no lifecycle or generation
check. A delayed write overtaking clear has not been reproduced; add an explicit
ordering test and fence instead of reporting it as an observed race.

## Phase 1: reliable shared snapshot and bounded work

Extract a pure projector taking events, calendars, settings, `now`, and an
explicit consumer timezone. Keep one native snapshot shared by all widgets.
Make the contract versioned and validate it before replacing the last valid
snapshot. Persist only display data and opaque account scope; never credentials
in widget JSON or widget preferences.

The envelope should include scope/lifecycle, monotonic generation,
`generatedAt`, last successful sync times, consumer timezone, coverage bounds,
and complete/truncated/error status. Event and task sections need independent
load/sync status, so a task-fetch failure cannot erase usable events. Distinguish
signed out, not loaded, invalid/unsupported data, cached or stale data, expired
coverage, and a successful empty result. Retain useful cached content on ordinary
network failures with a compact “Updated …” indicator. Explicit sign-out,
authorization loss, or scope change must remove private content.

Implementation steps:

1. Separate screen readiness from successful data hydration. Never publish an
   empty replacement solely because cache loading failed. Publish genuine empty
   data only after a successful load or explicit reset.
2. Serialize writes and clear operations. Carry lifecycle/generation through
   the bridge; native storage rejects obsolete generations/scopes. Sign-out
   establishes a barrier before another account can publish. Clear or scope
   calendar selections, preserving `null = all` and `[] = none`; remove config
   when a widget is deleted.
3. Rebuild from relevant data changes, successful sync, and foreground resume.
   While JS runs, follow local midnight and timezone changes. Native broadcasts
   may update labels and prune rows from valid coverage; they cannot claim a new
   sync or silently reuse incompatible timezone buckets.
4. Clamp day iteration to declared coverage and retain full bar endpoints.
   Reuse expanded occurrences instead of expanding twice. Store each compact
   event payload once with day references. Preserve exact membership-filtered
   counts and deterministic lanes/overflow.
5. Replace the global 64-row cutoff with a bounded covered collection; native
   selects currently relevant rows. Define tested occurrence and byte budgets
   before shipping. Budget exhaustion records incomplete coverage and prompts
   opening the app, rather than claiming that later events do not exist. Apply
   the expansion budget to both legacy and known-time recurrence paths.
6. Subscribe only to event/calendar data and widget-relevant settings. Skip
   identical projections. Repair stable collection IDs using occurrence identity
   with collision handling; keep writable canonical identity separate from a
   rendered occurrence ID. Test simultaneous events explicitly.

## Phase 2: common Agenda and Calendar design

Use one shared widget shell: Musubi surfaces and ink, consistent header/insets,
one primary route into the app, one-line content rows, and restrained calendar
pigments. Use the same state presentation across Agenda, Calendar, and Tasks.
Configuration is a secondary control; explanation belongs in app help.

Generate Android color/dimension resources from TypeScript sources in
[packages/design-system][tokens], adding semantic widget roles there when
needed. Do not hand-edit generated output or maintain another palette in the
native widget resources. Keep native rendering separate from web components.
Use existing fonts only where supported by RemoteViews; document a system-font
fallback and compare its size/weight optically on a device.

Agenda should keep date/time aligned and titles readable, revealing calendar or
location metadata only when space permits. Calendar should retain its quiet
month grid, compact dots at small sizes, and bars at usable large sizes. Preserve
empty lane space, full-span rounding, selected-calendar counts, today contrast,
week-start settings, and coherent overflow. Adapt visible rows/metadata to
available width, height, and font scale instead of shrinking text to fit.
Check both themes, readable pigment text, accessible names, and usable native
touch targets. No web UI edit is required by this phase.

## Phase 3: persisted Tasks and a small read-only widget

Tasks currently live in separate session-scoped component snapshots in
[TasksTab][tasks-tab] and [useCalendarTasks][calendar-tasks]. They fetch on focus
or invalidation; [useTaskRefreshStore][task-refresh] stores only an invalidation
version. Existing rows can survive a transient network failure, but a cold
offline launch starts with no tasks. Calendar/Agenda already append render-only
task markers while widgets do not.

Introduce one task collection and local cache scoped by server and signed-in
actor. Hydrate it with the existing launch pipeline and invalidate old reads,
mutations, and persistence writes on account/server reset. Refresh it after
successful mutations and task/provider/SSE invalidation, independently of which
tab is focused. Successful authoritative reads reconcile removals; authorization
loss or a committed nullable receipt evicts no-longer-readable rows. Ordinary
network failure preserves the last valid scoped cache and its freshness state.

Reuse the [shared task helpers][task-sharing]: deduplicate by canonical task ID,
revision, then `providerReadRetiredGeneration`; readable membership is distinct
from home ownership. Use `taskDisplayCalendar` for color/name and
`taskCapabilities` for actions. Provider delivery copies remain projections of
the canonical identity supplied by the API; deliberate forks have independent
IDs. Never deduplicate by title/date or mutate a synthetic calendar marker ID.

Use [calendarTasks][task-calendar] to retain the app's marker semantics: starts
have a render-only 30-minute footprint, deadlines sit in the all-day rail,
same-day all-day markers collapse, and both markers open the same task. That
helper does not expand recurring tasks into independent event occurrences.

The small Tasks widget shows as many full rows as fit, one per canonical task
in `needs-action` or `in-process`, with title and a compact due label. Order
overdue, today, upcoming, then undated; tie-break by priority, title, and ID.
Exclude completed/cancelled tasks from this view and filter by the widget's own
calendar selection. A row opens task detail by canonical ID after hydration;
the header opens Tasks. Add and verify that route explicitly.

Keep this first widget read-only, including for editable tasks. A mirror's
cached permissions must never imply completion rights. Native completion is a
later feature requiring fresh capabilities, canonical revision and retired-read
generation fences, authenticated transport, and committed mutation receipts
through the [existing task mutation API][task-api]. Do not optimistically toggle
native state or fall back to legacy task writes.

## Later work: background transport and iOS

Keep authenticated background fetching as a separate design after the shared
snapshot is reliable. Decide between an Expo background executor and native
authenticated transport only after reviewing credential access, self-hosted
server routing, session expiry, scoped cancellation, retry/backoff, membership
reconciliation, provider delivery semantics, and measured battery cost. Any new
dependency requires a separate decision. Reuse existing secure credential
storage; preferences hold display data/configuration only.

Android's `updatePeriodMillis` has a 30-minute minimum and triggers a provider
callback; it is not a network freshness guarantee. Receiver execution is
normally limited to about 10 seconds, so fetching/expansion must not block it.
[Android widget update guidance](https://developer.android.com/develop/ui/views/appwidgets/advanced#update-periodically).
WorkManager periodic work has a 15-minute minimum, with execution dependent on
constraints and system optimization; runs can be delayed or skipped.
[WorkManager scheduling](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work#schedule_periodic_work).
Doze defers background jobs/network access to maintenance opportunities.
[Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby).
Do not promise instant closed-app sync, a precise midnight callback, or use an
exact-alarm/foreground-service workaround for ordinary widget freshness.

iOS later needs its own WidgetKit extension, shared-container access, timeline
and refresh policy, native build/signing, and device acceptance. Reuse snapshot
meaning and tokens, not Android RemoteViews or assumptions about OS scheduling.

## Acceptance and delivery

Implementation validation on 2026-10-05:

| Check | Result |
| --- | --- |
| Full client Vitest suite | 591 tests in 53 files pass |
| Client TypeScript / ESLint | Pass; no lint errors, 77 existing warnings within the 108-warning budget |
| Shared calendar suites | All 26 test scripts pass, including combined candidate/result limits and unsafe-filter validation |
| Design-system generation, stale-output check, tests, TypeScript | Pass |
| Production native parser/storage/invariant tests | 11 checks pass without an emulator |
| Native Android debug build | `:app:assembleDebug` passes for x86_64 with the widget module included |
| Android Hermes bundle export | Pass with dotenv disabled |
| Documentation build | 31 pages build successfully |
| Disposable Android 17 / API 37 emulator, Pixel Launcher 17 | All three widgets render in light/dark; tested 1.0 and 2.0 font scales without widget-load errors |

Regressions cover long spans, more than 64 early events, failed/empty/corrupt
hydration, recurrence exclusions and bounded expansion, timezone/DST changes,
canonical deep links, scoped task caching, stale reads and mutation receipts,
membership/auth removal, and nullable receipts. Native tests exercise receipt
fences, malformed snapshots, retained-section metadata, stable identities,
timezone/coverage, lane gaps, and merged byte-budget trimming. These tests and
builds do not establish launcher or physical-device acceptance.

The emulator uses synthetic events/tasks and a separate AVD/ADB server under
`/tmp/musubi-widget-qa-avd`; no production account or physical device is involved.
Agenda and Tasks were shown at 4×3 cells, Calendar at 4×6. Both simultaneous
meetings remain visible, one canonical multi-calendar task appears once while
an independent copy remains separate, and a lane-1 bar keeps its position when
lane 0 is empty on later dates. Theme changes repaint without resizing. Larger
font reduces visible list rows and Calendar pill lanes; text uses ellipsis
instead of shrinking. Existing test widgets survived replacement of the debug
APK and restart of this disposable emulator. Temporary screenshots are outside
the repository; they are not a maintained screenshot catalog.

This is one emulator/launcher configuration with injected display fixtures,
not an end-to-end authenticated-app, production-upgrade, or physical-device test.

Native resource/module changes require rebuilding the development client; a
Metro export alone is insufficient. The debug build above is not an Android
release artifact. Use the existing
[Android QA workflow](../../handoffs/windows-android-qa-2026-09-13.md).

On emulator and a physical device, record launcher/version, widget size, theme,
font scale, steps, and screenshots. Verify resize boundaries, landscape,
TalkBack, multiple widget instances/selections, add/delete/re-add, deep-link
loading, cold offline launch, process death, reboot, force-stop/reopen recovery,
sign-out/account/server switch, network loss/reconnect, clock/timezone/month
changes, and Doze/standby recovery. Verify the older collection factory across
clear and same-account re-adoption, and an APK upgrade with already-added widgets.
Profile build duration, snapshot bytes, and native rendering cost on low-end
hardware. Record untested OS/launcher/provider cases explicitly.

At the supported compact Calendar width of 250 dp, individual date hit areas
are approximately 31 dp wide and can be 26 dp tall; they remain below the shared
44 dp control target. Header controls and list rows use the shared target.
Calendar switches to an enlargement prompt when scaled text cannot fit. Check
compact date selection with TalkBack before release; compact geometry is not
certified as meeting a 44 dp date target.

No physical-device installation, production deployment, or release acceptance
has been performed for this rework. Closed-app authenticated fetching and iOS
remain separate work.

[tabs]: ../../../apps/client/app/(tabs)/_layout.tsx
[snapshot]: ../../../apps/client/services/agendaWidget.ts
[agenda-service]: ../../../apps/client/modules/musubi-agenda-widget/android/src/main/java/dev/frgtn/musubi/widget/MusubiAgendaWidgetService.kt
[calendar-provider]: ../../../apps/client/modules/musubi-agenda-widget/android/src/main/java/dev/frgtn/musubi/widget/MusubiCalendarWidgetProvider.kt
[native-data]: ../../../apps/client/modules/musubi-agenda-widget/android/src/main/java/dev/frgtn/musubi/widget/AgendaWidgetData.kt
[native-module]: ../../../apps/client/modules/musubi-agenda-widget/android/src/main/java/dev/frgtn/musubi/widget/MusubiAgendaWidgetModule.kt
[preferences]: ../../../apps/client/modules/musubi-agenda-widget/android/src/main/java/dev/frgtn/musubi/widget/CalendarWidgetPreferences.kt
[expansion]: ../../../apps/client/lib/calendarExpansion.ts
[tokens]: ../../../packages/design-system
[tasks-tab]: ../../../apps/client/app/(tabs)/tasks.tsx
[calendar-tasks]: ../../../apps/client/hooks/useCalendarTasks.tsx
[task-refresh]: ../../../apps/client/store/useTaskRefreshStore.ts
[task-sharing]: ../../../packages/calendar/src/task-sharing.ts
[task-calendar]: ../../../packages/calendar/src/task-calendar.ts
[task-api]: ../../../apps/client/services/api.ts
