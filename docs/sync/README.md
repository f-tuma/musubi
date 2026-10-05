# Calendar and task sync

Reader-facing guides live in the canonical Starlight documentation:

- [Sync architecture](../../packages/docs/src/content/docs/architecture/sync.mdx)
- [Shared-task guide](../../packages/docs/src/content/docs/guides/shared-tasks.mdx)
- [Google Calendar](../../packages/docs/src/content/docs/providers/google.mdx)
- [Microsoft / Outlook](../../packages/docs/src/content/docs/providers/microsoft.mdx)
- [Apple / iCloud and CalDAV](../../packages/docs/src/content/docs/providers/caldav.mdx)

Published version: <https://musubi.pro/docs/architecture/sync/>

## Maintained implementation contracts

These records define operation-specific admission, privacy and recovery. They
supplement the public guides; dated acceptance audits are evidence for a bounded
operation, not a blanket provider certification.

| Area | Contracts |
| --- | --- |
| Shared tasks | [Home authority, memberships, receipts and projections](./shared-tasks.md) |
| Event delivery | [Write boundary](./event-write-boundary.md), [outbox worker](./event-outbox-worker.md), [delivery receipts](./event-delivery-status.md), [create recovery](./event-create-recovery.md) |
| Event identity and scope | [Time model](./event-time-model.md), [scope operations](./event-scope-operations.md), [provider state](./provider-event-state.md) |
| Google | [Personal occurrences](./google-occurrence-writes.md), [organizer](./google-organizer.md), [RSVP](./google-rsvp.md), [read access](./google-calendar-access.md), [availability](./google-availability.md) |
| Outlook | [Recurring create](./graph-recurring-create.md), [adoption](./graph-create-adoption.md), [organizer create](./microsoft-organizer-create.md), [RSVP](./microsoft-rsvp.md), [global zones](./outlook-time-zones.md), [selected moves](./outlook-occurrence-moves.md), [read access](./microsoft-calendar-access.md) |
| CalDAV | [Personal series](./caldav-series-writes.md), [DATE additions](./caldav-rdate-writes.md), [organizer](./caldav-organizer.md), [RSVP](./caldav-rsvp.md), [read access](./caldav-read-access.md), [alarms](./caldav-event-alarms.md) |

Use the [current capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx)
to distinguish accepted specialized writers from the older generic writer's
limits. Historical K06–K08 introductions in these contracts are not current
rollout status.
