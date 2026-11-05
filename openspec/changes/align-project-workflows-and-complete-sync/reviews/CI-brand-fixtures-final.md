# Finální nezávislé review: slice CI-brand-fixtures (Musubi)

Reviewer: Claude Fable 5.1, Orca task `task_d81f0584be83`, dispatch `ctx_529cbbe86093`, 2026-11-05.
Postup: `spec-review` (fresh context), `spec-guide/references/contracts.md` a `testing.md`, `AGENTS.md`/`CLAUDE.md`. Režim read-only: žádné spuštění testů, buildů, sítě ani git/tracker mutací. Jediný zápis je tento soubor.

Otázka review: je celý aktuální finální diff větve `codex/ci-brand-fixtures` připraven k otevření vlastního PR do `main`? Review není merge, publikace, deploy ani potvrzení CI.

## Verdikt

**APPROVE** pro přesný níže uvedený obsah (head `eef1e1d2…`, fingerprint `7754c65f…`). Žádný blocker. Doporučení R-01 až R-05 níže nevyžadují nové kolo před PR; lze je zapsat jako follow-up.

Schválení se vztahuje jen na tuto revizi a tuto otázku. Nedokládá zelené current-head Quality (21 jobů), nedokončuje slice, neautorizuje merge, publikaci ani změnu PR407. Merge až po reálných checks na tomto head commitu podle `AGENTS.md`.

## 1. Subjekt, revize, izolace

| Položka | Ověřeno |
| --- | --- |
| Worktree | `/home/flamendrin/orca/workspaces/musubi/codex-ci-brand-fixtures`, větev `codex/ci-brand-fixtures` |
| HEAD | `eef1e1d21f49e801daf249e4f89c7714b2c93163` (shoda s manifestem) |
| Base | `585dd231c3126ddc51a6ee5972c96bea95cfb15a` = `origin/main` (lokální ref `main` je zastaralý na `b138056`; pro PR na GitHubu je rozhodující `origin/main`) |
| Commity nad base | 2: `262998b` (fixture + docs), `eef1e1d` (U8 ruční kontexty) |
| `git status --porcelain` | prázdný (čistý strom, žádné untracked soubory) |
| `git diff --check` base..HEAD | bez nálezu |
| Změněné soubory | 13 (8 kódových/testových, 5 OpenSpec), shoda s `allChangedFiles` manifestu |
| Primární hashe | všech 12 SHA256 z `/tmp/musubi-ci-brand-final-subject.json` ověřeno **OK** |
| Agregátní fingerprint | `7754c65fbb5c1876fef301f7b938360919ebe5b9456d4c3cd0f3e07c3c235307` (přepočítán stejným algoritmem, shoda) |
| `.spec-pilot.json` | v diffu není, `git diff HEAD` nulový (U3 dodrženo) |

Izolace: nečetl jsem `reviews/CI-brand-fixtures-design.md` (kopie pre-apply review), žádné jiné reviewerské reporty, staré /tmp diagnózy, autorovu konverzaci ani prompty. Checkpoint brief a acceptance jsem četl jako **autorem hlášenou** evidenci a konfrontoval ji se skutečným diffem, produkčními/testovými rozhraními a surovými výstupy v `/tmp/musubi-ci-brand-scratch/`.

Skills: `spec-review`, `spec-guide` (contracts, testing) čteny z původního checkoutu `/home/flamendrin/workspace/musubi/.agents/skills` (v worktree je jen `musubi-ui`). `musubi-ui` nebyl potřeba: diff nemění `apps/web/src/**` ani žádný UI/styl.

## 2. Vlastní popis výsledného chování a hranic

**Problém (TEST-08):** `BrandMark` po hydrataci načítá dvě masky `<image href>` z `https://vardum.com/w/musubi/brand/web-app/{mark-neutral,mark-accent}` (`apps/web/src/brand.ts`, `apps/web/src/components/BrandMark.tsx:28,31`). Testy čekají na `networkidle`; když upstream visí, povinné browser joby vyprší.

