---
name: spec-review
description: "Skeptically review a proposed design or final diff against requirements and actual code, preferably in a fresh context. Use for Spec Pilot design or checkpoint review and when repository instructions require an independent review."
---

# Spec Pilot: fresh-context review

Read the relevant repository instructions. Identify the exact review subject, revision or file hashes, requirements and review scope. Use the user's language. This is an EGM-inspired review procedure, not a claim that the official EGM plugin ran.

If the host can start an independent agent with a fresh context, give it the canonical design or final diff, requirements, applicable repository rules and access to actual relevant code. Do not pass the author's conversation, expected findings, preferred answer or your diagnosis. Ask it to review the task, not role-play a test. The reviewer reads the artifact and examines the code itself. Do not call multiple personas in the same conversation independent review.

If isolation is unavailable, perform a clearly labelled self-review or prepare a handoff for a fresh session. If the repository requires independent approval, the self-review cannot satisfy that requirement. Continue useful preparation and report that exact remaining condition.

Explain the proposal's behavior and boundaries in your own words. Check consistency with accepted requirements, real files/interfaces, simpler existing solutions, failure and permission boundaries, compatibility and testability according to impact. For a final diff also inspect tests, changed expectations and CI, existing architecture and relevant UI evidence. Do not invent problems to fill a quota.

Report concrete findings with ID, location, evidence, impact and next step; distinguish blockers, decisions and recommendations. Include access limitations and unassessed areas. Use the [review template](../spec-guide/assets/review.md) when a durable report is useful.

Review does not change implementation or product intent. Resolve findings through fixes, evidence-backed dismissal or an owner decision. Re-review materially changed subjects and scope. Explicit approval applies only to the exact reviewed version and review question; it does not prove test execution or authorize publication. See [contracts](../spec-guide/references/contracts.md).
