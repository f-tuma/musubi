# Spec Pilot: bounded Musubi adoption

Date: 2026-10-26. Plugin version: 0.1.0. Mode: pilot.

## Goal and end

Prepare a portable local plugin for Claude Code and Codex, map Musubi's existing project sources, exercise the mechanical checks and recommend one small next checkpoint. This pilot ends at that recommendation and the reviewable plugin change. It does not initiate a product feature, provider operation, publication or production deployment.

The source inventory was read at Musubi revision `27639ade96ed0251377b93a5514123b43d3cc7bc`. Local validation used a selected-file snapshot: 11 regular files and the `CLAUDE.md` symlink. Their Git blob hashes were checked against the pinned tree. This is not a complete working checkout or evidence of product tests. The proposed `.spec-pilot.json` is an overlay in the validation copy, not a claim that the upstream revision already contained it.

## Existing authorities

| Responsibility | Source | Interpretation |
| --- | --- | --- |
| Agent instructions | `AGENTS.md`; `CLAUDE.md` aliases it | Map the regular canonical source once. Keep independent final review and current-head CI requirements. |
| Project intent | `README.md` | Starting overview; it does not supply every acceptance decision for a new feature. |
| Architecture | `packages/docs/src/content/docs/architecture/overview.mdx` | Reuse the maintained contributor map. |
| Behavior | `docs/sync/README.md` and the applicable domain contracts it links | Select the relevant contract for an actual change. Do not duplicate the whole domain in a new spec. |
| Fast tests | `docs/testing/behavior-scenarios.md`, `package.json` | Use the actual scenario inventory and existing production-code drivers. |
| UI design | `docs/ui/design-system.md`, scoped Musubi UI skill, `packages/design-system` | Existing token authority and components. A new DESIGN.md is unnecessary for adoption. |
| Release | `docs/releasing.md` and current release records | Reuse the runbook; validate actual current state for any release task. |

The helper scans selected candidate locations. Its inventory is not an exhaustive documentation audit. A scoped task still needs relevant actual code, tests and decisions. OpenSpec integration is not installed by this pilot; adoption first establishes canonical ownership. The plugin supplies workflow guidance without replacing Musubi's existing contracts or task tracking.

## Local checks

- Standard-library plugin unit/package suite: **33 tests passed** on Python 3.12.14. Cases include missing/empty content, equivalent document names, the canonical instruction alias, rejected traversal/symlinks and malformed paths, no-overwrite setup, stale inputs/artifacts and the distinction between mechanical and semantic outcomes.
- All three skills passed the available skill frontmatter validator.
- Read-only inventory over the pinned source snapshot was performed. It reused the existing design system and test command definitions.
- In the validation copy, the explicit project mapping and relevant visual design role are checked mechanically. `semantic_result` remains `unknown` even when those checks pass.
- Negative trials performed in the isolated validation copy: a changed declared subject was rejected as stale evidence; a missing mapped document was rejected. The current declared receipt matched its selected input/output hashes. These are helper checks, not evidence about live providers, the database or the application UI.

A fresh agent used the packaged guide against the unmodified snapshot. It mapped the existing sources, distinguished the sync-contract index from a task's accepted specification, and correctly reported missing `.spec-pilot.json` as pilot setup rather than a product failure. It reported missing production sources and declined to infer executed application tests. This exercises the guidance in a new agent context, not a native Claude/Codex plugin load.

Raw local validation outputs are working evidence outside the source change. CI runs the plugin test suite and the orientation mapping against its actual checkout. Its observed result for the PR revision remains separate from these local results.

## Native client trial

| Surface | Status |
| --- | --- |
| Python helper and package checks | Executed locally as described above |
| Guidance used in a fresh agent session | Orientation over the pinned snapshot; no native plugin-loading claim |
| Claude Code plugin load and invocation | NOT_RUN in this authoring environment |
| Codex plugin load and invocation | NOT_RUN in this authoring environment |
| Musubi application, browser, database and provider checks | NOT_RUN; no product implementation in this change |
| Publication, deployment and smoke checks | NOT_RUN |

Follow [the plugin README](../../plugins/spec-pilot/README.md) for both clients. Verify that `spec-guide`, `spec-review` and `spec-checkpoint` actually appear before treating installation as complete. Use the same bounded orientation prompt first. Record the installed client version, actual skill name, result and limitations. The absence of a supported loading capability is a client limitation, not permission to invent a successful run.

## Next checkpoint

Use the first native session to verify project orientation and a useful handoff. Then, in a complete checkout, read the existing `google-delete` scenario and its production-code driver and run only:

```sh
pnpm test:behavior --suite google-delete --scenario already-absent --json
```

The documentation identifies this as a service-free scenario. Confirm its implemented expectations and replaced boundaries before interpreting the output. Record the actual return code, JSON result and limits, then end this checkpoint without product changes. The next accepted implementation task can subsequently traverse design, isolated review, a small change and relevant tests.

The orientation agent also flagged a possible stale comment about `pnpm check` and build execution in the existing quality workflow. The package script definition is authoritative; verify that observation as separate maintenance work instead of expanding this pilot.
