# Výchozí stav, autority a hranice důkazů

Datum průzkumu: 5. listopadu 2026. Výchozí commit: b138056218aab1e3b01b69d7e53b3713a553dfcd.
Jde o úplný checkout. Níže je statická revize a čtení uložených záznamů; nové live/provider/DB ověření neproběhlo.

## Převzaté zdroje

| Odpovědnost | Použitý zdroj | Jak s ním návrh pracuje |
| --- | --- | --- |
| Záměr a funkce | README.md; nový docs/project/brief.md | Brief zpřesňuje záměr; tvrzení README o aktuální verzi je zastaralé |
| Instrukce a UI | AGENTS.md; docs/ui/design-system.md; packages/design-system | Zůstávají povinné; nevzniká druhá sada komponent ani tokenů |
| Normativní sync význam | docs/protocol/sync-profile-v1.md, sync-operation-v1.md | Zachované identity, immutable projection, authority a recovery |
| Skutečné routery | apps/api/src/sync/event_delivery.ts, task_delivery.ts; packages/db/src/queries/operation-admission.ts | Důkaz současné portable/host/retained klasifikace |
| Produkční složení | apps/api/src/index.ts: initializeSyncEngine + bootstrapProviderBudget; work_coordinator.ts | Koordinátor a budget jsou již výchozí produkční cesta |
| C08 | docs/planning/MUSU-40-acceptance.md; MUSU-40-family-inventory.md; e75d5c79122b977e7e5cec28606c7d6879f0c211 | Merge je předkem HEAD; staré „čeká PR“ je datovaný stav, ne současný backlog |
| C09 | docs/planning/MUSU-41-acceptance.md; f5004674d774fc55b628497ae6ad16d003c4d680 | Merge je předkem HEAD; fair-work, budget a managed reads existují |
| C10 | docs/planning/MUSU-42-acceptance.md; 1cf603b1f44c1cd83659336e1afd671e314b2570 | Merge je předkem HEAD; privátní alpha a konformance existují |
| Alpha hranice | docs/sync-alpha/README.md, supported-matrix.v1.json, compatibility.md | Přesný Node22/Linux/TSX snapshot, 10 profilů; nejde o obecný pull host |
| Ověřování | package.json, scripts/test-behavior.mjs, ci-shards.mjs, .github/workflows/quality.yml | check/verify nejsou automaticky všechny CI/platformní gates |
| Current release a runbook | docs/releasing.md; packages/docs/src/content/docs/operations/releases.mdx; README.md; docs/README.md | docs/releasing.md již vlastní current index; CP01 ostatní povrchy převede na odkazy, nezaloží další index |
| Přispívání a setup | packages/docs/src/content/docs/guides/contributing.mdx, running-locally.mdx, onboarding.mdx; reference/commands.mdx; AGENTS.md | Zachovat existující role; opravit zastaralé příkazy a odkazy místo dalšího quickstartu |
| Provozní diagnostika | docs/observability.md a jeho Starlight cíl operations/observability.mdx | Rozcestník a incident autorita; ne nový paralelní runbook |
| Publikace | docs/releases/publication.md, scripts/quality-proof.mjs, verify-publication.mjs, docker-publish.yml | Zachovat přísnější deklarovaný kontrakt čerstvosti a oddělení runtime důkazů |
| Poslední záznam runtime | docs/releases/0.2.16-acceptance.md | Zdokumentované konkrétní vydání a scope; není nová live inventura |
| Audit | 11 nezávislých reportů, syntéza a oponentury z 5. listopadu na stejném HEAD | 81 pozorování + K-09 převedeno do audit-disposition.md; soukromé reporty nejsou nutné pro použití plánu |

## Co „nový sync“ již obsahuje

| Skupina | Doložené source směrování / hranice | Zbývající práce tohoto programu |
| --- | --- | --- |
| Google personal event CREATE/UPDATE/DELETE | Bounded pinned portable kernels + Musubi bridge | Inventář, regresní produkční složení, účinné routing a retention gates |
| Graph personal event CREATE/DELETE | Portable one-shot / guarded profily | Stejné gates; DELETE nepovyšovat na CAS |
| DAV personal event CREATE/DELETE | Portable conditional resource profily | Stejné gates; zachovat URL/UID a resource boundary |
| Google task CREATE/UPDATE/DELETE | Portable adresované a samostatný causal ledger; host fallback pro retained vstup | Explicitní kombinace adresovaných/causal/retained vstupů a exit criteria |
| Generic Graph/DAV UPDATE | Host compatibility se sdíleným lifecycle | Nevymýšlet portable UPDATE bez nového profilu; stabilizovat host port |
| Generic legacy/all-day/known-time vstupy | Dosavadní podporované compatibility nebo refusal podle profilu | Zachovat přesné vstupy, milliseconds a vybrané refusal; bez re-encode |
| VTODO / To Do lifecycle | Shared host compatibility; ne portable task profily | Zachovat home authority, resource/precision a To Do secondary-write refusal |
| 13 specializovaných event rodin | Shared compatibility lifecycle přes skutečné host/native porty | Audit jediného dispatch, tests a dokumentace; žádná nová capability |
| Outlook move | Retained koordinátor journalu se shared child lifecycle | Zachovat bounded děti, stop/partial a pozdní ACK |
| Pull/discovery/budget/OAuth | C09 pool, dirty generations, source fencing a skutečné HTTP gates | Zachovat fair-work i hotfixy 0.2.14–16; čitelný provoz a shutdown |
| Reference consumer | Vlastní ledger, encrypted credential port, 10 endpoint profilů, frozen installed corpus | Ověření přenositelnosti se nesmí proměnit v neplánovaný daemon/Relay |

