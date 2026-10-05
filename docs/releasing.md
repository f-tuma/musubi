# Releasing

Three things ship on their own clock — the API, the web app, and a phone build
— and they have to keep talking to each other across the gaps. This is what
keeps that true.

## The one asymmetry everything follows from

**A phone build cannot be patched.** There is no `expo-updates` in this project,
so no OTA channel: every install carries the code it was built with until its
owner updates from the store. Apple review takes days, Play rollouts are
staged, and some people never update at all.

The API and the web app, by contrast, are a redeploy away.

So the rule is not "keep the clients current". It is **the server keeps working
for clients it can no longer change**.

## Explicit event-time activation

The owner approved explicit event-time editing, supported organizer operations,
provider RSVP and iCloud personal content writes for the coordinated **0.2.0**
release on 2026-09-14. The unpublished 0.1.8 candidate is superseded; no
intermediate 0.1.8 tag is planned. iCloud attendee RSVP remains deferred.

Production startup requires product/client/peer compatibility at **0.2.0 or
newer**, with the product satisfying both enforced minimums. Older writers can
lose explicit time metadata when copying events. Replace preliminary 0.1.8
clients with final 0.2.0 builds and coordinate the server, web, native and
connected peer rollout described below.

Flags remain off by default. The selected activation values, supported provider
scope and outstanding live/device checks are recorded in
[Core 0.2.0 activation](releases/core-0.2.0-activation.md). Permission, native
identity and operation-specific checks still apply with flags enabled.
Changing the compatibility boundary does not certify untested provider paths
or deploy production configuration.

## Order of deployment

**API → web → store build.**

Each step is additive, so the step before it keeps working:

1. **API first.** It only ever adds — a new field, a new endpoint, a new
   accepted value. Yesterday's web app and last month's phone are untouched.
2. **Web next.** It is always served fresh, so it can use whatever the API just
   grew. It never runs ahead of the API.
3. **Phone last**, and it may sit in review for a week. By the time it lands,
   everything it needs has been live for days.

Going the other way — a client that needs an endpoint the server has not
deployed — needs a feature flag or a capability check, not a careful eye on the
deploy order.

## 0.2.2 task protocol boundary

The [0.2.2 release runbook](releases/0.2.2.md) records an exception to additive
rollout: released 0.2.0/0.2.1 task write routes receive 426 before saving. Reads
and compatible event/calendar functions remain available, but every native task
write needs a 0.2.2 store build. Keep both global compatibility floors at 0.2.0;
do not turn this task-specific boundary into a whole-app lockout.

API → web → native distribution remains the order, but deploying API before the
store build accepts a temporary native task-write gap. Stop the old API before
starting the new one. The shared-task migration and old provider writers make
an image-only rollback unsafe; keep a verified preupgrade database backup and
follow [deployment and recovery](releases/0.2.2-deployment.md). A release tag is
Dokploy's deployment signal, so prepare backup and maintenance before publication.

## K06 coordinated compatibility break (prepared, not deployed)

The coordinated release is **0.2.0**. The former 0.1.8 development version was
not published; historical QA records do not represent a released artifact.

The owner approved raising **both client and federation peer floors to 0.2.0**.
Prepare server, web and native together; do not enable this deployment until
compatible clients and connected servers are available. This explicitly
supersedes the normal additive API→web→phone order above. No publishing,
production migration or deployment is authorized by this implementation.

All authenticated product API reads and writes require
`x-musubi-client-version: X.Y.Z >= 0.2.0`, including member-token requests,
uploads, ICS and streams. Browser EventSource alone uses
`/api/stream?clientVersion=0.2.0` because it cannot set headers. Missing/malformed
or old versions receive 426, not an authentication failure or a forced reload
that discards a draft. The header is compatibility evidence, **not authorization
or a substitute for event expected-revision validation**.

