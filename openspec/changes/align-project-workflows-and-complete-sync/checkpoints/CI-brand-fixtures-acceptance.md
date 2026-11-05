# CI-brand-fixtures — acceptance záznam implementace

Stav: **implementace a lokální ověření dokončeny; slice NENÍ hotový.** Chybí finální nezávislé review přesného diffu, vlastní PR a 21 current-head Quality jobů (full gate VT-05). Tento záznam není důkaz zelené Quality, merge, publikace ani deploymentu.

- Worker: Claude Opus 5.5, Orca task `task_58e488d4c966`, dispatch `ctx_20ef61cb6318`, 2026-11-05.
- Worktree: `/home/flamendrin/orca/workspaces/musubi/codex-ci-brand-fixtures` (vytvořil Orca jako `f-tuma/codex-ci-brand-fixtures`, koordinátor povolil lokální `git branch -m codex/ci-brand-fixtures`).
- Base: `main` `585dd231c3126ddc51a6ee5972c96bea95cfb15a` (ověřeno `git merge-base`). Head: commit tohoto záznamu na `codex/ci-brand-fixtures` (viz `git log`). PR407 a původní checkout `/home/flamendrin/workspace/musubi` se neměnily.
- Prostředí: Node v22.23.4, pnpm 11.8.0 (root `packageManager`), Playwright 1.62.0 s `chromium_headless_shell`, Docker 29.9.2, Linux. `.nvmrc` (24.15.0) se neměnil (task 1.3 / DX-06).
- Instalace: `pnpm install --frozen-lockfile --prefer-offline`, exit 0, 3 s, lockfile beze změny.

## Brief, review a hashe

| Artefakt | SHA256 |
| --- | --- |
| Původní přijatý subjekt `/tmp/musubi-ci-brand-fixtures-brief.md` (167 ř.) | `961943955f7282e5d740ac3aeb388fcdeb7da5ecd511a2d157bbc55dfac278f2` |
| Lokální `checkpoints/CI-brand-fixtures.md` s upřesněními U0–U7 (199 ř.) | `9f8e6d325e28a9a1d0f2f32906a55c37d4159f46abe5a4cfa6d192a1f8c8f532` |
| Design review `reviews/CI-brand-fixtures-design.md` (bajtová kopie `/tmp/musubi-ci-brand-fixtures-design-review.md`) | `5e3e8e430fa2dd3d63cb6c2fc6c309147f0eda4fa0b42eb234952ae3e9dba185` |

Dokumentační upřesnění přijatá koordinátorem (seznam je i v §0 briefu): U0 stav/umístění/worktree; U1 (R-01) odůvodnění context-level route bez tvrzení o service workeru; U2 (R-02) URL pouze z `BRAND_ASSETS`, `fulfill` kvůli console errors; U3 (R-03) dočasná `.spec-pilot.json` mapa; U4 (R-04) výjimka pořadí jen pro TEST-08; U5 (R-05) headless kontrolní režim, headed favicon jako reziduum; U6 (R-06) invokace SPEC/OpenSpec; U7 (R-07) obranná fixture v first-paint kontextech. Mechanismus, allowlist, rozsah kódu, hosty ani kontroly se nezměnily.

## Kanonické změny (k potvrzení vlastníkem)

1. `tasks.md`, věta „Závislosti“: doplněno „prerekvizitní slice CI-brand-fixtures (TEST-08, checkpoints/CI-brand-fixtures.md) odblokuje current-head Quality pro CP01 a smí proběhnout před dokončením CP01 i CP02–CP03, neuzavírá žádný CP02/CP03 box“. Žádný checkbox se neuzavřel.
2. `audit-disposition.md`: nový řádek TEST-08 za TEST-07 s odkazem na tento brief. Ostatní řádky beze změny.

## Strict OpenSpec validace

- `/home/flamendrin/.local/bin/spec openspec --project /home/flamendrin/orca/workspaces/musubi/codex-ci-brand-fixtures -- list --json` i `-- validate align-project-workflows-and-complete-sync --strict --json`: exit 2, `{"error":"OpenSpec has not been initialized by SPEC","mechanical_result":"error","status":"error"}`; `spec status` hlásí `not-installed`. Instalace ani rules se neměnily.
- Náhradně byl spuštěn přímo pinovaný binár, na který odkazuje SPEC instalace původního checkoutu (`.spec/bin/openspec` → `/home/flamendrin/.cache/SPEC/openspec/1.15.0/binary/openspec`, verze 1.15.0), s cwd v novém worktree:
  - `openspec list --json`: root `/home/flamendrin/orca/workspaces/musubi/codex-ci-brand-fixtures` (`source: nearest`), change `align-project-workflows-and-complete-sync`, 0/72 tasks.
  - `openspec validate align-project-workflows-and-complete-sync --strict --json` před kanonickou úpravou: exit 0, passed 1, failed 0.
  - Totéž po úpravě `tasks.md`/`audit-disposition.md` a před kódem: exit 0, `valid: true`, passed 1, failed 0.
  - Finální validace po všech změnách (22:25): exit 0, `valid: true`, passed 1, failed 0.
