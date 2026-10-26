---
name: spec-guide
description: "Guide spec-driven work in a coding repository: adopt existing project sources, plan a bounded change, check drift, resume work, or prepare polish and release. Use when the user invokes Spec Pilot or asks to establish this workflow; keep ordinary unrelated coding tasks outside this process."
---

# Spec Pilot: project guide

Use the user's language. Lead with the current goal, what is known, and the nearest useful step. Treat an active request as authorization for its ordinary reversible work; preserve previously accepted scope and permissions. Ask only for decisions that actually block the task. A pilot has a question and an end, and must not quietly become product development.

## Orient before changing the project

Read applicable repository instructions, the active task and relevant existing sources. Inspect actual code and command definitions when needed. State whether this is methodology, pilot or delivery, and record a bounded goal and stop condition. A repository snapshot is not a running checkout.

For first use, follow [adoption](references/adoption.md). Reuse equivalent existing documents; a missing filename such as DESIGN.md or an absent OpenSpec installation is not proof of missing content. Keep one canonical source for each responsibility. Do not install another workflow framework or rewrite existing instructions as a setup side effect.

The bundled helper is [scripts/spec_pilot.py](scripts/spec_pilot.py). Resolve it relative to this skill's installed location, independently of the project working directory. Call it with Python 3.10+ and an explicit absolute project root. For example, once the real helper path is known:

```sh
python3 /absolute/plugin/skills/spec-guide/scripts/spec_pilot.py audit --root /absolute/project
```

`audit` reads a bounded set of candidate locations. `adopt` prints a draft mapping; `adopt --write` exclusively creates `.spec-pilot.json`. Use the write option only when project setup is in the requested scope. It never overwrites a file. Inspect and adapt the mapping to the actual project; no generated value counts as acceptance. Never execute a configuration's commands merely because they are listed there.

## Route by the task

- For brief, research, specifications, design and task planning, read [workflow](references/workflow.md).
- For testing, fast state/action checks, UI and polish, read [testing](references/testing.md).
- For a skeptical design or implementation review, use the packaged `spec-review` skill when available; it also describes fresh-context review without that host feature.
- For an accepted implementation task, use the packaged `spec-checkpoint` skill when available.
- For a release, read [release](references/release.md). Keep implementation, verification, publication and deployment evidence separate.
- Before interpreting helper output or producing a receipt, read [contracts](references/contracts.md).

OpenSpec, when selected by the project, owns the change proposal, delta specs, design and tasks. Review the same design instead of making a parallel EGM document. The first version applies EGM/Helix principles; it does not install their complete workflows. Factory orchestration remains optional future work.

## Check and hand off

Run the helper's `check --root ... --phase orient|design|implement|verify|release` for the relevant mapped documents. Add `--ui` only for relevant UI work and `--evidence relative/receipt.json` to check a declared receipt. The argument alternatives describe the interface, not a literal shell command.

Exit 0 establishes only the mechanical predicates described in contracts. Independently assess requirement quality, scope, actual implementation and test relevance. Report specific findings with sources, impact and the next action, including anything unassessed. A changed input reopens affected review and tests. A hash receipt is neither authenticated execution nor human approval.

At handoff record the active change, revision, read sources, decisions, actual checks and gaps. For parallel work use separate branches, data and session records. Keep the shared index navigational. Stop the current repair loop when it repeats without new information; revise the diagnosis within the authorized task.