**Řešení v diffu:** nový helper `apps/web/e2e/external-brand.ts`:
- `installExternalBrandFixture(context)` registruje `context.route("https://vardum.com/**")`. Přesně dvě GET URL vzaté z `BRAND_ASSETS.logoInk/logoAccent` odbaví `fulfill` 200 `image/svg+xml` s SVG, jehož `<path d>` je přečten regexem z konstant `inkPath`/`accentPath` v `BrandMark.tsx` (právě jeden match každé, jinak throw při importu modulu). Jakýkoli jiný požadavek na host se `abort("blockedbyclient")`, zapíše do `unexpected`.
- `finish(testInfo, name)` připojí JSON přílohu (per URL/metoda/akce/počet) a `expect(unexpected).toEqual([])`.
- `test = base.extend({ externalBrand: [auto fixture nad `context`] })`: instalace před `use`, `finish` po těle testu (teardown fixture; selhání teardownu označí test jako failed). `expect` je re-export.
- Handler nikdy nevolá `continue`/`fetch`/`fallback` → žádný požadavek na host neodchází upstream, pokud route zachytí.

**Konzumenti:** `behavior`, `dst-grid`, `news`, `theme-bootstrap`, `worker-cache` mění jen import `test`/`expect` (typy dál z `@playwright/test`). `month-read.spec.ts` navíc u dvou ručních `browser.newContext()` (3 testové případy: stream + K06 full/handoff) instaluje fixture hned po `newContext`, tělo v `try` končí `finish(testInfo, <odlišný název>)`, `context.close()` ve `finally`. `production-e2e/assets.spec.ts`: obranná fixture ve first-paint kontextech bez JS, `route.continue()` → `route.fallback()` v page-level catch-all, aby context route byla konzultována; doplněný komentář o nahrazené hranici.

**Hranice:**
- Nahrazená hranice je jen externí brand host na Playwright network portu. Live dostupnost ani tvar upstream SVG se neověřují. Fixture dokládá funkci masky, ne pixelovou shodu s Vardum.
- Požadavky obsloužené service workerem route nezachytí; `apps/web/src/push/service-worker.js` nemá `fetch` handler (ověřeno grep), takže to zde nehraje roli.
- Pokrytí platí pro kontexty existující dnes: výchozí `context` (auto) + všechny ruční `newContext` v `e2e/*.spec.ts` a `production-e2e` (ověřeno grep: pouze `month-read.spec.ts:6442`, `:7637`, `assets.spec.ts:35`, všechny obalené). Nový ruční kontext bez helperu by nebyl automaticky odhalen.
- `task-radicale.spec.ts` dál importuje z `@playwright/test`; v CI se nespouští (`RADICALE_E2E` gate) a brief jej výslovně vylučuje.
- Při dřívějším selhání aserce v ručním kontextu `finish` neproběhne (bez přílohy, původní chyba zůstává); kontext se přesto zavře.
- Page-level routes mají přednost před context route. Prošel jsem všechny `.route(` vzory v dotčených specech: kromě `assets.spec.ts:41` (změněno na `fallback`) jsou všechny omezené na `/api/...` (glob, regex nebo predikát `url.pathname.startsWith("/api/")`), žádný další catch-all nestíní brand host. `unroute` se používá jen na stream/events vzory.

## 3. Splnění cíle a požadavků (proti souborům a diffu)

| Požadavek | Stav | Evidence |
| --- | --- | --- |
| Jediný pozorovatelný cíl: e2e a production smoke bez upstream `vardum.com` | splněno v kódu | handler bez `continue/fetch/fallback`; raw G3/U8 offline běhy (`--host-resolver-rules=MAP vardum.com ~NOTFOUND`): `u8-full-offline-2.txt` 402 passed/1 skipped, `u8-prod-offline.txt` 5 passed |
| Rozsah souborů přesně dle briefu §4 | splněno | `git diff --name-status`: 8 kódových souborů = §4; žádná změna `apps/web/src/**`, `playwright*.config.ts`, `scripts/**`, `.github/workflows/**`, `packages/**`, dependencies (`@playwright/test` 1.62.0 beze změny) |
| Runner/konfig/CI/runtime se nemění | ověřeno | viz výše; `pnpm-lock.yaml` není v diffu |
| Původní aserce, timeouty, retries, `networkidle` zachovány | ověřeno | `git diff -w` na `month-read.spec.ts` ukazuje jen import, `testInfo`, `installExternalBrandFixture`, `try/finally`, `finish`; `assets.spec.ts` mění jen import, fixture, `continue→fallback`, komentář a `finish`. Žádná aserce odstraněna ani změkčena |
| Discovery beze změny | ověřeno z raw | `shard-N-before/after` i `u8-shard-N` bajtově identické (101/101/101/100 z 403); `e2e-list` před/po/U8 po normalizaci řádků 403 identických ID; production `--list` před/po liší jen o posun řádků (697→696 atd.), 5 ID identických |
| VT-01 (nespotřebovaná/neznámá fixture selže) | splněno | neznámá cesta → `abort` + fail v `finish` (raw `u8-unknown.txt` ukazuje očekávané selhání s výpisem URL); nevyužití fixture (0 požadavků) není fail – u `theme-bootstrap`/first-paint je to záměrné, hranice je tam obranná |
| VT-03 (přiznaná mock hranice) | splněno | komentář v `assets.spec.ts`, acceptance „Reziduální rizika“ |
| VT-04 (reprodukovatelné prostředí) | splněno | geometrie z repo konstant, žádný nový brand zdroj |
| Kanonické změny jen zúžení | splněno | `tasks.md` 1 věta (výjimka pořadí jen pro tento slice, TEST-08), `audit-disposition.md` 1 řádek TEST-08; `openspec validate --strict` raw `u8-validate-final.json`: `valid: true` |
| `.spec-pilot.json` nezměněn | ověřeno | viz §1 |
| Nezávislé design review před apply | hlášeno autorem | nečteno (vyloučeno z primárního obsahu); existence souboru v diffu potvrzena |
| U8 (ruční kontexty) | splněno | kód + raw přílohy `u8-three.json`: v každém z 3 testů `*-context` příloha mark-neutral 2× a mark-accent 2× fulfilled (2 stránky), `unexpected: []`; auto `external-brand-routes` výchozího kontextu `routes: []` |