- Jde o mechanickou validaci OpenSpec, ne o SPEC `check` ani sémantické review.

## Změněné soubory (finální diff proti base)

```
 apps/web/e2e/behavior.spec.ts                      |   3 +-
 apps/web/e2e/dst-grid.spec.ts                      |   3 +-
 apps/web/e2e/external-brand.ts                     |  83 +++++++++  (nový helper)
 apps/web/e2e/month-read.spec.ts                    |   3 +-
 apps/web/e2e/news.spec.ts                          |   3 +-
 apps/web/e2e/theme-bootstrap.spec.ts               |   2 +-
 apps/web/e2e/worker-cache.spec.ts                  |   2 +-
 apps/web/production-e2e/assets.spec.ts             |  13 +-
 openspec/…/audit-disposition.md                    |   1 +
 openspec/…/checkpoints/CI-brand-fixtures-acceptance.md (tento záznam)
 openspec/…/checkpoints/CI-brand-fixtures.md        | 199 +
 openspec/…/reviews/CI-brand-fixtures-design.md     |  74 +
 openspec/…/tasks.md                                |   2 +-
```

Šest speců mění jen import `test`/`expect` (typy dál z `@playwright/test`). `assets.spec.ts`: import, obranná fixture v first-paint kontextech s `finish` před `context.close()`, `route.continue()` → `route.fallback()` pro ne-stylesheet požadavky, doplněný komentář. Žádná změna `apps/web/src/**`, configů, `scripts/**`, workflow, `packages/**`, dependencies, timeoutů, retries ani asercí. `git diff --check`: exit 0.

`.spec-pilot.json` byl během implementace dočasně přepsán branch mapou podle §6.1 a před commitem vrácen na původní bajty (SHA256 `099538b422408b9ea550ff548d0478e278e1e730ffc0ec81bfe2e35d70e610ae`, `cmp` shoda), ve finálním diffu není.

## Inventory a discovery

- `pnpm test:behavior --list`: exit 0, 758 scénářů; žádný nepokrývá hranici „externí brand obrázek v prohlížeči“ (nejbližší `web-edge/*` = worker/edge cache). Node-side JSON scénář: **N/A**, nový scénář ani kopie logiky nevznikly. Relevantní JSON replay je `pnpm test:behavior:browser` (níže).
- `node scripts/ci-shards.mjs web N/4 --list`, N=1..4, před a po: exit 0, výstupy **bajtově identické** (101/101/101/100 z 403, váhy 763864/763939/764876/763915).
- `pnpm --filter @musubi/web exec playwright test --list`: před i po 403 testů v 7 souborech; ID po normalizaci `soubor:řádek:sloupec` → `soubor` identická (posun řádků o +1 importní řádek).
- `… playwright test --config=playwright.production.config.ts --list`: před i po 5 testů ve 3 souborech, ID identická.

## Red / green / defekt

Dev server: vlastní `pnpm dev --host 127.0.0.1 --port 3517 --strictPort` (apps/web, PID zapsaný v `/tmp/musubi-ci-brand-scratch/dev-3517.pid`), `PLAYWRIGHT_ORIGIN=http://127.0.0.1:3517`. Produkční server: vlastní kontejner `musubi-web-smoke-cibrand` z image `musubi-web:smoke-cibrand` (`docker build -f apps/web/Dockerfile`), `-p 127.0.0.1:4337:3000`, healthy, `PLAYWRIGHT_ORIGIN=http://127.0.0.1:4337`. Kontrolní režim headless. Login cílený výběr: `-g "says so when a provider sign-in does not come back|shows only the passphrase form on a server with no OAuth"`.

