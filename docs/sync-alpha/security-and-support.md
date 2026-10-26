# Security and support proposals

Status: ready for owner decision, not an active public support promise.
No security mailbox, response SLA or supported-version window has been selected
by this technical candidate.

Proposed policy for review:

- Use a private vulnerability reporting channel enabled and verified by the
  repository owner before public release. Publish its working contact and who
  monitors it; do not ask reporters to post tokens, calendars or personal data
  in public issues.
- Request the candidate digest, affected profile, sanitized reproduction,
  expected/actual authority or dispatch behavior and impact. Treat credential
  exposure and cross-account access as sensitive. Coordinate disclosure with
  affected operators; a target response time requires an explicit owner promise.
- Offer experimental, best-effort support only for the exact documented runtime
  and profile matrix until a maintenance/version policy is accepted. Pin the
  candidate artifact and lockfile; do not infer compatibility from a shared name.

Owner decisions still required: public project/package naming and distribution;
release numbering; confirmation of license/notice handling for that distribution;
the private reporting channel and responsible maintainer; support scope,
compatibility window and disclosure/response commitments.

| Decision | Concrete proposal for owner review | Current state |
| --- | --- | --- |
| Distribution/name | Keep existing private workspace names and review source-commit alpha archives before offering any public package | No registry release approved |
| Candidate identity | Identify each technical snapshot by its full source commit and archive SHA-256; select public semver only when a distribution contract is accepted | No public version chosen |
| Own-code license | Retain the repository's existing MIT text and original copyright, with the actual dependency notices and closure inventory attached for review | No replacement license selected; compatibility review pending |
| Private contact | Have the repository owner enable and verify a private advisory/reporting channel and name its responsible maintainer before advertising it | No active channel or mailbox claimed |
| Support | Experimental best-effort support for the exact tested artifact/runtime/profile matrix, with no SLA until the owner makes a commitment | No maintenance or response-time promise |

Operational facts: credentials are host-owned and excluded from operation
envelopes and receipts. The reference host encrypts its separate credential store
with its own key; it has no token refresh. Production credential storage,
rotation, backup, network controls and incident response remain operator duties.
Tests use explicit disposable databases and synthetic native fixtures. No live
provider, public registry or production deployment is performed by the alpha gate.
