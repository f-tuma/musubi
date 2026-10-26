# Work from intent to operation

Choose depth by impact. Light changes need a clear scope, diff and relevant verification. Standard behavior changes need observable scenarios, a proportionate design, checkpoints and review. Permission boundaries, migrations, money and public contracts justify extra invariants, negative/integration cases, compatibility and recovery planning. Do not lower a profile to bypass a failing check.

| Step | Useful output | Decision or evidence |
| --- | --- | --- |
| Brief | Problem, users, scope, non-goals, assumptions | Owner's intended outcome and how to assess it |
| Research | Facts, source versions and bounded experiments | Resolve the uncertainties that affect the next decision |
| Specification | Observable main/error scenarios and relevant quality attributes | Expected behavior and verification method |
| Design | Actual boundaries, data, interfaces, alternatives, invariants | Fresh-context review and resolved blockers |
| Environment | Reproducible commands, isolated data, baseline failures | A new session can reproduce the relevant starting point |
| Plan | Small checkpoints linked to requirements | Expected result, checks and return condition |
| Implementation | One reviewable change | Production-logic tests, affected UI/integrations and review |
| Verification | Requirement-to-evidence map | Actual outcomes tied to the checked subject |
| Polish | Usable states, consistent design and useful copy | Relevant interaction, accessibility and first-use observations |
| Integration | Consistent code and canonical sources | Required checks and review of the final combined state |
| Release | Source, artifact, configuration and recovery | Appropriate authorization and observed publication/deployment |
| Operation | Smoke checks, signals and feedback | Findings become new bounded changes |

OpenSpec, if selected, owns `openspec/specs/` and a change's proposal/specs/design/tasks. Prefer its generated structure for the installed version. Custom templates here supplement content; they are not its validated schema. `/opsx:verify` availability/naming depends on host/profile and does not itself enforce archive or merge gates.

Use the same canonical technical design for EGM-inspired review. A fresh reviewer sees the artifact, requirements and relevant code without the author's conversation. If only self-review is available, state that limitation. Fix a design finding in design, an implementation fault in code, and a changed intent in accepted requirements before continuing affected work.

Reuse established patterns and code. Document a meaningful choice once; links carry it to other artifacts. Do not load every reference in every prompt. Repository instructions govern actual permissions and required checks. In solo work, role names do not imply multiple independent humans or permanently running agents.

The future factory can orchestrate these modules once the workflow works. Its board status cannot substitute for evidence. The initial plugin has no automatic lifecycle hooks, MCP server or factory adapter.