Specializované rodiny: graphOccurrenceContent, graphMeetingCancellation, organizer, reminderInstance, graphSeriesDeletion, graphSeriesCreate, caldavAlarm, caldavSplit, caldavSeriesDeletion, caldavSeries, googleOccurrence, rsvp, reminderEdit.

Top-level timeEdit a graphOccurrence jsou podle C08 acceptance **reserved admission/selection guard keys**. Návrh je nepovažuje za bezpečně smazatelný mrtvý kód. Nested rsvp.graphOccurrence je odlišný vstup. graphCreateAdoption na terminální not-needed operaci není důkaz chybného runtime routingu.

## Korekce převzaté z oponentur

- TRACE / OPS-02: logger může zdědit request context, ale explicitní fields jej přepisují; neznamená chybnou autorizaci ani zpochybnění HTTP výsledků.
- DATA-02: asymetrie mazání je statický fakt; provider resurrekce závisí i na retainUnmappedCreatePull a nebyla runtime prokázána.
- TRUST-01: možná vazba shadow e-mailu na session vyžaduje skutečný Better Auth integrační tok; nejde o potvrzený takeover.
- SYNC-07: 0.2.16 přidala skutečný PG/HTTP coordinator+budget test. Zbývá rozsah ostatních rodin, nikoli nulové pokrytí.
- TEST: korpusy v CI skutečně běží; mezera se týká společného vstupu a inventárního lepidla.
- REL: chybějící veřejný restore receipt není důkaz nikdy neprovedené obnovy; StartedAt není app readiness; historická store inventura není současná verze.
- K-09: chybí vazba začátků jobů/DEX kroků na start accepted attemptu; historický pozorovaný partial tvar pochází z PR. To neprokazuje vadné minulé publikace.

## Aktuální ověření této plánovací relace

- SPEC status: 0.4.0, review.mode=spec, OpenSpec 1.15.0; dokument language nenastavený, proto nové dokumenty česky.
- OpenSpec context/list: skutečný repo-local root; katalog specs a changes byl před touto změnou prázdný.
- Git ancestry: C08/C09/C10 merge commity jsou součástí výchozího HEAD.
- Jediný skutečný aplikační baseline: pnpm test:behavior --suite fair-work --scenario parked-pull-request-preflight --json — 1 passed, 0 failed/errors, report duration 197 ms.
- Tento scénář nahrazuje dependency porty. Neprokazuje celé fair-work, auth, PG, aplikaci, provider ani rollout.
- Spec audit/adopt/orient check jsou mechanické operace a nemají význam přijetí designu nebo aplikace.

## Co se znovu nezjišťovalo

Aktuální Dokploy/env flags, složení aktivních durable řádků, registry stav mimo poslední záznam, poslední store buildy, vlastnictví privátních recovery účtů a skutečná Better Auth/SSE chování. Odpovědi patří do příslušných checkpointů s vlastním oprávněním a důkazem.

## Project checks index

Sdílené checks.planning-whitespace = git diff --check kontroluje pouze whitespace plánovacích dokumentů, nikoli aplikační chování; není fast gate a na čistém stromu neprokazuje kontrolu commitnutého diffu. Whitespace finálního diffu se kontroluje i proti konkrétní base/head revizi. Source/database/ui jsou existující příkazy, které tato plánovací změna nespouštěla. Fair-work baseline výše je oddělený příklad, ne univerzální gate. Autoritou zvolených kontrol je přijatý CP brief. Před implementačním slice se záměrně aktualizují checks.fast/full/ui v .spec-pilot.json podle tohoto briefu (fast = nejmenší produkční JSON scénář podle AGENTS.md a relevantní types/lint). Chybějící fast/full nyní není PASS ani souhlas s apply. Navigační goal/stop se při tom nepřepisují; souběžné slices používají vlastní branch/mapu, aby si nepřepsaly checks. Slice-specific overrides se podle T1 před finálním content review a mergem vrátí k původnímu sdílenému indexu; kontrolované příkazy/revize zůstanou ve veřejné acceptance slice. STATUS.json odkazuje na brief cestou/hashem a uchovává jen průběh a skutečné výsledky.

Jediný doložený lokální příkaz pro celé CI/platformy zatím neexistuje; checks.full se proto nepředstírá pomocí pnpm check/verify. Než CP02 dodá ověřený full plán/preflight, koncový full gate checkpointu je pnpm check plus všech 21 current-head Quality jobů z publication proof kontraktu a všechny skutečné branch-protection checks; relevantní externí/device/live gates jsou navíc. Nedostupný nebo neprovedený gate = HOLD. Konkrétní dostupné kontroly prvních slice CP01 a CP08.1 jsou v tasks.md; každý další slice dostane před apply revidovaný CP brief.
