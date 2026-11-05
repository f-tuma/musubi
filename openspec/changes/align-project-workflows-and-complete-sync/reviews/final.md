# Review: finální plánovací subjekt `align-project-workflows-and-complete-sync`

**Verdikt: APPROVE** (pouze tento přesný plánovací subjekt; nejde o přijetí implementace, spuštění testů ani autorizaci apply/merge/publikace/deploymentu).

## Subjekt a revize

- Repo `/home/flamendrin/workspace/musubi`, branch `codex/spec-project-coherence`.
- Base `b138056218aab1e3b01b69d7e53b3713a553dfcd`, head `40ef420fba65704fc4fc8d0a1960492345fe029a` (HEAD worktree = 40ef420; commity 407dc77, 0e40943, 40ef420).
- Manifest `backups/codex-spec-project-coherence-20261105/review-subject.json`: všech 18 primárních souborů má SHA-256 shodné v manifestu, v commitu 40ef420 (`git show`) i ve worktree. Seznam je lexikálně seřazený; fingerprint přepočítaný podle deklarovaného algoritmu = `1c1258c8298c3c4ad9ffed1e5e51ee86e9ebb281ff16858fcb030cb27c087506` (shoda).
- `git diff --name-only b138056 40ef420` = přesně těchto 18 souborů, +1148 řádků, žádná aplikační změna. `git diff --check b138056 40ef420` čisté.

## Izolace

Jsem nový reviewer v čerstvém kontextu (Claude Opus 5.5, dispatch Orca `task_6ecbfb8ef881`). Nečetl jsem žádnou konverzaci autora ani jiné review záznamy (`reviews/*.md` včetně dřívějšího obsahu tohoto souboru, který jsem přepsal bez čtení), ani prompty reviewerů v `backups/`. Z `backups/` jsem četl pouze uvedený manifest. Nespouštěl jsem pnpm/build/spec/openspec/test/DB/síťové příkazy; pouze git, hash a čtení zdrojů.

## Přečtené zdroje

- Pravidla: `AGENTS.md`, `.agents/skills/spec-review/SKILL.md`, `.agents/skills/spec-guide/SKILL.md`, `references/{contracts,workflow,adoption,testing}.md`, `assets/review.md`.
- Celý subjekt: `.spec-pilot.json`, `docs/project/brief.md`, `openspec/config.yaml`, `.openspec.yaml`, `proposal.md`, `design.md`, `research.md`, `tasks.md`, `audit-disposition.md`, všech 7 delta specs, oba `.gitkeep`.
- Skutečný kód/příkazy (ověření tvrzení): `package.json` scripts (`check`, `verify`, `test`, `test:behavior*`, `test:db*`, `test:e2e:radicale`, `test:federation-db`, `storybook:web:test`, `docs:build`), `.nvmrc`, `.github/workflows/quality.yml` (triggery, joby, `ci-shards.test.mjs` řádky 383/460), `scripts/quality-proof.mjs` (QUALITY_JOB_NAMES, validace časů), `scripts/verify-publication.mjs`, `scripts/test-behavior.mjs` (SUITES), `.github/workflows/docker-publish.yml` (latest tag), `apps/api/src/sync/event_delivery.ts` (ř. 40–110), `packages/db/src/queries/operation-admission.ts` (eventSpecialized), `apps/api/src/sync/task_delivery.ts` (`retained-v0`), `packages/types/src/sync_operation.ts` (`legacy-v0`), `apps/api/src/index.ts` (initializeSyncEngine/bootstrapProviderBudget), `apps/api/src/singleton.ts` (pg_try_advisory_lock), `apps/api/src/middleware/require_client_version.ts` (existence), `docs/sync-alpha/supported-matrix.v1.json`, `README.md`, `docs/README.md`, `docs/releasing.md`, `packages/docs/.../reference/commands.mdx`, existence Starlight cest z T2, `.gitignore` (`/backups/`), git ancestry C08/C09/C10.

## Vlastními slovy: co plán dělá a kde jsou hranice

