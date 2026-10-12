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
working OAuth review tracker.

Current entry points:

- [Sync refactor roadmap and Its a Plan issue mapping](./planning/sync-refactor-roadmap.md), ordered phases without fixed dates and the future Calendar Relay context (2026-10-12).

- [Provider sync research: Nylas, Musubi and alternative architectures](./research/nylas/README.md), including a proposed open-source protocol and implementation plan (2026-10-12).

- [Shared tasks](https://musubi.pro/docs/guides/shared-tasks/) and their
  [implementation contract](./sync/shared-tasks.md).
- [Capabilities and verification](https://musubi.pro/docs/operations/capabilities/)
  for current provider boundaries and outstanding live/device checks.
- [Releases and upgrades](https://musubi.pro/docs/operations/releases/) and the
  [v0.2.2 deployment/recovery runbook](./releases/0.2.2-deployment.md).
- [Unpublished 0.2.3 candidate notes](./releases/0.2.3-notes.md) and
  [candidate deployment/recovery preparation](./releases/0.2.3-deployment.md).
  Published artifacts remain v0.2.2; preparation does not publish or deploy them.
- [Storybook](../apps/web/.storybook/) and colocated stories are the visual
  reference; the removed screenshot catalog is not maintained.
- [Android widget rework proposal](./ui/proposals/android-widgets.md) records
  current loading/refresh defects and the proposed Agenda, Calendar and Tasks
  work. It is a plan, not a shipped implementation.

Dated audits retain the state of their original investigation. Use the current
capability matrix and implementation contracts when deciding what is supported
today. A build passing is syntax verification, not proof of deployed docs,
provider delivery or physical-device acceptance.
