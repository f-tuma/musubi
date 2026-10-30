# Prepare and observe a release

Read the project's real release runbook and current task. Prepare concrete reviewable changes before requesting any genuinely required remaining authorization. Reuse authorization already given; do not introduce a ceremonial permission step for an authorized action.

Identify final source revision, passed applicable checks, known gaps, built artifact digest, toolchain, configuration references without secrets, compatibility and rollout conditions. Consider data migration, backup/restore and rollback limits according to impact. Polish and user documentation should match the released behavior.

Record publication separately from deployment and post-deployment checks. A successful build is not publication. A published artifact is not an observed running version. Run applicable smoke scenarios and examine the relevant operational signals; record failures and recovery. Archive or board status does not establish these outcomes.

If the current task ends at a release proposal or rehearsal, stop there and label unperformed actions. Turn follow-up findings into scoped changes. Use the [release template](../assets/release.md) only when useful; the presence of a template proves nothing.