Plán zavádí jednu zastřešující OpenSpec změnu se sedmi novými capability (workflow, verifikace, publikace, sync konvergence, sync spolehlivost, identita/data, klientská konzistence), krátký brief jako autoritu záměru a `.spec-pilot.json` jako pouhý navigační index. Nic neimplementuje. Práce je rozdělena do 12 pracovních balíků (CP01–CP12), z nichž každý slice smí začít až po vlastním, nezávisle revidovaném CP briefu s přesnými příkazy, stop/return podmínkou a vazbou na audit ID. Existující autority (docs/releasing.md, publication.md, Starlight contributing/running-locally, package.json + quality.yml, behavior-scenarios.md, protokoly sync-profile/operation v1) zůstávají kanonické; plán výslovně odmítá druhý registr testů, runbook, current index, DESIGN.md či EGM draft. Sync část vychází ze skutečnosti, že C08–C10 jsou v main, a místo greenfield extrakce požaduje inventář po rodinách (portable / host compatibility / retained-v0 / unsupported), oddělení živého v0 admission od historických v0 dat a per-rodinný exit gate (D4), kde prázdná fronta nestačí. Rizikové doménové věci (shadow e-mail auth, removal policy, delta deletions) jsou nejdřív reprodukce a teprve po owner rozhodnutí D1/D2 změna. Produkční aktivace (consumer/trigger, shutdown drain, latest/tag pořadí) je zablokovaná za D3/CP11.

## Ověření klíčových tvrzení proti zdrojům

| Tvrzení plánu | Výsledek |
| --- | --- |
| C08 e75d5c7, C09 f500467, C10 1cf603b jsou předky base | Potvrzeno `git merge-base --is-ancestor` |
| 21 Quality jobů v publication proofu; seznam v T3 | Potvrzeno `quality-proof.mjs:17-23,61`; všech 21 jobů běží i na `pull_request` (žádné `if:` na jobu) |
| `pnpm check`/`verify` nejsou kompletní Quality | Potvrzeno (check = release:verify…build; verify = check + e2e; chybí DB shardy, image, smoke, Android…) |
| `ci-shards.test.mjs` je v CI, ne v lokálním `pnpm test` (TEST-06) | Potvrzeno (quality.yml:383,460; `scripts.test` jej neobsahuje) |
| 13 specialized rodin + reserved `timeEdit`/`graphOccurrence` | Potvrzeno `event_delivery.ts:55-56` a `operation-admission.ts:17` |
| Úkol 6.1: reserved klíče nejsou kontrolované u Google content/delete větví | Potvrzeno: `event_delivery.ts` větve `usesSharedGoogleDelivery`/`usesSharedGoogleDelete` kontrolují jen `specialized`, ostatní shared větve i `timeEdit`/`graphOccurrence`. Plán to správně formuluje jako guard k ověření, ne potvrzenou chybu |
| legacy-v0 (decoder) vs retained-v0 (host) | Potvrzeno `sync_operation.ts:170,255`, `task_delivery.ts:132` |
| K-09: chybí vazba job/step startedAt ≥ accepted run start | Potvrzeno: `validateQualityProof` kontroluje jen completed ≥ started a shodu attemptu, ne `job.startedAt ≥ run.startedAt` |
| `latest` se taguje spolu s verzí (REL-03) | Potvrzeno `docker-publish.yml:208` |
| Singleton přes `pg_try_advisory_lock` | Potvrzeno `apps/api/src/singleton.ts:30` |
| Reference alpha = 10 profilů | Potvrzeno `supported-matrix.v1.json` (profiles: 10, hostOnly: 6) |
| Drift dokumentace (README/docs/README 0.2.2, commands.mdx „canonical“, releasing.md 0.2.16) | Potvrzeno |
| Audit disposition: 81 pozorování + K-09 | Potvrzeno: 82 řádků tabulky, každý má status a task nebo odůvodněné P3 odložení |
| Všechny cesty v `.spec-pilot.json` a příkazy v tabulce CP kontrol existují | Potvrzeno (všechny mapované soubory i uvedené pnpm skripty existují) |
| `backups/spec-sessions/` je git-ignorovaný | Potvrzeno `.gitignore:15 /backups/` |

## Nálezy

Žádný blocker. Níže doporučení a rozhodnutí vlastníka.

