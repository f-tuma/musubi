# Musubi documentation

The canonical, searchable contributor and operator documentation is the
Starlight site in [`packages/docs`](../packages/docs/).

- Published documentation: <https://musubi.pro/docs/>
- Run locally: `pnpm docs:dev`
- Production build: `pnpm docs:build`
- Documentation contribution guide:
  <https://musubi.pro/docs/contributing/documentation/>

This directory also contains maintained implementation contracts in
[`sync/`](./sync/README.md), web design rules in
[`ui/design-system.md`](./ui/design-system.md), release runbooks and dated audit
evidence. These supplement the reader guides; they are not all compatibility
pointers. [`google-oauth-verification.md`](./google-oauth-verification.md) is the
working OAuth review tracker. Which file owns intent, protocols, UI, commands,
release facts, capability evidence and history is mapped in
[`project/brief.md`](./project/brief.md).

Current entry points:

- [Project brief and document ownership](./project/brief.md), and the accepted
  [workflow and sync convergence program](../openspec/changes/align-project-workflows-and-complete-sync/proposal.md)
  with its design, tasks and checkpoint briefs. Accepting the program is not
  implementation, merge or deployment evidence.

- [Fast JSON behavior scenarios](./testing/behavior-scenarios.md), service-free
  development checks followed by verification through the running web app.

- [Sync profile v1](./protocol/sync-profile-v1.md), the internal host-independent
  identity, time, capability, coverage and delivery evidence contract.

- [Sync refactor roadmap and Its a Plan issue mapping](./planning/sync-refactor-roadmap.md),
  a historical record (planned 2026-10-12, last updated 2026-10-25) of the
  completed C01–C10 phases and the future Calendar Relay context. Its
  "in progress" statements describe that date, not the current backlog.

- [Provider sync research: Nylas, Musubi and alternative architectures](./research/nylas/README.md), including a proposed open-source protocol and implementation plan (2026-10-12).

- [Shared tasks](https://musubi.pro/docs/guides/shared-tasks/) and their
  [implementation contract](./sync/shared-tasks.md).
- [Capabilities and verification](https://musubi.pro/docs/operations/capabilities/),
  the dated capability matrix reviewed for v0.2.2, with the provider boundaries
  and live/device checks that were outstanding at that review.
- [Releasing](./releasing.md) is the only current release pointer: the current
  published release, deployment order, compatibility floors and the general
  upgrade/recovery boundary. [Releases and upgrades](https://musubi.pro/docs/operations/releases/)
  keeps the dated release records and mobile compatibility notes.
- Historical release records: the [v0.2.2 deployment/recovery record](./releases/0.2.2-deployment.md),
  the [0.2.3 candidate notes](./releases/0.2.3-notes.md) and
  [0.2.3 deployment preparation](./releases/0.2.3-deployment.md). They retain
  their original scope and date; later releases and their acceptance records
  are listed in [`releases/`](./releases/) and linked from releasing.md.
- [Storybook](../apps/web/.storybook/) and colocated stories are the visual
  reference; the removed screenshot catalog is not maintained.
- [Android widget rework proposal](./ui/proposals/android-widgets.md) records
  current loading/refresh defects and the proposed Agenda, Calendar and Tasks
  work. It is a plan, not a shipped implementation.

Dated audits retain the state of their original investigation. Use the dated
capability matrix, the implementation contracts and the current release pointer in
[`releasing.md`](./releasing.md) when deciding what is supported today. A build passing is syntax verification, not proof of deployed docs,
provider delivery or physical-device acceptance.
