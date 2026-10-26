# MUSU-40 · C08 family inventory

Aktualizováno 26. října 2026. Tento seznam je pracovní acceptance inventář celé
C08, nikoli tvrzení o produkčním nasazení nebo nové provider schopnosti.
Vychází z reálných dispatch větví, capability matrix a původních důkazů.

## Dokončení

C08 vyžaduje zachování home authority a bohatšího task contentu, original
occurrence slots, DAV resource/Graph family hranic, samostatných provider a
notification faktů a read-only obnovy uncertain RSVP/organizer operací.
Každá podporovaná větev musí mít explicitní lifecycle a ověřenou parity;
zbývající compatibility či unsupported profil se nesmí označit za portable.
Nasazení zůstává společným navazujícím krokem po implementaci a ověření.

## Rodiny a pořadí

| Gate | Stav | Hranice |
| --- | --- | --- |
| Task ACK | Main, PR #380 | Current locked claim, DB-clock lease, cancellation, mapping CAS a rollback |
| Google Task addressed UPDATE | Main, PR #381 | Saved mask, původní ID/tag/baseline, samostatný reference ledger |
| Google Task addressed DELETE | Main, PR #382 | Raw DELETE response versus scoped GET absence; retained binding/history |
| Google Task CREATE | Main, PR #383 | Generated ID; unknown/no-ID HOLD; API parity a strict reference mají oddělené důkazy |
| Google causal UPDATE/DELETE | Source/local-installed/app gate ověřen; čeká PR/CI | [Causal gate](MUSU-40-google-task-causal.md): immutable NULL admission, spárované predecessor ID/tag/baseline a vlastní reference queue |
| Google CREATE s předchůdcem | Čeká | Samostatná lineage/recurrence compatibility; chybějící adresa successor UPDATE se nikdy nezmění v nový CREATE |
| VTODO UPDATE/DELETE | Čeká | Úplný resource, URL/UID, silný ETag, privilege proof, maska a původní baseline |
| VTODO CREATE/causal flow | Čeká | Task-UUID URL/UID, If-None-Match, read-only uncertain recovery a retained deletion |
| To Do CREATE | Čeká | Existující home/independent-copy chování, response-address-only recovery |
| To Do UPDATE/DELETE | Čeká compatibility extrakce | Zachovat home chování a odmítnutí secondary live writes; portable conditionality zůstává neprokázaná |
| Generic event leftovers | Čeká audit lifecycle | Graph/DAV personal UPDATE a dosavadní all-day/legacy time profily; žádné nové generic known-time writes |
| Google one-off reminders | Čeká | `reminderEdit`: defaults/off/custom s ochranou ostatního contentu |
| Google instance reminders | Čeká | `reminderInstance`: exact stored original slot; off/custom, nikoli nové defaults |
| DAV alarms | Čeká | `caldavAlarm`: povolený jednoduchý DISPLAY alarm; zachovat ostatní resource bytes |
| Google personal occurrence | Čeká | `googleOccurrence`: generated/stored zoned/all-day edit/cancel, původní slot a master |
| DAV scoped resource | Čeká | `caldavSeries` update/occurrence/restore a `caldavSeriesDeletion` celého resource |
| DAV following split | Čeká | `caldavSplit`: dva journaled kroky, bez slepého opakování po nejasném výsledku |
| Graph family CREATE/adoption | Čeká | `graphSeriesCreate`: bounded finite family, transaction correlation, complete ACK |
| Graph family DELETE | Čeká | `graphSeriesDeletion`: scope/survivor proof, read-only uncertain recovery |
| Graph occurrence/series content/time | Čeká | `graphOccurrenceContent`: personal/organizer, původní sloty, exceptions, cancellation a time-model hranice |
| Graph move coordinator | Čeká parity | Pořadí nejvýše 20 journaled children, stop po uncertain child, partial results |
| Organizer Google/Graph/DAV | Čeká po providerech | `organizer`: durable possible-notification marker, oddělená acceptance a outcome, no resend |
| Graph recurring meeting cancel | Čeká | `graphMeetingCancellation`: finite family/occurrence a existující reprezentace, nikoli CAS |
| RSVP Google/Graph/DAV | Čeká po providerech a scope | `rsvp`: actor, baseline, original slot, imported/tracked family hranice; po dispatch čtení |
| Závěrečný cross-family audit | Čeká | Úplnost podporovaných větví, explicitní legacy/unsupported matrix, upgrade/crash/installed/UI a nezávislá revize |

Tabulka nezavádí podporu Google/To Do recurrence, task move/hierarchy/reorder,
nových meeting scopes nebo dosud nepodporovaných časových modelů. Existující
home recurrence a odmítnutí více lossy provider projekcí se musí zachovat.
Portable To Do UPDATE/DELETE se nepovyšuje na CAS na základě Google testů.

## Důkazy a zdroje

Každý slice začíná nejmenším produkčním JSON scénářem. Dependency port fixtures
neprokazují SQL, skutečnou autentizaci ani live provider chování. Změněné hranice
potřebují skutečné PG/HTTP/process testy; instalované obrazy mají vlastní source
fingerprint a upgrade/crash důkazy. Běžící aplikace se ověřuje na závěr.
Publikace a produkční rollout mají samostatné evidence.

- [Roadmap C08](sync-refactor-roadmap.md), [původní RF07B gate](refactor-cycle-proposal.md).
- [Task authority](../sync/shared-tasks.md) a [capability matrix](../../packages/docs/src/content/docs/operations/capabilities.mdx).
- `apps/api/src/sync/task_delivery.ts`, `google_shared_task_{update,delete}_delivery.ts`, `provider_profiles.ts`.
- `apps/api/src/sync/event_delivery.ts`: 13 specialized discriminantů a jejich skutečné větve.
- `packages/db/src/queries/task-outbox.ts`: causal barrier a paired predecessor evidence.
- [Runtime návrh](../research/nylas/05-protocol-and-plan.md): typed evidence/query helpers mohou zůstat za host porty; nikoli stringly typed fallback.