Exemptions are existing public discovery/health, Better Auth/bootstrap and OAuth
callbacks, public invite previews/deep links, account-confirmation pages/token
confirmation, universal-link metadata and public avatar reads. Public federation
accept additionally requires the compatible requester version before issuing a
member token. The only authenticated exemption is
`POST /api/v1/federation/token/rotate`; its handler still requires the existing
external member credential and only rotates that credential. There is no blanket
member-token exemption. Old peer handshakes and product requests are refused;
unknown/unreachable peer versions do not establish compatibility. Existing
connections and cache records are retained, never silently deleted.

Gateway requests forward the **actual calling client version**, never replace
it with the home server's version. Server-originated federated SSE identifies
its own product version. Established peer connections are checked before
forwarding product requests/connecting streams as well as at handshake.

The additive revision column can remain through an application rollback, but
rolling back to revision-incapable writers invalidates CAS protection; do not
advertise safe mixed-version writes. Full K06 enforcement/draft/provider work
must be completed and reviewed before this prepared rollout can be accepted.

## What the machine checks

`pnpm check` runs all of these; nothing below needs remembering. In CI they are
also their own job — **Old client compatibility** — so a break says what it is
without anyone opening a log.

### The wire contract

`packages/types/contracts/wire.json` holds the shape of every document that
crosses the wire, promised as of the release named inside it.
`packages/types/src/wire.test.ts` compares it against the schemas in the code
and fails on anything a client built against the promise could not survive.

Breaking is not symmetric, so the rule follows the direction:

| Direction | May | May not |
| --- | --- | --- |
| **read** (server → client) | add a field, always send one it used to omit | remove a field, change one, start omitting one it always sent |
| **write** (client → server) | accept a new **optional** field | require a new field, tighten an existing one, turn the schema strict |

Widening an enum counts as breaking in both directions: a client that validates
rejects a value it has never heard of, and the web validates every response.

Adding to the wire is silent, because that is how the product moves. Only
narrowing speaks up.

**When the test fails**, it names each break. Then either the change was not
meant to be breaking — fix it, usually by making the new field optional — or it
was, and you:

1. raise `MIN_CLIENT_VERSION` in `packages/types/src/version.ts` to the release
   that fixes it, knowing this locks every older install out until its owner
   updates;
2. run `pnpm wire:snapshot` to re-baseline.

Do not re-baseline to make a red test green. The snapshot is a promise to
software you cannot reach. Step 1 is not optional either, and the test now says
so: a snapshot dated *V* while `MIN_CLIENT_VERSION` is below *V* means builds
that cannot survive the change are still being let in.

### The addresses, not just the shapes

`scripts/check-routes.mjs` reads every `/api/…` URL that production code in
`apps/client` and `apps/web` builds, and fails if one does not resolve to a route
registered in `apps/api/src/index.ts`.

The wire contract guards what a document looks like. Nothing guarded where it is
sent — a path is a string on one side and a string on the other, so renaming
`/api/v1/calendars/:id/export` type-checks, passes every schema test, and is a
404 on every phone already installed.

A route may gain a sibling. It may not lose its name. If a path genuinely has to
move, register both and retire the old one a release after `MIN_CLIENT_VERSION`
passes it.

### The live-update frames

`scripts/check-realtime.mjs` compares the frame types the server emits over
`/api/stream` against the ones `apps/web/src/api/realtime.ts` and
`apps/client/hooks/useEventsStream.ts` handle, in both directions.

`type` is a bare string on both ends, so a rename compiles and deploys and then
fails invisibly: the socket stays open, frames keep arriving, none of them match
a case, and the calendar simply stops updating until the app is restarted.

The direction that matters most is **handled but no longer emitted** — a shipped
build listening for a name the server stopped sending. The phone frames the web
has no equivalent for are listed as `PHONE_MAY_IGNORE` in the script, with the
reason; the list is itself checked, so an exemption for a frame that no longer
exists fails too.

### What the phone does with a response

`apps/client/services/wire.ts` parses every document in the registry above
against the schema the build was compiled with, the way the web has always
parsed against `apps/web/src/api/contracts.ts`.

