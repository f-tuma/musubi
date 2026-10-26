# MUSU-42 / C10 — standalone candidate and conformance

Status: implementation and verification in progress. No technical candidate,
public release, live-provider certification or deployment is accepted by this
document yet. C09 is published by PR #388, squash
`f5004674d774fc55b628497ae6ad16d003c4d680`, whose verified tree equals the
independently approved `a7d61d272978e54b919dea8f52194b3ed8b4640a` after all
21 current-head Quality checks passed.

The C10 artifact contract is a private Node 22/Linux source-ESM snapshot with its
exact resolved TSX, separate production closure and compiler/test material. It
does not promise a public npm or plain-Node JavaScript distribution. The
[alpha packet](../sync-alpha/README.md) states runtime, supported profile,
compatibility, license/provenance and owner-review boundaries.

The checked-in corpus separates portable deterministic scenarios, independent
reference PostgreSQL/process fixtures and pure host compatibility. Actual Musubi
coverage/echo/home storage has a [separate DB gate](../sync-alpha/host-database.md).
Module entries pin required assertion registrations/completion evidence; a loaded
module alone cannot establish a passing test. Provider facts come from actual
production kernels/adapters at existing ports, not a second sync implementation.

Packaging freezes an exact tracked commit, deploys with the existing frozen
workspace lock, checks Git→production→test-mirror parity and actual dependency
resolution, inventories license texts, and creates a reviewable local archive.
Tooling lives outside runtime import resolution. Candidate verification runs an
external consumer/typecheck/CLI and reconciles every required conformance ID.
Parent aliases, missing/skipped/TODO cases, candidate mutation and incomplete
owned resource cleanup fail the gate. These are implementation requirements;
final acceptance needs their actual reports.

Independent preparation reviews identified concrete false-PASS and cleanup gaps
before implementation: sentinel-only assertions, report/output parent symlinks,
CREATE/journal crash windows, overlong fixture DB names and unreaped descendants.
Their fixes require real parser, filesystem, process and PostgreSQL proofs.
All earlier unexecuted proposals remain preparation, never passing evidence.

Remaining gates: final fast/types/workspace checks; paired real cross-account
and cleanup failure-path tests; frozen installed candidate and complete corpus;
actual host DB gate; applicable running-app confirmation; independent final PR
approval; all current-head CI checks; protected squash/main verification.
Public naming/version/license/support/security-contact proposals remain ready
for owner decision. Production deployment is the requested later joint step.
