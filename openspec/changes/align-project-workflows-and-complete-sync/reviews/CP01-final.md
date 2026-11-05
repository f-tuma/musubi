# CP01 docs — nezávislý finální content review

Datum: 2026-11-05. Reviewer: Claude (Opus 5.5), dispatched Orca worker, task_8796b20757a6.

## Subjekt a přesná revize

- Branch `codex/cp01-docs-authorities`, base `1bf82a8985113f8c6f3165c2c127aa831326eea4`, head `f2dc329b466b41b206cd1c1fec4dd4f3362917d6` (commity 041774e, 0bfe2c7, 03c0744, f2dc329).
- Primární fingerprint `78dbe9f90e4c18cbd78a6a85d3b1545a8d34e8c3a70e651cf81f9bf2d0173f54` podle manifestu `final-review-subject.json` (16 souborů). Sám jsem přepočítal SHA-256 všech 16 souborů z pracovního stromu i z `git show HEAD:<path>`: všechny hashe sedí, fingerprint podle uvedeného algoritmu sedí. `HEAD` = f2dc329. Pracovní strom nemá změny v trackovaných souborech; jediné netrackované položky jsou lokální skills pod `.agents/skills/` mimo subjekt.
- Diff base..head obsahuje navíc `reviews/CP01-design.md` (pre-apply review). Ten je ze subjektu vyloučen a nečetl jsem ho.

## Otázka a rozsah review

