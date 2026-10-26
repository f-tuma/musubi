# Musubi host database conformance gate

This full-repository gate complements the independent reference corpus. The
`host-compat` mode is pure runner lifecycle evidence; it does not run PostgreSQL
or prove pull coverage, echo convergence or home authority in storage.

Use a clean checkout without a local `.env` and an explicitly disposable
PostgreSQL 17 database. Supply the same synthetic test settings used by the
existing Quality database jobs: `ENVIRONMENT=test`, the owned `DATABASE_URL`,
`BETTER_AUTH_URL=http://localhost:7531`, a synthetic 64-hex `CALDAV_ENC_KEY`,
and `FEDERATION_ALLOW_PRIVATE_HOSTS=true`. No real provider credentials are
needed. Apply the committed migrations with `pnpm db:migrate`, then run:

```sh
pnpm test:sync-alpha:host-db
```

That alias executes these existing actual integration programs sequentially;
the normal required database CI shards also include every one:

| Production boundary | Executable source | Evidence axis |
| --- | --- | --- |
| Source read apply/storage | `packages/db/src/queries/source-read.integration.test.ts` | Coverage loss versus actual deletion, epoch/configuration and current source authority |
| Graph complete-window import | `apps/api/src/sync/graph_read_coverage.integration.test.ts` | Actual read coverage application and complete/partial native inventory handling |
| Shared task engine/SQL/native | `apps/api/src/sync/shared_tasks.integration.test.ts` | Home authority, secondary echo and equal native addresses in distinct destinations |
| Task ACK transaction | `packages/db/src/queries/task-ack.integration.test.ts` | Real observed echo, canonical preservation and lease/ref fences |
| Operation admission/host | `apps/api/src/sync/operation_admission.integration.test.ts` | Atomic pinned admission and source/format ownership before native work |
| DAV owned CREATE/host | `apps/api/src/sync/caldav_shared_create_delivery.integration.test.ts` | Pending echo, owned adoption and guarded host completion |

Fixtures call production query/handler/adapter/runtime functions and replace
their existing native HTTP boundaries. A test's synthetic input does not certify
a live provider. These are host-owned storage semantics; the standalone CLI has
no general import/coverage/echo implementation and does not inherit them.

Capture the exact source commit/tree, commands, exit statuses and sanitized raw
log hashes. All six programs and applicable current-head CI must pass. The local
acceptance report records the actual disposable database owner and cleanup;
source publication and production deployment are separate evidence. The tests
are reusable independently during development without starting the whole app.
