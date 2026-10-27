Independent bounded C10 exact-source review, commit
d5402b174e5f1b5f4bd7913499bc7d726105825c, tree
5dfdb65bc56e278fa5c469f09ccd59cf540720c3, against baseline
f5004674d774fc55b628497ae6ad16d003c4d680. The initial workspace was clean.

Disposition: concrete cleanup finding remains; no exact-source approval yet.
Root subsequently coordinated source UNFREEZE for this and separate preflight
findings. This note does not approve those later edits, an installed candidate,
the final PR, publication or deployment. No tests, prepared modules, builds,
network, PostgreSQL or Docker were executed by this reviewer. Repository files
and Git state were not changed; only this requested /tmp note was written.

Open finding — Medium, owned outer fixture CREATE has an ambiguous-response
cleanup gap. apps/sync-reference/conformance/database-fixture.mjs:14–20 opens the
admin pool, chooses its fresh outer name, and issues CREATE DATABASE. Its catch
only closes that pool and rethrows. If the server creates the database and the
query reply then errors, referenceFixture never returns its cleanup handle.
scripts/sync-conformance.mjs:114/125 consequently has no fixture to clean; the
owned outer database can remain. The strong intent-before-SQL journal and real
allocation-crash negative cover secondary allocations, not this outer CREATE.
This does not create a false PASS: the gate fails, but ownership cleanup is
incomplete. Root has assigned the fix to the owner.

Bounded acceptance: use the real existing pg Pool port to execute a fresh owned
outer CREATE, then inject the reply error. Preserve the failed outcome, close
the issuer, reconcile only the known freshly owned outer name, and prove zero
sessions/plain DROP/absence. Do not adopt or drop an unrelated existing DB.
There is no need for a general backend-termination or unrelated-process policy.

Coordinated preflight findings reported separately by root while this review
was active: package pnpm-version lookup uses the wrong cwd; host child env
forwarding strips synthetic settings and ambient dotenv expansion is not yet
bounded. Those files require the new freeze and review after owner fixes. No
additional independent finding is claimed for them in this note.

The earlier preparation findings are addressed in committed d540 source:

- scripts/sync-alpha-common.mjs:51–58 canonicalizes existing parents and rejects
  existing/dangling leaves. verify-sync-alpha.mjs:52–54 validates both main and
  conformance report paths before execution; package-sync-alpha.mjs validates
  output outside the physical checkout before mkdir. The reported six passing
  focused tests include actual filesystem alias negatives; this reviewer read
  their source/log, did not rerun them.
- All reference DB fixture names now use the bounded namespace helper. It
  rejects overlong original prefixes and produces parent-owned63-character
  nonce names under conformance. The two CalDAV process names no longer rely
  on PostgreSQL identifier truncation.
- Secondary allocations fsync an intent before SQL, refuse direct unobserved
  Client allocation, and record CREATE/DROP transitions. Cleanup waits for
  issuer sessions, reconciles only its exact fresh namespace and keeps recovery
  failed. Source includes the real PG allocation-gap negative and paired
  account fixture, with supplied passing logs retained separately.
- Packaging and conformance execution now own Linux process groups, kill and
  wait on timeout/overflow, and reject unreaped groups. The orchestrator tracks
  interruption, runs cleanup and does not turn recovered work into PASS.
- Module receipts require named assertions/log labels/completion markers or
  explicit paired supplemental evidence in addition to the loaded sentinel.
  Source-expanded templates and imported assertion groups are pinned; full
  required/selected/result/totals, zero skip/TODO, child exit, cleanup and source
  binding are reconciled by the outer verifier.

Other source boundaries reviewed without an additional blocker:

- The frozen Git archive and separate prod/dev deploys use the existing pnpm
  mechanism. Production source/SQL and nondependency manifest semantics are
  compared to Git; mirror production bytes/manifests come from actual runtime,
  with archive-only test support separately recorded. Reference conformance
  support is removed from runtime and restored only to the test mirror.
- Bare dependencies resolve from runtime; owned mirrors are explicit. Literal
  import resolutions are realpath-bounded against tooling/checkout/host/dotenv
  fallback. This static audit is not advertised here as a dynamic-code sandbox.
  The external consumer uses six actual runtime entry points with the declared
  Node22/Linux/exact-TSX contract and separate compiler/@types paths.
- Original LICENSE is retained in candidate and both convenience Docker images.
  Actual production/tooling dependency declarations and retained text hashes
  are inventoried; the narrow matching-version esbuild text source is explicit.
  No legal compatibility conclusion or replacement license is selected.
- Original docs/protocol/research bytes and bounded package/reference/LICENSE
  aliases remain separate from exact-commit navigation for unembedded context.
  No registry availability or checkout runtime fallback is inferred.
- The ten matrix tuples match the existing reference runner/admission families:
  Google event CREATE/UPDATE/DELETE, Graph event CREATE/DELETE, DAV VEVENT
  CREATE/DELETE, Google Task CREATE/UPDATE/DELETE. Google operation-derived
  identity, Graph weak-tag/non-CAS and one-shot recovery, DAV exact URL/UID,
  Tasks provider-assigned CREATE identity and bounded task masks remain
  distinguished. Live conditional enforcement/notifications and deployment are
  explicitly unestablished. Specialized host families are not promoted.
- HOSTCOMPAT is correctly called a pure lifecycle lane. The six-file actual
  Musubi source-read/coverage/tasks/ACK/admission/DAV host DB gate is separately
  wired and documented, without turning reference CLI into a pull engine.
- Existing required CI lanes remain. The new candidate/conformance step runs
  only on integration shard1, with20-minute job budget and receipt-only artifact
  upload. No candidate archive, registry push or production rollout is added.
  Current-head CI duration and all21 outcomes still need actual evidence.
- Cross-account source uses real ReferenceStore/runtime/HTTP with identical
  native calendar/event IDs and weak ETags, preserves distinct correlations and
  connection-bound receipts, refuses foreign attempt/observation completion
  without partial mutation, and verifies denied-A does not authorize/block B.
  Trusted evidence-port capability limits are not overstated as arbitrary-byte
  or compromised-database detection.

Final source approval requires review of the newly frozen exact diff after the
coordinated fixes. Final PR approval remains later: installed artifact and full
source conformance, actual host/app evidence, hashes/cleanup, whole checks and
current-head CI are separate gates. Owner public naming/version/security/support
decisions remain proposals; this review creates none of those promises.
