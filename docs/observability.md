# Observability

The maintained metrics, logging, dashboard, incident, and scaling runbook is
[`packages/docs/src/content/docs/operations/observability.mdx`](../packages/docs/src/content/docs/operations/observability.mdx).

Published version: <https://musubi.pro/docs/operations/observability/>

For v0.2.2 acceptance, distinguish inventory from delivery: event-outbox metrics
do not measure the task queue, missing labeled series do not prove empty queues,
and usage-snapshot success does not certify an outbox refresh. The runbook records
these limits and the unverified notification receiver test separately from a
healthy scrape or a `Normal` alert state.