## 4. Evidence: co jsem ověřil ze surových výstupů a co ne

Ověřeno čtením raw souborů v `/tmp/musubi-ci-brand-scratch/` (shoda s acceptance):
- R1 (deterministický red, `r1-intervention.diff` = hang handler): `r1-login.txt` 2 failed, `r1-prod.txt` 1 failed.
- D1a (`d1a-defect.diff`: `mark-accent` nikdy neodbaven): 2 failed + 1 failed. D1b/U8 unknown: teardown fail s `["GET …/unknown"]`.
- G2/G3 (262998b): `g2.txt`, `g3full.txt` 402 passed, 1 skipped; `g2.meta` exit 0.
- U8: `u8-three.txt` 3 passed; `u8-full-offline.txt` běh 1: 401 passed, 1 failed (K12 dark 390), 1 skipped; běh 2: 402 passed; `u8-prod.txt`/`u8-prod-offline.txt` 5 passed; `u8-k12-base.txt` (base bez fixture, živý upstream) 4 passed/1 failed → flaky existoval před fixture; `u8-k12-head-online.txt` 5 passed.
- `u8-check.txt`: vitest 57/630 a 110/851 passed, log končí úspěšným `@musubi/web:build`. Pro U8 běh neexistuje meta soubor s exit kódem (jen `check.meta` pro 262998b: exit 0, 229 s); exit 0 je silně implikován `&&` řetězcem končícím buildem, ale nepotvrzen přímým záznamem.
- D2 `d2-mark-zoom.png`: dvě propletená ramena (tmavé a akcentové), ne čtverec/prázdno. Jde o render s fixture, **nikoli** důkaz live Vardum.

Neověřeno / mimo možnosti tohoto review:
- CI běhy `42103645274` (main) a `42104615417` (PR407) a trace PR407 (`/tmp/musubi-cp01-pr407-production-report.zip` není v povoleném adresáři): bez sítě nepotvrzeno; mechanismus beru jako hlášený autorem, kód jej ale reprodukuje lokálně (R1).
- Žádný test jsem nespouštěl; neověřuji, že běhy skutečně proběhly na uvedeném head (hashe souborů ano, provenance logů ne).
- Current-head Quality (21 jobů) neběžela; acceptance to uvádí správně.
- Žádný screenshot ani fixture nepovažuji za live Vardum/DB/auth/provider důkaz; acceptance to netvrdí.

## 5. Nálezy

Žádný blocker.

