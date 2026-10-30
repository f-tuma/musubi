# Adopt an existing project

1. Establish the user-selected repository, current goal, revision and access. Read its instructions before mutations. Preserve the distinction between a complete checkout and a selected-file snapshot.
2. Run the bundled helper's `audit` with an explicit root. Read the actual sources before judging their content. Audit candidates are hints, not an exhaustive scan.
3. Map responsibilities: intent, instructions, architecture, behavior, design, commands, active change and release. Prefer an existing canonical document or package. An introduction README can be a starting brief while leaving scope and acceptance questions open.
4. Reuse native test runners, design tokens, component catalog, CI and task tracking. Do not add a second generic test runner, token source or workflow authority. Follow scoped UI skills.
5. If setup is authorized, create the proposed mapping with `adopt --write`, or construct it from the verified mapping. Existing mappings must be edited intentionally. Set the actual goal and stop condition, not an invented product objective.
6. Fill only gaps needed for the next task. Do not copy every template into the project. Mark assumptions and decisions separately. Choose OpenSpec integration only after mapping existing specs and ownership; do not migrate historical records as a setup side effect.
7. Select a small trial with clear input, expected output and end. A first orientation trial ends with the mapping and one next-step recommendation. A later technical trial should traverse one accepted change, review, implementation and relevant checks.

`.spec-pilot.json` is a thin index and bounded session context, not another requirements database. Its `documents` values are nonempty lists of repository-relative file paths. Map a design-system document and token sources under `visual_design` when they fulfill that responsibility; a literal DESIGN.md file is optional. The `checks` values are argument arrays for humans/agents to inspect, never automatically executed by this helper.

Use a separate work-session record for each concurrent stream. Do not overwrite a shared goal with the most recent agent's task.