| Krok | Revize / zásah | Příkaz (cwd `apps/web`, není-li uvedeno) | Čas | Exit | Výsledek |
| --- | --- | --- | --- | --- | --- |
| R0 login | base 585dd231, živý vardum | `pnpm exec playwright test month-read.spec.ts -g …` | 22:05:21, 8 s | 0 | 2 passed |
| R0 worker/theme | base | `pnpm exec playwright test worker-cache.spec.ts theme-bootstrap.spec.ts` | 22:05, 2 s | 0 | 6 passed |
| R0 produkce | base, image `smoke-cibrand` | `pnpm test:e2e:production` | 22:08:09, 21 s | 0 | 5 passed |
| R1 login | base + dočasný hang helper (`/tmp/musubi-ci-brand-scratch/r1-intervention.diff`) | jako R0 login | 22:07:20, 32 s | 1 | 2 failed: `page.waitForLoadState: Test timeout of 30000ms exceeded` (`month-read.spec.ts:6695`, `:6712`) |
| R1 produkce | base + tentýž hang helper v `assets.spec.ts` | `pnpm exec playwright test --config=playwright.production.config.ts production-e2e/assets.spec.ts` | 22:08:36, 32 s | 1 | 1 failed: tentýž timeout na `assets.spec.ts:62` |
| G1 login | fixture | jako R0 login | 22:10:26, 3 s | 0 | 2 passed; `external-brand-routes`: mark-neutral 1× fulfilled, mark-accent 1× fulfilled, `unexpected: []` |
| G1 worker/theme | fixture | jako R0 | 22:10, 2 s | 0 | 6 passed |
| G1 ui | fixture | root `pnpm test:behavior:browser` | 22:10, 8 s | 0 | 8 passed (beze změny počtu) |
| G1 produkce | fixture | `pnpm test:e2e:production` | 22:10:55, 8 s | 0 | 5 passed; obě role fulfilled v každém testu (authenticated Month 2×), first-paint 390/1280: 0 brand požadavků, `unexpected: []` |
| G2 plný e2e | fixture | root `PLAYWRIGHT_ORIGIN=http://127.0.0.1:3517 pnpm --filter @musubi/web test:e2e` | 22:13:26, 207 s | 0 | 402 passed, 1 skipped (`task-radicale.spec.ts`, gate `RADICALE_E2E`), 0 flaky (lokálně `retries: 0`), 0 failed |
| G3 plný e2e | fixture + host-resolver pravidlo | `pnpm exec playwright test -c playwright.g3.tmp.config.ts` | 22:17:01, 200 s | 0 | 402 passed, 1 skipped, 0 failed; žádný úspěch nezávisí na upstream vardum, včetně dvou ručních kontextů v `month-read.spec.ts` |
| Finální produkce | image znovu sestaven z finálního stromu (`sha256:4875a33f…`, 15 s), `.spec-pilot.json` již vrácen | `pnpm test:e2e:production` | 22:24:58, 7 s | 0 | 5 passed |
| G3 login | fixture + `--host-resolver-rules=MAP vardum.com ~NOTFOUND` (dočasné `playwright.g3*.tmp.config.ts`, kopie v `/tmp/musubi-ci-brand-scratch/`) | `pnpm exec playwright test -c playwright.g3.tmp.config.ts month-read.spec.ts -g …` | 22:12:56, 4 s | 0 | 2 passed |
| G3 ui+worker+theme | totéž | `… -c playwright.g3.tmp.config.ts behavior.spec.ts worker-cache.spec.ts theme-bootstrap.spec.ts` | 22:13, 6 s | 0 | 14 passed |
| G3 produkce | totéž | `… -c playwright.g3.production.tmp.config.ts` | 22:13, 7 s | 0 | 5 passed |
| G3 kontrola | totéž, bez fixture | dočasný spec: `page.goto("https://vardum.com/…/mark-neutral")` | 22:13 | 0 | 1 passed: navigace selhala `ERR_NAME_NOT_RESOLVED`, pravidlo tedy skutečně platí |
| D1a | fixture s dočasným defektem: `mark-accent` nikdy neodbaven (`/tmp/musubi-ci-brand-scratch/d1a-defect.diff`) | login `-g …` + produkční `assets.spec.ts` | 22:11:41, 32 s + 31 s | 1 / 1 | 2 failed + 1 failed na `networkidle` timeout (`assets.spec.ts:67`); helper vrácen, `cmp` shoda |
| D1b | fixture beze změny, dočasný spec načte `https://vardum.com/w/musubi/brand/web-app/unknown` | `PLAYWRIGHT_ORIGIN=…:4337 pnpm exec playwright test zz-defect.tmp.spec.ts` | 22:11:30, 2 s | 1 | teardown fail: `requests to the external brand host outside the served marks`, received `["GET https://vardum.com/w/musubi/brand/web-app/unknown"]` |
| D2 | fixture, produkční kontejner | tentýž dočasný spec: po `networkidle` mají obě `path` v hlavičce `mask=url(#…-ink/-accent)` a `d="M0 0h48v48H0z"` | 22:11:30 | 0 (ten test) | masky jsou aktivní (ne SSR fallback); vizuálně viz níže |

