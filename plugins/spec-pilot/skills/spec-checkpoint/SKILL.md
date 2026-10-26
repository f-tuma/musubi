---
name: spec-checkpoint
description: "Implement and verify one accepted Spec Pilot checkpoint with production-code tests, relevant UI and integration checks, review and revision-bound evidence. Use after a task and its intended behavior are sufficiently defined."
---

# Spec Pilot: implement one checkpoint

Read applicable repository instructions and the active accepted task. Identify requirements, expected observable behavior, actual boundaries and the relevant baseline. Use the user's language. Preserve previous authorization and the user's current objective; do not add a fresh approval gate for ordinary reversible work already in scope.

Choose a small reviewable checkpoint. Use the existing canonical OpenSpec change or project equivalent. Apply the risk-scaled [workflow](../spec-guide/references/workflow.md); a trivial fix may need a concise scope and targeted check rather than a document bundle. Missing files with our preferred names are not blockers when equivalent sources exist.

For a regression, reproduce the fault or establish a failing relevant test. For new rules prefer a behavioral test from accepted requirements. Implement through actual production boundaries. Read [testing](../spec-guide/references/testing.md), then run the smallest relevant project checks. Follow with affected integration and actual UI verification. A fixture-backed browser does not prove server/database/provider behavior. JSON is optional for state/action representations.

Compare the result with requirements before code-quality review. Use `spec-review` where available and honor repository-specific independent review requirements. Explain changes to tests, CI, snapshots and expectations. Fix concrete findings, repeat affected checks and obtain another review when the reviewed subject materially changes.

Record exact commands, results, revision, replaced boundaries and evidence limitations using [verification](../spec-guide/assets/verification.md). The helper described in [contracts](../spec-guide/references/contracts.md) can check declared document paths and hashes, not semantic correctness or authentic execution. Do not turn its exit 0 into a release certificate.

If a finding requires different product intent, surface the impact and update the canonical sources through the project's decision process. Repeated unsuccessful repairs without new evidence require a changed diagnosis. Finish at the checkpoint's stop condition, update the session handoff, and report what is actually implemented, verified or unknown. Follow repository git/PR rules. Release is a separate task covered by [release](../spec-guide/references/release.md).
