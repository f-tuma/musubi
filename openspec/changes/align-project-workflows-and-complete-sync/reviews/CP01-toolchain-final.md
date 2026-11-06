# Final review — CP01 slice 1.3 (koherence Node toolchainu), přesný final diff

Reviewer: Claude Fable 5.1, Orca worker task_02351414e68f (dispatch ctx_09cd05f4b886), 2026-11-06. Čerstvý kontext, read-only.

## Verdikt

**APPROVE** pro přesný subjekt níže (HEAD `ba139e83e2b3d5e9213e06f6a1bd6859eb636c4d` proti base `e6015977adba39e909a0824787ac9adcb64a8e99`, 12 souborů podle `/tmp/musubi-node13-final-subject.json`) na otázce: splňuje final diff přijatý checkpoint CP01 task 1.3 a je připraven na PR? Žádný nález proti kontraktu. Schválení se vztahuje jen na tyto bajty a tuto otázku; neprokazuje běh CI, neautorizuje merge ani publikaci. PR, 21 current-head Quality jobů, branch protection a squash merge zůstávají mimo tento verdict.

## Subjekt a ověřené hashe

- Manifest `/tmp/musubi-node13-final-subject.json`: SHA256 `ffd4d90765e504c3de1f3d130b6b3ed853ab39d902594f2600c74e9aca0b43d3`.
- `git rev-parse HEAD` = `ba139e83e2b3d5e9213e06f6a1bd6859eb636c4d`; `git merge-base HEAD e6015977…` = `e6015977adba39e909a0824787ac9adcb64a8e99`; branch `codex/cp01-toolchain-coherence`; `git status --porcelain --untracked-files=all` prázdný (tracked clean, žádné untracked).
- `git diff --name-status base..HEAD` = přesně 12 souborů manifestu (8 M, 4 A), jeden commit `ba139e8`; 595 insertions, 10 deletions.
- SHA256 každého ze 12 souborů jsem spočítal sám z pracovní kopie i z `git show HEAD:<path>`; všech 12 se shoduje s manifestem (tabulka hodnot = manifest, žádný rozdíl). Konkrétně mj. `scripts/verify-release.mjs` `13783706ccff13d917a7e52956a212baf1a8a7a12627dd136e456023fb1df30d`, `scripts/verify-release.test.mjs` `7ab3077e8a9edaa4491ed5f8c713fafcbc717361ba3dbe230c9180c3d56f4d16`, `.nvmrc` `0c4bf84f9bedd485b2c4eac05f59e35addc86ce7dbf0d90435528e04384c6314`, checkpoint `c6b0e06ff9be40cf3f280faa29b40a056da7133a06c64718b906f501243a95c1`, design review `520b7a3d59a12bb2c209adcd55f42e18939aa60937657c903691782b11955aa7`.
- Schválený design subjekt v3 (`backups/codex-cp01-20261105/reports/CP01-toolchain-approved-v3.md` v původním checkoutu): SHA256 `a497f9b5f7ca3404b77f34b1ead87ac615ae0590705bee2e7352b7d9880d8ebb` (shoda s tvrzením); `diff` proti kanonickému checkpointu = pouze řádek 3 (stavový odstavec). Tvrzení „tělo byte-identické“ je pravdivé.
- `.spec-pilot.json`: `git diff e6015977..HEAD -- .spec-pilot.json` prázdný; blob `34297fbe…` v HEAD i base; SHA256 `099538b4…e610ae` odpovídá acceptance. Obnova doložena.

## Otázka a izolace

Review otázka podle zadání: splňuje přesný final diff přijatý CP01 task 1.3 (checkpoint `CP01-toolchain-coherence.md`) a je připraven na PR s nezávislým schválením, s Quality a merge mimo tento verdict. Nedostal jsem autorovu konverzaci, cizí výsledky ani očekávaný verdikt. Nečetl jsem historické reviews ani prompty (`reviews/CP01-design.md`, `CP01-final*.md`, `CI-brand-*`, `validation.md`, `final.md`) kromě pre-apply design review tohoto slice, na který se checkpoint odvolává. Žádná mutace gitu, zdrojů, trackeru, žádný push/PR/instalace/build/.env/síť. Zapsán jen tento soubor.

