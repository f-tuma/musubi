# Mobile v0.2.2 release readiness — 2026-10-05

This audit distinguishes the source/native build checks from signed store
artifacts and physical-device acceptance. Baseline source was release PR #331
at `118cb01`; the follow-up mobile fixes are included in the final accepted PR
head. Record that head and its Quality run rather than treating the baseline CI
as validation of the new fixes.

## Concrete fixes before publication

- Task mutation and delete receipts must pass their schemas in production.
  Malformed responses no longer acknowledge a save or retire a copy's stable
  retry intent. Read-only DTO compatibility remains separate.
- A committed task receipt finishes an invalidated list refresh. An outstanding
  GET cannot leave the refresh spinner permanently active.
- Calendar task refresh records invalidations received during a save and drains
  them through the current account/server callback afterwards.
- Persisted auth cookie/session keys encode the entire normalized origin without
  punctuation or HTTP/HTTPS collisions. Ambiguous legacy keys are not imported;
  upgrading requires a fresh sign-in, after which normal session persistence
  applies.
- The first startup using the new auth namespace migrates the local schema,
  clears legacy account data, widgets and scheduled reminders, and only then
  opens the auth client. Cleanup failures cannot mark the upgrade complete.
- Queued realtime mutations and deferred launch-cache hydration reject retired
  session lifecycles before writing state/cache or starting old-server refreshes.
  Network listeners are renewed for the current server/auth scope.
- iOS is currently a TestFlight beta. The production profile now supplies the
  existing public Apple join URL and the update action opens **TestFlight**.
  A configured real App Store listing takes precedence after public release.
  Supplied URLs remain validated; an absent public listing no longer blocks beta.

Regression tests exercise production malformed receipts and copy retries,
waiting GET/commit races, invalidations during saving and scope switches, actual
Better Auth Expo cookie transport, and controlled-promise realtime/hydration
races. Source checks and the final CI run are recorded in PR #331.

## Native build and configuration evidence

- Production Android and iOS Metro/Hermes export passed again after the final
  JavaScript/config changes, with the actual TestFlight production configuration.
  The complete native suite passed: 497 tests across 48 files, plus the standalone
  origin-namespace assertions. Typecheck and the full client lint passed
  (zero errors; 66 existing warnings within its unchanged threshold).
- Isolated Android/iOS `expo prebuild --no-install --platform all` passed.
- Isolated Android `:app:assembleRelease` for arm64 completed successfully:
  945 Gradle tasks, Kotlin/Java/CMake, widget, release lint and packaging.
  Its 96.6 MB APK uses temporary debug signing and versionCode 1; it is build
  evidence, not the artifact for Play distribution.
- Generated Android manifest has package `dev.frgtn.musubi`, product 0.2.2,
  target SDK 36 and min SDK 24. Camera, microphone and overlay permissions are
  removed. Exact-alarm declarations, notification/boot/widget receivers and
  calendar-app category are present.
- Generated iOS configuration includes version 0.2.2, the Google reversed
  callback scheme, required modular pod headers, Apple Sign-In, associated
  domains, document-import declarations and time-sensitive notifications.
  App/adaptive icons have the expected dimensions and image modes.
- Native modules, plugins and dependency declarations are unchanged from the
  published v0.2.1 dependency basis. No dependency was added or updated.

Expo doctor reports 19/21 checks passing. Remaining checks recommend 11 newer
SDK patch versions and report same-version root/client installations. Native
link resolution contains one selected instance per module; SDK 57 uses
[monorepo autolinking module resolution](https://docs.expo.dev/guides/monorepos/#deduplicating-auto-linked-native-modules).
These notices did not block native compilation. They are recorded rather than
hidden or replaced by an untested dependency update.

The mobile web export has a pre-existing expo-sqlite WASM/Metro resolution
failure. Explicit Android/iOS exports passed; `apps/web` is a separate artifact.
This audit does not certify the optional Expo web target.

## EAS inventory and distribution

Read-only EAS inspection authenticated as the account owner for `@frgtn/musubi`,
project `4e24bdfa-490c-4c3e-9a76-7abef4efa823`. Production selects the production
environment, inherits product 0.2.2 and auto-increments remote platform counters.
Before new builds, EAS reports Android versionCode 63 and iOS buildNumber 16.
Do not reset either counter; local test APK counters are unrelated.

- Android has an existing default JKS build credential. EAS lists no FCM V1 key
  and no Play submission service-account key. Producing a signed Android build
  and submitting it to Play are separate actions; an AAB can be uploaded by the
  operator. Remote Android push delivery is not established by these checks.
- iOS has an active Store provisioning profile and distribution certificate,
  both expiring on 2027-07-14, plus configured APNs and App Store Connect keys.
  Inspection did not create, renew or download any credential. Portal validation
  and actual signed compilation remain build-time checks.
- EAS's latest recorded iOS production build is 0.1.7/build 16 from 2026-08-31.
  Android's latest cloud records are older May builds. This does not inventory
  locally produced artifacts or prove the currently distributed store versions.
- The existing [public TestFlight invite](https://testflight.apple.com/join/EqzdPVfC)
  was checked and identifies the Musubi Calendar beta. This confirms the update
  destination, not the version distributed through it.

No current signed v0.2.2 artifact or store submission is claimed by this source
audit. Record actual EAS build IDs, platform build numbers, source revision,
status and the selected artifacts in the release record when produced.

## Remaining acceptance

Physical Android/iOS session persistence, notification/reminder delivery,
provider readback, offline/reconnect, keyboard/safe areas and font scaling remain
separate acceptance. Linux prebuild/Hermes success is not an Xcode compilation
or a device test. Public app-link hosting was not established by the build audit.
The owner's confirmed preupgrade backup/restore and accepted deployment risk do
not turn these unperformed checks into passes.

See [mobile rollout](../releases/0.2.2-mobile.md) and
[deployment/recovery](../releases/0.2.2-deployment.md). Retain current Core gates.