| ID | Typ | Očekávaný stav a zdroj | Nález a důkaz | Dopad / jistota | Další krok |
| --- | --- | --- | --- | --- | --- |
| R-01 | Doporučení | `spec-guide/references/testing.md` „Project checks“: `fast/full/ui` jsou projektové kontroly sdíleného mapování; design T1 sám říká, že paralelní práce nesmí přepisovat sdílený index | design.md T1, tasks.md:12 a research.md „Project checks index“ předepisují před každým slice nastavit `checks.fast/full/ui` v `.spec-pilot.json` podle CP briefu „v oddělené větvi/mapě“. Není řečeno, zda se tato slice-specifická hodnota merguje do main, nebo se před merge vrací. Po squash merge by sdílený index na main nesl `fast` posledního mergnutého slice a souběžné PR by na stejném klíči kolidovaly | Střední dopad na srozumitelnost workflow (jádro zadání), nízké riziko pro produkt; jistota vysoká, že je to nejednoznačné | V CP01 briefu (1.4) rozhodnout jednu variantu: (a) sdílený index nese jen projektové `fast/full/ui` a slice-specifický výběr žije v CP briefu/STATUS.json, nebo (b) slice hodnota se před merge explicitně vrací. Doporučuji (a) |
| R-02 | Doporučení / chybějící evidence | design.md „Context“: stop condition je „kompletní, mechanicky validní“ plán; tasks.md:12 vyžaduje strict OpenSpec validaci před prvním briefem | Subjekt neobsahuje záznam o běhu `openspec validate --strict` pro tuto změnu (research.md uvádí jen OpenSpec context/list a SPEC status/check). Formát specs ručně vypadá validně (každý requirement má SHALL/MUST a ≥1 scenario), ale delta specs mají navíc `## Purpose` – vliv na parser jsem neověřoval | Nízký; jistota střední | Před přijetím plánu uložit skutečný výstup `openspec validate align-project-workflows-and-complete-sync --strict` a `spec check --phase design` vázaný na 40ef420 (mimo tento review, který příkazy nespouštěl) |
| R-03 | Doporučení (redakční) | design.md T3 | Výčet „…Storybook, Android build/DEX všech 5 image jobů včetně arm64…“ slévá Android job a image joby do jedné fráze; počet sedí (21), ale věta je nejednoznačná | Kosmetické | Při nejbližší revizi T3 oddělit „Android system bars (build + DEX)“ a „5 image jobů“ |
| D-01 | Rozhodnutí vlastníka (není blocker plánu) | design.md D1–D6 | Plán správně drží D1 (removal), D2 (delta kontrakt), D3 (produkční aktivace), D4 (retire rodiny), D5 (veřejná distribuce), D6 (role trackeru Its a Plan) jako explicitní blokované úkoly v CP01.4/8.4/8.6/11.3/12.1 | Přijetí plánu je neschvaluje | Vlastník rozhodne v příslušném CP; D6 je jediné, které blokuje dokončení CP01 |

## Hodnocení podle otázek zadání

- **Koherentní vlastnictví a reuse:** dobré. T2 tabulka mapuje každou odpovědnost na existující zdroj; CP02 rozšiřuje `SUITES`/`ci-shards` místo nového registru; žádný nový framework, UI závislost ani token zdroj.
- **Kompatibilita / oprávnění / recovery:** dobré. Žádný re-encode, decoder-before-encoder, RSVP no-resend floor, old-binary rollback = HOLD, capability hinty neobcházejí server, D2 pro veřejný delta kontrakt, CP07 nemění wire DTO bez kompatibilního návrhu.
- **Sync tvrzení a klasifikace portable/host/retained:** ověřené vzorky odpovídají kódu; generic Graph/DAV UPDATE, VTODO/To Do a specialized rodiny nejsou povyšovány na portable; host compatibility je uznána jako legitimní finální stav.
- **Malé checkpointy:** CP balíky jsou programové, ale každý slice vyžaduje revidovaný brief, jeden pozorovatelný výsledek a stop/return; CP06 je po rodinách. Procesní režie je vysoká, ale odpovídá AGENTS.md (review před každým PR).
- **Kontroly, návraty a gates:** tabulka CP kontrol odkazuje jen na existující skripty; nedostupný gate = HOLD; full gate do CP02 = `pnpm check` + 21 Quality jobů + branch protection, bez tvrzení o lokálním „vše“; CP08.1 výslovně nevykazuje neexistující suite jako PASS.

## Neposouzené oblasti

- Nespuštěno: `openspec validate`, `spec check`, žádné testy, build ani DB; plánovaný fair-work baseline jsem neopakoval.
- Skutečná branch protection na GitHubu, Dokploy/env flagy, registry, store buildy, Better Auth chování a stav trackeru Its a Plan (vyžaduje síť/přístup).
- Úplnost inventáře sync rodin a routerů jsem ověřil jen vzorkově (event router, admission seznam, task retained-v0); plný router diff je úkol CP05.
- Obsah 11 privátních auditních reportů; posuzoval jsem pouze veřejnou disposition tabulku proti kódu.
- Přesnost jednotlivých tvrzení o Starlight dokumentech nad rámec existence souborů a výše uvedených vzorků.

## Verdikt

**APPROVE** pro subjekt 40ef420 / fingerprint `1c1258c8…7506`. Plán je věcně ukotvený ve skutečném kódu, nezakládá paralelní autority, drží kompatibilitní a permission hranice a všechna riziková rozhodnutí odkládá za explicitní gates. R-01 doporučuji vyřešit v CP01 briefu; R-02 je evidence, kterou má autor doložit před formálním přijetím plánu. Toto schválení neprokazuje spuštění testů a neautorizuje apply, merge, publikaci ani deployment. Materiální změna subjektu znovu otevírá review.