## Skutečně čtené zdroje

- `AGENTS.md`/`CLAUDE.md` (worktree); `/home/flamendrin/workspace/musubi/.agents/skills/spec-review/SKILL.md`; `spec-guide/references/contracts.md`, `testing.md`.
- Change: `design.md` (T1, T2, D6), `tasks.md` 1.3 a „První slice“, `specs/project-workflow/spec.md` WF-02/WF-03, `audit-disposition.md` DX-06 (diff), `checkpoints/CP01-toolchain-coherence.md` (celý), `checkpoints/CP01-toolchain-acceptance.md` (celý), `reviews/CP01-toolchain-design.md` (subjekt, nálezy R-01..R-07, neposouzené, verdikt), `reviews/CP01-toolchain-design-subject.json`.
- Diff všech 12 souborů; `scripts/verify-release.mjs` celý (hlavička, `fail`, staré Dockerfile pravidlo ř. 170-194, nový blok ř. 196-316); `scripts/verify-release.test.mjs` celý (harness, 19 testů).
- Reálné vstupy: 4 Dockerfiles (všechny `FROM`, `COPY --from`, `ARG`, `HEALTHCHECK`), `git ls-files | grep -i dockerfile` (jen tyto 4), všechny 4 workflow soubory (`find` typ = soubory; per-file počty setup-node/node-version; CRLF 0), `quality.yml` verify job, `docker-publish.yml` prepare, `scripts/sync-alpha-common.mjs:9`, `package-sync-alpha.mjs:99`, `verify-sync-alpha.mjs:59-61`, `package.json` scripts (`release:verify`, `check`, `test`, `verify`), `.gitattributes` (neexistuje), `docs/releasing.md:290-295`, `troubleshooting.mdx:30-56`, `contributing.mdx`/`docs/README.md` (bez Node verze).
- Autorova evidence: `/tmp/musubi-cp01-toolchain-20261106/receipts/index.jsonl` (23 záznamů) + raw `.out/.err` kroků 07, 08, 11, 12, 13, 14a1/a2/b/c, 16, 19, 20; `final-content-hashes.sha256`; 3 z 5 screenshotů.

## Vlastní minimální kontroly (read-only, výstupy doslova)

| Kontrola | Výsledek |
| --- | --- |
| `node scripts/verify-release.mjs` ve worktree na HEAD | exit 0, `Release metadata verified: Musubi 0.2.16, pnpm@11.8.0`, 27 ms |
| `node --test scripts/verify-release.test.mjs` (fixtures jen v mkdtemp) | 19/19 pass, 1364 ms; názvy testů 1-19 shodné s acceptance |
| Regex `node-version` z validátoru nad řetězci | `"node-version: 22\r"` true; `"node-version: 22 # v6"` true; `"node-version: 22 # v6\r"` **false**; `"node-version: '22'\r"` true (viz N-01) |
| SHA256 12 souborů (worktree i HEAD blob) | všech 12 shodných s manifestem |
| Delta checkpoint vs. schválený subjekt | pouze ř. 3 |

## Posouzení proti kontraktu (co jsem ověřil)

