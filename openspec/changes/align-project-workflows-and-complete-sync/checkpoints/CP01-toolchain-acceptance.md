# CP01 toolchain (1.3) — lokální výsledek a meze přijetí

Záznam k 2026-11-06. Autor: Claude Fable 5.1, Orca worker task_d42b80dddbf8. Jde o autorský záznam skutečně provedených lokálních kontrol na větvi `codex/cp01-toolchain-coherence` v izolovaném worktree nad base `e6015977adba39e909a0824787ac9adcb64a8e99` (main po merge PR #407; strom shodný s headem `5bfb341`, Quality 42124082949 attempt 1 21/21). Není to nezávislé review, PR, CI běh ani souhlas s mergem. Historická acceptance CP01 docs a CI-brand-fixtures se tímto nepřepisuje ani nevydává za nové běhy.

## Subjekt a hashe

- Přijatý brief v3 (subjekt design review): SHA256 `a497f9b5f7ca3404b77f34b1ead87ac615ae0590705bee2e7352b7d9880d8ebb`.
- Pre-apply design review APPROVE (Claude Fable 5.1, Orca task_35c5e3f4fe61, 2026-11-05): `../reviews/CP01-toolchain-design.md`, SHA256 `520b7a3d59a12bb2c209adcd55f42e18939aa60937657c903691782b11955aa7`.
- Kanonický checkpoint `CP01-toolchain-coherence.md`: SHA256 `c6b0e06ff9be40cf3f280faa29b40a056da7133a06c64718b906f501243a95c1`; od subjektu se liší pouze řádkem 3 (stavový odstavec), což je podle nálezu R-06 nemateriální a je doloženo v `../reviews/CP01-toolchain-design-subject.json`. Tělo pravidel, rozsahu a kroků je byte-identické.
- Doporučení R-01 až R-07 zapracována bez dalšího owner gate: všechna čtení včetně `readdirSync` workflow jdou přes root URL skriptu (test mění pouze svou kopii); `.nvmrc` toleruje právě jeden koncový LF/CRLF; počty setup-node/node-version per soubor s diagnostikou obou počtů; `AS` jen velkými písmeny, jiné tvary fail-closed; fast bez types/lint, protože se mění jen `.mjs`, `.nvmrc` a MDX; próza návodů říká „přesně `.nvmrc` pro image, CI stejný major s plovoucím patchem“; inventář pěti faktů znovu ověřen na skutečné base (níže).

## Inventář na base e6015977 (před kódem)

| Fakt | Skutečný stav |
| --- | --- |
| `.nvmrc` | `24.15.0` + LF, naposledy `d20a5bd` 2026-07-05 |
| Dockerfiles | 4 soubory (`apps/api`, `apps/web`, `packages/docs`, `apps/sync-reference`); 8 řádků `FROM node:22.23.4-alpine@sha256:fe4f6d74…9914 AS …` (api:1,33; web:1,20; docs:1,16; sync-reference:1,15); 2 aliasy (`api:12 FROM base AS deploy`, `web:8 FROM base AS build`); 4 `COPY --from=` na dříve deklarované stage |
| Workflows | 4 živé soubory; 14 řádků `actions/setup-node@` a 14 řádků `node-version: 22` (quality 9, docker-publish 3, ios-widgets 1, vardum-assets 1) |
| Alpha | `scripts/sync-alpha-common.mjs:9` `PINS.nodeMajor: 22` |
| Docs literály | `README.md:90` „Node 22.12+“, `running-locally.mdx:16` „22.12 or newer. Astro 7 requires it.“, `troubleshooting.mdx:39` „22.12+ … Astro 7 is the strictest“; `commands.mdx:243` „both Docker builds“ |

Lokální prostředí: Node v22.23.4 (`node --version`), pnpm 11.8.0, žádný nvm/fnm/volta, takže mechanismus `nvm use` se neověřoval; `node --version` není důkaz nvm. Root `.env` ve worktree neexistuje; žádná tajemství se nekopírovala.

## Dodaný rozsah

- `.nvmrc` → `22.23.4` (verze používaných image). Žádný major upgrade.
- `scripts/verify-release.mjs`: nový blok „Node toolchain coherence“ za stávajícími Dockerfile pravidly: `.nvmrc` přesné `X.Y.Z` (jeden koncový LF/CRLF tolerován, chybějící soubor přes `fail`); každý `FROM` ve 4 Dockerfiles je buď digestem pinovaný `node:<.nvmrc>-alpine … AS <stage>`, nebo alias dříve deklarované stage téhož souboru, jinak fail-closed s `soubor:řádek` a textem řádku; aspoň jeden pin na soubor; všechny `*.yml`/`*.yaml` v `.github/workflows` přes root URL, per soubor rovnost počtu `actions/setup-node@` a `node-version:`, každý `node-version` holý major `.nvmrc`; `PINS.nodeMajor` rovný majoru; tři návody obsahují `.nvmrc` a neobsahují `22.12`. Smyčka je oddělená od HEALTHCHECK/USER/lockfile/digest pravidel (sync-reference bez HEALTHCHECK zůstává mimo ně).
- `scripts/verify-release.test.mjs`: `requiredFiles` + `.nvmrc`, sync-reference Dockerfile, alpha pins, tři návody; celý adresář `.github/workflows`; helper `verify()` s `edit`/`write`/`remove`; 5 stávajících testů beze změny; 14 nových testů (2 pozitivní/rozsahové, 12 negativních), fakta čtou ze skutečného checkoutu.
- Docs: `README.md` Requirements, `running-locally.mdx` řádek Node.js (včetně věty, že EAS buildy repozitář nepinuje), `troubleshooting.mdx` sekce „Astro or another dependency rejects Node“ (`cat .nvmrc`, bez 22.12/strictest; „only pnpm source“), volitelná oprava `commands.mdx` „both Docker builds“ → „the Docker builds“.
- Kanonické: tento záznam, `CP01-toolchain-coherence.md`, `../reviews/CP01-toolchain-design.md` + `-subject.json`, řádek DX-06 v `audit-disposition.md`. `tasks.md` 1.3 zůstává unchecked.
- Nezměněno: Dockerfiles, workflow runtime, `package.json`/engines, lockfile, závislosti, `eas.json`, `docs/releasing.md`, hláška `package-sync-alpha.mjs:99`, apps/web.

## Skutečně provedené kroky (red → oprava → green → mutace → obnovený green)

Raw receipts s přesnými argv, cwd, start/end, trváním, exit kódem a stavem stromu: `/tmp/musubi-cp01-toolchain-20261106/receipts/index.jsonl` (+ `<name>.out/.err`, `mutation-summary.json`, screenshoty). Všechny běhy na HEAD `e6015977` s uvedeným pracovním stromem.

| Krok | Příkaz | Výsledek |
| --- | --- | --- |
| 1 baseline | `node --test scripts/verify-release.test.mjs` na nedotčené base | 5/5 pass, 281 ms |
| 1 baseline | `node scripts/verify-release.mjs` | exit 0, „Release metadata verified: Musubi 0.2.16, pnpm@11.8.0“, 23 ms (starý validátor Node ignoruje; očekávané) |
| OpenSpec před kanonickým upřesněním | `openspec list --json` (root = tento worktree), `openspec validate align-project-workflows-and-complete-sync --strict --json` | valid=true, issues=[]; binary 1.15.0, žádné SPEC managed soubory se neinstalovaly |
| OpenSpec po uložení checkpointu/review | totéž validate | valid=true, issues=[] |
| 2 red testů | nový test nad **starým** validátorem | 19 testů: 7 pass (5 stávajících + 2 pozitivní/rozsahové, nejsou red důkaz), **12 negativních fail**, všech 12 s „expected a toolchain failure, got exit 0“; 707 ms |
| 3 red validátoru | nový blok, `node scripts/verify-release.mjs` na dosud neopraveném repu | **exit 1, 29 chyb**: 8 Docker pinů `pins Node 22.23.4, but .nvmrc declares 24.15.0` (api:1,33; web:1,20; docs:1,16; sync-reference:1,15), 14 workflow řádků `node-version 22 does not match .nvmrc major 24`, `PINS.nodeMajor 22`, 3× „must point contributors at .nvmrc“, 3× „:řádek still names the stale Node floor 22.12“ (README:90, running-locally:16, troubleshooting:39). Reprodukce DX-06 skutečným validátorem na reálných bajtech. |
| 3 mezistav | `node --test …` v nekonzistentním stavu | 5 pass / 14 fail; zaznamenáno jen jako „není zelené“, není důkaz |
| 4 oprava všech vstupů | `.nvmrc`, README, running-locally, troubleshooting, commands | `node scripts/verify-release.mjs` exit 0 (26 ms); `node --test …` **19/19 pass** |
| 5 mutace (mkdtemp kopie mimo repo, zrcadlený layout `scripts/…`, repo nedotčeno) | kontrola nemutované kopie | 19/19 pass |
| 5 a1 | vypuštěno porovnání verze pinu s `.nvmrc` | fail právě: „pinned patch differs“ + „drifted .nvmrc“ (17 pass) |
| 5 a2 | neznámý `FROM` tiše přeskočen | fail právě: „unknown FROM shapes fail closed“ (18 pass) |
| 5 b | vypuštěno porovnání majoru `node-version` | fail: „CI node-version major drifts“ (spárovaný) + „drifted .nvmrc“ + „new workflow covered by scan“ (16 pass) |
| 5 c | vypuštěno docs literálové pravidlo | fail právě: „each guide points at .nvmrc and drops 22.12“ (18 pass) |
| 5 obnoveno | nová nemutovaná kopie | 19/19 pass; skutečný `scripts/verify-release.mjs` SHA256 `13783706…df30d` beze změny |
| 6 docs build | `pnpm docs:build` po docs editech | exit 0, 5,0 s; dist stránky bez `22.12`/„both Docker“, s `.nvmrc` |
| 6 whitespace | `git diff --check` před commitem (po všech editech) | exit 0, 3 ms; strict OpenSpec validate po acceptance valid=true; finální `node --test` 19/19 a `node scripts/verify-release.mjs` exit 0 na finálním stromu |
| 7 source | `pnpm check` s `ENVIRONMENT=test BETTER_AUTH_URL=http://localhost:7531 DATABASE_URL=postgresql://musubi_toolchain:unused@127.0.0.1:59998/musubi_toolchain_test` | **exit 0, 233 s**; první krok `release:verify` zelený s novým blokem; žádná DB se nespouštěla ani nekontaktovala (source-only); řádek DX-06 v audit-disposition byl editován až po startu tohoto běhu (jen Markdown, netýká se `pnpm check`) |

Fast gate je `node --test` nad reálnou kopií repa, ne JSON scénář: `pnpm test:behavior --list` pro tuto hranici nic nenabízí — přiznaná mezera, nikoli PASS JSON gate. `.spec-pilot.json` nesl během kontrol dočasnou mapu `{fast: node --test scripts/verify-release.test.mjs, planning-whitespace, docs-build, source}` a před finálním review byl obnoven na bajty merge-base (`git diff e6015977 -- .spec-pilot.json` prázdný; SHA256 `099538b422408b9ea550ff548d0478e278e1e730ffc0ec81bfe2e35d70e610ae`, blob `34297fbe`).

## Proklik běžící dokumentace

Produkční node entry z čerstvého buildu: `node packages/docs/dist/server/entry.mjs`, HOST=127.0.0.1, PORT=4531, ASTRO_NODE_LOGGING=disabled, start 08:00:39Z, pid 46885, cwd tento worktree. Orca built-in browser, vlastní nová záložka.

- Desktop (viewport 1440×1000; pane reálně 960 px, po rozbalení 1445 px): `/docs/guides/running-locally/` řádek Node.js zobrazuje nový text; skutečným kliknutím na sidebar „Troubleshooting“ přechod na `/docs/guides/troubleshooting/`, sekce „Astro or another dependency rejects Node“ s `cat .nvmrc` a „only pnpm source“; `/docs/reference/commands/` „in the Docker builds“, bez „both Docker“. 0 konzolových chyb na commands.
- Narrow 390×844 mobile: troubleshooting bez horizontálního overflow (`scrollWidth` 390 = `innerWidth`); menu otevřeno focus+Enter (první `click` na Menu nepřepnul stav, jako v CP01 docs acceptance), odkaz „Run Locally“ v otevřeném menu focus+Enter → `/docs/guides/running-locally/`, řádek Node.js čitelný, `scrollWidth` 390. Jeden screenshot se scale 3 vyšel jako dlaždicový artefakt nástroje a byl nahrazen scale 1; jeden desktop screenshot zachytil prázdný rámec během scrollu a byl zopakován. Pět čitelných screenshotů v `/tmp/musubi-cp01-toolchain-20261106/screenshots/`.
- Hashe tří dist stránek před a po prokliku shodné (server četl stejný build; `pnpm check` přebuildoval dist až po zastavení serveru). Server ukončen podle PID/cmdline/cwd 08:04:08Z, port 4531 volný, zavřena jen vlastní záložka. Dark theme se v této relaci neověřoval; nejde o UI změnu pod apps/web.

## DX-06 a meze

DX-06 po této relaci: staticky doložený a lokálně sjednocený (deklarace na `.nvmrc` 22.23.4, strojově hlídáno), runtime dopad původního nesouladu (lokální Node 24) nadále neověřený. Nedoložené/mimo rozsah: CI patch plave (`node-version: 22`); validátor porovnává soubory, ne `process.version`; EAS/native Node neověřen a z repa neurčený; sync-reference image Quality nestaví; `COPY --from=<externí image>` nehlídán; `docs/releasing.md` nový gate nepopisuje; hláška `package-sync-alpha.mjs:99` zůstává hardcoded; docs ochrana je literálová; žádné mapování docs/node green na device/store PASS. Dependency floor (`undici >=22.19.0`) se v próze neuvádí jako support claim.

## Otevřené gates

Chybí: nezávislý fresh final diff review, otevření PR, všech 21 current-head Quality jobů a branch-protection checks na skutečném headu, image boot a squash merge. Nic z toho se zde nevykazuje. Task 1.3 zůstává unchecked; CP01 jako celek ani další CP nejsou hotové. Žádný push, tag, publikace ani deployment neproběhly.