Je přesný LOKÁLNÍ obsah CP01 docs slice (tasks 1.1/1.2/1.4) připravený pro další krok, tedy otevření PR do main, až bude splněná jeho podmínka (výslovný souhlas s mergem PR #406, merge a přenesení jen CP01 změn na nový main)? Review neschvaluje merge, deploy ani CI a není důkazem, že proběhly testy.

Mimo rozsah: task 1.3 (Node/toolchain), ostatní CP, runtime chování.

## Izolace a omezení

- Čerstvý kontext bez autorovy konverzace a bez jiných review záznamů. Nečetl jsem `reviews/CP01-design.md`, `reviews/final.md` ani `reviews/validation.md`.
- Z privátních souborů jsem četl pouze `backups/codex-cp01-20261105/final-review-subject.json` a sanitizované `receipts/link-ledger.json` a `receipts/tracker-alignment.json`.
- Nic jsem nespouštěl: pnpm, build, spec ani testy. Nespouštěl jsem docs server ani browser, nepoužil jsem síť a nečetl jsem Its a Plan. Spustil jsem jen read-only git (`diff`, `show`, `merge-base --is-ancestor`, `cat-file`) a lokální hashování a parsování v Pythonu.
- Výsledky `pnpm check`, `docs:build`, JSON scénáře, link ledgeru a prokliku v browseru beru jako evidenci hlášenou autorem, nikoli jako ověřenou provenance.

## Přečtené zdroje

- Pravidla a kontrakty: AGENTS.md, CLAUDE.md, `.agents/skills/spec-review`, `spec-checkpoint`, `spec-guide` (review asset, contracts, workflow, testing).
- OpenSpec change: proposal.md, tasks.md (hlavička, CP brief pravidla, řádek CP01, sekce 1), `specs/project-workflow` (WF-01–04), začátek `specs/verification-workflow` (VT-01–03), diff design.md (T1, T2 řádek capabilities, D6) a research.md, celý diff audit-disposition.md, `checkpoints/CP01-docs-authorities.md` a `checkpoints/CP01-docs-acceptance.md`.
- Celý content diff všech 11 dokumentů: README.md, docs/README.md, docs/releasing.md, docs/planning/sync-refactor-roadmap.md, docs/project/brief.md a Starlight contributing, running-locally, onboarding, reference/commands, operations/releases a operations/capabilities.
- Skutečné hranice: root `package.json` (check, dev, test, test:behavior, verify, build, lint, typecheck, test:db, storybook:web, scan:bundle, db:generate), `turbo.json`, `pnpm-workspace.yaml`, skripty všech workspace package.json, `.github/workflows/quality.yml` (triggery, 21 jobů, verify job), `apps/web/vite.config.ts` (port 3000, proxy na 7531), `apps/web/playwright.config.ts` (`reuseExistingServer`), `scripts/test-behavior.mjs`, `apps/web/src/tests/behavior/task-inspector.scenarios.test.tsx`, docs/testing/behavior-scenarios.md, záhlaví `docs/releases/0.2.12-readiness.md`, git historie capabilities.mdx a roadmapy a začátek `docs/google-oauth-verification.md`.

## Co změna dělá (vlastními slovy)

- **Jedna current release autorita.** Za jediný current release pointer je výslovně prohlášený `docs/releasing.md`. README a docs/README už neuvádějí číslo verze (dřívější tvrzení „current 0.2.2“ odstraněno), jen na něj odkazují. Starlight Releases má záhlaví „Record — 5 November 2026 (0.2.16)“ místo „Current record“. Starý 0.2.12 HOLD audit je převedený do minulého času. Odkazy „current runbook“ na `0.2.12-readiness.md` jsou přeznačené na historický záznam, recovery hranice 0087 a 0.2.2 zůstávají zachované a odkazované.
- **Mapa autorit.** Sekce „Vlastnictví dokumentů“ v `docs/project/brief.md` obsahuje tabulku vlastníků pro záměr, agent pravidla, normativní protokoly, OpenSpec program, web UI, příkazy/CI, contributor setup, JSON scénáře, release, publication proof, capability/provozní evidenci, historii a Its a Plan (D6). README, docs/README, contributing, commands a releasing na ni odkazují.
- **Contributor vstupy.** Tabulka workspace doplňuje web, sync-reference, emails, design-system, sync a provider balíčky. Ověřovací smyčka teď vede: nejmenší JSON scénář → `pnpm check` → Quality (21 jobů). Návody výslovně říkají, že fixture scénář neprokazuje DB, auth ani provider a že zelený lokální `check` neznamená zelený PR. Running-locally přidává krok pro web klienta a opravuje `pnpm dev` (dev + storybook). Commands přestal tvrdit „canonical“ a místo zastaralé tabulky dvanácti self-checků odkazuje na skutečné scripts.
- **Native vs. web.** Konvence native klienta (Tap/Btn, theme při renderu, Reanimated) jsou oddělené od webu. Ten odkazuje na musubi-ui, design system a `pnpm --filter @musubi/web lint`.
- **Datovaná capability a historie.** Capabilities.mdx má banner a frontmatter „reviewed for v0.2.2 on 5 October 2026“, matice a řádky evidence jsou beze změny. Roadmapa C01–C10 má historický banner s doloženými merge SHA pro C08–C10 a odkazem na nový program. Původní text zůstal.
- **Kanonické a audit záznamy.** Design T1 (dočasné checks overrides se před finálním review vracejí), T2 řádek capabilities a D6 (rozhodnutí vlastníka). Audit-disposition aktualizuje jen dotčená ID s výslovně lokálním a neuzavřeným stavem. Acceptance záznam se všemi tasky stále unchecked (0/72).
- Žádná změna aplikace, package skriptů, lockfile, workflow, `.nvmrc`, Dockerfile, protokolů, `.spec-pilot.json` ani `tasks.md` (ověřeno diff --stat). Portable a host guarantees se nemění.

## Ověření tvrzení proti skutečnosti (statické, provedené mnou)

| Tvrzení v docs | Skutečnost | Výsledek |
| --- | --- | --- |
| `check` = release metadata, contracts, peers, typecheck, workspace testy, lint native+web, build web+docs | root `check` script; `build` = turbo, build skript mají jen web a docs | shoda (vynechaný `test:query-runtime` kryje odkaz „exact definition“) |
| Web lint bez warningů, native budget | web `--max-warnings 0`, client `expo lint --max-warnings 108` | shoda |
| `pnpm dev` spouští dev + web Storybook, API aplikuje migrace | `turbo run dev storybook`; api dev = migrate + tsx watch; storybook má jen web | shoda |
| Web dev port 3000, proxy `/api` → 127.0.0.1:7531 | vite `server.port: 3000`, proxy/devProxy na 7531 | shoda |
| Quality 21 jobů, běží pro každý PR a push na main; `pnpm check` + migrační drift v jednom jobu | spočítáno 1+1+1+1+4+4+1+1+5+1+1 = 21; trigger `pull_request` a `push main`; verify job | shoda |
| `test:e2e`/`test:behavior:browser` spustí dev server, pokud neběží | playwright `webServer` s `reuseExistingServer: true` | shoda |
| task-inspector scénář běží na produkčním inspectoru, serializeru a HTTP klientovi v Vitest/jsdom s fixtures | driver renderuje `TaskDetails`, volá `updateTask`/`removeTask`, JSON suite registrovaná v runneru | shoda |
| C08/C09/C10 SHA s daty 26./26./27. 10. jsou předky main | `merge-base --is-ancestor` vůči origin/main (b138056) i base | shoda |
| Capability matice nebyla od 5. 10. reinventarizována | jediný commit souboru 84a88f4 z 2026-10-05 | shoda |
| `0.2.12-readiness.md` je datovaný HOLD záznam, ne current runbook | jeho vlastní záhlaví: „Assessment 27 October… Decision: HOLD“ | shoda |
| Relativní odkazy v pěti Markdown souborech | všechny cíle existují na HEAD | shoda |
| blob/main odkazy | všechny cíle existují na origin/main kromě `docs/project/brief.md` (2 odkazy) | viz C1 |
| `git diff --check 1bf82a8 f2dc329` | exit 0 | shoda |

## Nálezy

Blokery: žádné.

| ID | Druh | Očekávaný stav a zdroj | Nález a evidence | Dopad / jistota | Další krok |
| --- | --- | --- | --- | --- | --- |
| C1 | Podmínka před PR (není vada obsahu) | Brief „Sekvence vůči PR #406“ a return „nefunkční current odkaz“ | `contributing.mdx` a `commands.mdx` odkazují na `blob/main/docs/project/brief.md#vlastnictví-dokumentů`. Soubor na origin/main (b138056) neexistuje. Ledger to hlásí jako `pending-main-merge`. | Pokud by CP01 obsah šel do main nebo na web dřív než #406, budou to 2 nefunkční odkazy. Jistota vysoká. | Dodržet pořadí z briefu: merge #406, rebase jen CP01 a před otevřením PR znovu ověřit odkazy na skutečné base. Workaround nepoužívat. |
| C2 | Chybějící evidence ověření (není vada obsahu) | Brief „Ověření – Po úpravách: … SPEC orient/design check a strict OpenSpec validate“; task 1.4 „ověřit SPEC orient/design mapping“ | Acceptance uvádí `spec check --phase design` a strict validate jen „před apply“. Orient check není zaznamenaný vůbec. Kontrola po edits není doložená. Kanonické OpenSpec artefakty (proposal/specs/design/tasks) se po 041774e už neměnily, takže riziko nevalidní struktury je nízké. | Pro připravenost obsahu nízký dopad, ale bez toho nelze checkpoint/1.4 označit done. Jistota vysoká. | Před PR nebo na finální base spustit `spec check --phase orient` a `--phase design` a strict validate. Výsledek zapsat do acceptance. |
| R1 | Doporučení | WF-01: ostatní vstupy odkazují a nevydávají kopii current stavu | `docs/releasing.md:11-13` tvrdí, že README, docs/README i Starlight Releases „link here instead of restating a version“. `operations/releases.mdx` přitom dál nese sekci „Record — 5 November 2026 (0.2.16)“ s verzí a source SHA. Je označená jen jako datovaný záznam (není tam „current“), takže autorita se nezdvojuje, ale věta o „nerestating“ je pro Starlight stránku nepřesná. | Nízký. Nejasnost při příštím vydání, kdy stránka zůstane u 0.2.16. Jistota vysoká. | Přeformulovat, např. že Starlight stránka vede jen datované záznamy a neoznačuje žádný jako current. Případně při vydání doplnit nový dated record. Nové review jen u materiální změny. |
| R2 | Doporučení (nit) | Přesné datování historie (WF-01) | docs/README uvádí roadmapu jako „last updated 2026-10-25“ a banner „stav k 25. říjnu“. Poslední obsahová úprava roadmapy je ale c42fe4c (#384) z 26. 10., i když vlastní text roadmapy zůstal u „C08 aktualizováno 25. října“. | Velmi nízký. | Volitelně uvést „poslední úprava 26. 10.“ nebo nechat odkaz na vlastní datum dokumentu. |
| D1 | Rozhodnutí přijaté v rozsahu (bez akce) | Brief: datované záznamy se nemění, jen kvalifikace current/historie | V releases.mdx se historický 0.2.12 HOLD odstavec převedl do minulého času a vypadla věta „Check tags, drafts and registry names again before publication.“ Přidáno „The records above supersede this assessment.“ | Pouze kvalifikace zastaralého present-tense pokynu, fakta (v0.2.11, SHA, HOLD) zůstala. Považuji to za přípustné. | Žádná. |

## Neposuzované oblasti

- Skutečné spuštění `pnpm check`, `docs:build`, JSON scénáře, link ledgeru a browser prokliku. Vše je autorem hlášené. Zejména `pnpm check` proběhl podle acceptance před poslední formulací v onboarding a docs build byl opakován.
- 21 current-head Quality jobů a branch-protection pro nové bajty: neexistují, protože branch nemá PR. Jde o otevřený full gate, žádný PASS.
- Stav Its a Plan: tracker jsem nečetl. Receipt hlásí MUSU-70 ve sloupci 3 (started). Brief vyžaduje, aby byl stav na konci relace pravdivě upravený, a to jsem neověřil.
- Vykreslení MDX a Starlight routy a anchory mimo statickou kontrolu existence souborů a nadpisů. Externí URL (musubi.pro, GitHub releases a actions) jsem nekontroloval.
- Task 1.3 (Node 22.12+ v návodu vs. `.nvmrc` 24 vs. CI 22) je výslovně mimo slice a v acceptance je přiznaný jako otevřený. Není to nález tohoto review.

## Verdikt

**APPROVE** pro přesný lokální obsah s fingerprintem `78dbe9f9…f54` na head `f2dc329`, s ohledem na otázku připravenosti pro další krok PR.

Odůvodnění:
- Je jedna current release autorita a framing scriptů a CI je pravdivý (ověřeno proti package.json, turbo, vite, playwright a quality.yml).
- Pravidla native a web jsou oddělená. Capability a historie jsou datované a zachované.
- Portable a host guarantees ani runtime, toolchain a CI se nemění. Auditní a tracker status je kvalifikovaný poctivě a všechny tasky zůstávají unchecked.

Schválení neplatí pro merge, deploy ani CI a neprokazuje provedení testů. Podmínky C1 (pořadí po #406 a re-check odkazů) a C2 (zaznamenat orient/design check a strict validate) je nutné splnit před otevřením PR, respektive před označením 1.1/1.2/1.4 za hotové. R1 a R2 jsou nepovinné. Jakákoli materiální změna obsahu, například rebase s konfliktní úpravou nebo jiná base než main po #406, vyžaduje nové review.