- **Fail-closed tvary `FROM`:** detekce `^FROM\b` case-insensitive, klasifikace (a) `^FROM node:(\d+\.\d+\.\d+)-alpine@sha256:[a-f0-9]{64} AS ([A-Za-z0-9_-]+)$` a (b) `^FROM ([A-Za-z0-9_-]+) AS ([A-Za-z0-9_-]+)$` přesně podle briefu; `--platform`, `${VAR}`, bez digestu, `node@sha256:` bez tagu, cizí image, bez `AS`, malé `as`, nedeklarovaný alias → `fail` s `soubor:řádek` a textem řádku; aspoň jeden pin na soubor. Alias set je per soubor a jen z dříve deklarovaných stage. Odpovídá reálným souborům: 8 pinů (api:1,33; web:1,20; docs:1,16; sync-reference:1,15), 2 aliasy (api:12, web:8), 4 `COPY --from` na deklarované stage.
- **Sync-reference mimo legacy HEALTHCHECK policy:** seznam legacy smyčky (ř. 170-174) nezměněn (3 soubory); nová smyčka má 4 soubory a nekontroluje HEALTHCHECK/USER/lockfile; test 6 to explicitně potvrzuje (`doesNotMatch /^HEALTHCHECK /m`).
- **Root-relative reads v reálné kopii:** všechna nová čtení (`.nvmrc`, Dockerfiles, `.github/workflows/` přes `readdirSync(new URL(…, root))`, alpha, 3 návody) jdou přes `root = new URL("../", import.meta.url)`; test spouští kopii `fixture/scripts/verify-release.mjs` bez `cwd`, kopíruje celý `.github/workflows` (R-01 splněno). Mutace `edit`/`write`/`remove` jdou jen do fixture.
- **LF/CRLF:** `.nvmrc` toleruje právě jeden `\r?\n` (test 6 pozitivně LF, CRLF, bez newline; test 9 negativně `\n\n`, mezera, `v`, alias, major, prázdný, chybějící). Dockerfile řádky `trim()`, workflow `\s*` před `$` → holé `node-version: 22\r` projde. Repo je LF (0 CR ve workflow souborech, žádný `.gitattributes`).
- **Per-file setup-node deklarace:** počty `actions/setup-node@` vs. `^\s*node-version:` per soubor, komentované řádky vynechány, hláška jmenuje soubor, oba počty a `.nvmrc` major (R-03 splněno); `node-version-file`, `>-`, `22.x`, `lts/*`, `22.23.4`, `${{ }}`, prázdná → fail-closed s `soubor:řádek:hodnota`. Reálný stav: 14/14 (quality 9, docker-publish 3, ios-widgets 1, vardum-assets 1). Workflow bez obou projde (test 7 syntetický), nový workflow se setup-node je zachycen (test 17).
- **Alpha:** `nodeMajor:\s*(\d+)` → 22 = major `.nvmrc`; chybějící → fail. Hláška `package-sync-alpha.mjs:99` nezměněna (přiznané reziduum).
- **Docs koherence:** `README.md:90`, `running-locally.mdx:16`, `troubleshooting.mdx:39,45` obsahují `.nvmrc`; `git grep "22\.12|Astro 7 (requires|is the strictest)"` v tracked stromu mimo lockfile/openspec najde jen validátor a test. Próza říká „přesně `.nvmrc` pro image, CI současné vydání stejného majoru, jiné majory neověřené, EAS repo nepinuje“ (R-05 splněno; pravdivé vůči `node-version: 22` a chybějícímu `node` v `eas.json`). Žádný číselný minimum-support claim; 22.19 se neuvádí. `commands.mdx` „both“ → „the Docker builds“ (volitelná položka briefu). Screenshoty autora (desktop troubleshooting, desktop i 390 px running-locally) zobrazují nový text bez overflow.
- **Rozsah:** diff nemění Dockerfiles, `.github/`, `package.json` (bez `engines`), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `eas.json`, `docs/releasing.md`, apps/web. `.nvmrc` 22.23.4 = tag image; žádný major upgrade.
- **Dědění:** `check` → první krok `release:verify`; Quality `verify` → `pnpm check`; `docker-publish` prepare → `node scripts/verify-release.mjs "$V"`; žádná CI změna.
- **Evidence vs. kód:** receipt 08 (red validátor na neopraveném repu) obsahuje přesně 29 hlášek obou tříd (8 pinů, 14 workflow, 1 alpha, 3+3 docs) s čísly řádků shodnými s reálnými soubory; receipt 07: 19 testů, 7 pass / 12 fail, 12× „got exit 0“; 11/19/20: 19/19, exit 0; mutace a1/a2/b/c shazují právě spárované testy (a1: 8+12; a2: 10; b: 8+14+17; c: 19), control i restored copy 19/19; 16 `pnpm check` exit 0, 233 246 ms, cwd worktree, HEAD e6015977 s dirty stromem odpovídajícím subjektu; 17 `git diff --check` exit 0. `final-content-hashes.sha256` = hashe manifestu pro 7 obsahových souborů. Acceptance tvrzení, která jsem porovnal, sedí s raw výstupy; neobsahuje žádný přenesený starý PASS a otevřené gates vyjmenovává.
- **Kanonika:** `tasks.md` 1.3 zůstává `[ ]`; DX-06 status sloupec nezměněn („staticky doložený; runtime dopad neověřený“), dispozice popisuje jen doloženou lokální část a jmenuje otevřené PR/Quality/merge; checkpoint ř. 3 jmenuje review, hashe, base a acceptance.
- **Oddělené hranice:** acceptance odděluje source (`pnpm check` bez DB), platform (CI/Docker nevykázáno), live (žádný push/tag/deploy). Fast = node:test nad reálnou kopií, přiznaná absence JSON scénáře (T1 výjimka zapsaná v checkpointu i acceptance).