It does **not** throw in production, and that is deliberate. Musubi is
self-hostable, so "the server is older than the app" is ordinary: someone
installs today's build and points it at the server they set up last spring.
`minClientVersion` keeps an old app away from a new server; nothing keeps a new
app away from an old one. Refusing to render would kill the app for exactly
those people, so a mismatch degrades as it always did and is written into the
diagnostics the settings screen copies — which is how such a report reaches us
at all. In development it throws, because there it can still be fixed.

### What a browser tab does across a deploy

The service worker caches nothing, but a tab keeps running the JavaScript it
opened with, and people leave Musubi open for days.
`apps/web/src/api/use-newer-server.ts` compares the version compiled into the
bundle against the one `/api/v1/server` reports — a document the app already
fetches, so the check costs no request — and offers a reload when the server is
ahead.

It offers rather than reloads: someone may be halfway through writing an event.
It stays quiet when the server is *behind* the tab, because that is the
self-hosting case and there is no newer bundle to fetch. And because a release
lands API first and web second, the tab remembers which version it already
reloaded for — otherwise the bar returns straight after a reload that could not
have helped yet.

### Federation, the fourth clock

The Musubi server at the other end of a connection updates when its owner
decides to, and nothing here can make that happen. Two things follow.

`MIN_PEER_VERSION` in `packages/types/src/version.ts` is the floor. Connecting
reads the peer's `/api/v1/server` first and refuses below it **by name** — "that
server runs Musubi 0.0.9" — instead of letting the handshake fail with
"that server rejected the invite", which explains nothing.

It refuses on nothing else. A peer that names no version, answers with an
error, or cannot be reached is allowed through: the handshake that follows is
the real test, and turning every unfamiliar server into a dead end would cost
more than it saves.

The Connections dialog shows what each connected server is running, read live
through the gateway — no new route, no credential in the browser. A version
nobody can see is a difference nobody can diagnose.

### Version metadata

`scripts/verify-release.mjs` asserts that `PRODUCT_VERSION` in
`packages/types/src/version.ts` matches the root `package.json`, that
`MIN_CLIENT_VERSION` is not ahead of the product, and that the contract
snapshot is not ahead either.

The API mirrors the version rather than importing it because it ships as a
`pnpm deploy` closure with no repository root above it. Nothing enforced that
mirror before, and the server spent two releases announcing itself as 0.1.3
while the product was 0.1.5.

### Release announcements

User-facing release notes ship to every upgraded server as a custom migration:

```bash
pnpm --filter @musubi/db exec drizzle-kit generate --custom --name release_X_Y_Z_announcement
```

Insert one concise announcement with `min_version` set to the release. The API
can deploy first: older clients filter the row without marking it as seen, then
show it on their first start after updating. No server admin action is needed.
Keep only changes users will notice; GitHub generates the complete engineering
changelog separately.

Announcement IDs share their date namespace with admin-written messages, so the
migration must choose an ID lexically greater than existing same-day IDs,
not just a free suffix. Read markers compare strings: suffix `10` sorts before
`9`; the allocator extends the highest suffix at that boundary (for example
`9` to `90`). Preserve admin messages and read markers.
The 0.1.7 migration also initializes the empty marker for accounts that predate
the announcement feature. That is a one-time bootstrap and must not be repeated
in later releases; new accounts intentionally baseline past old news.

## Migrations: expand now, contract later

`migrateDatabase()` runs at API boot, so **rolling back the image does not roll
back the schema**. A release that drops a column cannot be undone by redeploying
the previous one.

Split every destructive change across two releases:

- **Expand** — add the nullable column, backfill it, write to both. Ships with
  code that tolerates either shape.
- **Contract** — drop the old column. Ships only once the expand release has
  been live long enough that you will not roll back past it.

Never ship the drop in the same release as the code that stops using the
column. `0049_drop_show_kanji` did exactly that and got away with it only
because nothing anywhere read the column — it is the exception, not the model.

## Things still worth doing