| ID | Typ | Místo | Nález | Dopad | Další krok |
| --- | --- | --- | --- | --- | --- |
| R-01 | doporučení | `apps/web/e2e/external-brand.ts:9` | Glob `BRAND_HOST = "https://vardum.com/**"` je literál, zatímco obsluhované URL se berou z `BRAND_ASSETS`. Změní-li se host v `brand.ts`, mapa `served` se posune, ale route se nespustí: požadavky půjdou tiše upstream bez záznamu v `unexpected` (fixture se neuplatní, ne selže). | nízký dnes; tichá regrese při změně hosta | follow-up: odvodit glob z `new URL(BRAND_ASSETS.logoInk).origin + "/**"` (nebo ověřit, že obě URL glob matchují, jinak throw). Nemění mechanismus ani allowlist, ale je to změna helperu → podle briefu §10 nové kolo, proto ne v tomto PR |
| R-02 | doporučení | `external-brand.ts:11–20` | Regex `const (inkPath\|accentPath) = "([^"]+)";` závisí na formátování `BrandMark.tsx` (jeden řádek, dvojité uvozovky). Reformat na jiné uvozovky/šablonu shodí import modulu a tím všech 7 spec souborů. Chyba je explicitní a brief to uvádí jako return podmínku. | střední při refaktoru brandu, jinak žádný | zaznamenat jako známé vazbu; případně v budoucnu exportovat cesty z `BrandMark.tsx` (změna `src/**`, mimo tento slice) |
| R-03 | poznámka | `external-brand.ts`, `apps/web/tsconfig.json`, `package.json` lint | `e2e/**` není v `typecheck` include ani v `eslint .storybook src`; Playwright typy jen stripuje. Typové chyby helperu by se projevily až za běhu. Ručně jsem signatury (`test.extend`, fixture `(fixtures, use, testInfo)`, `testInfo.attach`, `Route`, `BrowserContext`) prošel bez nálezu a raw běhy modul načetly v 403 testech. | nízký | stav existoval před diffem (TEST-05/TEST-04 oblast); není důvod k změně zde |
| R-04 | poznámka | acceptance „Full source“, `/tmp/musubi-ci-brand-scratch/u8-check.txt` | Pro U8 `pnpm check` chybí meta záznam s exit kódem (pro 262998b `check.meta` existuje). Log sám končí úspěšným buildem. | nízký | při příštím záznamu ukládat meta i pro opakované běhy; pro tento PR rozhodující je CI |
| R-05 | poznámka | `external-brand.ts` auto fixture | Auto fixture závisí na `context`, takže i testy používající jen `browser` (3 ruční případy) nyní vytvoří nevyužitý výchozí kontext a přílohu `routes: []`. Režie zanedbatelná; acceptance to uvádí. | žádný | nic |

Nehledal jsem umělé nálezy; výše uvedené jsou jediné věci, které bych při vlastní implementaci udělal jinak nebo zaznamenal.

## 6. Konzistence s kanonickými artefakty a AGENTS

- `tasks.md` ř. 12 (postup CP brief: požadavky, soubory, jeden pozorovatelný výsledek, přesné argv fast/full/ui, prerequisites, evidence, audit ID, stop/return; strict validace před i po kanonické odchylce; dočasná branch mapa checks) – brief §1–§10 a acceptance toto naplňují; odchylka pořadí byla zapsána do kanonu v témže diffu a validována.
- `audit-disposition.md`: nový řádek TEST-08 správně odkazuje na brief jako konkrétní task a neuzavírá TEST-04/TEST-05.
- `AGENTS.md`: práce na `codex/` větvi, oddělení implementační/publikační/deploy evidence (acceptance výslovně říká, že není důkaz Quality/merge/deploy), žádné obcházení required checks. Nezávislé review před PR = toto review.
- `verification-workflow` spec (fixture API nenahrazuje důkaz DB/auth/provider; nespotřebovaná/neznámá fixture selže; full = CI hranice) – respektováno; acceptance přiznává, že lokální `pnpm check` není full gate.
- Proposal „nespouští apply“ vs. tasks „apply vybraného boxu/slice po briefu“: slice postupuje podle procedury v tasks; koordinátor přijal brief (hlášeno), tedy v souladu.

## 7. Nehodnocené oblasti

- Obsah `reviews/CI-brand-fixtures-design.md` (záměrně vyloučen).
- Semantika testů mimo dotčené řádky (např. správnost K06/stream asercí) – nezměněna diffem, neposuzována.
- Chování na jiných prohlížečích než Chromium headless (projekt má jen chromium).
- Headed/`--ui` režim (favicon `tab-icon` → `unexpected`), brief U5 to přiznává jako reziduum.
- Provenance a čas lokálních běhů (nelze mechanicky svázat s head commitem).

## 8. Doporučený další krok

Otevřít PR `codex/ci-brand-fixtures` → `main` (base `origin/main` 585dd23) s tímto přesným obsahem; v popisu uvést, že helper nahrazuje jen dvě brand masky, že Vardum live dostupnost se neověřuje, a odkázat na acceptance. Squash merge až po zelených checks na `eef1e1d`. R-01 až R-05 zapsat jako follow-up (ne do tohoto PR, aby se neotevíralo nové kolo review). PR407 se tímto nemění (§9.4 briefu vyžaduje koordinátora/vlastníka).
