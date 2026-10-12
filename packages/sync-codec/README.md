# @musubi/sync-codec

Private pinned version-1 serializers for the existing personal event/task transports. Runtime code imports only shared types and ical.js; it has no DB, auth, HTTP, environment, or ambient clock dependency.

Encode with encodeEventV1/encodeTaskV1 and an explicit acceptedAt timestamp and persisted operationId. Save the returned admittedProjection and nativePlan once. Retry consumes saved bytes/JSON with parseNativeWritePlanV1; it never reruns an Event/Task projector. Recognized serializer formats are not provider capability grants. Existing host preflight, permission, expected validators, side-effect, privacy and authority fences remain necessary.

Google/Graph JSON bodies preserve the current provider projection and omission/nullable-clear semantics. Event CREATE carries the stable Google operation marker/native ID or Graph transactionId. Task native IDs are not fabricated. Graph personal UPDATE only accepts title, description, location, and local-only color. Known zoned/floating edits and specialized recurrence/meeting/RSVP operations remain in their existing transports. Existing bounded Google and CalDAV RRULE/EXDATE/RDATE serialization is retained; Graph recurrence stays unsupported.

DAV plans pin a replacement component, exact UID, creation resource and property allowlist. Update merges only those properties into the freshly validated exact-ETag resource. Omitted fields, other components, alarms, VTIMEZONE and timezone parameters survive. The merge uses no Event/Task value. Ambiguous/missing UID masters fail closed; recurrence edits with detached exceptions remain unsupported by this codec. Task late patches select saved property/body fields through restrictCaldavTaskPlanV1/restrictJsonBodyPlanV1. These helpers never reserialize canonical objects.

No admission/backfill or rollout is owned by this package. The encoder feature remains default off until the decoder floor has actual deployment evidence. Pure and legacy parity tests run with pnpm --filter @musubi/sync-codec test; API adapter imports exist only in the test file.