## Nálezy

Žádný blocker ani chyba proti kontraktu. Níže jen doporučení mimo rozsah 1.3 (nezastavují PR):

| ID | Typ | Location | Evidence | Impact | Next step |
| --- | --- | --- | --- | --- | --- |
| N-01 | Doporučení (hranice, mimo rozsah) | `scripts/verify-release.mjs:277` regex `node-version` | JS `.` nematchuje `\r`: `"node-version: 22 # v6\r"` → false (vlastní probe). Reálné soubory jsou LF a žádný `node-version` řádek nemá koncový komentář. | Při budoucím CRLF checkoutu s komentářem za `node-version` by validátor selhal fail-closed s hláškou „must be the bare major … received: 22 # v6“, tedy bezpečným směrem, ale matoucí. Brief regex předepisuje doslova, takže jde o vlastnost kontraktu, ne odchylku. | Nic teď; pokud repo někdy přidá `.gitattributes`/CRLF, doplnit `\r?` před `$` v samostatném slice. |
| N-02 | Doporučení (hranice, mimo rozsah) | `scripts/verify-release.mjs:259-263` `readdirSync` filtr `*.ya?ml` | Podadresář pojmenovaný `*.yml` by `readFileSync` shodil výjimkou (EISDIR) místo `fail()`; `.github/workflows` dnes obsahuje jen 4 regulární soubory (`find -printf %y` = f). | Nenulový exit zůstává (fail-closed), jen bez formátované hlášky. | Volitelně `withFileTypes` + `isFile()` v pozdějším slice. |
| N-03 | Doporučení (docs, přiznané v briefu) | `docs/releasing.md:290-295` „Version metadata“ | Popisuje jen version/contract pravidla; nový Node gate ani Dockerfile pravidla nepopisuje. Checkpoint to explicitně vylučuje z rozsahu. | Čtenář release runbooku se o novém důvodu selhání `release:verify` dozví jen z hlášky. | Zapsat do dalšího docs slice (CP01 1.2 follow-up nebo CP11), ne do tohoto PR. |
| N-04 | Poznámka (evidence) | `CP01-toolchain-acceptance.md` sekce „Proklik“ | Screenshoty a dist hashe jsou autorské; nezávisle jsem ověřil jen 3 PNG (obsah odpovídá diffu) a nebuildoval docs. | Žádný dopad na verdikt; docs build dědí Quality `verify` (`pnpm check` → `build`). | Nic. |

## Neposouzené hranice

- Stav PR, branch protection a 21 current-head Quality jobů (bez sítě; PR neexistuje). Verdikt je nepodmíněný jen pro bajty; CI zůstává samostatná brána.
- `pnpm check`, `pnpm docs:build` a proklik jsem neopakoval; spoléhám na raw receipts 12/16 porovnané s kódem a na vlastní běh validátoru a testu.
- Chování `actions/setup-node` při `node-version: 22` (jakou patch vyřeší), reálný runtime dopad původního nesouladu, EAS/native Node, boot image – všechny přiznané v checkpointu i acceptance jako neověřené.
- `openspec validate --strict` jsem nespouštěl (receipts 04/06/18 hlásí valid=true).
- Dark theme docs a klávesnicová navigace Starlight – mimo rozsah (není UI pod apps/web).

## Závěr

Přesný final diff `ba139e83…` nad `e6015977…` implementuje všechny položky „Přesný rozsah souborů“ a stop podmínky checkpointu, zapracovává R-01..R-07, nepřekračuje rozsah a jeho acceptance evidence odpovídá raw výstupům i reálnému kódu. **APPROVE** pro PR. Merge až po zelených required checks aktuálního headu; task 1.3 zůstává unchecked do merge.