R0 dnes prošel, protože upstream odpověděl (sonda 22:05: `mark-neutral`/`mark-accent` → 302 na podepsaný render endpoint za 0,12/0,15 s). R0 tedy dokládá jen nedeterministickou závislost; deterministický red je R1. Selhání starého CI (42103645274 na main, 42104615417 na PR407) dokládá selhání povinných jobů; přesný mechanismus je potvrzen v trace produkčního smoke z PR407 (`/tmp/musubi-cp01-pr407-production-report.zip`, soukromé; sanitizovaný souhrn `/tmp/musubi-cp01-pr407-ci-summary.json`). U shardů 1–4 je stejná příčina silná inference, trace shardů jsem neověřoval.

Všechny dočasné zásahy (R1 helper, D1a defekt, D1b/D2 a G3 kontrolní specy, G3 configy) byly odstraněny; žádný není v tracked ani untracked stavu worktree.

## Vizuální důkaz (D2)

Přílohy z G1 produkčního smoke: `/tmp/musubi-ci-brand-scratch/g1-prod-shots/production-sign-up.png`, `unstyled-brand-390.png`, `unstyled-brand-1280.png`; výřez značky 8× `/tmp/musubi-ci-brand-scratch/d2-mark-zoom.png`. Po hydrataci značka ukazuje dvě propletená ramena (ink a accent) ve tvaru SSR fallbacku, ne čtverec ani prázdno. Nová screenshot aserce se nepřidala. Fixture dokládá funkci masky, ne pixelovou shodu s upstream SVG.

## Full source

Příkaz (root): `ENVIRONMENT=test BETTER_AUTH_URL=http://localhost:7531 DATABASE_URL=postgresql://musubi_cibrand:unused@127.0.0.1:59999/musubi_cibrand_test pnpm check`. Env odvozen z `.github/workflows/quality.yml` (job „Typecheck, test, lint, docs, and migrations“); `DATABASE_URL` je vlastní neprodukční konfigurace na nepoužívaném portu, žádná DB se nespouštěla ani nekontaktovala; root `.env` se nečetl ani nekopíroval.

Výsledek: start 22:20:32, 229 s, **exit 0**. Souhrn: vitest 851/851 a 630/630 passed (57 a 110 souborů), všechny node test runnery `# fail 0`, lint a build prošly (lint vypsal existující varování mimo tento diff). Jde o lokální `source`, ne o full gate: 21 current-head Quality jobů zatím neběželo.

## Reziduální rizika a hranice

- Live dostupnost a tvar upstream Vardum SVG se neověřují. Fixture API (`/api/*`) nedokládá DB, auth ani provider. Dev-server e2e není produkční server; produkční smoke běží proti skutečnému kontejneru.
- `month-read.spec.ts` obsahuje dva testy s vlastním `browser.newContext()` (ř. ~6443 „carries one session's edit into the other over the stream“, ř. ~7633 „K06 two real … drafts …“), které auto fixture nepokrývá. Nečekají na `networkidle` ani nesbírají console errors, takže je dostupnost vardum neblokuje (G2 i G3 plný e2e). Brief povoluje v `month-read.spec.ts` jen změnu importu, proto se nerozšiřovaly; v nich může jít požadavek na upstream. Jde o nalezenou mezeru oproti cíli §1 „žádný test nesahá na upstream“, k rozhodnutí koordinátora (případné rozšíření = nové review).
- Headed/`--ui` ladění může načíst favicon `tab-icon` a selhat na `unexpected` (U5). `task-radicale.spec.ts:81` zůstává závislý na vardum (v CI se nespouští). Flaky dynamic import (TEST-05, CP02 2.4) a Node toolchain 1.3 se zde neřeší.
- Otevřené gates: finální nezávislé review, PR, 21 current-head Quality jobů a branch-protection checks, poté update PR407 headu (§9.4, mimo tento slice).

## Úklid

- Dev server na 127.0.0.1:3517 (vlastní PID 1381883 a jeho potomci) ukončen; port volný.
- Kontejner `musubi-web-smoke-cibrand` odstraněn, image `musubi-web:smoke-cibrand` (obě sestavení) odstraněna; port 4337 volný. Cizí procesy, kontejnery ani DB nebyly dotčeny.
- Scratch a evidence mimo repo: `/tmp/musubi-ci-brand-scratch/` (výstupy běhů, diffy zásahů, přílohy, původní `.spec-pilot.json`). Worktree ponechán pro review.
